import { describe, expect, it } from "vitest";
import { measureDesign } from "../measureDesign";
import { buildRenderMesh } from "../renderMesh";
import { boxCabinetObj, cornerObj } from "./cornerMock";

/**
 * EzCabinet has not drawn a corner unit yet. The mock stands in for one, in
 * their own part naming, so the upload path can be exercised end to end. These
 * pin that it reads as the thing it pretends to be.
 */
const base = cornerObj({ sizeMm: 900, heightMm: 870, armMm: 600, legMm: 100 });

describe("the mock corner base", () => {
	it("measures as a square unit", () => {
		const measured = measureDesign(base);
		expect(measured).toMatchObject({
			widthMm: 900,
			heightMm: 870,
			depthMm: 900,
		});
	});

	it("classifies its fronts, so the finish picker and door toggle reach them", () => {
		const roles =
			buildRenderMesh(base)?.groups.map((group) => group.role) ?? [];
		expect(roles).toContain("door");
		expect(roles).toContain("carcass");
	});
});

describe("the mock corner wall unit", () => {
	const wall = cornerObj({ sizeMm: 600, heightMm: 720, armMm: 350, legMm: 0 });

	it("measures with width and depth in the right slots", () => {
		expect(measureDesign(wall)).toMatchObject({
			widthMm: 600,
			heightMm: 720,
			depthMm: 600,
		});
	});
});

describe("the render mesh of a corner base", () => {
	it("stands up, sized [width, depth, height]", () => {
		expect(buildRenderMesh(base)?.sizeMm).toEqual([900, 900, 870]);
	});
});

/**
 * Fix round 1: the square-footprint branch above used to fire on any tie
 * between the two largest extents, with no check for which pair is actually
 * the floor plan. An ordinary box cabinet whose width and height happen to
 * match — a 600×600 or 900×900 base unit, both deeper than 350mm — ties the
 * same two extents without being a corner at all, and used to read on its
 * back exactly like the bug this branch was meant to fix. These pin that the
 * plate vote, not the tie alone, decides it.
 */
describe("an ordinary box cabinet with a square front", () => {
	it("measures 600 wide, 600 tall, 350 deep — not laid on its back", () => {
		const box = boxCabinetObj({ widthMm: 600, heightMm: 600, depthMm: 350 });
		expect(measureDesign(box)).toMatchObject({
			widthMm: 600,
			heightMm: 600,
			depthMm: 350,
		});
	});

	it("measures 900 wide, 900 tall, 350 deep — not laid on its back", () => {
		const box = boxCabinetObj({ widthMm: 900, heightMm: 900, depthMm: 350 });
		expect(measureDesign(box)).toMatchObject({
			widthMm: 900,
			heightMm: 900,
			depthMm: 350,
		});
	});

	it("still measures an ordinary non-square box correctly", () => {
		const box = boxCabinetObj({ widthMm: 600, heightMm: 720, depthMm: 350 });
		expect(measureDesign(box)).toMatchObject({
			widthMm: 600,
			heightMm: 720,
			depthMm: 350,
		});
	});

	it("still measures a tall unit with a square footprint correctly", () => {
		const box = boxCabinetObj({ widthMm: 600, heightMm: 2100, depthMm: 600 });
		expect(measureDesign(box)).toMatchObject({
			widthMm: 600,
			heightMm: 2100,
			depthMm: 600,
		});
	});
});
