import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "@/lib/planner/catalogue";
import { emptyLayout, plannerEngine } from "@/lib/planner/layout";
import { asRoom } from "@/lib/planner/room";
import { priceOrder } from "../price";
import { summaryExtras, summaryLines } from "../summary";

const catalogue = PLANNER_CATALOGUE;
const kitchen = catalogue.roomTypes.find((r) => r.id === "kitchen");
const base = catalogue.families.find(
	(f) => f.kind === "base" && kitchen?.familyIds.includes(f.id),
);
if (!base) throw new Error("seed catalogue has no kitchen base cabinet");

/** Two base cabinets on a kitchen wall: carcasses, doors and a worktop. */
const order = () => {
	const engine = plannerEngine(catalogue);
	const one = engine.addModule(emptyLayout(4200), base.id, 0);
	const two = engine.addModule(one, base.id, base.sizes[0].widthMm);
	return priceOrder(asRoom(two), catalogue.finishes[0].id, catalogue);
};

describe("order summary", () => {
	it("lists everything charged: its lines add up to the subtotal", () => {
		const { breakdown, cabinetsRm } = order();
		const listed =
			summaryLines(breakdown).reduce((sum, line) => sum + line.amountRm, 0) +
			summaryExtras(breakdown).reduce((sum, line) => sum + line.amountRm, 0);
		expect(listed).toBeCloseTo(cabinetsRm, 2);
	});

	it("adds the worktop but never repeats carcasses or doors", () => {
		const ids = summaryExtras(order().breakdown).map((line) => line.id);
		expect(ids).toContain("worktop");
		expect(ids).not.toContain("carcasses");
		expect(ids).not.toContain("doors");
	});

	it("reads nothing from a breakdown it cannot parse", () => {
		expect(summaryExtras(null)).toEqual([]);
		expect(summaryExtras({ cabinets: [] })).toEqual([]);
	});
});
