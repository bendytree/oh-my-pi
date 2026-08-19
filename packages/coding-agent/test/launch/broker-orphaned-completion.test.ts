// Integration test — real broker over the unix-socket RPC (same rationale as
// broker-idle-shutdown.test.ts). Guards the orphaned-completion deadlock: a
// detached daemon's completion notification is ackable only by the owning
// process's subscription id (minted per process), so once that process is gone
// — the reboot case — nothing can ever ack it. `start` must reuse the name
// then; it may refuse only while the owner still holds a live connection.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, idleGraceMs: number): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

const spec = (name: string, cwd: string) => ({
	name,
	application: process.execPath,
	args: ["-e", ""],
	env: {},
	cwd,
	pty: false,
	restart: "no" as const,
	persist: false,
	detached: true,
});

describe("daemon broker orphaned completion notifications", () => {
	it("blocks start while the owner connection is live, frees the name once it is gone", async () => {
		using tempDir = TempDir.createSync("@omp-launch-orphan-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const clientA = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
		const broker = startBroker(projectDir, runtimeDir, 60_000);
		try {
			// Owner sink that never resolves: the client acks only after the sink
			// settles, so the completion stays pending while clientA is connected.
			clientA.onCompletion("sess-owner", () => new Promise<never>(() => {}));

			const started = await clientA.request({ op: "start", spec: spec("jam", projectDir), owner: "sess-owner" });

			// The daemon self-exits immediately; its terminal settlement files the
			// completion notification for sess-owner.
			const waited = await clientA.request({ op: "wait", name: "jam", for: "exit", timeoutMs: 10_000 });
			if (waited.op !== "wait") throw new Error("expected wait result");
			expect(waited.timedOut).toBe(false);

			// Owner still connected and unacked: the name must stay blocked.
			await expect(clientA.request({ op: "start", spec: spec("jam", projectDir) })).rejects.toThrow(
				/unacknowledged completion notifications/,
			);

			// Owner goes away without unsubscribing — the reboot shape: nobody can
			// ever ack. A fresh client (new subscription id) must be able to reuse
			// the name instead of hitting the error forever.
			clientA.close();
			const clientB = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
			try {
				// clientA's FIN races clientB's request on separate connections;
				// retry until the broker has pruned the dead owner socket. Before
				// the fix this never succeeds and the deadline fails the test.
				const deadline = Date.now() + 10_000;
				for (;;) {
					try {
						const restarted = await clientB.request({ op: "start", spec: spec("jam", projectDir) });
						expect(restarted.op).toBe("start");
						break;
					} catch (error) {
						if (Date.now() >= deadline) throw error;
						await new Promise(resolve => setTimeout(resolve, 50));
					}
				}
			} finally {
				await clientB.request({ op: "shutdown" }).catch(() => {});
				clientB.close();
			}
		} finally {
			process.title = previousTitle;
		}
		await broker;
	}, 30_000);
});
