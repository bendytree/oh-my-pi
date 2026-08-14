/**
 * Schedule tool - session-local timed prompts.
 *
 * Each registered schedule arms a wall-clock timer inside this process. When
 * it fires, the entry spawns a fresh subagent (via the shared structured
 * subagent path) with the stored assignment and registers the run as an async
 * job, so the result auto-delivers into the parent transcript exactly like a
 * background `task` spawn settling.
 *
 * Deliberately ephemeral: entries live in tool-instance memory and die on
 * session dispose, `/new` (session-change callback), or process exit. Nothing
 * is persisted or re-armed on resume.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import scheduleDescription from "../prompts/tools/schedule.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { runStructuredSubagent, StructuredSubagentError } from "../task/structured-subagent";
import type { SingleResult } from "../task/types";

const scheduleSchema = type({
	op: '"add" | "list" | "cancel"',
	"name?": "string",
	"task?": "string",
	"every?": "string",
	"at?": "string",
	"agent?": "string",
	"model?": "string",
	"+": "delete",
}).describe("manage session-local scheduled prompts");

type ScheduleParams = typeof scheduleSchema.infer;

/** Minimum recurring cadence; guards against accidental sub-30s prompt storms. */
const MIN_INTERVAL_MS = 30_000;
/** setTimeout's signed-32-bit ceiling; longer delays would fire immediately. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DURATION_PATTERN = /^(?:\d+[smh])+$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

type ScheduleKind = { type: "every"; intervalMs: number } | { type: "at" };

interface ScheduleEntry {
	id: string;
	task: string;
	agent?: string;
	model?: string;
	kind: ScheduleKind;
	/** Human-readable cadence echo (`every 20m` / `at 21:00`). */
	cadence: string;
	nextFireAt: number;
	timer?: NodeJS.Timeout;
	running: boolean;
	runs: number;
	skipped: number;
}

/** Row snapshot exposed on tool results for rendering/tests. */
export interface ScheduleEntrySnapshot {
	name: string;
	cadence: string;
	nextFireAt: number | null;
	agent?: string;
	model?: string;
	runs: number;
	skipped: number;
	running: boolean;
}

export interface ScheduleToolDetails {
	op: ScheduleParams["op"];
	entries: ScheduleEntrySnapshot[];
}

/** Parse a compound duration (`20m`, `2h30m`, `45s`) into milliseconds. */
export function parseScheduleEvery(value: string): number | string {
	const token = value.trim().toLowerCase();
	if (!DURATION_PATTERN.test(token)) {
		return `Invalid \`every\` value ${JSON.stringify(value)}. Use durations like "45s", "20m", "2h", "1h30m".`;
	}
	let totalMs = 0;
	for (const segment of token.match(/\d+[smh]/g) ?? []) {
		const amount = Number(segment.slice(0, -1));
		totalMs += amount * UNIT_MS[segment.slice(-1)];
	}
	if (totalMs < MIN_INTERVAL_MS) return `\`every\` must be at least 30s.`;
	if (totalMs > MAX_TIMER_DELAY_MS) return `\`every\` is too long; maximum is about 24 days.`;
	return totalMs;
}

/** Parse `at` (`HH:MM` local next-occurrence, or ISO datetime) into an epoch ms fire time. */
export function parseScheduleAt(value: string, nowMs = Date.now()): number | string {
	const token = value.trim();
	const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(token);
	let fireAt: number;
	if (clock) {
		const at = new Date(nowMs);
		at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
		fireAt = at.getTime();
		if (fireAt <= nowMs) fireAt += 86_400_000;
	} else {
		fireAt = Date.parse(token);
		if (!Number.isFinite(fireAt)) {
			return `Invalid \`at\` value ${JSON.stringify(value)}. Use "HH:MM" (24h local) or an ISO datetime.`;
		}
		if (fireAt <= nowMs) return `\`at\` time ${JSON.stringify(value)} is in the past.`;
	}
	if (fireAt - nowMs > MAX_TIMER_DELAY_MS) return `\`at\` is too far out; maximum is about 24 days.`;
	return fireAt;
}

function formatFireTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function buildRunFailureMessage(result: SingleResult): string {
	const abortReason = result.abortReason?.trim();
	if (result.aborted && abortReason) return abortReason;
	return result.error?.trim() || result.stderr?.trim() || abortReason || "run failed";
}

