import { describe, expect, it } from "vitest";
import {
	doorPriceRmIn,
	PLANNER_CATALOGUE,
	RATES,
	sizePriceRmIn,
} from "../catalogue";
import { plannerCatalogueSchema } from "../catalogueSchema";
import {
	emptyLayout,
	type PlannerLayout,
	plannerEngine,
	setDoor,
} from "../layout";
import { furnished } from "./furnished";

const engine = plannerEngine(PLANNER_CATALOGUE);
const {
	addModule,
	removeModule,
	setBaseSkirting,
	setHangAt,
	setRotation,
	setWallToCeiling,
	setWallWidth,
	setWidth,
} = engine;

import type { PlannerCatalogue } from "../catalogueSchema";
import {
	MM_PER_FT,
	ceilingTrimFt as roomCeilingTrimFt,
	endPanelPriceRm as roomEndPanelPriceRm,
	computePlannerPrice as roomPrice,
	skirtingFt as roomSkirtingFt,
	worktopFt as roomWorktopFt,
	WORKTOP_RM_PER_FT,
} from "../pricing";
import { asRoom, emptyRoom, roomEngine } from "../room";

/** These tests were written against one wall; a straight room is one run. */
const worktopFt = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomWorktopFt(asRoom(l), c);
const ceilingTrimFt = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomCeilingTrimFt(asRoom(l), c);
const skirtingFt = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomSkirtingFt(asRoom(l), c);
const endPanelPriceRm = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomEndPanelPriceRm(asRoom(l), c);
const computePlannerPrice = (
	l: PlannerLayout,
	f: Parameters<typeof roomPrice>[1],
	c: PlannerCatalogue,
) => roomPrice(asRoom(l), f, c);

const WALL_MM = 6000;
const empty = () => emptyLayout(WALL_MM);

const run = () => {
	let next = empty();
	next = addModule(next, "base-cabinet", 0, "b1", 900);
	next = addModule(next, "base-drawers", 900, "b2", 400);
	next = addModule(next, "tall-cabinet", 1300, "t1", 600);
	next = addModule(next, "wall-cabinet", 0, "w1", 900);
	return next;
};

/** These tests price against the bundled seed. Named so a reader can see at a
 * glance which catalogue a figure came from — the whole point of the
 * parameter. */
const price = (layout: PlannerLayout, finish = "white") =>
	computePlannerPrice(layout, finish, PLANNER_CATALOGUE);

describe("per-unit pricing", () => {
	it("prices an empty room at nothing", () => {
		const result = price(empty());
		expect(result.totalRm).toBe(0);
		expect(result.cabinets).toEqual([]);
	});

	it("charges each carcass its own size's price", () => {
		const result = price(run());
		const line = result.cabinets.find((l) => l.id === "b1");
		expect(line?.carcassRm).toBe(
			sizePriceRmIn(PLANNER_CATALOGUE, "base-cabinet", 900),
		);
	});

	it("re-prices when the size changes", () => {
		const before = price(run()).totalRm;
		const wider = setWidth(run(), "b1", 900);
		expect(price(wider).totalRm).toBe(before);

		const narrower = setWidth(run(), "b1", 600);
		expect(price(narrower).totalRm).toBeLessThan(before);
	});

	it("charges nothing for a cabinet whose door was taken off", () => {
		// A placed cabinet arrives wearing the base style now; a layout saved
		// before that, or one with its fronts removed, still prices with none.
		const doored = run();
		const bare = price(
			[...doored.floor, ...doored.wall].reduce(
				(layout, placed) => setDoor(layout, placed.id, null),
				doored,
			),
		);
		expect(bare.cabinets.every((line) => line.doorRm === 0)).toBe(true);
		const doors = bare.categories.find((line) => line.id === "doors");
		expect(doors?.amountRm).toBe(0);
		expect(doors?.detail).toEqual({ key: "noDoors" });
	});

	it("adds the door's own price once it is put on", () => {
		const doored = setDoor(run(), "b1", "shaker");
		const result = price(doored);
		const line = result.cabinets.find((l) => l.id === "b1");

		expect(line?.doorRm).toBe(doorPriceRmIn(PLANNER_CATALOGUE, "shaker", 900));
		expect(line?.doorLabel).toBe("Shaker");
		expect(line?.amountRm).toBe(
			sizePriceRmIn(PLANNER_CATALOGUE, "base-cabinet", 900) +
				doorPriceRmIn(PLANNER_CATALOGUE, "shaker", 900),
		);
	});

	it("prices a dearer door style above a plainer one", () => {
		const slab = price(setDoor(run(), "b1", "slab"));
		const glass = price(setDoor(run(), "b1", "glass"));
		expect(glass.totalRm).toBeGreaterThan(slab.totalRm);
	});

	it("totals the categories, and they total the lines", () => {
		const result = price(setDoor(run(), "b1", "slab"));
		const lines = result.cabinets.reduce((sum, l) => sum + l.amountRm, 0);
		const perCabinet = result.categories.filter(
			(c) => c.id === "carcasses" || c.id === "doors",
		);
		const byLength = result.categories.filter(
			(c) => c.id !== "carcasses" && c.id !== "doors",
		);
		const sum = (of: typeof result.categories) =>
			of.reduce((total, c) => total + c.amountRm, 0);

		// The two per-cabinet categories are exactly the cabinet lines split in
		// two, and the total is those plus everything charged by the foot. Stated
		// against the categories rather than naming each one, so adding a
		// length-priced piece does not silently stop being checked.
		expect(sum(perCabinet)).toBeCloseTo(lines, 6);
		expect(result.totalRm).toBeCloseTo(lines + sum(byLength), 6);
		expect(sum(byLength)).toBeGreaterThan(result.worktopFt * WORKTOP_RM_PER_FT);
	});

	it("drops when a cabinet is removed", () => {
		const before = price(run()).totalRm;
		const fewer = price(removeModule(run(), "b1"));
		expect(fewer.totalRm).toBeLessThan(before);
	});
});

