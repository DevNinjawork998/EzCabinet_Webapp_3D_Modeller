import { describe, expect, it } from "vitest";
import { nextStage, STAGES, stageReached, stageRefusal } from "../stage";

describe("production stages", () => {
	it("runs in factory order", () => {
		expect(STAGES).toEqual([
			"MEASURE",
			"CUTTING",
			"EDGING",
			"ASSEMBLY",
			"QC",
			"READY",
		]);
	});

	it("starts at MEASURE and stops after READY", () => {
		expect(nextStage(null)).toBe("MEASURE");
		expect(nextStage("QC")).toBe("READY");
		expect(nextStage("READY")).toBeNull();
	});

	it("allows exactly the next stage of a paid order", () => {
		expect(
			stageRefusal({ status: "PAID", productionStage: "CUTTING" }, "EDGING"),
		).toBeNull();
	});

	it("refuses an unpaid order", () => {
		expect(
			stageRefusal(
				{ status: "AWAITING_PAYMENT", productionStage: null },
				"MEASURE",
			),
		).toBe("not_paid");
	});

	it("refuses a skipped, repeated or backward step", () => {
		const order = { status: "PAID", productionStage: "CUTTING" as const };
		expect(stageRefusal(order, "ASSEMBLY")).toBe("not_next_stage");
		expect(stageRefusal(order, "CUTTING")).toBe("not_next_stage");
		expect(stageRefusal(order, "MEASURE")).toBe("not_next_stage");
	});

	it("marks every stage up to the current one as reached", () => {
		expect(stageReached(null, "MEASURE")).toBe(false);
		expect(stageReached("EDGING", "CUTTING")).toBe(true);
		expect(stageReached("EDGING", "EDGING")).toBe(true);
		expect(stageReached("EDGING", "ASSEMBLY")).toBe(false);
	});
});
