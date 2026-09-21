import { describe, expect, it } from "vitest";
import {
	CONSTRUCTION,
	constructionOf,
	defaultWidthMmIn,
	familyIn,
	isCorner,
	PLANNER_CATALOGUE,
	RATES,
	ratesOf,
	roomTypeIn,
	WALL_COLOURS,
	wallColoursOf,
	wallHexOf,
} from "../catalogue";
import { familySchema, plannerCatalogueSchema } from "../catalogueSchema";

describe("the seed catalogue is one consistent document", () => {
	it("satisfies its own schema", () => {
		expect(() => plannerCatalogueSchema.parse(PLANNER_CATALOGUE)).not.toThrow();
	});

	it("prices every door on every rung of the ladder", () => {
		for (const style of PLANNER_CATALOGUE.doorStyles) {
			for (const mm of PLANNER_CATALOGUE.doorWidthLadderMm) {
				expect(style.priceRmBySizeMm[String(mm)]).toBeGreaterThan(0);
			}
		}
	});

	it("carries every family its rooms name", () => {
		const ids = new Set(PLANNER_CATALOGUE.families.map((f) => f.id));
		for (const room of PLANNER_CATALOGUE.roomTypes) {
			for (const id of room.familyIds) expect(ids.has(id)).toBe(true);
		}
	});
});

describe("familyIn", () => {
	it("finds a family in the catalogue passed in", () => {
		expect(familyIn(PLANNER_CATALOGUE, "base-cabinet")?.kind).toBe("base");
	});

	it("is undefined for a family the catalogue does not carry", () => {
		expect(familyIn(PLANNER_CATALOGUE, "no-such-family")).toBeUndefined();
	});

	it("reads the catalogue given, not the seed", () => {
		const trimmed = {
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.filter(
				(f) => f.id !== "base-cabinet",
			),
		};
		expect(familyIn(trimmed, "base-cabinet")).toBeUndefined();
	});
});

describe("roomTypeIn", () => {
	it("finds a room", () => {
		expect(roomTypeIn(PLANNER_CATALOGUE, "kitchen").label).toBe("Kitchen");
	});

	it("throws on a room the catalogue does not carry", () => {
		const trimmed = {
			...PLANNER_CATALOGUE,
			roomTypes: PLANNER_CATALOGUE.roomTypes.filter((r) => r.id !== "foyer"),
		};
		expect(() => roomTypeIn(trimmed, "foyer")).toThrow(/foyer/);
	});
});

describe("defaultWidthMmIn", () => {
	it("takes the middle rung of the ladder", () => {
		const sizes = familyIn(PLANNER_CATALOGUE, "base-cabinet")?.sizes ?? [];
		expect(defaultWidthMmIn(PLANNER_CATALOGUE, "base-cabinet")).toBe(
			sizes[Math.floor(sizes.length / 2)].widthMm,
		);
	});

	it("falls back to 600 for an unknown family", () => {
		expect(defaultWidthMmIn(PLANNER_CATALOGUE, "no-such-family")).toBe(600);
	});
});

describe("constructionOf", () => {
	it("is the seed when the catalogue overrides nothing", () => {
		expect(constructionOf(PLANNER_CATALOGUE)).toEqual(CONSTRUCTION);
	});

	it("takes the catalogue's own board thickness", () => {
		const thick = {
			...PLANNER_CATALOGUE,
			construction: { ...CONSTRUCTION, panelThicknessMm: 18 },
		};
		expect(constructionOf(thick).panelThicknessMm).toBe(18);
	});

	it("does not mutate the seed", () => {
		constructionOf({
			...PLANNER_CATALOGUE,
			construction: { ...CONSTRUCTION, panelThicknessMm: 18 },
		});
		expect(CONSTRUCTION.panelThicknessMm).toBe(16);
	});
});

