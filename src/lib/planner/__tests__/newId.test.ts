import { describe, expect, it, vi } from "vitest";

describe("newId", () => {
	// A page reload re-evaluates the module, and the restored draft still holds
	// the ids handed out before it. A fresh module must never hand them out again.
	it("does not repeat an id after the module is reloaded", async () => {
		const before = (await import("@/lib/planner/layout")).newId();
		vi.resetModules();
		const after = (await import("@/lib/planner/layout")).newId();
		expect(after).not.toBe(before);
	});

	it("fits the stored layout's id limit", async () => {
		const { newId } = await import("@/lib/planner/layout");
		expect(newId().length).toBeLessThanOrEqual(64);
	});
});
