import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import { emptyLayout, type PlannerLayout, plannerEngine } from "../layout";

/**
 * A corner reaches the one-wall engine as a reserved stretch of wall. These pin
 * that every existing rule treats it as one more neighbour — nothing about a
 * corner is special once it is a span.
 */
const engine = plannerEngine(PLANNER_CATALOGUE);

const cornered = (floorMm = 607, wallMm = 397): PlannerLayout => ({
	...emptyLayout(3000),
	reserved: {
		floor: [{ startMm: 0, endMm: floorMm }],
		wall: [{ startMm: 0, endMm: wallMm }],
	},
});

describe("a reserved corner span", () => {
	it("is where a cabinet dropped at the corner stops short of", () => {
		const next = engine.addModule(cornered(), "base-cabinet", 0, "a", 600);
		expect(next.floor[0].xMm).toBe(607);
	});

	it("stops a drag flush against it", () => {
		const placed = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		expect(engine.moveModule(placed, "a", 100).floor[0].xMm).toBe(607);
	});

	it("is per row: a wall unit stops at the wall row's corner", () => {
		const next = engine.addModule(cornered(), "wall-cabinet", 0, "w", 400);
		expect(next.wall[0].xMm).toBe(397);
	});

	it("keeps a dragged tall unit out of the hung row's corner too", () => {
		const placed = engine.addModule(
			cornered(300, 700),
			"tall-cabinet",
			1000,
			"t",
			600,
		);
		expect(engine.moveModule(placed, "t", 0).floor[0].xMm).toBe(700);
	});

	it("blocks the far end when the corner is on the right", () => {
		const layout: PlannerLayout = {
			...emptyLayout(3000),
			reserved: { floor: [{ startMm: 2393, endMm: 3000 }] },
		};
		const next = engine.addModule(layout, "base-cabinet", 2800, "a", 600);
		expect(next.floor[0].xMm).toBe(1793);
	});

	it("is the anchor a gap is measured to", () => {
		const placed = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		expect(engine.offsetsOf(placed, "a")).toMatchObject({
			leftAnchorMm: 607,
			leftMm: 393,
		});
	});

	it("is where closing the gaps packs from", () => {
		let layout = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		layout = engine.addModule(layout, "base-cabinet", 2000, "b", 600);
		expect(engine.closeGaps(layout).floor.map((m) => m.xMm)).toEqual([
			607, 1207,
		]);
	});

	it("makes a layout with a cabinet inside it impossible", () => {
		const layout: PlannerLayout = {
			...cornered(),
			floor: [
				{
					id: "a",
					familyId: "base-cabinet",
					widthMm: 600,
					doorStyleId: null,
					hinge: "left",
					xMm: 0,
				},
			],
		};
		expect(engine.isClear(layout)).toBe(false);
		expect(engine.isClear({ ...layout, reserved: undefined })).toBe(true);
	});

	it("is a snap target", () => {
		const placed = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		expect(engine.dropModule(placed, "a", 640).floor[0].xMm).toBe(607);
	});
});

describe("a corner at each end", () => {
	const both = (): PlannerLayout => ({
		...emptyLayout(3000),
		reserved: {
			floor: [
				{ startMm: 0, endMm: 607 },
				{ startMm: 2393, endMm: 3000 },
			],
			wall: [
				{ startMm: 0, endMm: 397 },
				{ startMm: 2603, endMm: 3000 },
			],
		},
	});

	it("stops a cabinet short of the far corner too", () => {
		const next = engine.addModule(both(), "base-cabinet", 2800, "a", 600);
		expect(next.floor[0].xMm).toBe(1793);
		expect(engine.isClear(next)).toBe(true);
	});

	it("packs from the corner at the start", () => {
		let next = engine.addModule(both(), "base-cabinet", 1500, "a", 600);
		next = engine.closeGaps(next);
		expect(next.floor[0].xMm).toBe(607);
	});
});

describe("end walls", () => {
	const flushLeft = (endWalls: { left: boolean; right: boolean }) =>
		engine.addModule(
			// `wallToWall` on, to show `endWalls` wins when both are given.
			{ ...emptyLayout(3000), wallToWall: true, endWalls },
			"base-cabinet",
			0,
			"a",
			600,
		);

	it("bury the end a wall stands at", () => {
		expect(
			engine.exposureOf(flushLeft({ left: true, right: true })).get("a")?.left,
		).toBe(false);
	});

	it("leave an end in the open where no wall stands", () => {
		expect(
			engine.exposureOf(flushLeft({ left: false, right: true })).get("a")?.left,
		).toBe(true);
	});
});
