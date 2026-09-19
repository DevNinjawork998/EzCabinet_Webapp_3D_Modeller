import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE, WALL_GAP_MM } from "../catalogue";
import type { FloorPlan } from "../floorplan";
import { emptyLayout, type PlacedModule, plannerEngine } from "../layout";
import {
	asRoom,
	cornerVertexFor,
	emptyRoom,
	isActiveCorner,
	nearCornerMm,
	offWall,
	type RoomLayout,
	roomEngine,
	runIndexOf,
	runView,
	SNAP_TO_WALL_MM,
	setDoor,
	setHinge,
	wallToJoin,
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

describe("freeWallMm", () => {
	it("is the whole wall on an empty back wall", () => {
		expect(engine.freeWallMm(kitchen(), 0)).toBe(4200);
	});

	it("subtracts one cabinet on the back wall", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(engine.freeWallMm(room, 0)).toBe(3600);
	});

	it("subtracts both corner squares of a U, not just the near one", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 1800, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "l", 600, 3);
		room = engine.addModule(room, "base-cabinet", 3000, "r", 600, 1);
		// 4200 − 607 − 607 − 600 = 2386. `runExtentMm` alone would miss the far
		// square and overstate this by 607.
		expect(engine.freeWallMm(room, 0)).toBe(2386);
	});

	it("goes negative by the overhang when the run no longer fits", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 900);
		// The shape a share link could deliver once parsed from JSON — no
		// setter produces this, but `freeWallMm` still has to read it.
		const tampered: RoomLayout = {
			...room,
			plan: { ...room.plan, widthMm: 600 },
		};
		expect(engine.freeWallMm(tampered, 0)).toBe(-300);
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

