import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearDraft,
	loadDraft,
	type PlannerDraft,
	saveDraft,
} from "@/lib/plannerDraft";

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k) => map.get(k) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (k) => void map.delete(k),
		setItem: (k, v) => void map.set(k, v),
	} as Storage;
}

const draft: PlannerDraft = {
	version: 1,
	roomId: "kitchen",
	finishId: "oak",
	rooms: { kitchen: { runs: [] } },
};

beforeEach(() => {
	vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("plannerDraft", () => {
	it("round-trips a draft", () => {
		saveDraft(draft);
		expect(loadDraft()).toEqual(draft);
	});

	it("returns null when nothing is stored", () => {
		expect(loadDraft()).toBeNull();
	});

	it("returns null on corrupt JSON rather than throwing", () => {
		localStorage.setItem("ezcabinet.planner.draft", "{not json");
		expect(loadDraft()).toBeNull();
	});

	it("returns null on a draft written by a future version", () => {
		localStorage.setItem(
			"ezcabinet.planner.draft",
			JSON.stringify({ ...draft, version: 99 }),
		);
		expect(loadDraft()).toBeNull();
	});

	it("survives a storage that throws on write", () => {
		vi.stubGlobal("localStorage", {
			...memoryStorage(),
			setItem: () => {
				throw new DOMException("QuotaExceededError");
			},
		} as Storage);
		expect(() => saveDraft(draft)).not.toThrow();
	});

	it("survives a storage that throws on read", () => {
		vi.stubGlobal("localStorage", {
			...memoryStorage(),
			getItem: () => {
				throw new DOMException("SecurityError");
			},
		} as Storage);
		expect(loadDraft()).toBeNull();
	});

	it("clears", () => {
		saveDraft(draft);
		clearDraft();
		expect(loadDraft()).toBeNull();
	});

	it("returns null when rooms is not an object", () => {
		for (const rooms of ["kitchen", 42, null, true]) {
			localStorage.setItem(
				"ezcabinet.planner.draft",
				JSON.stringify({ ...draft, rooms }),
			);
			expect(loadDraft()).toBeNull();
		}
	});

	it("returns null when roomId or finishId is not a string", () => {
		localStorage.setItem(
			"ezcabinet.planner.draft",
			JSON.stringify({ ...draft, roomId: 7 }),
		);
		expect(loadDraft()).toBeNull();
		localStorage.setItem(
			"ezcabinet.planner.draft",
			JSON.stringify({ ...draft, finishId: null }),
		);
		expect(loadDraft()).toBeNull();
	});

	// Drafts saved before ids were random can hold two cabinets sharing one.
	it("gives a repeated cabinet id a fresh one, keeping the first", () => {
		const cab = (id: string, xMm: number) => ({ id, familyId: "bc", xMm });
		saveDraft({
			...draft,
			rooms: {
				kitchen: {
					runs: [
						{ floor: [cab("m1", 0), cab("m2", 600)], wall: [cab("m1", 0)] },
					],
					free: [cab("m2", 900)],
				},
			},
		});
		const kitchen = loadDraft()?.rooms.kitchen as {
			runs: { floor: { id: string }[]; wall: { id: string }[] }[];
			free: { id: string }[];
		};
		const ids = [
			...kitchen.runs[0].floor,
			...kitchen.runs[0].wall,
			...kitchen.free,
		].map((m) => m.id);
		expect(ids.slice(0, 2)).toEqual(["m1", "m2"]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
