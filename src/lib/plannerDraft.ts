/**
 * The customer's work-in-progress design, kept in the browser.
 *
 * Signing in navigates away from the page — Google's redirect takes the whole
 * document, and with it the R3F scene and every piece of React state. So the
 * layout is written down on every change rather than at the moment we happen
 * to ask for an account. That also survives a refresh, a crash and a closed
 * tab, which no amount of prompting earlier would have.
 *
 * Deliberately NOT in `lib/planner`: that folder is the pure engine Phase 4
 * lifts into Factory Tracker, and `localStorage` is a browser API.
 *
 * Every access is wrapped: in a private window, or with site data blocked,
 * `localStorage` can be absent or throw on touch. A planner that starts empty
 * is the correct outcome there, not a crash.
 */

import { newId } from "@/lib/planner/layout";

const KEY = "ezcabinet.planner.draft";
const VERSION = 1;

export type PlannerDraft = {
	version: typeof VERSION;
	roomId: string;
	finishId: string;
	rooms: Record<string, unknown>;
};

export function saveDraft(draft: PlannerDraft): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(draft));
	} catch {
		// Storage full, blocked, or absent. Nothing to do and nothing to say.
	}
}

export function loadDraft(): PlannerDraft | null {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PlannerDraft>;
		// A draft from a newer build is discarded rather than guessed at: the
		// layout document's own schemaVersion is what makes a *stored* design
		// survive, and this is only a scratchpad.
		if (parsed?.version !== VERSION) return null;
		if (typeof parsed.roomId !== "string") return null;
		if (typeof parsed.finishId !== "string") return null;
		if (!parsed.rooms || typeof parsed.rooms !== "object") return null;
		uniqueIds(parsed.rooms, new Set());
		return parsed as PlannerDraft;
	} catch {
		return null;
	}
}

/**
 * Ids were a counter that restarted at m1 on every page load, so a draft saved
 * then can hold two cabinets sharing an id — which selects, moves and deletes
 * both. Keep each id's first cabinet and re-id the repeats, in place. A
 * cabinet is any object with both an `id` and a `familyId`.
 */
function uniqueIds(node: unknown, seen: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) uniqueIds(item, seen);
		return;
	}
	if (!node || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	if (typeof record.id === "string" && typeof record.familyId === "string") {
		const id = seen.has(record.id) ? newId() : record.id;
		record.id = id;
		seen.add(id);
	}
	for (const value of Object.values(record)) uniqueIds(value, seen);
}

export function clearDraft(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {}
}
