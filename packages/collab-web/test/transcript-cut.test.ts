/**
 * Contract: the transcript auto-collapses at the host's latest `/clear`
 * (`reset_boundary` entry). Regression target: joining a long-lived session
 * rendered the entire pre-clear history because the web client ignored reset
 * boundaries entirely.
 */
import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { findResetBoundary, transcriptCutIndex } from "../src/lib/transcript-cut";

let seq = 0;
function user(content: string): SessionEntry {
	seq++;
	return {
		type: "message",
		id: `e${seq}`,
		parentId: seq > 1 ? `e${seq - 1}` : null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	} as SessionEntry;
}
function resetBoundary(): SessionEntry {
	seq++;
	return {
		type: "reset_boundary",
		id: `e${seq}`,
		parentId: `e${seq - 1}`,
		timestamp: new Date().toISOString(),
	};
}

describe("transcript reset-boundary collapse", () => {
	it("hides everything before the latest reset_boundary", () => {
		const entries = [user("old"), user("older"), resetBoundary(), user("fresh")];
		const boundary = findResetBoundary(entries);
		expect(boundary).not.toBeNull();
		const cut = transcriptCutIndex(entries, boundary, null, null);
		expect(cut).toBe(3);
		expect(entries.slice(cut).every(e => e.type !== "reset_boundary")).toBe(true);
	});

	it("collapses at the latest boundary when cleared twice", () => {
		const entries = [user("gen0"), resetBoundary(), user("gen1"), resetBoundary(), user("gen2")];
		const cut = transcriptCutIndex(entries, findResetBoundary(entries), null, null);
		expect(entries.slice(cut).map(e => e.type)).toEqual(["message"]);
	});

	it("shows the full transcript once that boundary is revealed", () => {
		const entries = [user("old"), resetBoundary(), user("fresh")];
		const boundary = findResetBoundary(entries);
		const cut = transcriptCutIndex(entries, boundary, boundary?.id ?? null, null);
		expect(cut).toBe(0);
	});

	it("re-collapses at a NEW boundary even after an older one was revealed", () => {
		const entries = [user("gen0"), resetBoundary(), user("gen1")];
		const revealed = findResetBoundary(entries)?.id ?? null;
		entries.push(resetBoundary(), user("gen2"));
		const cut = transcriptCutIndex(entries, findResetBoundary(entries), revealed, null);
		expect(entries.slice(cut).map(e => e.type)).toEqual(["message"]);
	});

	it("keeps the deeper of boundary cut and the user's manual trim", () => {
		const entries = [user("old"), resetBoundary(), user("a"), user("b")];
		const manualId = entries[3].id;
		const cut = transcriptCutIndex(entries, findResetBoundary(entries), null, manualId);
		expect(cut).toBe(3);
	});

	it("is a no-op without any boundary", () => {
		const entries = [user("a"), user("b")];
		expect(findResetBoundary(entries)).toBeNull();
		expect(transcriptCutIndex(entries, null, null, null)).toBe(0);
	});
});
