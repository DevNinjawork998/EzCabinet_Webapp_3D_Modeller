import { describe, expect, it } from "vitest";
import {
	PLANNER_CATALOGUE,
	WALL_CABINET_FLOOR_MM,
} from "@/lib/planner/catalogue";
import { plannerCatalogueSchema } from "@/lib/planner/catalogueSchema";
import { buildCatalogue, type DesignRow } from "../buildCatalogue";

const GEOMETRY = {
	shelves: 1,
	fixedShelves: 0,
	doorLeaves: 2,
	drawers: 0,
	hasBack: true,
	legs: 4,
	legHeightMm: 100,
	legDiameterMm: 57,
	legInsetMm: 17,
};

const design = (over: Partial<DesignRow> = {}): DesignRow => ({
	id: "bc-800",
	name: "BC 800mm",
	category: "BASE_CABINET",
	rooms: ["KITCHEN"],
	widthMm: 800,
	heightMm: 870,
	depthMm: 588,
	priceRm: 680,
	status: "PUBLISHED",
	meshPathname: "cabinet-mesh/bc-800/abc.icbmesh",
	geometry: GEOMETRY,
	...over,
});

const room = (catalogue: ReturnType<typeof buildCatalogue>, id: string) =>
	catalogue.roomTypes.find((r) => r.id === id)?.familyIds;

describe("buildCatalogue", () => {
	it("turns one design into one cabinet with the row's own price and box", () => {
		const built = buildCatalogue([design()], PLANNER_CATALOGUE);

		expect(built.families).toEqual([
			{
				id: "bc-800",
				label: "BC 800mm",
				category: "BASE_CABINET",
				kind: "base",
				depthMm: 588,
				heightMm: 870,
				floorHeightMm: 0,
				sizes: [{ widthMm: 800, priceRm: 680, meshDesignId: "bc-800" }],
				drawers: 0,
				geometry: GEOMETRY,
			},
		]);
	});

	it("carries a weighed design's weight onto its size, and none otherwise", () => {
		const built = buildCatalogue(
			[design({ weightKg: 38.5 }), design({ id: "bc-600", widthMm: 600 })],
			PLANNER_CATALOGUE,
		);

		expect(built.families.map((f) => f.sizes[0].weightKg)).toEqual([
			undefined,
			38.5,
		]);
		// Built and parsed cabinets agree, key order included — the page compares
		// them as JSON, so a misplaced `weightKg` would read as an unpublished edit.
		expect(JSON.stringify(plannerCatalogueSchema.parse(built).families)).toBe(
			JSON.stringify(built.families),
		);
	});

	it("keeps three widths of one cabinet as three separate cabinets", () => {
		const built = buildCatalogue(
			[
				design({ id: "bc-900", name: "BC 900mm", widthMm: 900, priceRm: 720 }),
				design({ id: "bc-600", name: "BC 600mm", widthMm: 600, priceRm: 540 }),
				design(),
			],
			PLANNER_CATALOGUE,
		);

		expect(built.families.map((f) => [f.id, f.sizes])).toEqual([
			["bc-600", [{ widthMm: 600, priceRm: 540, meshDesignId: "bc-600" }]],
			["bc-800", [{ widthMm: 800, priceRm: 680, meshDesignId: "bc-800" }]],
			["bc-900", [{ widthMm: 900, priceRm: 720, meshDesignId: "bc-900" }]],
		]);
	});

	it("points at a mesh only when the design converted to one", () => {
		const built = buildCatalogue(
			[design({ meshPathname: null })],
			PLANNER_CATALOGUE,
		);

		expect(built.families[0].sizes[0]).toEqual({ widthMm: 800, priceRm: 680 });
	});

	it("offers a design in every room it is filed under, and nowhere else", () => {
		const built = buildCatalogue(
			[design({ rooms: ["KITCHEN", "LIVING_ROOM"] })],
			PLANNER_CATALOGUE,
		);

		expect(room(built, "kitchen")).toEqual(["bc-800"]);
		expect(room(built, "living")).toEqual(["bc-800"]);
		expect(room(built, "bedroom")).toEqual([]);
		expect(room(built, "foyer")).toEqual([]);
	});

	it("leaves archived designs out of the catalogue and every room", () => {
		const built = buildCatalogue(
			[design({ status: "ARCHIVED" })],
			PLANNER_CATALOGUE,
		);

		expect(built.families).toEqual([]);
		expect(room(built, "kitchen")).toEqual([]);
	});

	it("hangs a wall unit and takes its kind from the category", () => {
		const built = buildCatalogue(
			[
				design({ category: "FRIDGE_HOUSING" }),
				design({ id: "wc", category: "WALL_CABINET" }),
			],
			PLANNER_CATALOGUE,
		);

		const byId = new Map(built.families.map((f) => [f.id, f]));
		expect(byId.get("wc")?.kind).toBe("wall");
		expect(byId.get("wc")?.floorHeightMm).toBe(WALL_CABINET_FLOOR_MM);
		expect(byId.get("bc-800")?.kind).toBe("tall");
		expect(byId.get("bc-800")?.floorHeightMm).toBe(0);
	});

	it("orders cabinets by category, then width", () => {
		const built = buildCatalogue(
			[
				design({ id: "wall", category: "WALL_CABINET", widthMm: 400 }),
				design({ id: "base-900", widthMm: 900 }),
				design({ id: "base-600", widthMm: 600 }),
			],
			PLANNER_CATALOGUE,
		);

		expect(built.families.map((f) => f.id)).toEqual([
			"base-600",
			"base-900",
			"wall",
		]);
	});

	it("drops geometry that is not a valid fit-out rather than trusting it", () => {
		const built = buildCatalogue(
			[design({ geometry: { shelves: "lots" } })],
			PLANNER_CATALOGUE,
		);

		expect(built.families[0].geometry).toBeUndefined();
		expect(built.families[0].drawers).toBe(0);
	});

	it("takes the drawer count from the design's fit-out", () => {
		const built = buildCatalogue(
			[
				design({
					category: "DRAWER_BASE",
					geometry: { ...GEOMETRY, drawers: 3 },
				}),
			],
			PLANNER_CATALOGUE,
		);

		expect(built.families[0].drawers).toBe(3);
	});

	it("replaces every seed family and carries the settings through", () => {
		const built = buildCatalogue([design()], PLANNER_CATALOGUE);

		expect(built.families.map((f) => f.id)).toEqual(["bc-800"]);
		expect(built.doorStyles).toEqual(PLANNER_CATALOGUE.doorStyles);
		expect(built.doorWidthLadderMm).toEqual(
			PLANNER_CATALOGUE.doorWidthLadderMm,
		);
		expect(built.finishes).toEqual(PLANNER_CATALOGUE.finishes);
		expect(built.roomTypes.map((r) => r.defaultWallWidthMm)).toEqual(
			PLANNER_CATALOGUE.roomTypes.map((r) => r.defaultWallWidthMm),
		);
	});

	it("builds a valid catalogue from a library with nothing in it yet", () => {
		const built = plannerCatalogueSchema.parse(
			buildCatalogue([], PLANNER_CATALOGUE),
		);

		expect(built.families).toEqual([]);
		expect(built.roomTypes.every((r) => r.familyIds.length === 0)).toBe(true);
	});

	it("builds a catalogue that round-trips its own schema", () => {
		const built = buildCatalogue([design()], PLANNER_CATALOGUE);

		expect(plannerCatalogueSchema.parse(built).families).toEqual(
			built.families,
		);
	});
});
