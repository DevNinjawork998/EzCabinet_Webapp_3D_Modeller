import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import type { FloorPlan } from "../floorplan";
import { emptyLayout, type PlacedModule, plannerEngine } from "../layout";
import {
	asRoom,
	cornerVertexFor,
	emptyRoom,
	isActiveCorner,
	nearCornerMm,
	type RoomLayout,
	roomEngine,
	runIndexOf,
	runView,
	setDoor,
	withRun,
} from "../room";

const engine = roomEngine(PLANNER_CATALOGUE);
const oneWall = plannerEngine(PLANNER_CATALOGUE);

const base = (id: string, xMm: number, widthMm = 600): PlacedModule => ({
	id,
	familyId: "base-cabinet",
	widthMm,
	doorStyleId: null,
	hinge: "left",
	xMm,
});

/** 4200 × 3600: the back wall is 4200, the left wall (run 3) 3600. */
const kitchen = () => emptyRoom(4200);

/** The old left L, by hand: the back wall and the left wall, meeting at
 * vertex 3 — the start of the back wall and the end of the left wall. */
const lRoom = (
	main: PlacedModule[] = [],
	side: PlacedModule[] = [],
): RoomLayout => {
	const room = kitchen();
	return {
		...room,
		runs: room.runs.map((run, i) =>
			i === 0
				? { floor: main, wall: [] }
				: i === 3
					? { floor: side, wall: [] }
					: run,
		),
	};
};

const lPlan: FloorPlan = {
	template: "l",
	widthMm: 5500,
	depthMm: 5075,
	notchWidthMm: 1500,
	notchDepthMm: 3000,
	mirror: false,
};

const xOf = (room: RoomLayout, id: string) =>
	room.runs.flatMap((r) => [...r.floor, ...r.wall]).find((m) => m.id === id)
		?.xMm;

describe("asRoom", () => {
	it("makes one wall's rows the back wall of a rectangle", () => {
		const room = asRoom(emptyLayout(3000));
		expect(room.plan).toEqual({
			template: "rect",
			widthMm: 3000,
			depthMm: 3600,
		});
		expect(room.runs).toHaveLength(4);
		expect(room.runs[0]).toEqual({ floor: [], wall: [] });
		expect(room.corners).toEqual([]);
		expect("wallToWall" in room).toBe(false);
	});
});

describe("runView", () => {
	it("gives each wall its own length, depth and end walls", () => {
		expect(runView(kitchen(), 0)).toMatchObject({
			wallWidthMm: 4200,
			roomDepthMm: 3600,
			endWalls: { left: true, right: true },
		});
		expect(runView(kitchen(), 3)).toMatchObject({
			wallWidthMm: 3600,
			roomDepthMm: 4200,
		});
		expect(runView(kitchen(), 0).reserved).toBeUndefined();
	});

	it("leaves a run ending at the notch's outside corner open at that end", () => {
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		expect(runView(room, 2).endWalls).toEqual({ left: true, right: false });
		expect(runView(room, 3).endWalls).toEqual({ left: false, right: true });
	});
});

describe("a straight run", () => {
	it("edits exactly as the one-wall engine does", () => {
		const flat = oneWall.addModule(
			emptyLayout(4200),
			"base-cabinet",
			0,
			"a",
			600,
		);
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(runView(room, 0).floor).toEqual(flat.floor);
	});

	it("refuses a run that does not exist", () => {
		const room = kitchen();
		expect(engine.addModule(room, "base-cabinet", 0, "a", 600, 4)).toBe(room);
	});
});

