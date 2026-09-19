import { describe, expect, it } from "vitest";
import {
	type FloorPlan,
	frameOf,
	nearestWall,
	outlineOf,
	planIsValid,
	reshape,
	setWallLength,
	shapeOf,
	toLocalMm,
	toWorldMm,
	transferTarget,
	vertexKind,
	wallLabelMm,
	wallsOf,
} from "../floorplan";

const rect: FloorPlan = { template: "rect", widthMm: 4200, depthMm: 3600 };
// The IKEA screenshot: 5500 wide, 5075 deep, 1500 × 3000 notch front-right.
const l: FloorPlan = {
	template: "l",
	widthMm: 5500,
	depthMm: 5075,
	notchWidthMm: 1500,
	notchDepthMm: 3000,
	mirror: false,
};
const lMirror: FloorPlan = { ...l, mirror: true };

const lengths = (plan: FloorPlan) => wallsOf(plan).map((w) => w.lengthMm);
const kinds = (plan: FloorPlan) =>
	wallsOf(plan).map((_, i) => vertexKind(plan, i));

describe("wallsOf", () => {
	it("walks a rectangle back, right, front, left", () => {
		expect(lengths(rect)).toEqual([4200, 3600, 4200, 3600]);
		const [back, right, , left] = wallsOf(rect);
		expect(back.startMm).toEqual({ xMm: -2100, zMm: -1800 });
		expect(back.inward.zMm).toBeCloseTo(1);
		expect(right.inward.xMm).toBeCloseTo(-1);
		expect(left.inward.xMm).toBeCloseTo(1);
	});

	it("labels a wall at its midpoint, pushed into the room", () => {
		const [back] = wallsOf(rect);
		expect(wallLabelMm(back, 300)).toEqual({ xMm: 0, zMm: -1500 });
	});

	it("chains every wall's end to the next wall's start", () => {
		for (const plan of [rect, l, lMirror]) {
			const walls = wallsOf(plan);
			walls.forEach((wall, i) => {
				expect(walls[(i + 1) % walls.length].startMm).toEqual(wall.endMm);
			});
		}
	});

	it("gives each wall the room's extent out from it", () => {
		expect(wallsOf(rect).map((w) => w.depthMm)).toEqual([
			3600, 4200, 3600, 4200,
		]);
		// The notch's top wall faces the upper area only.
		expect(wallsOf(l)[2].depthMm).toBe(2075);
	});

	it("turns the side walls the way the L's side run used to turn", () => {
		const walls = wallsOf(rect);
		expect(walls[0].yawRad).toBeCloseTo(0);
		expect(walls[1].yawRad).toBeCloseTo(-Math.PI / 2);
		expect(walls[3].yawRad).toBeCloseTo(Math.PI / 2);
	});

	it("cuts the notch from the front right, or front left when mirrored", () => {
		expect(lengths(l)).toEqual([5500, 2075, 1500, 3000, 4000, 5075]);
		expect(lengths(lMirror)).toEqual([5500, 5075, 4000, 3000, 1500, 2075]);
	});
});

describe("vertexKind", () => {
	it("is inside at every corner of a rectangle", () => {
		expect(kinds(rect)).toEqual(["inside", "inside", "inside", "inside"]);
	});

	it("is outside at the notch's inner corner only", () => {
		expect(kinds(l)).toEqual([
			"inside",
			"inside",
			"outside",
			"inside",
			"inside",
			"inside",
		]);
		expect(kinds(lMirror).indexOf("outside")).toBe(3);
		expect(kinds(lMirror).filter((k) => k === "outside")).toHaveLength(1);
	});
});