describe("worktop", () => {
	it("measures only the families that carry one", () => {
		// 900 base + 400 drawer base carry a worktop; the tall unit and the wall
		// cabinet do not.
		expect(worktopFt(run(), PLANNER_CATALOGUE)).toBeCloseTo(
			1300 / MM_PER_FT,
			6,
		);
	});

	it("is nothing in a room whose products have no worktop", () => {
		const bedroom = furnished(engine, "bedroom");
		expect(worktopFt(bedroom, PLANNER_CATALOGUE)).toBe(0);
	});

	it("bills a base run and not a wall run", () => {
		// `base-cabinet` and `wall-cabinet` are both 900mm wide here, so if the
		// worktop were billed by anything but the kind of cabinet these two would
		// come to the same number.
		const floor = addModule(empty(), "base-cabinet", 0, "b1", 900);
		const hanging = addModule(empty(), "wall-cabinet", 0, "w1", 900);

		expect(worktopFt(floor, PLANNER_CATALOGUE)).toBeCloseTo(900 / MM_PER_FT, 5);
		expect(worktopFt(hanging, PLANNER_CATALOGUE)).toBe(0);
	});

	it("bills nothing for a tall unit", () => {
		const tall = addModule(empty(), "tall-cabinet", 0, "t1", 600);

		expect(worktopFt(tall, PLANNER_CATALOGUE)).toBe(0);
	});

	it("bills nothing over a cabinet lifted off the floor or turned", () => {
		// The scene draws no slab over either, and the billed slab has to be the
		// drawn slab.
		const floor = addModule(empty(), "base-cabinet", 0, "b1", 900);

		expect(worktopFt(setHangAt(floor, "b1", 400), PLANNER_CATALOGUE)).toBe(0);
		expect(worktopFt(setRotation(floor, "b1", 90), PLANNER_CATALOGUE)).toBe(0);
	});
});

