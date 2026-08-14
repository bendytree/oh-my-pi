/**
 * Contracts: the schedule tool's session-local timed spawns.
 *
 * 1. `every`/`at` wire values parse on documented boundaries (compound
 *    durations, 30s floor, HH:MM next-occurrence rollover, past rejection).
 * 2. A fired schedule spawns a FRESH subagent through the shared structured
 *    subagent path with the stored assignment/agent/model, and the run settles
 *    as an async job whose result text carries the schedule header.
 * 3. Overlap fires are skipped (not stacked), `at` entries are one-shot,
 *    cancel disarms the timer, and session dispose kills every timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as structuredSubagentModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { parseScheduleAt, parseScheduleEvery, ScheduleTool } from "@oh-my-pi/pi-coding-agent/tools/schedule";

describe("schedule wire value parsing", () => {
	it("parses simple and compound durations", () => {
		expect(parseScheduleEvery("45s")).toBe(45_000);
		expect(parseScheduleEvery("20m")).toBe(1_200_000);
		expect(parseScheduleEvery("1h30m")).toBe(5_400_000);
	});

	it("rejects sub-30s cadences and malformed durations", () => {
		expect(parseScheduleEvery("10s")).toContain("at least 30s");
		expect(parseScheduleEvery("2 hours")).toContain("Invalid `every`");
		expect(parseScheduleEvery("9pm")).toContain("Invalid `every`");
	});

	it("resolves HH:MM to the next local occurrence", () => {
		const now = new Date(2026, 7, 14, 20, 0, 0, 0).getTime(); // 20:00 local
		const tonight = parseScheduleAt("21:00", now);
		expect(tonight).toBe(new Date(2026, 7, 14, 21, 0, 0, 0).getTime());
		// 09:00 already passed today → tomorrow morning.
		const tomorrow = parseScheduleAt("09:00", now);
		expect(tomorrow).toBe(new Date(2026, 7, 15, 9, 0, 0, 0).getTime());
	});

	it("rejects past ISO datetimes and unparseable times", () => {
		const now = Date.parse("2026-08-14T20:00:00Z");
		expect(parseScheduleAt("2026-08-14T19:00:00Z", now)).toContain("in the past");
		expect(parseScheduleAt("9pm", now)).toContain("Invalid `at`");
	});
});

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "run",
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "assignment",
		exitCode: 0,
		output: "pipeline green",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(part => part.type === "text");
	return part?.text ?? "";
}

describe("schedule tool firing", () => {
	const managers: AsyncJobManager[] = [];
	let disposeCallbacks: Array<() => void>;

	function createSession(manager: AsyncJobManager | undefined, taskDepth = 0): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			taskDepth,
			getAgentId: () => "Main",
			asyncJobManager: manager,
			registerDisposeCallback: (callback: () => void) => {
				disposeCallbacks.push(callback);
			},
		} as unknown as ToolSession;
	}

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	async function createTool(manager: AsyncJobManager | undefined = createManager()): Promise<{
		tool: ScheduleTool;
		manager: AsyncJobManager | undefined;
	}> {
		const tool = ScheduleTool.createIf(createSession(manager));
		if (!tool) throw new Error("Expected ScheduleTool for a depth-0 session");
		return { tool, manager };
	}

	beforeEach(() => {
		disposeCallbacks = [];
		vi.useFakeTimers();
	});

	afterEach(async () => {
		for (const callback of disposeCallbacks.splice(0)) callback();
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("refuses schedule creation for subagent sessions", () => {
		expect(ScheduleTool.createIf(createSession(createManager(), 1))).toBeNull();
	});

	it("spawns a fresh subagent per fire and settles the run as an async job", async () => {
		const spawns: structuredSubagentModule.StructuredSubagentRequest[] = [];
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			spawns.push(request);
			return {
				result: makeResult({ id: request.identity?.id ?? "run" }),
				policy: { agentName: request.agent ?? "task" },
				mergeSummary: "",
				changesApplied: null,
				artifactsDir: "/tmp/artifacts",
			} as unknown as structuredSubagentModule.StructuredSubagentResult;
		});

		const { tool, manager } = await createTool();
		const added = await tool.execute("tc", {
			op: "add",
			name: "Pipe",
			task: "Check the pipeline and report one line.",
			every: "20m",
			agent: "scout",
			model: "opus",
		});
		expect(added.isError).toBeUndefined();
		expect(firstText(added)).toContain("Scheduled `Pipe` (every 20m)");

		vi.advanceTimersByTime(1_200_000);
		const job = manager!.getJob("PipeRun1");
		expect(job).toBeDefined();
		await job!.promise;

		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.assignment).toBe("Check the pipeline and report one line.");
		expect(spawns[0]?.agent).toBe("scout");
		expect(spawns[0]?.model).toBe("opus");
		expect(spawns[0]?.identity?.id).toBe("PipeRun1");
		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain("[schedule `Pipe` run #1 (every 20m)]");
		expect(job!.resultText).toContain("pipeline green");

		// Recurring entry re-armed: a second period fires run #2.
		vi.advanceTimersByTime(1_200_000);
		await manager!.getJob("PipeRun2")!.promise;
		expect(spawns).toHaveLength(2);
	});

	it("skips overlapping fires instead of stacking runs", async () => {
		let release: (() => void) | undefined;
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockImplementation(async request => {
			const { promise, resolve } = Promise.withResolvers<void>();
			release = resolve;
			await promise;
			return {
				result: makeResult({ id: request.identity?.id ?? "run" }),
				policy: { agentName: "task" },
				mergeSummary: "",
				changesApplied: null,
				artifactsDir: "/tmp/artifacts",
			} as unknown as structuredSubagentModule.StructuredSubagentResult;
		});

		const { tool, manager } = await createTool();
		await tool.execute("tc", { op: "add", name: "Slow", task: "Slow check.", every: "1m" });

		vi.advanceTimersByTime(60_000); // run 1 starts and blocks
		vi.advanceTimersByTime(60_000); // fire lands while run 1 active → skipped
		expect(manager!.getJob("SlowRun2")).toBeUndefined();

		const listed = await tool.execute("tc", { op: "list" });
		expect(listed.details?.entries[0]).toMatchObject({ name: "Slow", runs: 1, skipped: 1, running: true });

		release?.();
		await manager!.getJob("SlowRun1")!.promise;

		vi.advanceTimersByTime(60_000); // next fire after completion runs again
		expect(manager!.getJob("SlowRun2")).toBeDefined();
		release?.();
		await manager!.getJob("SlowRun2")!.promise;
	});

	it("treats `at` schedules as one-shot and removes them after firing", async () => {
		// Bun's vi shim has no setSystemTime; use a real-clock ISO target and
		// advance fake timers past the arming delay.
		const fireAt = new Date(Date.now() + 3_600_000).toISOString();
		vi.spyOn(structuredSubagentModule, "runStructuredSubagent").mockResolvedValue({
			result: makeResult(),
			policy: { agentName: "task" },
			mergeSummary: "",
			changesApplied: null,
			artifactsDir: "/tmp/artifacts",
		} as unknown as structuredSubagentModule.StructuredSubagentResult);

		const { tool, manager } = await createTool();
		await tool.execute("tc", { op: "add", name: "Evening", task: "Check fizz buzz.", at: fireAt });

		vi.advanceTimersByTime(3_700_000);
		await manager!.getJob("EveningRun1")!.promise;

		const listed = await tool.execute("tc", { op: "list" });
		expect(listed.details?.entries).toHaveLength(0);
		expect(firstText(listed)).toBe("No active schedules.");
	});

	it("cancel disarms the timer and dispose kills all schedules", async () => {
		const spawn = vi.spyOn(structuredSubagentModule, "runStructuredSubagent");

		const { tool } = await createTool();
		await tool.execute("tc", { op: "add", name: "Doomed", task: "Never runs.", every: "1m" });
		const cancelled = await tool.execute("tc", { op: "cancel", name: "Doomed" });
		expect(firstText(cancelled)).toContain("Cancelled `Doomed`");

		await tool.execute("tc", { op: "add", name: "AlsoDoomed", task: "Never runs either.", every: "1m" });
		for (const callback of disposeCallbacks.splice(0)) callback();

		vi.advanceTimersByTime(600_000);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects adds without a delivery path or with ambiguous timing", async () => {
		// Explicit `undefined` would trigger createTool's default manager; build the manager-less session directly.
		const bare = ScheduleTool.createIf(createSession(undefined));
		if (!bare) throw new Error("Expected ScheduleTool");
		const noManager = await bare.execute("tc", { op: "add", task: "Work.", every: "1m" });
		expect(noManager.isError).toBe(true);
		expect(firstText(noManager)).toContain("async.enabled");

		const { tool: tool2 } = await createTool();
		const both = await tool2.execute("tc", { op: "add", task: "Work.", every: "1m", at: "21:00" });
		expect(both.isError).toBe(true);
		expect(firstText(both)).toContain("exactly one of");
	});
});