describe("moveToRun", () => {
	it("hands a cabinet to another wall, keeping id, door and hinge", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = setDoor(room, "a", "shaker");
		room = setHinge(room, "a", "right");
		const next = engine.moveToRun(room, "a", 3, 1500);
		expect(runIndexOf(next, "a")).toBe(3);
		expect(next.runs[0].floor).toEqual([]);
		const moved = next.runs[3].floor.find((m) => m.id === "a");
		expect(moved).toMatchObject({
			id: "a",
			familyId: "base-cabinet",
			widthMm: 600,
			doorStyleId: "shaker",
			hinge: "right",
			xMm: 1200,
		});
	});

	it("drops rotationDeg on a turned cabinet", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.setRotation(room, "a", 90);
		const next = engine.moveToRun(room, "a", 3, 1500);
		const moved = next.runs[3].floor.find((m) => m.id === "a");
		expect(moved?.rotationDeg).toBeUndefined();
	});

	it("refuses a wall with no room, unchanged", () => {
		// Run 2 (front, 4200mm) never shares a corner with run 0, so filling it
		// exactly leaves nothing else in play.
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 0, "w1", 900, 2);
		room = engine.addModule(room, "base-cabinet", 900, "w2", 900, 2);
		room = engine.addModule(room, "base-cabinet", 1800, "w3", 900, 2);
		room = engine.addModule(room, "base-cabinet", 2700, "w4", 900, 2);
		room = engine.addModule(room, "base-cabinet", 3600, "w5", 600, 2);
		expect(engine.moveToRun(room, "a", 2, 1500)).toBe(room);
	});

	it("refuses a corner unit, unchanged", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.moveToRun(room, "c", 1, 500)).toBe(room);
	});

	it("frees the corner square when the only cabinet on the other wall leaves, and does not pull the first back", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 3000, "s", 600, 3);
		expect(isActiveCorner(room, 3)).toBe(true);
		expect(xOf(room, "a")).toBe(607);
		const next = engine.moveToRun(room, "s", 2, 300);
		expect(isActiveCorner(next, 3)).toBe(false);
		expect(xOf(next, "a")).toBe(607);
		expect(runIndexOf(next, "s")).toBe(2);
	});

	it("activates a corner and cascades when the target wall meets a used one", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 0, "x", 600, 2);
		expect(xOf(room, "a")).toBe(0);
		const next = engine.moveToRun(room, "x", 3, 300);
		expect(runIndexOf(next, "x")).toBe(3);
		expect(isActiveCorner(next, 3)).toBe(true);
		expect(xOf(next, "a")).toBe(607);
	});

	// A wall-kind and a tall-kind cabinet can never share an x-span — `addModule`
	// keeps a wall unit out of a tall unit's footprint on every wall, both
	// directions, regardless of any custom height either carries (see
	// `occupiedSpans` in layout.ts) — so a transferred wall cabinet can never
	// literally land over a tall unit. The reachable version of "the kept
	// height doesn't fit here" is a lifted cabinet in the *other* row at the
	// same x: a base cabinet raised well off the floor reaches up into the
	// wall row's usual hanging band, which is exactly the shape of conflict
	// `hangRangeMm` already guards drags against.
	it("keeps a custom hang height that is still valid on the destination", () => {
		let room = engine.addModule(kitchen(), "wall-cabinet", 0, "w", 400);
		room = engine.setHangAt(room, "w", 1600);
		// A tall cabinet elsewhere on the destination wall: present, but never
		// in the wall cabinet's way — confirming the two coexist normally.
		room = engine.addModule(room, "tall-cabinet", 3000, "t", 600, 3);
		const next = engine.moveToRun(room, "w", 3, 200);
		const moved = next.runs[3].wall.find((m) => m.id === "w");
		expect(moved).toMatchObject({ id: "w", hangAtMm: 1600 });
	});

	it("drops a custom hang height a lifted cabinet on the destination now blocks", () => {
		let room = engine.addModule(kitchen(), "wall-cabinet", 0, "w", 400);
		room = engine.setHangAt(room, "w", 1200);
		// A base cabinet lifted to 400mm on the destination wall occupies
		// 400–1280mm — past the wall row's usual 1200mm floor.
		let room2 = engine.addModule(room, "base-cabinet", 0, "b", 600, 3);
		room2 = engine.setHangAt(room2, "b", 400);
		const next = engine.moveToRun(room2, "w", 3, 200);
		const moved = next.runs[3].wall.find((m) => m.id === "w");
		expect(moved).toBeDefined();
		expect(moved?.hangAtMm).toBeUndefined();
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

describe("free-standing cabinets", () => {
	// 4200 × 3600: back wall at z = -1800, left wall (run 3) at x = -2100. A
	// base unit is 607 deep, so its centre stands 303.5 off its back edge.
	const HALF = 303.5;
	const withBase = () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = setDoor(room, "a", "shaker");
		return setHinge(room, "a", "right");
	};
	const freeOf = (room: RoomLayout, id: string) =>
		room.free.find((m) => m.id === id);

	it("starts every room with none", () => {
		expect(kitchen().free).toEqual([]);
		expect(SNAP_TO_WALL_MM).toBe(150);
	});

	it("frees a run cabinet dropped mid-room, keeping id, door and hinge", () => {
		const next = engine.dropAt(withBase(), "a", { xMm: 0, zMm: 0 });
		expect(next.runs[0].floor).toEqual([]);
		expect(runIndexOf(next, "a")).toBe(-1);
		expect(freeOf(next, "a")).toMatchObject({
			id: "a",
			familyId: "base-cabinet",
			widthMm: 600,
			doorStyleId: "shaker",
			hinge: "right",
			xMm: 0,
			zMm: 0,
		});
		expect(freeOf(next, "a")?.rotationDeg ?? 0).toBe(0);
	});

	it("keeps facing the way its wall faced it", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 1500, "s", 600, 3);
		const next = engine.dropAt(room, "s", { xMm: 0, zMm: 0 });
		expect(freeOf(next, "s")?.rotationDeg).toBe(90);
	});

	it("joins the left wall when its back edge lands 100 mm off it", () => {
		const free = engine.dropAt(withBase(), "a", { xMm: 0, zMm: 0 });
		const next = engine.dropAt(free, "a", {
			xMm: -2100 + 100 + HALF,
			zMm: 0,
		});
		expect(next.free).toEqual([]);
		expect(runIndexOf(next, "a")).toBe(3);
		expect(next.runs[3].floor[0]).toMatchObject({
			doorStyleId: "shaker",
			hinge: "right",
		});
	});

	it("stays free when its back edge lands 400 mm off", () => {
		const next = engine.dropAt(withBase(), "a", {
			xMm: -2100 + 400 + HALF,
			zMm: 0,
		});
		expect(runIndexOf(next, "a")).toBe(-1);
		expect(freeOf(next, "a")).toMatchObject({ xMm: -2100 + 400 + HALF });
	});

	it("moves free to free", () => {
		const free = engine.dropAt(withBase(), "a", { xMm: 0, zMm: 0 });
		const next = engine.dropAt(free, "a", { xMm: 500, zMm: 300 });
		expect(next.free).toHaveLength(1);
		expect(freeOf(next, "a")).toMatchObject({ xMm: 500, zMm: 300 });
	});

	it("rejoins the back wall when dragged back to it", () => {
		const free = engine.dropAt(withBase(), "a", { xMm: 0, zMm: 0 });
		const next = engine.dropAt(free, "a", { xMm: 0, zMm: -1800 + 50 + HALF });
		expect(next.free).toEqual([]);
		expect(runIndexOf(next, "a")).toBe(0);
		expect(xOf(next, "a")).toBe(1800);
	});

	it("re-places a cabinet along its own wall when dropped near it", () => {
		const next = engine.dropAt(withBase(), "a", {
			xMm: 0,
			zMm: -1800 + 50 + HALF,
		});
		expect(runIndexOf(next, "a")).toBe(0);
		expect(xOf(next, "a")).toBe(1800);
	});

	it("refuses a wall unit and a corner unit", () => {
		const hung = engine.addModule(kitchen(), "wall-cabinet", 0, "w", 400);
		expect(engine.placeFree(hung, "w", { xMm: 0, zMm: 0 })).toBe(hung);
		expect(engine.dropAt(hung, "w", { xMm: 0, zMm: 0 })).toBe(hung);
		const corner = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.placeFree(corner, "c", { xMm: 0, zMm: 0 })).toBe(corner);
	});

	it("refuses the L's notch", () => {
		let room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		expect(engine.placeFree(room, "a", { xMm: 2000, zMm: 1500 })).toBe(room);
		expect(
			runIndexOf(engine.placeFree(room, "a", { xMm: 0, zMm: 0 }), "a"),
		).toBe(-1);
	});

	it("snaps back a drop whose centre is outside the room, not onto the wall behind it", () => {
		let room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		// In the notch, a hand's breadth behind its walls.
		const notch = { xMm: 2100, zMm: 800 };
		expect(engine.dropAt(room, "a", notch)).toBe(room);
		expect(wallToJoin(lPlan, notch, 607)).toBeNull();
	});

	it("refuses overlapping another free cabinet", () => {
		let room = engine.addModule(withBase(), "base-cabinet", 600, "b", 600);
		room = engine.placeFree(room, "a", { xMm: 0, zMm: 0 });
		expect(engine.placeFree(room, "b", { xMm: 300, zMm: 0 })).toBe(room);
		// Touching is not overlapping.
		expect(
			freeOf(engine.placeFree(room, "b", { xMm: 600, zMm: 0 }), "b"),
		).toBeDefined();
	});

	it("refuses overlapping a run cabinet", () => {
		// A base unit centred on the back wall: its front edge is at z ≈ -1188.
		let room = engine.addModule(kitchen(), "base-cabinet", 1800, "r", 600);
		room = engine.addModule(room, "base-cabinet", 0, "a", 600, 2);
		expect(engine.placeFree(room, "a", { xMm: 0, zMm: -1000 })).toBe(room);
		expect(
			freeOf(engine.placeFree(room, "a", { xMm: 0, zMm: -800 }), "a"),
		).toBeDefined();
	});

	it("keeps a free tall unit out from under a wall unit, but not a base", () => {
		let room = engine.addModule(kitchen(), "wall-cabinet", 1800, "w", 600);
		room = engine.addModule(room, "tall-cabinet", 0, "t", 600, 2);
		room = engine.addModule(room, "base-cabinet", 1000, "b", 600, 2);
		expect(engine.placeFree(room, "t", { xMm: 0, zMm: -1200 })).toBe(room);
		expect(
			freeOf(engine.placeFree(room, "b", { xMm: 0, zMm: -1200 }), "b"),
		).toBeDefined();
	});

	it("refuses a turn that swings a corner through a wall", () => {
		const room = engine.placeFree(withBase(), "a", {
			xMm: 0,
			zMm: -1800 + 350,
		});
		expect(engine.rotateFree(room, "a", 45)).toBe(room);
		expect(freeOf(engine.rotateFree(room, "a", 180), "a")?.rotationDeg).toBe(
			180,
		);
	});

	it("removes a free cabinet", () => {
		const room = engine.placeFree(withBase(), "a", { xMm: 0, zMm: 0 });
		expect(engine.removeModule(room, "a").free).toEqual([]);
	});

	it("gives a free cabinet both ends as panels", () => {
		const room = engine.placeFree(withBase(), "a", { xMm: 0, zMm: 0 });
		expect(engine.exposureOf(room).get("a")).toEqual({
			left: true,
			right: true,
		});
		const panels = engine.endPanels(room);
		expect(panels.filter((p) => p.moduleId === "a")).toHaveLength(2);
		expect(engine.allPositions(room).map((p) => p.placed.id)).toEqual(["a"]);
	});

	it("edits a free cabinet's door and hinge by id", () => {
		const room = engine.placeFree(withBase(), "a", { xMm: 0, zMm: 0 });
		expect(freeOf(setDoor(room, "a", null), "a")?.doorStyleId).toBeNull();
		expect(freeOf(setHinge(room, "a", "left"), "a")?.hinge).toBe("left");
	});

	it("draws a free cabinet as a run of one centred on its frame", () => {
		let room = engine.placeFree(withBase(), "a", { xMm: 500, zMm: 300 });
		room = engine.rotateFree(room, "a", 90);
		const drawn = engine.freeRun(room, "a");
		expect(drawn).not.toBeNull();
		if (!drawn) return;
		const { view, frame } = drawn;
		expect(frame).toEqual({ yawRad: Math.PI / 2, xMm: 500, zMm: 300 });
		// `Run` puts a cabinet's centre at x = xMm + w/2 − wall/2 and
		// z = −roomDepth/2 + gap + depth/2: both zero, the frame's origin.
		const [p] = oneWall.allPositions(view);
		expect(p.xMm + p.widthMm / 2 - view.wallWidthMm / 2).toBe(0);
		expect(-view.roomDepthMm / 2 + WALL_GAP_MM + p.family.depthMm / 2).toBe(0);
		// The same view the price reads, only its depth set for drawing.
		expect({ ...view, roomDepthMm: 0 }).toEqual({
			...engine.freeView(room, "a"),
			roomDepthMm: 0,
		});
		expect(engine.freeRun(room, "nope")).toBeNull();
	});

	it("says when a dragged centre has left its wall", () => {
		const plan = kitchen().plan;
		// Back wall at z = -1800; 607 deep, so the snap reaches 150 + 303.5.
		expect(offWall(plan, 0, { xMm: 0, zMm: -1800 + 150 + HALF }, 607)).toBe(
			false,
		);
		expect(offWall(plan, 0, { xMm: 0, zMm: -1800 + 151 + HALF }, 607)).toBe(
			true,
		);
	});

	it("names the wall a drop would join, or none", () => {
		const plan = kitchen().plan;
		expect(wallToJoin(plan, { xMm: -2100 + 100 + HALF, zMm: 0 }, 607)).toEqual({
			run: 3,
			xMm: 1800,
		});
		expect(wallToJoin(plan, { xMm: 0, zMm: 0 }, 607)).toBeNull();
	});

	it("lands a dragged turn on square when it is near it", () => {
		const room = engine.placeFree(withBase(), "a", { xMm: 0, zMm: 0 });
		expect(
			freeOf(engine.rotateFree(room, "a", 93, true), "a")?.rotationDeg,
		).toBe(90);
		expect(freeOf(engine.rotateFree(room, "a", 93), "a")?.rotationDeg).toBe(93);
		expect(
			freeOf(engine.rotateFree(room, "a", 2, true), "a")?.rotationDeg,
		).toBe(undefined);
	});

	it("reports a free footprint and a clear room", () => {
		const room = engine.placeFree(withBase(), "a", { xMm: 0, zMm: 0 });
		expect(engine.freeFootprint(room, "a")).toHaveLength(4);
		expect(engine.freeFootprint(room, "nope")).toBeNull();
		expect(engine.freeIsClear(room)).toBe(true);
		expect(engine.runFootprints(withBase(), "floor")).toHaveLength(1);
	});

	describe("a stale free cabinet", () => {
		// A catalogue change removed its family: the engine skips it, as it
		// skips an unknown run cabinet, and the rest of the room stays editable.
		const stale = () => {
			const room = engine.placeFree(withBase(), "a", { xMm: 0, zMm: 0 });
			return {
				...room,
				free: room.free.map((m) => ({ ...m, familyId: "gone" })),
			};
		};

		it("does not freeze the room", () => {
			const room = stale();
			const added = engine.addModule(room, "base-cabinet", 0, "b", 600, 2);
			expect(runIndexOf(added, "b")).toBe(2);
			const freed = engine.placeFree(added, "b", { xMm: 1000, zMm: 0 });
			expect(freeOf(freed, "b")).toBeDefined();
			// Checkout stays strict.
			expect(engine.isClear(freed)).toBe(false);
		});

		it("still refuses an edit that creates an overlap", () => {
			let room = engine.addModule(stale(), "base-cabinet", 0, "b", 600, 2);
			room = engine.placeFree(room, "b", { xMm: 1000, zMm: 0 });
			room = engine.addModule(room, "base-cabinet", 0, "c", 600, 2);
			expect(engine.placeFree(room, "c", { xMm: 1200, zMm: 0 })).toBe(room);
		});

		it("lets the room be edited around an existing overlap, but not worsened", () => {
			let room = engine.addModule(withBase(), "base-cabinet", 600, "b", 600);
			room = engine.placeFree(room, "a", { xMm: 0, zMm: 0 });
			room = engine.placeFree(room, "b", { xMm: 1000, zMm: 0 });
			// Tampered or stale: b now overlaps a.
			const bad = {
				...room,
				free: room.free.map((m) => (m.id === "b" ? { ...m, xMm: 300 } : m)),
			};
			const added = engine.addModule(bad, "base-cabinet", 0, "c", 600, 2);
			expect(runIndexOf(added, "c")).toBe(2);
			expect(engine.placeFree(added, "c", { xMm: 200, zMm: 0 })).toBe(added);
			expect(engine.isClear(added)).toBe(false);
		});
	});
});