describe("frames", () => {
	it("needs no translation for a rectangle's walls", () => {
		for (const wall of wallsOf(rect)) {
			const frame = frameOf(wall);
			expect(frame.xMm).toBeCloseTo(0);
			expect(frame.zMm).toBeCloseTo(0);
		}
	});

	it("puts a run's wall line on its wall", () => {
		for (const plan of [rect, l, lMirror]) {
			for (const wall of wallsOf(plan)) {
				const p = toWorldMm(
					{ x: 0, y: 0, z: -wall.depthMm / 2 },
					frameOf(wall),
				);
				expect(p.x).toBeCloseTo((wall.startMm.xMm + wall.endMm.xMm) / 2);
				expect(p.z).toBeCloseTo((wall.startMm.zMm + wall.endMm.zMm) / 2);
			}
		}
	});

	it("round-trips a point", () => {
		const frame = frameOf(wallsOf(l)[3]);
		const back = toLocalMm(toWorldMm({ x: 120, y: 900, z: -40 }, frame), frame);
		expect(back.x).toBeCloseTo(120);
		expect(back.y).toBeCloseTo(900);
		expect(back.z).toBeCloseTo(-40);
	});
});

describe("setWallLength", () => {
	it("moves the parameter the wall is made of", () => {
		expect(setWallLength(rect, 2, 5000)).toMatchObject({ widthMm: 5000 });
		expect(setWallLength(rect, 3, 3000)).toMatchObject({ depthMm: 3000 });
		expect(setWallLength(l, 4, 4500)).toMatchObject({ notchWidthMm: 1000 });
		expect(setWallLength(l, 1, 2500)).toMatchObject({ notchDepthMm: 2575 });
		expect(setWallLength(lMirror, 5, 2500)).toMatchObject({
			notchDepthMm: 2575,
		});
	});

	it("clamps so the room never pinches shut", () => {
		expect(setWallLength(rect, 0, 500)).toMatchObject({ widthMm: 1000 });
		// A notch as wide as the room leaves no leg.
		expect(setWallLength(l, 2, 5000)).toMatchObject({ notchWidthMm: 4500 });
		expect(lengths(setWallLength(l, 2, 5000))[4]).toBe(1000);
	});
});

describe("planIsValid", () => {
	it("accepts what clampPlan leaves alone and refuses the rest", () => {
		expect(planIsValid(rect)).toBe(true);
		expect(planIsValid(l)).toBe(true);
		expect(planIsValid({ ...l, notchWidthMm: 5000 })).toBe(false);
		expect(planIsValid({ ...rect, widthMm: 4200.5 })).toBe(false);
	});
});

describe("reshape", () => {
	it("keeps the back wall and gives a new L a half-size notch", () => {
		expect(reshape(rect, "l")).toEqual({
			template: "l",
			widthMm: 4200,
			depthMm: 3600,
			notchWidthMm: 2100,
			notchDepthMm: 1800,
			mirror: false,
		});
		expect(shapeOf(reshape(l, "l-mirror"))).toBe("l-mirror");
		expect(reshape(l, "rect")).toEqual({
			template: "rect",
			widthMm: 5500,
			depthMm: 5075,
		});
	});
});

describe("outlineOf", () => {
	it("pushes every corner out by the scribe", () => {
		expect(outlineOf(rect, 5)[0]).toEqual({ xMm: -2105, zMm: -1805 });
		// The notch's inner corner moves into the notch, away from the room.
		expect(outlineOf(l, 5)[3]).toEqual({ xMm: 1255, zMm: -457.5 });
	});
});

describe("nearestWall", () => {
	it("reads a floor point as a wall and a distance along it", () => {
		// The left wall runs from the front (z = 1800) to the back.
		expect(nearestWall(rect, { xMm: -2000, zMm: 1000 })).toEqual({
			run: 3,
			xMm: 800,
		});
		expect(nearestWall(rect, { xMm: 100, zMm: -1700 })).toEqual({
			run: 0,
			xMm: 2200,
		});
	});
});

describe("transferTarget", () => {
	it("hands a drop to the wall it lands nearest, unless that is its own", () => {
		expect(transferTarget(rect, 0, { xMm: -2000, zMm: 1000 })).toEqual({
			run: 3,
			xMm: 800,
		});
		expect(transferTarget(rect, 3, { xMm: -2000, zMm: 1000 })).toBeNull();
	});
});