describe("catalogue is a real parameter, not just an import default", () => {
	it("PLANNER_CATALOGUE satisfies its own schema", () => {
		expect(() => plannerCatalogueSchema.parse(PLANNER_CATALOGUE)).not.toThrow();
	});

	it("prices off a catalogue passed in explicitly", () => {
		const explicit = computePlannerPrice(run(), "white", PLANNER_CATALOGUE);
		expect(explicit.totalRm).toBe(price(run()).totalRm);
	});

	it("a different catalogue produces a different price", () => {
		const pricier = {
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.map((f) =>
				f.id === "base-cabinet"
					? {
							...f,
							sizes: f.sizes.map((s) => ({ ...s, priceRm: s.priceRm * 2 })),
						}
					: f,
			),
		};
		expect(
			computePlannerPrice(run(), "white", pricier).totalRm,
		).toBeGreaterThan(price(run()).totalRm);
	});

	it("charges the next rung up for a width between rungs", () => {
		expect(doorPriceRmIn(PLANNER_CATALOGUE, "shaker", 850)).toBe(
			doorPriceRmIn(PLANNER_CATALOGUE, "shaker", 900),
		);
	});

	it("charges the catalogue's worktop rate, not the bundled one", () => {
		const priced = {
			...PLANNER_CATALOGUE,
			rates: { worktopRmPerFt: RATES.worktopRmPerFt * 2 },
		};
		const base = computePlannerPrice(run(), "white", PLANNER_CATALOGUE);
		const dear = computePlannerPrice(run(), "white", priced);

		const line = (p: typeof base) =>
			p.categories.find((c) => c.id === "worktop");
		expect(line(dear)?.amountRm).toBeCloseTo(
			(line(base)?.amountRm ?? 0) * 2,
			6,
		);
		expect(line(dear)?.detail.vars?.rate).toBe(RATES.worktopRmPerFt * 2);
	});

	it("charges the catalogue's end-panel rates", () => {
		const priced = {
			...PLANNER_CATALOGUE,
			rates: {
				worktopRmPerFt: RATES.worktopRmPerFt,
				endPanelBaseRm: 1,
				endPanelWallRm: 1,
				endPanelTallRm: 1,
			},
		};
		const panels = endPanelPriceRm(run(), priced);
		expect(panels.amountRm).toBe(panels.count);
	});

	it("charges the catalogue's skirting and ceiling-trim rates", () => {
		const priced = {
			...PLANNER_CATALOGUE,
			rates: {
				worktopRmPerFt: RATES.worktopRmPerFt,
				skirtingRmPerFt: RATES.skirtingRmPerFt * 3,
				ceilingTrimRmPerFt: RATES.ceilingTrimRmPerFt * 3,
			},
		};
		const flush = setWallToCeiling(run(), true);
		const base = computePlannerPrice(flush, "white", PLANNER_CATALOGUE);
		const dear = computePlannerPrice(flush, "white", priced);

		const amount = (p: typeof base, id: "skirting" | "ceilingTrim") =>
			p.categories.find((c) => c.id === id)?.amountRm ?? 0;
		expect(amount(dear, "skirting")).toBeCloseTo(
			amount(base, "skirting") * 3,
			6,
		);
		expect(amount(dear, "ceilingTrim")).toBeCloseTo(
			amount(base, "ceilingTrim") * 3,
			6,
		);
	});
});

describe("every room prices", () => {
	it("gives a furnished run in each room a believable, non-zero total", () => {
		for (const room of PLANNER_CATALOGUE.roomTypes) {
			const result = price(furnished(engine, room.id));
			expect(result.totalRm).toBeGreaterThan(0);
			// A single wall of cabinetry should not read as a car.
			expect(result.totalRm).toBeLessThan(30000);
		}
	});
});

describe("ceiling trim", () => {
	it("charges nothing while the run hangs", () => {
		const result = price(run());
		expect(ceilingTrimFt(run(), PLANNER_CATALOGUE)).toBe(0);
		expect(result.ceilingTrimFt).toBe(0);
		expect(result.categories.some((c) => c.id === "ceilingTrim")).toBe(false);
	});

	it("charges the wall run's length once it goes to the ceiling", () => {
		const flushed = setWallToCeiling(run(), true);
		// One 900mm wall unit is the whole hung row.
		expect(ceilingTrimFt(flushed, PLANNER_CATALOGUE)).toBeCloseTo(
			900 / MM_PER_FT,
			6,
		);
		expect(price(flushed).categories.some((c) => c.id === "ceilingTrim")).toBe(
			true,
		);
	});

	it("costs more than the same run hanging, by the strip and nothing else", () => {
		const hanging = price(run());
		const flushed = price(setWallToCeiling(run(), true));
		expect(flushed.totalRm).toBeGreaterThan(hanging.totalRm);
		expect(flushed.totalRm - hanging.totalRm).toBeCloseTo(
			flushed.ceilingTrimFt * RATES.ceilingTrimRmPerFt,
			6,
		);
	});

	it("charges nothing for a ceiling run with nothing hung on the wall", () => {
		let floorOnly = empty();
		floorOnly = addModule(floorOnly, "base-cabinet", 0, "b1", 900);
		expect(
			ceilingTrimFt(setWallToCeiling(floorOnly, true), PLANNER_CATALOGUE),
		).toBe(0);
	});
});