export class ScheduleTool implements AgentTool<typeof scheduleSchema, ScheduleToolDetails> {
	readonly name = "schedule";
	readonly approval = "exec" as const;
	readonly label = "Schedule";
	readonly summary = "Schedule session-local timed prompts; each run spawns a fresh subagent";
	readonly description: string;
	readonly parameters = scheduleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	readonly #entries = new Map<string, ScheduleEntry>();
	#nameCounter = 0;

	/** Only parent sessions schedule; subagents park after yield and cannot host timers. */
	static createIf(session: ToolSession): ScheduleTool | null {
		if ((session.taskDepth ?? 0) > 0) return null;
		return new ScheduleTool(session);
	}

	private constructor(private readonly session: ToolSession) {
		this.description = prompt.render(scheduleDescription);
		// Session dies → schedules die. Both hooks matter: dispose covers exit,
		// the session-change callback covers `/new` adopting a fresh session id.
		session.registerDisposeCallback?.(() => this.#clearAll());
		session.registerSessionChangeCallback?.(() => this.#clearAll());
	}

	async execute(_toolCallId: string, params: ScheduleParams): Promise<AgentToolResult<ScheduleToolDetails>> {
		switch (params.op) {
			case "add":
				return this.#add(params);
			case "cancel":
				return this.#cancel(params);
			case "list":
				return this.#result(params.op, this.#listText());
		}
	}

	#result(op: ScheduleParams["op"], text: string, isError?: boolean): AgentToolResult<ScheduleToolDetails> {
		return {
			content: [{ type: "text", text }],
			details: { op, entries: this.#snapshots() },
			...(isError ? { isError } : {}),
		};
	}

	#snapshots(): ScheduleEntrySnapshot[] {
		return [...this.#entries.values()].map(entry => ({
			name: entry.id,
			cadence: entry.cadence,
			nextFireAt: entry.nextFireAt,
			...(entry.agent ? { agent: entry.agent } : {}),
			...(entry.model ? { model: entry.model } : {}),
			runs: entry.runs,
			skipped: entry.skipped,
			running: entry.running,
		}));
	}

	#add(params: ScheduleParams): AgentToolResult<ScheduleToolDetails> {
		const task = params.task?.trim();
		if (!task) return this.#result("add", "Missing `task`: the self-contained assignment each run performs.", true);
		const every = params.every?.trim();
		const at = params.at?.trim();
		if ((every ? 1 : 0) + (at ? 1 : 0) !== 1) {
			return this.#result("add", "Provide exactly one of `every` (recurring) or `at` (one-shot).", true);
		}
		if (!this.session.asyncJobManager) {
			return this.#result(
				"add",
				"Scheduling requires background job delivery (async.enabled) which this session does not have.",
				true,
			);
		}

		let kind: ScheduleKind;
		let cadence: string;
		let nextFireAt: number;
		if (every) {
			const intervalMs = parseScheduleEvery(every);
			if (typeof intervalMs === "string") return this.#result("add", intervalMs, true);
			kind = { type: "every", intervalMs };
			cadence = `every ${every}`;
			nextFireAt = Date.now() + intervalMs;
		} else {
			const fireAt = parseScheduleAt(at ?? "");
			if (typeof fireAt === "string") return this.#result("add", fireAt, true);
			kind = { type: "at" };
			cadence = `at ${at}`;
			nextFireAt = fireAt;
		}

		const requestedName = params.name?.trim();
		if (requestedName && !NAME_PATTERN.test(requestedName)) {
			return this.#result("add", "Invalid `name`: use 1-32 chars of [A-Za-z0-9_-].", true);
		}
		const id = requestedName ?? this.#generateName();
		if (this.#entries.has(id)) {
			return this.#result("add", `Schedule \`${id}\` already exists. Cancel it first or pick another name.`, true);
		}

		const entry: ScheduleEntry = {
			id,
			task,
			...(params.agent?.trim() ? { agent: params.agent.trim() } : {}),
			...(params.model?.trim() ? { model: params.model.trim() } : {}),
			kind,
			cadence,
			nextFireAt,
			running: false,
			runs: 0,
			skipped: 0,
		};
		this.#entries.set(id, entry);
		this.#arm(entry);
		return this.#result(
			"add",
			`Scheduled \`${id}\` (${cadence}): next run ${formatFireTime(nextFireAt)}. Dies with this session; results auto-deliver as background jobs.`,
		);
	}

	#cancel(params: ScheduleParams): AgentToolResult<ScheduleToolDetails> {
		const name = params.name?.trim();
		if (!name) return this.#result("cancel", `Missing \`name\`. ${this.#listText()}`, true);
		const entry = this.#entries.get(name);
		if (!entry) return this.#result("cancel", `No schedule named \`${name}\`. ${this.#listText()}`, true);
		clearTimeout(entry.timer);
		this.#entries.delete(name);
		return this.#result("cancel", `Cancelled \`${name}\`.${entry.running ? " Its in-flight run continues." : ""}`);
	}

	#listText(): string {
		if (this.#entries.size === 0) return "No active schedules.";
		const rows = [...this.#entries.values()].map(entry => {
			const status = entry.running ? "running" : `next ${formatFireTime(entry.nextFireAt)}`;
			const counts = `${entry.runs} run${entry.runs === 1 ? "" : "s"}${entry.skipped ? `, ${entry.skipped} skipped` : ""}`;
			const target = entry.agent ? ` agent=${entry.agent}` : "";
			return `- \`${entry.id}\` (${entry.cadence}${target}): ${status}; ${counts}`;
		});
		return `Active schedules:\n${rows.join("\n")}`;
	}

	#generateName(): string {
		let id: string;
		do {
			id = `Sched${++this.#nameCounter}`;
		} while (this.#entries.has(id));
		return id;
	}

	#arm(entry: ScheduleEntry): void {
		const delay = Math.min(Math.max(0, entry.nextFireAt - Date.now()), MAX_TIMER_DELAY_MS);
		entry.timer = setTimeout(() => this.#fire(entry), delay);
	}

	#fire(entry: ScheduleEntry): void {
		if (!this.#entries.has(entry.id)) return;
		if (entry.kind.type === "every") {
			// Fixed cadence from registration: advance past any missed slots
			// (e.g. laptop-suspended VM) instead of burst-firing catch-ups.
			const intervalMs = entry.kind.intervalMs;
			do {
				entry.nextFireAt += intervalMs;
			} while (entry.nextFireAt <= Date.now());
			this.#arm(entry);
		} else {
			this.#entries.delete(entry.id);
		}
		if (entry.running) {
			entry.skipped++;
			logger.debug("schedule: skipped fire, previous run still active", { schedule: entry.id });
			return;
		}
		const manager = this.session.asyncJobManager;
		if (!manager) {
			entry.skipped++;
			logger.warn("schedule: no async job manager; skipping fire", { schedule: entry.id });
			return;
		}
		entry.running = true;
		entry.runs++;
		const runId = `${entry.id}Run${entry.runs}`;
		try {
			manager.register(
				"task",
				runId,
				async ({ signal }) => {
					try {
						return await this.#runSpawn(entry, runId, signal);
					} finally {
						entry.running = false;
					}
				},
				{ id: runId, agentId: runId, ownerId: this.session.getAgentId?.() ?? undefined },
			);
		} catch (error) {
			// register() itself threw (job cap, disposed manager) — the run body
			// never started, so release the overlap latch here.
			entry.running = false;
			entry.skipped++;
			logger.warn("schedule: failed to register run job", {
				schedule: entry.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #runSpawn(entry: ScheduleEntry, runId: string, signal: AbortSignal): Promise<string> {
		const header = `[schedule \`${entry.id}\` run #${entry.runs} (${entry.cadence})]`;
		try {
			const execution = await runStructuredSubagent({
				session: this.session,
				invocationKind: "task",
				assignment: entry.task,
				...(entry.agent ? { agent: entry.agent } : {}),
				...(entry.model ? { model: entry.model } : {}),
				identity: { id: runId, label: `schedule ${entry.id}` },
				keepAlive: false,
				shareEvalSession: false,
				signal,
			});
			const { result } = execution;
			if (result.exitCode !== 0 || result.error || result.aborted) {
				throw new Error(`${header} failed: ${buildRunFailureMessage(result)}`);
			}
			return `${header}\n${result.output.trim() || "(no output)"}`;
		} catch (error) {
			if (error instanceof StructuredSubagentError) {
				throw new Error(`${header} failed preflight: ${error.message}`);
			}
			throw error;
		}
	}

	#clearAll(): void {
		for (const entry of this.#entries.values()) clearTimeout(entry.timer);
		this.#entries.clear();
	}
}
