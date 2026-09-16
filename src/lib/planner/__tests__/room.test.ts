import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import { emptyLayout, type PlacedModule, plannerEngine } from "../layout";
import {
	asRoom,
	emptyRoom,
	type RoomLayout,
	roomEngine,
	runIndexOf,
	runView,
	runYawRad,
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

/** A 4200 × 3600 room turned into an L by hand, so these tests do not lean on
 * `setShape` (Task 4). */
const lRoom = (
	side: "left" | "right",
	main: PlacedModule[] = [],
	sideRun: PlacedModule[] = [],
): RoomLayout => ({
	...emptyRoom(4200),
	runs: [
		{ floor: main, wall: [] },
		{ floor: sideRun, wall: [] },
	],
	corner: { side, floor: null, wall: null },
});

describe("asRoom", () => {
	it("makes one wall's rows the only run", () => {
		const room = asRoom(emptyLayout(3000));
		expect(room.runs).toEqual([{ floor: [], wall: [] }]);
		expect(room.corner).toBeNull();
		expect(runView(room, 0)).toEqual(emptyLayout(3000));
	});
});

describe("a straight room", () => {
	it("edits exactly as the one-wall engine does", () => {
		const flat = oneWall.addModule(
			emptyLayout(4200),
			"base-cabinet",
			0,
			"a",
			600,
		);
		const room = engine.addModule(emptyRoom(4200), "base-cabinet", 0, "a", 600);
		expect(runView(room, 0)).toEqual(flat);
	});

	it("has no side run to add to", () => {
		const room = emptyRoom(4200);
		expect(engine.addModule(room, "base-cabinet", 0, "a", 600, 1)).toBe(room);
	});
});

describe("runView", () => {
	it("swaps the room's axes for the side wall and never encloses it", () => {
		const room = { ...lRoom("right"), wallToWall: true };
		expect(runView(room, 1)).toMatchObject({
			wallWidthMm: 3600,
			roomDepthMm: 4200,
			wallToWall: false,
		});
		expect(runView(room, 0)).toMatchObject({
			wallWidthMm: 4200,
			wallToWall: true,
		});
	});

	it("reserves the corner at the start of the main wall for a left corner", () => {
		expect(runView(lRoom("left"), 0).reserved).toEqual({
			floor: { startMm: 0, endMm: 607 },
			wall: { startMm: 0, endMm: 397 },
		});
	});

	it("reserves the far end of the side wall for a left corner", () => {
		expect(runView(lRoom("left"), 1).reserved?.floor).toEqual({
			startMm: 2993,
			endMm: 3600,
		});
	});

	it("mirrors both for a right corner", () => {
		const room = lRoom("right");
		expect(runView(room, 0).reserved?.floor).toEqual({
			startMm: 3593,
			endMm: 4200,
		});
		expect(runView(room, 1).reserved?.floor).toEqual({
			startMm: 0,
			endMm: 607,
		});
	});
});

describe("dispatch", () => {
	it("finds the run holding an id", () => {
		const room = lRoom("right", [base("m", 1000)], [base("s", 1000)]);
		expect(runIndexOf(room, "m")).toBe(0);
		expect(runIndexOf(room, "s")).toBe(1);
		expect(runIndexOf(room, "nope")).toBe(-1);
	});

	it("moves a side-wall cabinet against that wall's own corner", () => {
		const room = lRoom("right", [], [base("s", 1000)]);
		expect(engine.moveModule(room, "s", 0).runs[1].floor[0].xMm).toBe(607);
	});

	it("adds to the run it is told to", () => {
		const room = engine.addModule(
			lRoom("left"),
			"base-cabinet",
			3500,
			"s",
			600,
			1,
		);
		expect(room.runs[1].floor[0].xMm).toBe(2393);
		expect(room.runs[0].floor).toEqual([]);
	});

	it("leaves the room untouched for an unknown id", () => {
		const room = lRoom("left");
		expect(engine.moveModule(room, "nope", 10)).toBe(room);
	});

	it("withRun writes rows only, never the view's swapped axes", () => {
		const room = lRoom("left");
		const view = { ...runView(room, 1), floor: [base("s", 0)] };
		const next = withRun(room, 1, view);
		expect(next.wallWidthMm).toBe(4200);
		expect(next.roomDepthMm).toBe(3600);
		expect(next.runs[1].floor).toHaveLength(1);
	});

	it("lists positions of every run", () => {
		const room = lRoom("left", [base("m", 1000)], [base("s", 1000)]);
		expect(
			engine
				.allPositions(room)
				.map((p) => p.placed.id)
				.sort(),
		).toEqual(["m", "s"]);
	});

	it("removes across runs", () => {
		const room = lRoom("left", [base("m", 1000)], [base("s", 1000)]);
		const next = engine.removeModules(room, ["m", "s"]);
		expect(next.runs.map((r) => r.floor.length)).toEqual([0, 0]);
	});
});

describe("room-wide settings", () => {
	it("clamps the ceiling the way the one-wall engine does", () => {
		expect(
			engine.setCeilingHeight(emptyRoom(4200), 99_999).ceilingHeightMm,
		).toBe(oneWall.setCeilingHeight(emptyLayout(4200), 99_999).ceilingHeightMm);
	});

	it("will not shorten the main wall through a right-hand corner", () => {
		const room = lRoom("right", [base("m", 2000)]);
		expect(engine.minWallWidthMm(room)).toBe(2600 + 607);
		expect(engine.setWallWidth(room, 1000).wallWidthMm).toBe(3207);
	});

	it("will not shorten the room through the side wall's cabinets", () => {
		const room = lRoom("left", [], [base("s", 1000)]);
		expect(engine.minRoomDepthMm(room)).toBe(1600 + 607);
		expect(engine.setRoomDepth(room, 100).roomDepthMm).toBe(2207);
	});
});

describe("runYawRad", () => {
	it("turns the side wall onto the side it is on", () => {
		expect(runYawRad(lRoom("left"), 0)).toBe(0);
		expect(runYawRad(lRoom("left"), 1)).toBeCloseTo(Math.PI / 2);
		expect(runYawRad(lRoom("right"), 1)).toBeCloseTo(-Math.PI / 2);
	});
});
