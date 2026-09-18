/**
 * Where the planner's gizmos sit relative to the floor.
 *
 * Pure arithmetic, deliberately out of `PlannerScene.tsx`: the placement rule
 * below has a boundary, the boundary was wrong, and a component that pulls in
 * three.js and drei cannot be checked in a plain node test. Same split as
 * `grain.ts`.
 */

/** A hair above the floor, so a gizmo sits on it rather than in it. */
export const PUCK_LIFT = 0.012;

/**
 * How far below its own underside a hung cabinet's handle sits. The drop is
 * what makes the handle read as belonging to the cabinet above it rather than
 * to whatever stands beneath it.
 */
export const HANDLE_DROP = 0.14;

/** Where the two ↻ heads orbit the move disc, and the circumradius of the
 * triangle drawn at each one. */
export const HANDLE_HEAD_R = 0.165;
export const HANDLE_HEAD_TIP = 0.03;

/**
 * How far the handle reaches from its centre.
 *
 * Not the rotate ring's 0.185 outer edge, which is the number this looks like
 * it ought to be. A three-segment `circleGeometry` puts its first vertex at
 * theta zero, and each head is turned to face radially outward, so a head's
 * tip lands a full `HANDLE_HEAD_TIP` past its own orbit — 10mm beyond the
 * ring. The tips are what has to clear the floor, so the tips are what this
 * measures. Resize the ring, the orbit or the heads and this follows.
 */
export const HANDLE_REACH = HANDLE_HEAD_R + HANDLE_HEAD_TIP;

/**
 * Where a cabinet's handle centres, given the height of its underside.
 *
 * A cabinet standing on the floor gets its handle lying flat on the floor in
 * front of it, where its reach is horizontal and the floor is no threat. A
 * lifted one gets it standing upright, hung `HANDLE_DROP` below its own
 * underside — and that is where the floor comes in, because upright the handle
 * reaches `HANDLE_REACH` *below* that centre while the floor is an opaque,
 * depth-tested plane at exactly zero.
 *
 * Unclamped this buried the handle. Every family's `floorHeightMm` starts at
 * zero and the floor row's hang range is continuous from there, so "lifted"
 * was true of a one-millimetre nudge: the handle stood up, dropped 140mm below
 * an underside still on the floor, and the floor sliced the ring in half. Any
 * lift under `HANDLE_DROP + HANDLE_REACH + PUCK_LIFT` did it.
 *
 * Clamped, the handle parks a hair above the boards until the cabinet is high
 * enough to hang it properly, and tracks the underside from there.
 */
export const handleCentreM = (floorHeightMm: number): number =>
	floorHeightMm > 0
		? Math.max(floorHeightMm / 1000 - HANDLE_DROP, HANDLE_REACH + PUCK_LIFT)
		: PUCK_LIFT;
