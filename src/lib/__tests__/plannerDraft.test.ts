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
});
