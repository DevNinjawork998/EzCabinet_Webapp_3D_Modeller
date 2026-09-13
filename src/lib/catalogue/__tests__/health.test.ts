import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { blockersOf, strandedFamilyIds } from "../health";

/** Deep clone so a test can mutate without touching the live constant. */
const clone = (c: PlannerCatalogue): PlannerCatalogue =>
	JSON.parse(JSON.stringify(c));

describe("blockersOf", () => {
	it("finds nothing in a catalogue where every rung is priced", () => {
		expect(blockersOf(PLANNER_CATALOGUE)).toEqual([]);
	});

	it("reports a rung priced at zero", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].sizes[0].priceRm = 0;

		expect(blockersOf(next)).toEqual([
			{
				familyId: next.families[0].id,
				familyLabel: next.families[0].label,
				widthMm: next.families[0].sizes[0].widthMm,
				familyIndex: 0,
				sizeIndex: 0,
				meshDesignId: next.families[0].sizes[0].meshDesignId,
			},
		]);
	});

	it("reports every unpriced rung, in family then ladder order", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[1].sizes[0].priceRm = 0;
		next.families[0].sizes[1].priceRm = 0;

		expect(blockersOf(next).map((b) => b.widthMm)).toEqual([
			next.families[0].sizes[1].widthMm,
			next.families[1].sizes[0].widthMm,
		]);
	});

	it("treats a negative price as unpriced too", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].sizes[0].priceRm = -10;

		expect(blockersOf(next)).toHaveLength(1);
	});

	it("ignores an unpriced rung in a family no room offers", () => {
		// The retire path this branch added is "untick every room", and the
		// publish gate is catalogue-wide. A retired family that can still block
		// every publish bricks the screen over a cabinet no customer can see —
		// which is `Testing123`'s state in the live catalogue today.
		const next = clone(PLANNER_CATALOGUE);
		const family = next.families[0];
		family.sizes[0].priceRm = 0;
		for (const room of next.roomTypes) {
			room.familyIds = room.familyIds.filter((id) => id !== family.id);
		}

		expect(blockersOf(next)).toEqual([]);

		// Offer it again and the same rung blocks, because now it can be sold.
		next.roomTypes[0].familyIds.push(family.id);
		expect(blockersOf(next)).toHaveLength(1);
	});

	it("keeps two same-width sizes in one family distinct by index", () => {
		const next = clone(PLANNER_CATALOGUE);
		const family = next.families[0];
		const dupeWidth = family.sizes[0].widthMm;
		family.sizes[0].priceRm = 0;
		family.sizes.push({
			...family.sizes[0],
			widthMm: dupeWidth,
			priceRm: 0,
		});

		const result = blockersOf(next).filter(
			(b) => b.familyIndex === 0 && b.widthMm === dupeWidth,
		);
		expect(result).toHaveLength(2);
		expect(result.map((b) => b.sizeIndex)).toEqual([
			0,
			family.sizes.length - 1,
		]);
		expect(result[0].sizeIndex).not.toBe(result[1].sizeIndex);
	});
});

describe("strandedFamilyIds", () => {
	it("finds nothing when every family is offered by a room", () => {
		expect(strandedFamilyIds(PLANNER_CATALOGUE)).toEqual([]);
	});

	it("names a family no room offers", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families.push({
			...PLANNER_CATALOGUE.families[0],
			id: "test-orphan",
			label: "Testing123",
		});

		expect(strandedFamilyIds(next)).toEqual(["test-orphan"]);
	});

	it("does not report a family offered by only one room", () => {
		const next = clone(PLANNER_CATALOGUE);
		const id = next.families[0].id;
		for (const room of next.roomTypes) {
			room.familyIds = room.familyIds.filter((f) => f !== id);
		}
		next.roomTypes[0].familyIds.push(id);

		expect(strandedFamilyIds(next)).toEqual([]);
	});
});
