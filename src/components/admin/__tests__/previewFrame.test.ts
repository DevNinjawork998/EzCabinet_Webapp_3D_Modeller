import { describe, expect, it } from "vitest";
import { previewFrame } from "../previewFrame";

const dist = (a: number[], b: number[]) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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

	it("backs off in proportion to the largest dimension", () => {
		const small = previewFrame([400, 300, 360]);
		const big = previewFrame([800, 600, 720]);
		expect(dist(big.camera, big.target)).toBeCloseTo(
			2 * dist(small.camera, small.target),
		);
	});

	it("frames a tall unit by its height, not its width", () => {
		const base = previewFrame([600, 580, 870]);
		const tall = previewFrame([600, 580, 2400]);
		expect(
			dist(tall.camera, tall.target) / dist(base.camera, base.target),
		).toBeCloseTo(2400 / 870);
	});
});
