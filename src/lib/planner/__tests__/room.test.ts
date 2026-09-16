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

const kitchen = () => emptyRoom(4200);

describe("setShape", () => {
	it("an L adds an empty side wall and corner", () => {
		const room = engine.setShape(kitchen(), "left");
		expect(room.runs).toHaveLength(2);
		expect(room.corner).toEqual({ side: "left", floor: null, wall: null });
	});

	it("moves a cabinet already in the corner out of it", () => {
		const straight = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		const room = engine.setShape(straight, "left");
		expect(room.runs[0].floor[0].xMm).toBe(607);
	});

	it("refuses to go straight while the side wall holds a cabinet", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "s", 600, 1);
		expect(engine.setShape(room, "straight")).toBe(room);
		const cleared = engine.removeModule(room, "s");
		expect(engine.setShape(cleared, "straight").runs).toHaveLength(1);
	});

	it("refuses to go straight while the corner holds a unit", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(engine.setShape(room, "straight")).toBe(room);
	});
});

describe("setCornerSide", () => {
	it("keeps every cabinet the same distance from the corner", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 1000, "m", 600);
		room = engine.addModule(room, "base-cabinet", 1000, "s", 600, 1);
		const flipped = engine.setShape(room, "right");
		expect(flipped.corner?.side).toBe("right");
		expect(flipped.runs[0].floor[0].xMm).toBe(4200 - 1000 - 600);
		expect(flipped.runs[1].floor[0].xMm).toBe(3600 - 1000 - 600);
		expect(engine.isClear(flipped)).toBe(true);
	});
});

describe("corner units", () => {
	it("fill their row's slot and push both runs clear of the bigger square", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(room.corner?.floor?.familyId).toBe("corner-base");
		expect(room.runs[0].floor[0].xMm).toBe(900);
		expect(room.runs.flatMap((run) => run.floor)).toHaveLength(1);
	});

	it("go to the wall slot when they hang", () => {
		const room = engine.addModule(
			engine.setShape(kitchen(), "right"),
			"corner-wall",
			0,
			"cw",
		);
		expect(room.corner?.wall?.familyId).toBe("corner-wall");
		expect(room.corner?.floor).toBeNull();
	});

	it("are refused on a straight wall and in a full slot", () => {
		const straight = kitchen();
		expect(engine.addModule(straight, "corner-base", 0)).toBe(straight);
		expect(engine.fits(straight, "corner-base")).toBe(false);

		const full = engine.addModule(
			engine.setShape(kitchen(), "left"),
			"corner-base",
			0,
			"c",
		);
		expect(engine.addModule(full, "corner-base", 0, "d")).toBe(full);
		expect(engine.fits(full, "corner-base")).toBe(false);
	});

	it("are refused when a run cannot give way", () => {
		// A side wall packed from the front to the corner has nowhere to slide.
		let room = engine.setShape({ ...kitchen(), roomDepthMm: 2000 }, "right");
		room = engine.addModule(room, "base-cabinet", 607, "s1", 900, 1);
		room = engine.addModule(room, "base-cabinet", 1507, "s2", 400, 1);
		expect(engine.fits(room, "corner-base")).toBe(false);
	});

	it("sit at the corner end of the main wall, turned for a right corner", () => {
		const left = engine.addModule(
			engine.setShape(kitchen(), "left"),
			"corner-base",
			0,
			"c",
		);
		expect(engine.cornerPositions(left)[0]).toMatchObject({ xMm: 0 });
		expect(engine.cornerPositions(left)[0].placed.rotationDeg).toBeUndefined();

		const right = engine.setShape(left, "right");
		expect(engine.cornerPositions(right)[0]).toMatchObject({ xMm: 3300 });
		expect(engine.cornerPositions(right)[0].placed.rotationDeg).toBe(270);
	});

	it("are priced, listed and removed like any cabinet", () => {
		const room = engine.addModule(
			engine.setShape(kitchen(), "left"),
			"corner-base",
			0,
			"c",
		);
		expect(engine.allPositions(room).map((p) => p.placed.id)).toEqual(["c"]);
		expect(engine.widthOptionsFor(room, "c")).toEqual([
			{ widthMm: 900, priceRm: 1150, fits: true },
		]);
		expect(engine.removeModule(room, "c").corner?.floor).toBeNull();
		expect(setDoor(room, "c", "shaker").corner?.floor?.doorStyleId).toBe(
			"shaker",
		);
	});
});

describe("exposure beside the corner", () => {
	it("an empty corner leaves the end beside it in the open", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		expect(engine.exposureOf(room).get("a")?.left).toBe(true);
		expect(
			engine
				.endPanels(room)
				.some((p) => p.moduleId === "a" && p.side === "left"),
		).toBe(true);
	});

	it("a corner unit covers the end beside it and wears no panels itself", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(engine.exposureOf(room).get("a")?.left).toBe(false);
		expect(engine.exposureOf(room).get("c")).toEqual({
			left: false,
			right: false,
		});
		expect(engine.endPanels(room).some((p) => p.moduleId === "c")).toBe(false);
	});
});

describe("cornerWorktop", () => {
	it("is none on a straight wall or an L with no base beside the corner", () => {
		expect(engine.cornerWorktop(kitchen())).toBeNull();
		expect(engine.cornerWorktop(engine.setShape(kitchen(), "left"))).toBeNull();
	});

	it("closes an empty corner when a base unit meets it", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		expect(engine.cornerWorktop(room)).toEqual({ sizeMm: 607, topMm: 880 });
	});

	it("covers a corner base unit", () => {
		const room = engine.addModule(
			engine.setShape(kitchen(), "left"),
			"corner-base",
			0,
			"c",
		);
		expect(engine.cornerWorktop(room)).toEqual({ sizeMm: 900, topMm: 880 });
	});
});
