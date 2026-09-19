import { describe, expect, it } from "vitest";
import { clampPanTarget, panTargetMm, type RoomBoundsMm } from "../camera";
import type { WallFrame } from "../floorplan";
import type { Vec3Mm } from "../parts";

/** A 4.2m wall, a 3m deep room, a standard 2.7m ceiling, and a bare wall so
 * the whole floor is in bounds. */
const ROOM: RoomBoundsMm = {
	runWidthMm: 4200,
	roomDepthMm: 3000,
	ceilingHeightMm: 2700,
	runDepthMm: 0,
};

describe("clampPanTarget", () => {
	it("leaves a target already inside the room alone", () => {
		const inside = { x: 500, y: 1200, z: -400 };
		expect(clampPanTarget(inside, ROOM)).toEqual(inside);
	});

	it("clamps past either end of the run", () => {
		expect(clampPanTarget({ x: 9000, y: 0, z: 0 }, ROOM).x).toBe(2100);
		expect(clampPanTarget({ x: -9000, y: 0, z: 0 }, ROOM).x).toBe(-2100);
	});

	it("clamps below the floor and above the ceiling", () => {
		expect(clampPanTarget({ x: 0, y: -500, z: 0 }, ROOM).y).toBe(0);
		expect(clampPanTarget({ x: 0, y: 9000, z: 0 }, ROOM).y).toBe(2700);
	});

	it("clamps through the back wall and out of the open side", () => {
		// Not quite the wall itself: even a bare wall keeps the cabinets' gap.
		expect(clampPanTarget({ x: 0, y: 0, z: -9000 }, ROOM).z).toBe(-1495);
		expect(clampPanTarget({ x: 0, y: 0, z: 9000 }, ROOM).z).toBe(1500);
	});

	it("clamps every axis at once", () => {
		expect(clampPanTarget({ x: 9000, y: 9000, z: 9000 }, ROOM)).toEqual({
			x: 2100,
			y: 2700,
			z: 1500,
		});
	});

	// A run wider than the wall it stands against is what a customer building
	// past the end produces, and the clamp has to follow the run rather than
	// pin them to a wall they have already outgrown.
	it("follows the run width it is given", () => {
		const wide = { ...ROOM, runWidthMm: 8000 };
		expect(clampPanTarget({ x: 9000, y: 0, z: 0 }, wide).x).toBe(4000);
	});

	// The puck lies on the floor, and the floor under the cabinets is not floor
	// it can be dropped on: it would sit beneath a carcass that then takes the
	// pointer.
	it("keeps clear of the run's own footprint", () => {
		const withRun = { ...ROOM, runDepthMm: 600 };
		// Back wall at -1500, the 5mm wall gap, 600 of cabinet.
		expect(clampPanTarget({ x: 0, y: 0, z: -9000 }, withRun).z).toBe(-895);
		// The open side is unaffected.
		expect(clampPanTarget({ x: 0, y: 0, z: 9000 }, withRun).z).toBe(1500);
	});

	// A clamp whose minimum exceeds its maximum pins the pan to a single point,
	// which reads as the gizmo being broken rather than the layout being absurd.
	it("lets the room win when the run is deeper than the room", () => {
		const silly = { ...ROOM, roomDepthMm: 1000, runDepthMm: 4000 };
		expect(clampPanTarget({ x: 0, y: 0, z: -9000 }, silly).z).toBe(500);
		expect(clampPanTarget({ x: 0, y: 0, z: 9000 }, silly).z).toBe(500);
	});
});

const ALL = { x: true, y: true, z: true };
const IDENTITY: WallFrame = { yawRad: 0, xMm: 0, zMm: 0 };
/** A rectangle's left wall: turned a quarter, not moved. Its local +x runs
 * along world −z, its local +z (into the room) along world +x. */
const LEFT: WallFrame = { yawRad: Math.PI / 2, xMm: 0, zMm: 0 };
/** That wall's own box: 3.6m long, the room 4.2m out from it. */
const LEFT_ROOM: RoomBoundsMm = {
	...ROOM,
	runWidthMm: 3600,
	roomDepthMm: 4200,
};

const close = (actual: Vec3Mm, expected: Vec3Mm) => {
	expect(actual.x).toBeCloseTo(expected.x);
	expect(actual.y).toBeCloseTo(expected.y);
	expect(actual.z).toBeCloseTo(expected.z);
};

describe("panTargetMm", () => {
	it("is the plain mask and clamp on the back wall", () => {
		const point = { x: 9000, y: 1200, z: -9000 };
		const anchor = { x: 0, y: 0, z: 300 };
		close(
			panTargetMm(point, anchor, ALL, IDENTITY, ROOM),
			clampPanTarget(point, ROOM),
		);
		// The floor puck: y stays where the anchor is.
		close(
			panTargetMm(
				point,
				anchor,
				{ x: true, y: false, z: true },
				IDENTITY,
				ROOM,
			),
			clampPanTarget({ x: 9000, y: 0, z: -9000 }, ROOM),
		);
	});

	it("slides along a turned wall and stops at its ends", () => {
		const anchor = { x: 0, y: 0, z: 0 };
		// Dragged along world −z: along the left wall, clamped to its 3.6m.
		close(panTargetMm({ x: 0, y: 0, z: -9000 }, anchor, ALL, LEFT, LEFT_ROOM), {
			x: 0,
			y: 0,
			z: -1800,
		});
		close(panTargetMm({ x: 0, y: 0, z: 500 }, anchor, ALL, LEFT, LEFT_ROOM), {
			x: 0,
			y: 0,
			z: 500,
		});
	});

	it("masks in the wall's frame, not the world's", () => {
		// Elevation of the left wall: along it and up, never toward it. The
		// anchor's distance from that wall is world x, so x is what is kept.
		const anchor = { x: -500, y: 0, z: 0 };
		close(
			panTargetMm(
				{ x: 300, y: 1000, z: -700 },
				anchor,
				{ x: true, y: true, z: false },
				LEFT,
				LEFT_ROOM,
			),
			{ x: -500, y: 1000, z: -700 },
		);
	});
});