describe("corners switch on when both walls hold cabinets", () => {
	it("reserve nothing while only one wall is used", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(runView(room, 0).reserved).toBeUndefined();
		expect(xOf(room, "a")).toBe(0);
	});

	it("reserve the square on both walls and push both runs clear", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 3000, "s", 600, 3);
		expect(runView(room, 0).reserved?.floor).toEqual([
			{ startMm: 0, endMm: 607 },
		]);
		expect(runView(room, 3).reserved?.floor).toEqual([
			{ startMm: 2993, endMm: 3600 },
		]);
		expect(xOf(room, "a")).toBe(607);
		expect(xOf(room, "s")).toBe(2393);
	});

	it("refuse the cabinet that would switch one on when a wall cannot give way", () => {
		let room = emptyRoom(4200, 2000);
		room = engine.addModule(room, "base-cabinet", 200, "s1", 900, 3);
		room = engine.addModule(room, "base-cabinet", 1100, "s2", 900, 3);
		expect(engine.addModule(room, "base-cabinet", 0, "a", 600, 0)).toBe(room);
	});

	it("reserve both ends of the back wall in a U", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 1800, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "l", 600, 3);
		room = engine.addModule(room, "base-cabinet", 3000, "r", 600, 1);
		expect(runView(room, 0).reserved?.floor).toEqual([
			{ startMm: 0, endMm: 607 },
			{ startMm: 3593, endMm: 4200 },
		]);
	});

	it("reserve nothing in a galley, whose walls never meet", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "f", 600, 2);
		expect(runView(room, 0).reserved).toBeUndefined();
		expect(runView(room, 2).reserved).toBeUndefined();
	});

	it("never switch on at an outside corner", () => {
		let room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		room = engine.addModule(room, "base-cabinet", 900, "top", 600, 2);
		room = engine.addModule(room, "base-cabinet", 0, "side", 600, 3);
		expect(runView(room, 2).reserved).toBeUndefined();
		expect(runView(room, 3).reserved).toBeUndefined();
	});

	it("free the square when a wall empties, and pull nothing back", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 3000, "s", 600, 3);
		room = engine.removeModule(room, "s");
		expect(runView(room, 0).reserved).toBeUndefined();
		expect(xOf(room, "a")).toBe(607);
	});
});

describe("setShape", () => {
	it("turns a rectangle into an L, keeping the back wall", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		const next = engine.setShape(room, "l");
		expect(next.plan.template).toBe("l");
		expect(next.runs).toHaveLength(6);
		expect(next.runs[0]).toBe(room.runs[0]);
	});

	it("refuses while any other wall holds a cabinet", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "s", 600, 3);
		expect(engine.setShape(room, "l")).toBe(room);
	});
});

describe("setWallLength", () => {
	it("moves the parameter the wall is made of", () => {
		const next = engine.setWallLength(kitchen(), 2, 5000);
		expect(next.plan).toMatchObject({ widthMm: 5000 });
		expect(runView(next, 0).wallWidthMm).toBe(5000);
	});

	it("stops at what the wall's cabinets need", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 2400, "a", 600);
		room = engine.setWallLength(room, 0, 1000);
		expect(runView(room, 0).wallWidthMm).toBe(3000);
		expect(engine.wallLengthRangeMm(room, 0)).toEqual({
			minMm: 3000,
			maxMm: 12000,
		});
	});

	it("keeps a run by its far corner when only that end has one", () => {
		// The back wall and the right wall meet at vertex 0, the back wall's end.
		let room = engine.addModule(kitchen(), "base-cabinet", 3600, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "r", 600, 1);
		const before = xOf(room, "b") ?? 0;
		const wider = engine.setWallLength(room, 0, 4700);
		expect(xOf(wider, "b")).toBe(before + 500);
		expect(xOf(wider, "r")).toBe(xOf(room, "r"));
	});
});

