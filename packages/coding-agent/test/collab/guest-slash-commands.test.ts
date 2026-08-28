/**
 * End-to-end contract: writable guests can run the host-executed slash
 * commands (`/clear`, `/compact`) by sending them as `prompt` frames. The
 * host intercepts them before `promptCustomMessage`, runs the matching
 * interactive-mode handler, and announces success via a session notice.
 * Unknown "/..." text still flows through as a normal prompt; read-only
 * guests keep getting the generic read-only rejection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { CompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface HostHarness {
	ctx: InteractiveModeContext;
	prompts: { from?: string }[];
	resets: { count: number };
	compacts: { instructions?: string; mode?: CompactMode }[];
	notices: string[];
	streaming: { value: boolean };
	/** Resolves on the next promptCustomMessage call — no polling. */
	nextPrompt(): Promise<{ from?: string }>;
	/** Resolves on the next handleResetContextCommand call — no polling. */
	nextReset(): Promise<void>;
	/** Resolves once a notice containing `match` has been emitted — no polling. */
	awaitNotice(match: string): Promise<string>;
	/** Resolves on the next handleCompactCommand call — no polling. */
	nextCompact(): Promise<{ instructions?: string; mode?: CompactMode }>;
}

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): HostHarness {
	const prompts: { from?: string }[] = [];
	const resets = { count: 0 };
	const compacts: { instructions?: string; mode?: CompactMode }[] = [];
	const notices: string[] = [];
	const streaming = { value: false };
	const promptWaiters: ((details: { from?: string }) => void)[] = [];
	const resetWaiters: (() => void)[] = [];
	const compactWaiters: ((call: { instructions?: string; mode?: CompactMode }) => void)[] = [];
	const noticeWaiters: { match: string; resolve: (message: string) => void }[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			get isStreaming() {
				return streaming.value;
			},
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: (_level: string, message: string) => {
				notices.push(message);
				for (let i = noticeWaiters.length - 1; i >= 0; i--) {
					if (message.includes(noticeWaiters[i].match)) {
						noticeWaiters.splice(i, 1)[0].resolve(message);
					}
				}
			},
			promptCustomMessage: (message: { details?: { from?: string } }) => {
				const details = message.details ?? {};
				prompts.push(details);
				for (const waiter of promptWaiters.splice(0)) waiter(details);
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		handleResetContextCommand: () => {
			resets.count++;
			for (const waiter of resetWaiters.splice(0)) waiter();
			return Promise.resolve();
		},
		handleCompactCommand: (instructions?: string, mode?: CompactMode) => {
			const call = { instructions, mode };
			compacts.push(call);
			for (const waiter of compactWaiters.splice(0)) waiter(call);
			return Promise.resolve("ok");
		},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	const nextPrompt = (): Promise<{ from?: string }> => {
		const { promise, resolve } = Promise.withResolvers<{ from?: string }>();
		promptWaiters.push(resolve);
		return promise;
	};
	const nextReset = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		resetWaiters.push(resolve);
		return promise;
	};
	const nextCompact = (): Promise<{ instructions?: string; mode?: CompactMode }> => {
		const { promise, resolve } = Promise.withResolvers<{ instructions?: string; mode?: CompactMode }>();
		compactWaiters.push(resolve);
		return promise;
	};
	const awaitNotice = (match: string): Promise<string> => {
		const seen = notices.find(message => message.includes(match));
		if (seen !== undefined) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<string>();
		noticeWaiters.push({ match, resolve });
		return promise;
	};
	return { ctx, prompts, resets, compacts, notices, streaming, nextPrompt, nextReset, nextCompact, awaitNotice };
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/** Broadcast frames that interleave nondeterministically with directed replies. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	const welcome = await nextFrame();
	if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
	return { socket, nextFrame };
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHostContext();
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.prompts.length = 0;
	harness.compacts.length = 0;
	harness.notices.length = 0;
	harness.resets.count = 0;
	harness.streaming.value = false;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab guest slash commands", () => {
	it("runs /clear on the host instead of prompting and announces it", async () => {
		const guest = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => guest.socket.close());

		const reset = harness.nextReset();
		guest.socket.send({ t: "prompt", text: "/clear" });
		await reset;
		expect(await harness.awaitNotice("cleared the context")).toBe("writer cleared the context");
		expect(harness.resets.count).toBe(1);
		expect(harness.prompts).toHaveLength(0);
	});

	it("rejects /clear while the agent is streaming", async () => {
		const guest = await joinAsGuest(host.link, "writer-streaming");
		guestCleanups.push(() => guest.socket.close());

		harness.streaming.value = true;
		guest.socket.send({ t: "prompt", text: "/clear" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("/clear");
		expect(harness.resets.count).toBe(0);
		expect(harness.prompts).toHaveLength(0);
	});

	it("runs /compact with mode and focus parsed like the host TUI", async () => {
		const guest = await joinAsGuest(host.link, "compactor");
		guestCleanups.push(() => guest.socket.close());

		const compacted = harness.nextCompact();
		guest.socket.send({ t: "prompt", text: "/compact soft focus on auth" });
		expect(await compacted).toEqual({ instructions: "focus on auth", mode: "soft" });
		expect(harness.prompts).toHaveLength(0);
		expect(harness.notices).toContain("compactor started /compact");
	});

	it("returns the parser error for invalid /compact args", async () => {
		const guest = await joinAsGuest(host.link, "compactor-bad");
		guestCleanups.push(() => guest.socket.close());

		guest.socket.send({ t: "prompt", text: "/compact snapcompact extra focus" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("snapcompact");
		expect(harness.compacts).toHaveLength(0);
	});

	it("still forwards unknown slash text to the model as a prompt", async () => {
		const guest = await joinAsGuest(host.link, "prose");
		guestCleanups.push(() => guest.socket.close());

		const prompted = harness.nextPrompt();
		guest.socket.send({ t: "prompt", text: "/etc/hosts looks broken" });
		expect(await prompted).toEqual({ from: "prose" });
		expect(harness.resets.count).toBe(0);
	});

	it("keeps the read-only rejection ahead of command interception", async () => {
		const guest = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => guest.socket.close());

		guest.socket.send({ t: "prompt", text: "/clear" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("read-only");
		expect(harness.resets.count).toBe(0);
	});
});
