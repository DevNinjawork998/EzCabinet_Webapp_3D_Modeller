import { describe, expect, it } from "vitest";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { plannerCatalogueSchema } from "@/lib/planner/catalogueSchema";
import { removeDesign } from "../removeDesign";

/**
 * Taking a cabinet back out of the catalogue.
 *
 * The rung is the easy half. The half that breaks a customer's planner is
 * everything that *points* at the rung: a room's `familyIds`, a starter layout
 * placing that exact width. A dangling reference there is a share link that
 * renders wrong, which is the one failure this project says it cannot have.
 */

const base = (over: Partial<PlannerCatalogue> = {}): PlannerCatalogue =>
	plannerCatalogueSchema.parse({
		families: [
			{
				id: "base-unit",
				label: "Base cabinet",
				kind: "base",
				depthMm: 600,
				heightMm: 870,
				floorHeightMm: 0,
				drawers: 0,
				sizes: [
					{ widthMm: 600, priceRm: 540 },
					{ widthMm: 800, priceRm: 500, meshDesignId: "d-800" },
				],
			},
			{
				id: "wall-unit",
				label: "Wall cabinet",
				kind: "wall",
				depthMm: 350,
				heightMm: 720,
				floorHeightMm: 1500,
				drawers: 0,
				sizes: [{ widthMm: 800, priceRm: 400, meshDesignId: "d-wall" }],
			},
		],
		doorStyles: [
			{
				id: "slab",
				label: "Slab",
				look: "slab",
				priceRmBySizeMm: { "800": 90 },
			},
		],
		doorWidthLadderMm: [600, 800],
		roomTypes: [
			{
				id: "kitchen",
				label: "Kitchen",
				familyIds: ["base-unit", "wall-unit"],
				starter: [
					{ familyId: "base-unit", widthMm: 800 },
					{ familyId: "base-unit", widthMm: 600 },
				],
				defaultWallWidthMm: 3000,
			},
		],
		finishes: [{ id: "oak", label: "Oak", hex: "#c8a678" }],
		...over,
	});

const design = (over = {}) => ({
	familyId: "base-unit",
	widthMm: 800,
	name: "BC 800mm",
	...over,
});

describe("removeDesign", () => {
	it("drops just the rung when the family has other widths", () => {
		const result = removeDesign(base(), design());
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const family = result.catalogue.families.find((f) => f.id === "base-unit");
		expect(family?.sizes.map((s) => s.widthMm)).toEqual([600]);
		expect(result.changes).toContain(
			'Removed the 800mm rung from "Base cabinet"',
		);
		// Still a real catalogue afterwards.
		expect(() => plannerCatalogueSchema.parse(result.catalogue)).not.toThrow();
	});

	it("drops a starter placement that used the removed width", () => {
		const result = removeDesign(base(), design());
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const kitchen = result.catalogue.roomTypes[0];
		expect(kitchen.starter).toEqual([{ familyId: "base-unit", widthMm: 600 }]);
	});

	it("drops the whole family when that was its last rung", () => {
		const result = removeDesign(base(), design({ familyId: "wall-unit" }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.catalogue.families.map((f) => f.id)).toEqual(["base-unit"]);
		// And nothing still points at it.
		expect(result.catalogue.roomTypes[0].familyIds).toEqual(["base-unit"]);
		expect(result.changes).toContain(
			'Removed "Wall cabinet" from the catalogue',
		);
	});

	it("refuses when removing the family would leave a room with nothing", () => {
		const only = base({
			roomTypes: [
				{
					id: "bedroom",
					label: "Bedroom",
					familyIds: ["wall-unit"],
					starter: [],
					defaultWallWidthMm: 3000,
				},
			],
		} as Partial<PlannerCatalogue>);
		const result = removeDesign(only, design({ familyId: "wall-unit" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toMatch(/Bedroom/);
	});

	it("refuses when it would empty the catalogue", () => {
		const one = base({
			families: [base().families[1]],
			roomTypes: [
				{
					id: "kitchen",
					label: "Kitchen",
					familyIds: ["wall-unit"],
					starter: [],
					defaultWallWidthMm: 3000,
				},
			],
		} as Partial<PlannerCatalogue>);
		const result = removeDesign(one, design({ familyId: "wall-unit" }));
		expect(result.ok).toBe(false);
	});

	it("is a no-op when the design was never pushed", () => {
		const catalogue = base();
		const result = removeDesign(catalogue, design({ familyId: null }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBe(false);
		expect(result.catalogue).toBe(catalogue);
	});

	it("is a no-op when the rung is already gone", () => {
		const catalogue = base();
		const result = removeDesign(catalogue, design({ widthMm: 1200 }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBe(false);
	});
});
