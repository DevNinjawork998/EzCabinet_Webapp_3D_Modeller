import { describe, expect, it } from "vitest";
import { previewFrame } from "../previewFrame";

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V): V => {
	const l = Math.hypot(...a);
	return [a[0] / l, a[1] / l, a[2] / l];
};

/** The viewer's field of view is 40° vertical on a canvas wider than tall, so
 * ±tan(20°) on both axes is the conservative bound for "in frame". */
const HALF_FOV_TAN = Math.tan((20 * Math.PI) / 180);

/** Every corner of the cabinet, projected through the camera, lands inside
 * the frame. */
function fitsInFrame([w, d, h]: V): boolean {
	const { target, camera } = previewFrame([w, d, h]);
	const forward = unit(sub(target, camera));
	const right = unit(cross(forward, [0, 1, 0]));
	const up = cross(right, forward);
	for (const x of [-w / 2000, w / 2000])
		for (const y of [0, h / 1000])
			for (const z of [-d / 2000, d / 2000]) {
				const v = sub([x, y, z], camera);
				const depth = dot(v, forward);
				if (Math.abs(dot(v, up)) / depth > HALF_FOV_TAN) return false;
				if (Math.abs(dot(v, right)) / depth > HALF_FOV_TAN) return false;
			}
	return true;
}

describe("previewFrame", () => {
	it("targets the cabinet's mid-height on the origin, in metres", () => {
		// [width, depth, height] — RenderMesh.sizeMm's order.
		const { target } = previewFrame([800, 600, 720]);
		expect(target).toEqual([0, 0.36, 0]);
	});

	it("puts the camera in front of and above the target", () => {
		const { target, camera } = previewFrame([800, 600, 720]);
		expect(camera[2]).toBeGreaterThan(target[2]);
		expect(camera[1]).toBeGreaterThan(target[1]);
	});

	it.each([
		["a base unit", [600, 580, 870]],
		["a wide wall unit", [1200, 350, 720]],
		["a tall unit", [600, 580, 2400]],
		["a 300mm filler", [300, 580, 870]],
		// The shapes a largest-dimension rule clipped: a near-cube needs more
		// room than its longest side suggests.
		["a corner base unit", [900, 900, 870]],
		["a corner wall unit", [600, 600, 720]],
		["a cube", [800, 800, 800]],
	] as const)("keeps all of %s in frame", (_, size) => {
		expect(fitsInFrame([...size])).toBe(true);
	});
});