describe("skirting", () => {
	it("charges every base run, since the legs always need covering", () => {
		const result = price(run());
		// base 900 + drawers 400 + tall 600, all touching from 0.
		expect(skirtingFt(run(), PLANNER_CATALOGUE)).toBeCloseTo(
			1900 / MM_PER_FT,
			6,
		);
		expect(result.categories.some((c) => c.id === "skirting")).toBe(true);
	});

	it("runs no board under a cabinet lifted off the floor", () => {
		let run = empty();
		run = addModule(run, "base-cabinet", 0, "b1", 900);
		run = addModule(run, "base-cabinet", 900, "b2", 900);

		expect(
			skirtingFt(setHangAt(run, "b2", 400), PLANNER_CATALOGUE),
		).toBeCloseTo(900 / MM_PER_FT, 6);
	});

	it("does not charge across a gap the board is not cut for", () => {
		let apart = empty();
		apart = addModule(apart, "base-cabinet", 0, "b1", 900);
		apart = addModule(apart, "base-cabinet", 1500, "b2", 900);

		let together = empty();
		together = addModule(together, "base-cabinet", 0, "b1", 900);
		together = addModule(together, "base-cabinet", 900, "b2", 900);

		// Same cabinets either way, so the same board length — the gap splits the
		// board in two, it does not add a third piece bridging it.
		expect(skirtingFt(apart, PLANNER_CATALOGUE)).toBeCloseTo(
			skirtingFt(together, PLANNER_CATALOGUE),
			6,
		);
		expect(skirtingFt(apart, PLANNER_CATALOGUE)).toBeCloseTo(
			1800 / MM_PER_FT,
			6,
		);
	});

	it("drops the line entirely when the customer turns the board off", () => {
		const bare = price(setBaseSkirting(run(), false));
		const skirted = price(run());

		expect(bare.skirtingFt).toBe(0);
		expect(bare.categories.some((c) => c.id === "skirting")).toBe(false);
		expect(skirted.totalRm - bare.totalRm).toBeCloseTo(
			skirted.skirtingFt * RATES.skirtingRmPerFt,
			6,
		);
	});

	it("charges nothing in a room with only wall units", () => {
		const wallOnly = addModule(empty(), "wall-cabinet", 0, "w", 900);
		expect(skirtingFt(wallOnly, PLANNER_CATALOGUE)).toBe(0);
		expect(price(wallOnly).categories.some((c) => c.id === "skirting")).toBe(
			false,
		);
	});

	it("adds exactly the board's own cost to the total", () => {
		const result = price(run());
		const line = result.categories.find((c) => c.id === "skirting");
		expect(line?.amountRm).toBeCloseTo(
			result.skirtingFt * RATES.skirtingRmPerFt,
			6,
		);
	});
});

describe("end panels", () => {
	it("clads every exposed side, and says how many", () => {
		const result = price(run());
		const line = result.categories.find((c) => c.id === "endPanels");

		// 2 sides: the floor run's right end, and the wall unit's right end — both
		// runs start flush with the left wall now that every room has walls, so
		// the wall unit at x = 0 is buried on its left too.
		expect(result.endPanelCount).toBe(2);
		expect(line?.detail).toEqual({ key: "endPanelsOther", vars: { count: 2 } });
	});

	it("prices a tall end above a wall end — a bigger board is a bigger panel", () => {
		const tall = addModule(empty(), "tall-cabinet", 0, "t1", 600);
		const wall = addModule(empty(), "wall-cabinet", 0, "w1", 900);

		expect(endPanelPriceRm(tall, PLANNER_CATALOGUE).amountRm).toBeGreaterThan(
			endPanelPriceRm(wall, PLANNER_CATALOGUE).amountRm,
		);
		// Both sit at x = 0, flush with the left wall, so the tall unit's left
		// side is buried and only its right side wears a panel now.
		expect(endPanelPriceRm(tall, PLANNER_CATALOGUE).amountRm).toBe(
			RATES.endPanelTallRm * 1,
		);
	});

	it("charges nothing for a run built wall to wall", () => {
		let run = addModule(
			setWallWidth(empty(), 1800),
			"base-cabinet",
			0,
			"b1",
			900,
		);
		run = addModule(run, "base-cabinet", 900, "b2", 900);
		expect(price(run).endPanelCount).toBe(0);
		expect(price(run).categories.some((c) => c.id === "endPanels")).toBe(false);
	});

	it("charges the end that stands clear of the wall", () => {
		// Every room has walls now, so the left end, flush with one, is buried;
		// the right end stops 600 short of the other and is clad.
		let run = addModule(
			setWallWidth(empty(), 2400),
			"base-cabinet",
			0,
			"b1",
			900,
		);
		run = addModule(run, "base-cabinet", 900, "b2", 900);
		expect(price(run).endPanelCount).toBe(1);
	});
});