describe("corner units", () => {
	it("go to the target wall's start corner, drawn there unturned", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(room.corners).toEqual([
			expect.objectContaining({
				vertex: 3,
				floor: expect.objectContaining({ id: "c" }),
			}),
		]);
		expect(xOf(room, "a")).toBe(900);
		const [drawn] = engine.cornerPositionsOf(room, 0);
		expect(drawn.xMm).toBe(0);
		expect(drawn.placed.rotationDeg).toBeUndefined();
		expect(engine.cornerPositionsOf(room, 3)).toEqual([]);
	});

	it("pick the end corner when the start is an outside corner", () => {
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		expect(cornerVertexFor(room, 3)).toBe(3);
		expect(cornerVertexFor(room, 2)).toBe(1);
		expect(engine.placeCorner(room, "corner-base", 2)).toBe(room);
	});

	it("go to the wall slot when they hang", () => {
		const room = engine.addModule(
			kitchen(),
			"corner-wall",
			0,
			"cw",
			undefined,
			1,
		);
		expect(room.corners[0]).toMatchObject({ vertex: 0, floor: null });
		expect(room.corners[0].wall?.familyId).toBe("corner-wall");
	});

	it("are refused in a full slot", () => {
		const full = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.addModule(full, "corner-base", 0, "d")).toBe(full);
		expect(engine.fits(full, "corner-base")).toBe(false);
	});

	it("ignore a client's own xMm and rotation", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		const floor = room.corners[0].floor;
		if (!floor) throw new Error("fixture lost its corner");
		const tampered: RoomLayout = {
			...room,
			corners: [
				{ ...room.corners[0], floor: { ...floor, xMm: 1234, rotationDeg: 90 } },
			],
		};
		const [drawn] = engine.cornerPositions(tampered);
		expect(drawn.placed.xMm).toBe(0);
		expect(drawn.placed.rotationDeg).toBeUndefined();
	});

	it("are priced, listed and removed like any cabinet", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.allPositions(room).map((p) => p.placed.id)).toEqual(["c"]);
		expect(engine.widthOptionsFor(room, "c")).toEqual([
			{ widthMm: 900, priceRm: 1150, fits: true },
		]);
		expect(engine.removeModule(room, "c").corners).toEqual([]);
		expect(setDoor(room, "c", "shaker").corners[0].floor?.doorStyleId).toBe(
			"shaker",
		);
	});
});

describe("exposure", () => {
	it("buries a side flush against a wall", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(engine.exposureOf(room).get("a")?.left).toBe(false);
	});

	it("leaves the end beside an empty corner square in the open", () => {
		const room = lRoom([base("a", 607)], [base("s", 2393)]);
		expect(engine.exposureOf(room).get("a")?.left).toBe(true);
	});

	it("covers the end beside a corner unit, which wears no panels itself", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(engine.exposureOf(room).get("a")?.left).toBe(false);
		expect(engine.exposureOf(room).get("c")).toEqual({
			left: false,
			right: false,
		});
		expect(engine.endPanels(room).some((p) => p.moduleId === "c")).toBe(false);
	});
});

describe("cornerWorktops", () => {
	it("is empty with no active corner", () => {
		expect(engine.cornerWorktops(kitchen())).toEqual([]);
		expect(engine.cornerWorktops(lRoom([base("a", 0)]))).toEqual([]);
	});

	it("closes an empty corner when a base unit meets it", () => {
		expect(
			engine.cornerWorktops(lRoom([base("a", 607)], [base("s", 2393)])),
		).toEqual([{ vertex: 3, sizeMm: 607, topMm: 880 }]);
	});

	it("covers a corner base unit", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.cornerWorktops(room)).toEqual([
			{ vertex: 3, sizeMm: 900, topMm: 880 },
		]);
	});
});

describe("where a run starts", () => {
	it("is the start of the wall, unless only the far end is a corner", () => {
		expect(nearCornerMm(kitchen(), 0)).toBe(0);
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		expect(nearCornerMm(room, 3)).toBe(3000);
	});

	it("packs toward a corner at the far end", () => {
		// The left wall's only corner is its far end, vertex 3.
		const room = engine.closeGaps(lRoom([base("a", 607)], [base("s", 1000)]));
		expect(xOf(room, "s")).toBe(2393);
		expect(engine.runExtentMm(room, 3)).toBe(1207);
	});
});

describe("dispatch", () => {
	it("finds, moves and removes across runs", () => {
		const room = lRoom([base("a", 607)], [base("s", 1000)]);
		expect(runIndexOf(room, "s")).toBe(3);
		expect(
			engine
				.removeModules(room, ["a", "s"])
				.runs.every((r) => r.floor.length === 0),
		).toBe(true);
	});

	it("withRun writes rows only", () => {
		const room = kitchen();
		const view = { ...runView(room, 3), wallWidthMm: 1 };
		const next = withRun(room, 3, { ...view, floor: [base("x", 0)] });
		expect(next.plan).toBe(room.plan);
		expect(next.runs[3].floor).toHaveLength(1);
	});
});

