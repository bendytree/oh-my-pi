import type { SessionEntry } from "@oh-my-pi/pi-wire";

/** Last host `/clear` boundary in the transcript, if any. */
export interface ResetBoundary {
	id: string;
	/** Index of the first entry after the boundary. */
	cut: number;
}

/** Find the latest `reset_boundary` entry (hosts append one per `/clear`). */
export function findResetBoundary(entries: readonly SessionEntry[]): ResetBoundary | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "reset_boundary") return { id: entry.id, cut: i + 1 };
	}
	return null;
}

/**
 * First visible entry index: auto-collapses at the host's latest `/clear`
 * (unless that boundary was explicitly revealed) and applies the user's
 * manual local trim, whichever hides more.
 */
export function transcriptCutIndex(
	entries: readonly SessionEntry[],
	boundary: ResetBoundary | null,
	revealedBoundaryId: string | null,
	clearCutoffId: string | null,
): number {
	let cut = boundary !== null && boundary.id !== revealedBoundaryId ? boundary.cut : 0;
	if (clearCutoffId !== null) {
		const i = entries.findIndex(entry => entry.id === clearCutoffId);
		if (i > cut) cut = i;
	}
	return cut;
}
