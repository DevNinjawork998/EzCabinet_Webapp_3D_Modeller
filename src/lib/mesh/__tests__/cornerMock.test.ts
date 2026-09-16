import { describe, expect, it } from "vitest";
import { measureDesign } from "../measureDesign";
import { buildRenderMesh } from "../renderMesh";
import { cornerObj } from "./cornerMock";

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