describe("cornerShutSides", () => {
	// The left wall is 3600 long and its corner is its far end.
	const pair = (mainMm: number, sideEndMm: number) =>
		lRoom([base("a", mainMm)], [base("b", sideEndMm - 600)]);
	const both = new Map([
		["a", "left"],
		["b", "right"],
	]);

	it("shuts the leaf each run hinges onto the corner", () => {
		expect(engine.cornerShutSides(pair(607, 2993))).toEqual(both);
	});

	it("still shuts them when a cabinet is nudged a few mm off the square", () => {
		expect(engine.cornerShutSides(pair(611, 2993))).toEqual(both);
		expect(engine.cornerShutSides(pair(750, 2993))).toEqual(both);
	});

	it("lets them open once both are out of each other's reach", () => {
		expect(engine.cornerShutSides(pair(1600, 2000))).toEqual(new Map());
		expect(engine.cornerShutSides(pair(1400, 2200))).toEqual(both);
	});

	it("still shuts them when a cabinet is lifted off the floor", () => {
		const lifted = lRoom(
			[{ ...base("a", 607), hangAtMm: 40 }],
			[base("b", 2393)],
		);
		expect(engine.cornerShutSides(lifted)).toEqual(both);
	});

	it("lets them open when a lift clears the other run's doors", () => {
		const hoisted = lRoom(
			[{ ...base("a", 607), hangAtMm: 1500 }],
			[base("b", 2393)],
		);
		expect(engine.cornerShutSides(hoisted)).toEqual(new Map());
	});

	it("ignores a turned cabinet", () => {
		const turned = lRoom(
			[{ ...base("a", 607), rotationDeg: 30 }],
			[base("b", 2393)],
		);
		expect(engine.cornerShutSides(turned)).toEqual(new Map());
	});

	it("shuts nothing while only one wall holds cabinets", () => {
		expect(engine.cornerShutSides(lRoom([base("a", 607)]))).toEqual(new Map());
	});

	it("opens both once the corner square is deeper than the leaves reach", () => {
		const filled = (squareMm: number): RoomLayout => ({
			...lRoom([base("a", squareMm)], [base("b", 3600 - squareMm - 600)]),
			corners: [{ vertex: 3, floor: base("corner", 0, squareMm), wall: null }],
		});
		expect(engine.cornerShutSides(filled(900))).toEqual(both);
		expect(engine.cornerShutSides(filled(2600))).toEqual(new Map());
	});
});

describe("fits guards an out-of-range run", () => {
	it("refuses rather than crashing on a run past the plan's walls", () => {
		// vertexKind wraps by modulo, so most out-of-range runs answer via that
		// wrap; run = count + 3 lands on the L plan's one outside/inside pair
		// (vertex 2 outside, vertex 3 inside) and used to reach `lengthOf`,
		// which indexes `wallsOf(plan)` with the raw, un-wrapped run and threw.
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		const run = room.runs.length + 3;
		expect(() =>
			engine.fits(room, "base-cabinet", undefined, run),
		).not.toThrow();
		expect(engine.fits(room, "base-cabinet", undefined, run)).toBe(false);
	});
});

describe("a run anchors at its outside/inside far end before any corner is active", () => {
	// The L plan's run 3 (the left wall) starts at the notch's outside corner
	// and ends at vertex 3, a real one — the same end `nearCornerMm` picks —
	// with no cabinets on either wall yet, so no corner has switched on.
	const lRoomPlan = (): RoomLayout => ({
		...emptyRoom(5500),
		plan: lPlan,
		runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
	});

	it("measures runExtentMm from the far corner, not from x = 0", () => {
		const at = nearCornerMm(lRoomPlan(), 3);
		const placed = engine.addModule(
			lRoomPlan(),
			"base-cabinet",
			at,
			"a",
			600,
			3,
		);
		// The cabinet needs only its own 600mm, not the run up to it.
		expect(engine.runExtentMm(placed, 3)).toBe(600);
	});

	it("closeGaps keeps the run packed against the far corner", () => {
		const at = nearCornerMm(lRoomPlan(), 3);
		const placed = engine.addModule(
			lRoomPlan(),
			"base-cabinet",
			at,
			"a",
			600,
			3,
		);
		const packed = engine.closeGaps(placed);
		expect(xOf(packed, "a")).toBe(at - 600);
	});

	it("setWallLength keeps the run against that corner as the wall grows", () => {
		const at = nearCornerMm(lRoomPlan(), 3);
		let room = engine.addModule(lRoomPlan(), "base-cabinet", at, "a", 600, 3);
		const before = xOf(room, "a") ?? 0;
		room = engine.setWallLength(room, 3, 4000);
		expect(xOf(room, "a")).toBe(before + 1000);
	});
});