describe("ratesOf", () => {
	it("is the seed when the catalogue carries no rates", () => {
		expect(ratesOf(PLANNER_CATALOGUE)).toEqual(RATES);
	});

	it("takes the catalogue's worktop rate", () => {
		const priced = {
			...PLANNER_CATALOGUE,
			rates: { worktopRmPerFt: 275 },
		};
		expect(ratesOf(priced).worktopRmPerFt).toBe(275);
	});

	/** `rates` has one required key and five optional ones, so a real published
	 * catalogue routinely omits some. Absent must mean "keep the fallback",
	 * never "undefined". */
	it("keeps the fallback for the rates a catalogue omits", () => {
		const partial = {
			...PLANNER_CATALOGUE,
			rates: { worktopRmPerFt: 275 },
		};
		expect(ratesOf(partial).skirtingRmPerFt).toBe(RATES.skirtingRmPerFt);
		expect(ratesOf(partial).endPanelTallRm).toBe(RATES.endPanelTallRm);
	});

	it("does not mutate the seed", () => {
		ratesOf({ ...PLANNER_CATALOGUE, rates: { worktopRmPerFt: 275 } });
		expect(RATES.worktopRmPerFt).toBe(200);
	});
});

describe("isCorner", () => {
	it("recognises the two corner categories and nothing else", () => {
		expect(isCorner({ category: "CORNER_BASE_CABINET" })).toBe(true);
		expect(isCorner({ category: "CORNER_WALL_CABINET" })).toBe(true);
		expect(isCorner({ category: "BASE_CABINET" })).toBe(false);
		expect(isCorner({ category: undefined })).toBe(false);
	});

	it("parses a family filed under a corner category", () => {
		const corner = PLANNER_CATALOGUE.families.find(
			(family) => family.id === "base-cabinet",
		);
		if (!corner) throw new Error("seed lost base-cabinet");
		expect(
			familySchema.safeParse({ ...corner, category: "CORNER_BASE_CABINET" })
				.success,
		).toBe(true);
	});
});

describe("wallColoursOf", () => {
	it("is the seed when the catalogue carries no palette", () => {
		expect(wallColoursOf(PLANNER_CATALOGUE)).toEqual(WALL_COLOURS);
	});

	it("takes the catalogue's own palette", () => {
		const own = [{ id: "x", label: "X", hex: "#010203" }];
		expect(wallColoursOf({ ...PLANNER_CATALOGUE, wallColours: own })).toEqual(
			own,
		);
	});

	it("hands back a copy, so a caller cannot mutate the seed", () => {
		wallColoursOf(PLANNER_CATALOGUE).push({
			id: "junk",
			label: "Junk",
			hex: "#000000",
		});
		expect(wallColoursOf(PLANNER_CATALOGUE)).toEqual(WALL_COLOURS);
	});

	it("keeps an empty palette empty rather than filling it", () => {
		// An admin who deletes every colour means it, and the fallback must not
		// resurrect the seed behind their back.
		expect(wallColoursOf({ ...PLANNER_CATALOGUE, wallColours: [] })).toEqual(
			[],
		);
	});
});

describe("wallHexOf", () => {
	it("resolves a palette id to its hex", () => {
		const first = WALL_COLOURS[0];
		expect(wallHexOf(first.id, PLANNER_CATALOGUE)).toBe(first.hex);
	});

	it("passes a custom hex straight through", () => {
		expect(wallHexOf("#a8b3a0", PLANNER_CATALOGUE)).toBe("#a8b3a0");
		expect(wallHexOf("#A8B3A0", PLANNER_CATALOGUE)).toBe("#A8B3A0");
	});

	it("reads an unpainted wall as null", () => {
		expect(wallHexOf(null, PLANNER_CATALOGUE)).toBeNull();
		expect(wallHexOf("", PLANNER_CATALOGUE)).toBeNull();
	});

	it("reads a retired palette id as unpainted, never as a wrong colour", () => {
		expect(
			wallHexOf("wall-colour-the-admin-deleted", PLANNER_CATALOGUE),
		).toBeNull();
	});

	it("refuses junk rather than handing it to three.js", () => {
		// A stored value is only ever an id or a hex. Anything else is a
		// tampered document, and an unpainted wall is the safe reading.
		for (const junk of ["#fff", "#gggggg", "red", "javascript:alert(1)"]) {
			expect(wallHexOf(junk, PLANNER_CATALOGUE)).toBeNull();
		}
	});

	it("prefers the catalogue's palette over the seed", () => {
		const own = [{ id: "wall-white-dove", label: "Repainted", hex: "#123456" }];
		expect(
			wallHexOf("wall-white-dove", { ...PLANNER_CATALOGUE, wallColours: own }),
		).toBe("#123456");
	});
});