describe("an L-shaped room", () => {
	const rooms = roomEngine(PLANNER_CATALOGUE);
	const finish = PLANNER_CATALOGUE.finishes[0].id;

	const lWithBases = () => {
		let room = emptyRoom(4200);
		room = rooms.addModule(room, "base-cabinet", 0, "m", 600);
		// The left wall, run 3: its corner with the back wall is its far end.
		return rooms.addModule(room, "base-cabinet", 3000, "s", 600, 3);
	};

	it("runs the worktop along both walls and across the corner once", () => {
		expect(roomWorktopFt(lWithBases(), PLANNER_CATALOGUE)).toBeCloseTo(
			(600 + 600 + 607) / MM_PER_FT,
		);
	});

	it("charges a corner unit as a cabinet, and its square of worktop", () => {
		const room = rooms.addModule(lWithBases(), "corner-base", 0, "c");
		const price = roomPrice(room, finish, PLANNER_CATALOGUE);
		expect(price.cabinets.map((line) => line.id).sort()).toEqual([
			"c",
			"m",
			"s",
		]);
		expect(price.worktopFt).toBeCloseTo((600 + 600 + 900) / MM_PER_FT);
	});
});

describe("a free-standing cabinet", () => {
	const rooms = roomEngine(PLANNER_CATALOGUE);
	const standing = (familyId: string, widthMm: number) => {
		const room = rooms.addModule(emptyRoom(4200), familyId, 0, "f", widthMm);
		return rooms.placeFree(room, "f", { xMm: 0, zMm: 0 });
	};

	it("is priced as a run of one: its own worktop, kick board and both ends", () => {
		const room = standing("base-cabinet", 600);
		expect(room.free).toHaveLength(1);
		expect(roomWorktopFt(room, PLANNER_CATALOGUE) * MM_PER_FT).toBeCloseTo(600);
		expect(roomSkirtingFt(room, PLANNER_CATALOGUE) * MM_PER_FT).toBeCloseTo(
			600,
		);
		const panels = rooms.endPanels(room);
		expect(panels).toHaveLength(2);
		expect(panels.every((p) => p.kind === "base")).toBe(true);
		expect(roomEndPanelPriceRm(room, PLANNER_CATALOGUE).amountRm).toBe(
			2 * RATES.endPanelBaseRm,
		);
	});

	it("gives a tall unit two tall panels and no worktop", () => {
		const room = standing("tall-cabinet", 600);
		expect(room.free).toHaveLength(1);
		expect(roomWorktopFt(room, PLANNER_CATALOGUE)).toBe(0);
		const panels = rooms.endPanels(room);
		expect(panels.map((p) => p.kind)).toEqual(["tall", "tall"]);
	});

	it("bills a tall unit the same kick board free as on a wall", () => {
		const onWall = rooms.addModule(
			emptyRoom(4200),
			"tall-cabinet",
			1000,
			"f",
			600,
		);
		const wallFt = roomSkirtingFt(onWall, PLANNER_CATALOGUE);
		expect(wallFt).toBeGreaterThan(0);
		expect(
			roomSkirtingFt(standing("tall-cabinet", 600), PLANNER_CATALOGUE),
		).toBeCloseTo(wallFt);
	});

	it("ignores a hangAtMm smuggled onto a free row", () => {
		const room = standing("base-cabinet", 600);
		const lifted = {
			...room,
			free: room.free.map((m) => ({ ...m, hangAtMm: 400 })),
		};
		expect(roomWorktopFt(lifted, PLANNER_CATALOGUE)).toBeCloseTo(
			roomWorktopFt(room, PLANNER_CATALOGUE),
		);
		expect(roomSkirtingFt(lifted, PLANNER_CATALOGUE)).toBeCloseTo(
			roomSkirtingFt(room, PLANNER_CATALOGUE),
		);
	});
});
