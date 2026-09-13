import type { Positioned } from "./layout";

/**
 * Which outer sides of a cabinet nothing sits against.
 *
 * A real run is finished where it can be seen: the cabinet at the end of a
 * row gets a veneered end panel matching the doors, while the sides buried
 * between neighbours stay plain carcass board nobody will ever look at. The
 * scene drew every side as melamine, which made the most camera-facing surface
 * in the default 3/4 view the one wrong material in the picture.
 *
 * A neighbour is not the only thing that can bury a side: so can a wall. Pass
 * `EndWalls` and the run's two outer ends stop counting as exposed, which is
 * what a kitchen built into an alcove actually looks like.
 *
 * Pure, and framework-free per `lib/planner`: it reads a row the way
 * `positionsOf` already hands it over — sorted left to right — and answers a
 * question about neighbours, not about geometry.
 */

/**
 * Positions are computed from widths and drag offsets, so two cabinets that
 * are touching can differ by a fraction of a millimetre. Anything under this
 * is the same edge.
 */
const TOUCHING_MM = 1;

export type ExposedSides = { left: boolean; right: boolean };

/**
 * The return walls at the ends of the run, when the room has them.
 *
 * A cabinet against a wall has its side buried, so it needs no end panel even
 * though no cabinet sits next to it. Without this the run's two outer ends are
 * always reported exposed, and a kitchen built into an alcove gets veneer — and
 * a charge — for two faces nobody can see.
 */
export type EndWalls = { wallWidthMm: number; enclosed: boolean };

/** Both sides — what a cabinet standing on its own wears. */
export const FULLY_EXPOSED: ExposedSides = { left: true, right: true };

/**
 * `positions` must be one row, sorted left to right — which is exactly what
 * `positionsOf` returns. Passing both rows mixed together would have a wall
 * unit hide a base unit's end panel, and they are at different heights.
 */
export function exposedSides(
	positions: Positioned[],
	index: number,
	/** Omit when the run's ends stand in open space, which is the default. */
	walls?: EndWalls,
	/** How close counts as touching. The engine passes one board's thickness:
	 * a gap too narrow to take a panel shows no drilled side anyone can see. */
	touchingMm = TOUCHING_MM,
): ExposedSides {
	const self = positions[index];
	if (!self) return FULLY_EXPOSED;

	const selfEnd = self.xMm + self.widthMm;

	// Every other cabinet in the row is a candidate, not just index ± 1: a row
	// is sorted by `xMm`, but a zero-width gap is not guaranteed to be with the
	// immediate neighbour once cabinets have been dragged around.
	let left = true;
	let right = true;
	for (let i = 0; i < positions.length; i++) {
		if (i === index) continue;
		const other = positions[i];
		const otherEnd = other.xMm + other.widthMm;
		if (Math.abs(otherEnd - self.xMm) <= touchingMm) left = false;
		if (Math.abs(other.xMm - selfEnd) <= touchingMm) right = false;
	}

	// A wall buries a side exactly as a neighbour does, and the same tolerance
	// decides it: these are the run's own end coordinates, so "touching" here
	// means the same thing it means between two cabinets.
	if (walls?.enclosed) {
		if (Math.abs(self.xMm) <= touchingMm) left = false;
		if (Math.abs(walls.wallWidthMm - selfEnd) <= touchingMm) right = false;
	}

	return { left, right };
}

/** Clear space beside a cabinet, millimetres. Unbounded where nothing stands
 * there — the run's own end, in a room with no return wall. */
export type SideGaps = { left: number; right: number };

/** Nothing on either side — what a cabinet standing on its own has. */
export const UNBOUNDED_GAPS: SideGaps = {
	left: Number.POSITIVE_INFINITY,
	right: Number.POSITIVE_INFINITY,
};

/**
 * How much room a cabinet has on each side before it reaches its neighbour.
 *
 * `exposedSides` answers the same question as a yes or no, which is all an end
 * panel needs: veneer the side or do not. A door needs the distance. A leaf
 * swings past its own stile — a 444mm leaf reaches 152mm beyond it at 110° —
 * so whether it fouls what is next to it is a matter of how far away that is,
 * not whether it happens to be touching. Slide a cabinet 50mm clear and the
 * boolean flips to "exposed" while the doors still collide.
 *
 * Infinity rather than a large number, so a caller can compare against it
 * without knowing how wide the room is.
 */
export function sideGapsMm(
	positions: Positioned[],
	index: number,
	/** Omit when the run's ends stand in open space, which is the default. */
	walls?: EndWalls,
): SideGaps {
	const self = positions[index];
	if (!self) {
		return {
			left: Number.POSITIVE_INFINITY,
			right: Number.POSITIVE_INFINITY,
		};
	}

	const selfEnd = self.xMm + self.widthMm;
	let left = Number.POSITIVE_INFINITY;
	let right = Number.POSITIVE_INFINITY;

	// Every other cabinet is a candidate, not just index ± 1 — the same reason
	// `exposedSides` scans them all: a dragged cabinet can leave the nearest
	// neighbour somewhere else in the array.
	for (let i = 0; i < positions.length; i++) {
		if (i === index) continue;
		const other = positions[i];
		const otherEnd = other.xMm + other.widthMm;
		if (otherEnd <= self.xMm + TOUCHING_MM) {
			left = Math.min(left, Math.max(0, self.xMm - otherEnd));
		}
		if (other.xMm >= selfEnd - TOUCHING_MM) {
			right = Math.min(right, Math.max(0, other.xMm - selfEnd));
		}
	}

	// A return wall bounds a side exactly as a neighbour does.
	if (walls?.enclosed) {
		left = Math.min(left, Math.max(0, self.xMm));
		right = Math.min(right, Math.max(0, walls.wallWidthMm - selfEnd));
	}

	return { left, right };
}
