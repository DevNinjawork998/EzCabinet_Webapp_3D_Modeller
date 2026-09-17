import { describe, expect, it } from "vitest";
import { measureDesign } from "../measureDesign";
import { buildRenderMesh } from "../renderMesh";
import { blindCornerObj, boxCabinetObj, cornerObj } from "./cornerMock";

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

	// Fix round 2: the square-front reading above is right, but it is right by
	// luck of the vote, not by certainty — the same tie, with a different set
	// of named boards, is the blind-corner bug below. A tied footprint always
	// carries the warning now, even when the depth-first reading happens to be
	// correct.
	it("gains the low-confidence note even though it measures correctly", () => {
		const box = boxCabinetObj({ widthMm: 600, heightMm: 600, depthMm: 350 });
		expect(measureDesign(box)?.notes).not.toHaveLength(0);
	});

	// SAME_EXTENT is a tolerance, not an exact match — pin that a near-square
	// front (2mm apart, well inside the 0.5% band) is still caught by the tie
	// check and flagged, even though it still measures correctly.
	it("still treats a near-square front (600 vs 602) as tied", () => {
		const box = boxCabinetObj({ widthMm: 600, heightMm: 602, depthMm: 350 });
		const measured = measureDesign(box);
		expect(measured).toMatchObject({
			widthMm: 600,
			heightMm: 602,
			depthMm: 350,
		});
		expect(measured?.notes).not.toHaveLength(0);
	});

	// Outside the tolerance, the tie check does not fire at all — this is what
	// makes the note specific to a genuine square coincidence rather than
	// noise on every cabinet whose width and height happen to be close.
	it("does not treat a clearly unequal front (600 vs 610) as tied", () => {
		const box = boxCabinetObj({ widthMm: 600, heightMm: 610, depthMm: 350 });
		const measured = measureDesign(box);
		expect(measured).toMatchObject({
			widthMm: 600,
			heightMm: 610,
			depthMm: 350,
		});
		expect(measured?.notes).toHaveLength(0);
	});
});

/**
 * Fix round 2: the square-footprint branch above declines when the smallest
 * axis does not strictly win the plate vote — correctly, for a real corner
 * whose named boards do not settle it either way. But the depth-first fallback
 * it declined into judged its own vote margin between the two *floor* axes,
 * never asking whether the footprint was tied in the first place, so a
 * genuinely ambiguous corner read on its back with a "decisive" vote and no
 * warning at all.
 */
describe("a blind corner the plate vote cannot settle", () => {
	it("is flagged rather than silently mis-measured", () => {
		const blind = blindCornerObj({
			sizeMm: 900,
			heightMm: 870,
			armMm: 600,
			legMm: 100,
		});
		const measured = measureDesign(blind);
		expect(measured).not.toBeNull();
		expect(measured?.notes).not.toHaveLength(0);
	});
});