describe("restored from the v2 file, adapted to v3's vertex-keyed corners", () => {
	it("moves a cabinet only as far as it needs, leaving a free gap alone", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 700, "a", 600);
		room = engine.addModule(room, "base-cabinet", 3600, "b", 600);
		// 1300–3600 is free, so there is room for the 900mm corner square.
		expect(engine.fits(room, "corner-base")).toBe(true);
		const next = engine.addModule(room, "corner-base", 0, "c");
		expect(next.corners[0]?.floor?.familyId).toBe("corner-base");
		expect(xOf(next, "a")).toBe(900);
		expect(xOf(next, "b")).toBe(3600);
	});

	it("clears both rows together for a tall unit, so the wall unit clears its end", () => {
		let room = engine.addModule(kitchen(), "tall-cabinet", 0, "t", 600);
		room = engine.addModule(room, "wall-cabinet", 600, "w", 400);
		// Activating the corner from the other wall triggers the cascade.
		const next = engine.addModule(room, "base-cabinet", 3000, "s", 600, 3);
		expect(isActiveCorner(next, 3)).toBe(true);
		expect(xOf(next, "t")).toBe(607);
		expect(next.runs[0].wall.find((m) => m.id === "w")?.xMm).toBe(1207);
	});

	it("refuses a tall unit that would stand under a wide corner wall unit", () => {
		const wide = {
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.map((f) =>
				f.id === "corner-wall"
					? { ...f, sizes: [{ widthMm: 900, priceRm: 900 }] }
					: f,
			),
		};
		const e = roomEngine(wide);
		const room = e.addModule(kitchen(), "corner-wall", 0, "cw");
		const next = e.addModule(room, "tall-cabinet", 607, "t", 600);
		expect(e.isClear(next)).toBe(true);
		expect(next).toBe(room);
	});

	it("cornerWorktops is none when the corner floor slot holds a non-base unit", () => {
		// No non-base corner family exists in the seed yet — a corner tall
		// unit is a future shape, per the CLAUDE.md corner-panel rules.
		const cornerTall: (typeof PLANNER_CATALOGUE.families)[number] = {
			id: "corner-tall",
			label: "Corner tall cabinet",
			category: "CORNER_BASE_CABINET",
			kind: "tall",
			depthMm: 900,
			heightMm: 2380,
			floorHeightMm: 0,
			drawers: 0,
			sizes: [{ widthMm: 900, priceRm: 1500 }],
		};
		const testCatalogue = {
			...PLANNER_CATALOGUE,
			families: [...PLANNER_CATALOGUE.families, cornerTall],
		};
		const testEngine = roomEngine(testCatalogue);
		const room = testEngine.addModule(kitchen(), "corner-tall", 0, "c");
		expect(room.corners[0]?.floor?.familyId).toBe("corner-tall");
		expect(testEngine.cornerWorktops(room)).toEqual([]);
	});

	it("refuses the add that would switch on a second corner the back wall cannot give both squares to", () => {
		// "b" sits flush against vertex 3's eventual square with no free run
		// left for vertex 0's — the second corner's cascade would have to push
		// it back into the first corner's square.
		let room = engine.addModule(kitchen(), "base-cabinet", 607, "b", 3200);
		room = engine.addModule(room, "base-cabinet", 0, "l", 600, 3);
		expect(isActiveCorner(room, 3)).toBe(true);
		const attempt = engine.addModule(room, "base-cabinet", 0, "r", 600, 1);
		expect(attempt).toBe(room);
	});
});
