import { WALL_GAP_MM } from "./catalogue";
import { toLocalMm, toWorldMm, type WallFrame } from "./floorplan";
import type { Vec3Mm } from "./parts";

/**
 * Where the camera is allowed to look.
 *
 * The box is drawn in the targeted wall's own frame: x runs along the wall
 * from the middle, y up from the floor, z out of that wall into the room. So
 * the box is the room as seen from that wall, and clamping to it is what stops a customer panning
 * until nothing is on screen but grey.
 */

export type RoomBoundsMm = {
	/** Along the wall. The *run's* width, not the wall's — a run built past
	 * the end of the wall still has to be reachable. */
	runWidthMm: number;
	roomDepthMm: number;
	ceilingHeightMm: number;
	/** The deepest cabinet standing on the floor, or 0 for a bare wall.
	 *
	 * The camera's handle is a puck lying on the floor, and the floor under the
	 * run is not floor you can put anything on — drag the puck in there and it
	 * ends up beneath a carcass, drawn over the top of it but with the carcass
	 * taking the pointer. Visible and unpressable is the worst state a control
	 * can be in, so the run's own footprint is out of bounds. What is left is
	 * the floor somebody could stand on. */
	runDepthMm: number;
};

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/**
 * The nearest point inside the room to the one asked for.
 *
 * Only the orbit *target* is clamped. The camera keeps its angle and distance
 * and is moved by the same correction, so a clamp reads as the pan running out
 * of room rather than as the view lurching.
 */
export function clampPanTarget(
	target: Vec3Mm,
	{ runWidthMm, roomDepthMm, ceilingHeightMm, runDepthMm }: RoomBoundsMm,
): Vec3Mm {
	const backZ = -roomDepthMm / 2;
	const frontZ = roomDepthMm / 2;
	// A run deeper than the room would invert the range, so the room wins. That
	// is a nonsense layout rather than a nonsense camera, and a clamp whose
	// minimum exceeds its maximum silently pins the pan to one point.
	const nearestZ = Math.min(backZ + WALL_GAP_MM + runDepthMm, frontZ);
	return {
		x: clamp(target.x, -runWidthMm / 2, runWidthMm / 2),
		y: clamp(target.y, 0, ceilingHeightMm),
		z: clamp(target.z, nearestZ, frontZ),
	};
}

/**
 * Where the orbit target goes when the puck is dragged to `point` (world mm).
 *
 * The view's axes and the room box both mean something only in the targeted
 * wall's frame, so both points are carried into it, each axis taken from
 * `point` where the view pans it and from `anchor` where it does not, clamped,
 * and carried back out.
 */
export function panTargetMm(
	point: Vec3Mm,
	anchor: Vec3Mm,
	axes: { x: boolean; y: boolean; z: boolean },
	frame: WallFrame,
	bounds: RoomBoundsMm,
): Vec3Mm {
	const p = toLocalMm(point, frame);
	const a = toLocalMm(anchor, frame);
	return toWorldMm(
		clampPanTarget(
			{ x: axes.x ? p.x : a.x, y: axes.y ? p.y : a.y, z: axes.z ? p.z : a.z },
			bounds,
		),
		frame,
	);
}
