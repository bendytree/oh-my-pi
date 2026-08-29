/**
 * Contract: `snapshotForReplication()` starts at the last `/clear` boundary on
 * the live path. Guests joining a long-lived session must not download the
 * pre-clear history (minutes through the relay for multi-MB sessions); the
 * full history stays on disk for exports and resumes.
 */
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function appendUser(manager: SessionManager, content: string): string {
	return manager.appendMessage({ role: "user", content, timestamp: Date.now() });
}

describe("collab snapshotForReplication reset-boundary slice", () => {
	it("replicates only the boundary and post-clear entries after /clear", () => {
		const manager = SessionManager.inMemory();
		appendUser(manager, "old one");
		appendUser(manager, "old two");
		const boundaryId = manager.appendResetBoundary();
		appendUser(manager, "fresh one");
		appendUser(manager, "fresh two");

		const snapshot = manager.snapshotForReplication();
		expect(snapshot.entries.map(entry => entry.id)).toEqual([
			boundaryId,
			...manager
				.getBranch()
				.slice(-2)
				.map(entry => entry.id),
		]);
		expect(snapshot.entries[0]?.type).toBe("reset_boundary");
		expect(
			snapshot.entries.some(
				entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "old one",
			),
		).toBe(false);
	});

	it("slices at the latest boundary when the session was cleared twice", () => {
		const manager = SessionManager.inMemory();
		appendUser(manager, "gen0");
		manager.appendResetBoundary();
		appendUser(manager, "gen1");
		const lastBoundaryId = manager.appendResetBoundary();
		appendUser(manager, "gen2");

		const snapshot = manager.snapshotForReplication();
		expect(snapshot.entries[0]?.id).toBe(lastBoundaryId);
		expect(snapshot.entries).toHaveLength(2);
	});

	it("replicates everything when the live path branched back before the clear", () => {
		const manager = SessionManager.inMemory();
		const preClearId = appendUser(manager, "old one");
		manager.appendResetBoundary();
		appendUser(manager, "fresh one");
		manager.branch(preClearId);

		const snapshot = manager.snapshotForReplication();
		// No boundary on the live path: the guest needs the full tree.
		expect(snapshot.entries).toHaveLength(3);
	});

	it("returns deep copies, not live entry references", () => {
		const manager = SessionManager.inMemory();
		appendUser(manager, "only");
		const snapshot = manager.snapshotForReplication();
		const entry = snapshot.entries[0];
		expect(entry).toBeDefined();
		expect(entry).not.toBe(manager.getBranch()[0]);
	});
});
