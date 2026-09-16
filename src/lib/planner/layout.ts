import {
	CEILING_LIMITS,
	CEILING_TRIM_MM,
	type Construction,
	constructionOf,
	DEFAULT_CEILING_MM,
	DEFAULT_ROOM_DEPTH_MM,
	defaultWidthMmIn,
	type Family,
	familyIn,
	type ModuleKind,
	ROOM_DEPTH_LIMITS,
	WALL_CABINET_FLOOR_MM,
	WALL_HANG_LIMITS,
} from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import { type ExposedSides, exposedSides } from "./exposure";
import { standOf } from "./parts";

/**
 * A kitchen is a run along one wall, in two rows: things standing on the floor
 * and things hanging above them.
 *
 * Every cabinet stores **where it is**, not just what order it is in. An
 * earlier version derived each position by packing the row left to right, and
 * the result was a planner you could reorder but never actually arrange: a
 * wall cabinet could not be put in the gap above the base run, because packing
 * decided where it went. Position is the thing the customer is choosing, so it
 * is the thing the document stores.
 *
 * What the layout still guarantees is that a position is *buildable*:
 * `clampX` stops a cabinet against its neighbours and the wall, so overlap is
 * unrepresentable. Gaps are allowed — a kitchen has appliances and windows —
 * and `closeGaps` packs the run again on request.
 *
 * Pure: the UI holds a `PlannerLayout` and calls these.
 */

export type PlacedModule = {
	id: string;
	familyId: string;
	/**
	 * The size the customer chose, from the family's ladder. Width lives on the
	 * cabinet rather than on the product so one can be dropped in and then
	 * resized — which is the whole point of the size dropdown.
	 */
	widthMm: number;
	/** The door on it, or `null` for a bare carcass, which is how it starts. */
	doorStyleId: string | null;
	/**
	 * Which stile the door hangs on, so it swings the way the customer wants it
	 * to. A real spec, not a view setting — a fitter has to be told, so it lives
	 * in the document and rides through to the SKU list.
	 *
	 * Only a single-leaf cabinet gets a choice. A pair always hinges outward from
	 * the middle, which is the only way a pair is ever hung.
	 */
	hinge: HingeSide;
	/** Left edge of the carcass, from the left end of the run. */
	xMm: number;
	/**
	 * This one cabinet's underside height, when the customer has raised or
	 * lowered it away from the row. Absent means "hangs with the row", which
	 * is what every wall unit does until somebody drags its arrow — a real
	 * override and an unset one have to stay distinguishable, so this is
	 * optional rather than defaulted to the row's height.
	 *
	 * Ignored in ceiling mode: lining the tops up is the whole point of that
	 * mode, and it wins.
	 */
	hangAtMm?: number;
	/**
	 * Yaw about the cabinet's own vertical centre axis, in whole degrees,
	 * counter-clockwise seen from above. Absent means zero — square to the wall,
	 * facing the room, which is how every cabinet has ever been placed.
	 *
	 * Absent rather than defaulted to `0` for the same reason `hangAtMm` is:
	 * a turned cabinet leaves the counter run (see `inRun`), and a stored zero
	 * would be an override that changes nothing yet reads as one.
	 */
	rotationDeg?: number;
};

/** The stile a door hangs on. Left is what the scene has always drawn — a lone
 * leaf with its handle on the right. */
export type HingeSide = "left" | "right";

export type PlannerLayout = {
	wallWidthMm: number;
	/** Front-to-back room depth — the customer's, not a catalogue figure. */
	roomDepthMm: number;
	/** Floor to ceiling. Also the customer's; see `setCeilingHeight`. */
	ceilingHeightMm: number;
	/** Underside of the wall cabinets. They line up, as a real kitchen does.
	 *  Only read directly when `wallToCeiling` is off — `hangingHeightMmOf` is
	 *  what decides where the row actually sits. */
	hangingHeightMm: number;
	/**
	 * Run the wall units up to the ceiling instead of hanging them at a fixed
	 * height. The stored `hangingHeightMm` is kept rather than overwritten, so
	 * switching back gives the customer their own figure and not the default.
	 */
	wallToCeiling: boolean;
	/**
	 * Cover the base units' legs with a kick board. On by default because it is
	 * how a finished kitchen looks and what most customers picture — but some
	 * want the levellers showing, so it is theirs to turn off.
	 */
	baseSkirting: boolean;
	/**
	 * Close the leftover at each end of the run with a scribed filler board, the
	 * way a kitchen built into an alcove is finished. Off by default: a run that
	 * stops short of both walls is perfectly normal, and this is the customer's
	 * call about their room, not something to assume.
	 */
	wallToWall: boolean;
	/** Floor row: base and tall units. */
	floor: PlacedModule[];
	/** Hung row. */
	wall: PlacedModule[];
	/**
	 * Stretches of this wall a corner has taken, per row. Only set on a run view
	 * built by `room.ts`; a straight wall has none. They enter `occupiedSpans`,
	 * so everything that settles against a neighbour — clamping, snapping, gaps,
	 * `isClear` — treats a corner as one more neighbour and needs no rule of
	 * its own.
	 */
	reserved?: Partial<Record<Row, Span>>;
};

export type Row = "floor" | "wall";

export type Span = { startMm: number; endMm: number };

/** Where a cabinet sits: the clear gap either side of it, and what the gap
 * runs to — a neighbour's edge, or the wall. See `offsetsOf`. */
export type Offsets = {
	leftMm: number;
	rightMm: number;
	/** x the left gap runs back to: a neighbour's right edge, or 0. */
	leftAnchorMm: number;
	/** x the right gap runs out to: a neighbour's left edge, or the wall. */
	rightAnchorMm: number;
	/** Underside off the floor. Only a hung cabinet has one to report. */
	floorMm: number | null;
};

/** Land exactly on an edge within this of it, when a drag is released. */
export const SNAP_MM = 60;

/** Land exactly on an eighth-turn within this of it. Generous, because a
 *  rotation is dragged with a thumb and almost every one is reaching for
 *  square — the angles in between are the rare case, not the target. */
export const ROTATION_SNAP_DEG = 6;

/** Tall units stand floor-to-ceiling, so they live in the floor row. */
export const rowFor = (kind: ModuleKind): Row =>
	kind === "wall" ? "wall" : "floor";

export const emptyLayout = (
	wallWidthMm: number,
	roomDepthMm: number = DEFAULT_ROOM_DEPTH_MM,
	ceilingHeightMm: number = DEFAULT_CEILING_MM,
): PlannerLayout => ({
	wallWidthMm,
	roomDepthMm,
	ceilingHeightMm,
	hangingHeightMm: WALL_CABINET_FLOOR_MM,
	wallToCeiling: false,
	baseSkirting: true,
	wallToWall: false,
	floor: [],
	wall: [],
});

export type Positioned = {
	placed: PlacedModule;
	family: Family;
	/** Copied off the instance, so callers never reach for a type's width. */
	widthMm: number;
	xMm: number;
};

const isPositioned = (p: Positioned | null): p is Positioned => p !== null;

/**
 * Whether a floor cabinet is still part of the counter run.
 *
 * One that has been lifted off the floor or turned off the wall is a thing
 * standing on its own: no worktop crosses it, no kick board runs under it, and
 * nothing on the floor grounds it. It has to be one predicate rather than a
 * test repeated per consumer, because the slab that is drawn and the slab that
 * is billed have to be the same slab — `skirtingSpans` reads it here and
 * `Worktop` reads it in the scene.
 *
 * A cabinet whose *family* stands off the floor is not what this asks about:
 * a raised catalogue `floorHeightMm` is how that family is always fitted, kick
 * board included, so only the customer's own override counts.
 */
export const inRun = (position: Positioned): boolean =>
	position.placed.hangAtMm === undefined && !position.placed.rotationDeg;

/**
 * How far a turn pushes a cabinet past its own width, on each side.
 *
 * Square to the wall, a cabinet occupies exactly its width along it. Turn it
 * and its *depth* starts to count: a box yawed by θ has a footprint spanning
 * `|w·cosθ| + |d·sinθ|`, and because it turns about its own centre the extra
 * is shared equally either side.
 *
 * This is what stops a turned cabinet eating into a side wall. `clampToWall`
 * is the only thing standing between the run and the room, and it was written
 * in widths — so at the end of the run a turned carcass swung its corner
 * straight through the wall, since by its width it was still inside.
 *
 * Zero for every cabinet that has not been turned, which is why the rest of
 * the placement arithmetic can stay written in widths.
 */
export function spreadMm(position: Positioned): number {
	const deg = position.placed.rotationDeg;
	if (!deg) return 0;

	const rad = (deg * Math.PI) / 180;
	const spanMm =
		Math.abs(position.widthMm * Math.cos(rad)) +
		Math.abs(position.family.depthMm * Math.sin(rad));
	return (spanMm - position.widthMm) / 2;
}

/**
 * How far a turn pushes a cabinet back past its own depth.
 *
 * `spreadMm`'s other half. That one answers what a turn costs *along* the
 * wall; this one answers what it costs *into* it, and the cabinet needs both
 * because it spins about its own centre — which sits only half its depth off
 * the wall. A 900-wide, 607-deep carcass turned square occupies 900mm of
 * depth about a centre 303mm out, so 147mm of it ends up behind the wall
 * plane. Nothing was stopping that: `clampToWall` is written in x, and in x
 * the cabinet was still inside.
 *
 * The scene adds this to the back-to-centre offset, which slides the carcass
 * forward until its turned corner just clears the wall — which is where a real
 * one would end up, because you cannot push a corner into brick.
 *
 * Zero for every cabinet that has not been turned, so an untouched run sits
 * exactly where it always did.
 */
export function depthSpreadMm(
	widthMm: number,
	depthMm: number,
	rotationDeg: number | undefined,
): number {
	if (!rotationDeg) return 0;
	const rad = (rotationDeg * Math.PI) / 180;
	const spanMm =
		Math.abs(depthMm * Math.cos(rad)) + Math.abs(widthMm * Math.sin(rad));
	return (spanMm - depthMm) / 2;
}

const clampToWall = (xMm: number, widthMm: number, wallWidthMm: number) =>
	Math.min(Math.max(0, xMm), Math.max(0, wallWidthMm - widthMm));

function overlapsAnything(
	xMm: number,
	widthMm: number,
	spans: Span[],
): boolean {
	return spans.some((span) => xMm < span.endMm && xMm + widthMm > span.startMm);
}

let counter = 0;
/** ponytail: a counter is enough for a client-side planner; swap for nanoid
 * when layouts start being saved and merged. */
export const newId = () => `m${++counter}`;

const find = (
	layout: PlannerLayout,
	id: string,
): { row: Row; placed: PlacedModule } | null => {
	for (const row of ["floor", "wall"] as const) {
		const placed = layout[row].find((module) => module.id === id);
		if (placed) return { row, placed };
	}
	return null;
};

/**
 * Whether this cabinet has a height of its own to drag.
 *
 * Every cabinet does. A base unit lifted off the floor is a valid thing to
 * want — a floating vanity, a raised oven housing, a run stepped over a skirting
 * board — and the customer expects to be able to ask for it, so the vertical
 * axis is granted to both rows.
 *
 * The one refusal is ceiling mode: it aligns the wall row's *tops*, so a
 * per-cabinet underside has nothing to say there and `floorHeightMmOf` would
 * overrule it anyway.
 *
 * The scene needs the same answer `dragModule` acts on — a handle that stands
 * up and offers an axis the engine has stopped granting is worse than no
 * handle — so the rule lives here once and both read it.
 */
export const canHangAt = (layout: PlannerLayout, id: string): boolean => {
	const found = find(layout, id);
	if (!found) return false;
	return found.row === "wall" ? !layout.wallToCeiling : true;
};

const withX = (
	layout: PlannerLayout,
	row: Row,
	id: string,
	xMm: number,
): PlannerLayout => ({
	...layout,
	[row]: layout[row].map((module) =>
		module.id === id ? { ...module, xMm } : module,
	),
});

/** One finished panel over one cabinet side that nothing hides. */
export type EndPanel = {
	row: Row;
	moduleId: string;
	side: "left" | "right";
	kind: ModuleKind;
};

/** One kick board: an unbroken stretch of floor units, and how tall the board
 *  over them has to be. */
export type SkirtingSpan = {
	startMm: number;
	endMm: number;
	/** As tall as whatever the cabinets in this stretch stand on. */
	heightMm: number;
	/** Deepest carcass over this stretch — how far forward the board may reach. */
	depthMm: number;
	/** How far back from the carcass front the board's face sits. */
	recessMm: number;
};

/**
 * How long a wall the planner will accept. Wide enough for a real kitchen wall,
 * narrow enough that a mistyped figure does not produce a room you cannot see.
 */
export const WALL_LIMITS = { minMm: 1000, maxMm: 12000 } as const;

/** Put a door on a carcass, or take it off again with `null`. */
export function setDoor(
	layout: PlannerLayout,
	id: string,
	doorStyleId: string | null,
): PlannerLayout {
	const found = find(layout, id);
	if (!found) return layout;

	return {
		...layout,
		[found.row]: layout[found.row].map((module) =>
			module.id === id ? { ...module, doorStyleId } : module,
		),
	};
}

/** Hang a door on the other stile. Kept off `setDoor` because a customer flips
 * the swing of a door they have already chosen. */
export function setHinge(
	layout: PlannerLayout,
	id: string,
	hinge: HingeSide,
): PlannerLayout {
	const found = find(layout, id);
	if (!found) return layout;

	return {
		...layout,
		[found.row]: layout[found.row].map((module) =>
			module.id === id ? { ...module, hinge } : module,
		),
	};
}

/** Put the same door on several at once — what the palette does to a selection. */
export function setDoors(
	layout: PlannerLayout,
	ids: Iterable<string>,
	doorStyleId: string | null,
): PlannerLayout {
	let next = layout;
	for (const id of ids) next = setDoor(next, id, doorStyleId);
	return next;
}

/**
 * The placement engine, bound to one catalogue.
 *
 * A factory rather than a `catalogue` parameter on each function: `positioned`
 * is the only place a `familyId` becomes a `Family`, but almost every export
 * reaches it, so an explicit parameter would have meant editing several
 * hundred call sites to fix three bugs. Closing over the catalogue leaves
 * every body and every call unchanged and still makes "which catalogue"
 * a value with an owner rather than a module global.
 *
 * Cheap to build — it allocates closures, not indexes — but build it once per
 * catalogue anyway (`useMemo` in the client tree) so React sees stable
 * identities.
 */
export function plannerEngine(catalogue: PlannerCatalogue) {
	const construction: Construction = constructionOf(catalogue);

	const positioned = (placed: PlacedModule): Positioned | null => {
		const found = familyIn(catalogue, placed.familyId);
		return found
			? { placed, family: found, widthMm: placed.widthMm, xMm: placed.xMm }
			: null;
	};

	/** One row, left to right. Order comes from position, not from the array. */
	function positionsOf(layout: PlannerLayout, row: Row): Positioned[] {
		return layout[row]
			.map(positioned)
			.filter(isPositioned)
			.sort((a, b) => a.xMm - b.xMm);
	}

	/** Every cabinet in the run, both rows. For the 3D scene. */
	function allPositions(layout: PlannerLayout): Positioned[] {
		return [...positionsOf(layout, "floor"), ...positionsOf(layout, "wall")];
	}

	/** How far along the wall the run reaches — its rightmost edge. */
	function rowEndMm(layout: PlannerLayout, row: Row): number {
		// Footprint, not width. A turned cabinet reaches past its own width, and
		// this figure is what `minWallWidthMm` lets the wall shrink to — so in
		// widths the wall could be pulled in through a turned carcass's corner.
		return positionsOf(layout, row).reduce(
			(end, position) =>
				Math.max(end, position.xMm + position.widthMm + spreadMm(position)),
			0,
		);
	}

	/**
	 * Whether the cabinet being moved out of the way is itself a tall unit.
	 * Only the floor row can hold one, so that is the only array worth
	 * searching.
	 */
	const isTallModule = (layout: PlannerLayout, id: string | undefined) =>
		id !== undefined &&
		familyIn(
			catalogue,
			layout.floor.find((placed) => placed.id === id)?.familyId ?? "",
		)?.kind === "tall";

	/**
	 * The spans a cabinet in this row cannot occupy.
	 *
	 * A tall unit is floor-to-ceiling, so the two rows have to agree about it,
	 * and the agreement runs **both ways**: a tall unit blocks the hung row,
	 * and every wall cabinet blocks the tall unit. Putting both here means
	 * every move, drop, resize and add gets it for free.
	 *
	 * The second direction was missing, and `addModule` was quietly the only
	 * path that compensated — via `evictBlockedWallUnits`. So a tall unit
	 * could be *placed* correctly and then dragged or widened straight through
	 * the wall cabinet beside it, which on screen is one cabinet merged into
	 * the next. `ignoreId` is the cabinet being settled, so it is also what
	 * says which of the two directions applies.
	 */
	function occupiedSpans(
		layout: PlannerLayout,
		row: Row,
		ignoreId?: string,
	): Span[] {
		const own = positionsOf(layout, row);
		const crossRow =
			row === "wall"
				? positionsOf(layout, "floor").filter(
						(position) => position.family.kind === "tall",
					)
				: isTallModule(layout, ignoreId)
					? positionsOf(layout, "wall")
					: [];

		const cabinets = [...own, ...crossRow]
			.filter((position) => position.placed.id !== ignoreId)
			.map((position) => {
				// What it actually occupies along the wall, not what it is wide —
				// the two differ the moment somebody turns it. See `spreadMm`.
				const spread = spreadMm(position);
				return {
					startMm: position.xMm - spread,
					endMm: position.xMm + position.widthMm + spread,
				};
			});
		const corner = [
			layout.reserved?.[row],
			// A tall unit stands in the hung row too, so that row's corner is in
			// its way as well — the same two-way rule as the wall cabinets above.
			row === "floor" && isTallModule(layout, ignoreId)
				? layout.reserved?.wall
				: undefined,
		].filter((span): span is Span => span !== undefined);

		return [...cabinets, ...corner].sort((a, b) => a.startMm - b.startMm);
	}

	/** The clear stretches of wall in a row, in order. */
	function freeSpans(
		layout: PlannerLayout,
		row: Row,
		ignoreId?: string,
	): Span[] {
		const gaps: Span[] = [];
		let cursor = 0;

		for (const span of occupiedSpans(layout, row, ignoreId)) {
			if (span.startMm > cursor)
				gaps.push({ startMm: cursor, endMm: span.startMm });
			cursor = Math.max(cursor, span.endMm);
		}
		if (cursor < layout.wallWidthMm) {
			gaps.push({ startMm: cursor, endMm: layout.wallWidthMm });
		}

		return gaps;
	}

	/**
	 * Where one cabinet sits, as the gaps a dimension line would be drawn
	 * across.
	 *
	 * Every cabinet here is locked to one wall in one of two rows, so its
	 * whole position is a figure either side of it along that wall, plus how
	 * high it hangs if it is a wall unit. That is what the callouts report.
	 *
	 * The neighbours come from `occupiedSpans`, which is the same list
	 * collision settles against — so a tall unit counts as the wall row's
	 * neighbour, exactly as it does when a hung cabinet is dragged into it. A
	 * gap the customer can see is a gap the customer can move into, and the
	 * two must never disagree.
	 *
	 * The anchors are returned alongside the distances because the overlay has
	 * to know *where* the line stops, not only how long it is.
	 */
	function offsetsOf(layout: PlannerLayout, id: string): Offsets | null {
		const row: Row = layout.wall.some((placed) => placed.id === id)
			? "wall"
			: "floor";
		const position = positionsOf(layout, row).find(
			(candidate) => candidate.placed.id === id,
		);
		if (!position) return null;

		// Its own footprint, for the same reason the neighbours' is: a gap
		// measured to a turned cabinet's width rather than to its corner is a gap
		// the customer cannot actually move into.
		const spread = spreadMm(position);
		const leftEdgeMm = position.xMm - spread;
		const rightEdgeMm = position.xMm + position.widthMm + spread;
		const neighbours = occupiedSpans(layout, row, id);

		const leftAnchorMm = neighbours
			.filter((span) => span.endMm <= leftEdgeMm)
			.reduce((anchor, span) => Math.max(anchor, span.endMm), 0);
		const rightAnchorMm = neighbours
			.filter((span) => span.startMm >= rightEdgeMm)
			.reduce(
				(anchor, span) => Math.min(anchor, span.startMm),
				layout.wallWidthMm,
			);

		return {
			leftMm: leftEdgeMm - leftAnchorMm,
			rightMm: rightAnchorMm - rightEdgeMm,
			leftAnchorMm,
			rightAnchorMm,
			floorMm:
				position.family.kind === "wall"
					? floorHeightMmOf(position, layout)
					: null,
		};
	}

	/**
	 * Put a cabinet a typed distance off whatever is beside it — the gap
	 * `offsetsOf` reports, so the figure a customer reads on a dimension line is
	 * the figure they type back into it. A panel showing the distance to the far
	 * wall while the scene shows the distance to the neighbour is two numbers for
	 * one position, and neither can be checked against the other.
	 *
	 * A gap wider than the room there is capped at it, so the cabinet stops
	 * flush against the far neighbour or wall. `moveModule` alone would not
	 * stop it: it only checks where the cabinet lands, so a target clear of
	 * everything beyond that neighbour would hop the cabinet over it.
	 */
	function setGap(
		layout: PlannerLayout,
		id: string,
		side: "left" | "right",
		gapMm: number,
	): PlannerLayout {
		if (!Number.isFinite(gapMm) || gapMm < 0) return layout;
		const found = find(layout, id);
		const offsets = offsetsOf(layout, id);
		if (!found || !offsets) return layout;

		const spread = spreadOf(found.placed);
		const gap = Math.min(gapMm, offsets.leftMm + offsets.rightMm);
		const xMm =
			side === "left"
				? offsets.leftAnchorMm + gap + spread
				: offsets.rightAnchorMm - gap - found.placed.widthMm - spread;
		return moveModule(layout, id, Math.round(xMm));
	}

	/**
	 * Settle a cabinet at the position it is being asked for.
	 *
	 * It cannot leave the wall, and it cannot pass through anything: a cabinet
	 * pushed into its neighbour stops flush against it, exactly like pushing a
	 * real carcass down a wall. `fromMm` is where the cabinet currently is, which
	 * is what decides *which side* of an obstacle it stops on — without it, a
	 * cabinet dragged fast enough to jump clean over a neighbour in one frame
	 * would pop out on the far side.
	 *
	 * `spread` is what a turn adds either side of the cabinet's own width. The
	 * whole settle is done in **footprint** terms — the box that is really in
	 * the way — and shifted back to the stored left edge on the way out, so
	 * every caller keeps handing in and getting back an `xMm` that means the
	 * same thing it always has.
	 */
	function clampX(
		layout: PlannerLayout,
		row: Row,
		widthMm: number,
		xMm: number,
		ignoreId?: string,
		fromMm?: number,
		spread = 0,
	): number {
		const footprintMm = widthMm + spread * 2;
		const wanted = clampToWall(xMm - spread, footprintMm, layout.wallWidthMm);
		const spans = occupiedSpans(layout, row, ignoreId);
		const origin = fromMm === undefined ? wanted : fromMm - spread;

		let settled = wanted;
		// One pass per obstacle, repeated until nothing moves: stopping against one
		// neighbour can push the cabinet into the next one along.
		for (let pass = 0; pass < spans.length + 1; pass++) {
			let moved = false;

			for (const span of spans) {
				const left = settled;
				const right = settled + footprintMm;
				if (right <= span.startMm || left >= span.endMm) continue;

				// Approaching from the left means stopping before the obstacle.
				const approachingFromLeft = origin + footprintMm / 2 < span.startMm;
				settled = approachingFromLeft ? span.startMm - footprintMm : span.endMm;
				settled = clampToWall(settled, footprintMm, layout.wallWidthMm);
				moved = true;
			}

			if (!moved) break;
		}

		// If it still overlaps, every direction is blocked — leave it where it was.
		// Back to the stored left edge on the way out.
		return (
			(overlapsAnything(settled, footprintMm, spans)
				? clampToWall(origin, footprintMm, layout.wallWidthMm)
				: settled) + spread
		);
	}

	/**
	 * The edges worth landing on: the neighbours in this row, the ends of the
	 * wall, and — the one that makes a kitchen look designed rather than dragged —
	 * the edges of the cabinets in the *other* row, so a wall unit lines up with
	 * the base cabinet under it.
	 */
	function snapTargets(
		layout: PlannerLayout,
		row: Row,
		ignoreId?: string,
	): number[] {
		const other: Row = row === "floor" ? "wall" : "floor";
		const edges = [0, layout.wallWidthMm];

		// A corner's edge is somewhere a run is meant to start.
		for (const span of [layout.reserved?.floor, layout.reserved?.wall]) {
			if (span) edges.push(span.startMm, span.endMm);
		}

		for (const r of [row, other]) {
			for (const position of positionsOf(layout, r)) {
				if (position.placed.id === ignoreId) continue;
				// Footprint edges, like everything else on this axis: flush against a
				// turned cabinet means flush against its corner.
				const spread = spreadMm(position);
				edges.push(
					position.xMm - spread,
					position.xMm + position.widthMm + spread,
				);
			}
		}

		return edges;
	}

	/**
	 * The same idea one axis over: the heights worth landing on.
	 *
	 * Every other cabinet contributes **two** — its underside and its top —
	 * from **both** rows, which is what makes the alignments a customer actually
	 * asks for fall out of one rule. "Top flush with the wall unit beside it" is
	 * a top meeting a top. "Underside flush with the worktop" is an underside
	 * meeting a base unit's top. "Level with the tall unit" is the same again.
	 * None of them needs its own case.
	 *
	 * The row's own hanging height is in the list too, so a cabinet dragged out
	 * of the row has something to drop back onto — without it, rejoining the row
	 * by hand is the one alignment the gizmo could not do.
	 *
	 * The floor and the ceiling round it off.
	 */
	function hangTargets(layout: PlannerLayout, ignoreId?: string): number[] {
		const heights = [0, layout.ceilingHeightMm, hangingHeightMmOf(layout)];

		for (const row of ["floor", "wall"] as const) {
			for (const position of positionsOf(layout, row)) {
				if (position.placed.id === ignoreId) continue;
				const floorMm = floorHeightMmOf(position, layout);
				heights.push(floorMm, floorMm + position.family.heightMm);
			}
		}

		return heights;
	}

	/**
	 * Tidy up the vertical half of a released drag, the way `snapX` tidies the
	 * horizontal: either the cabinet's underside or its top lands on a target
	 * within `SNAP_MM`, nearest wins, and anything further away is left where the
	 * pointer put it.
	 *
	 * Returns a height rather than a layout, so `setHangAt` still applies the
	 * range in `hangRangeMm` afterwards — the snap is a preference and never a
	 * way past the limits.
	 */
	function snapHangAt(
		position: Positioned,
		layout: PlannerLayout,
		hangAtMm: number,
	): number {
		const heightMm = position.family.heightMm;

		let best = hangAtMm;
		let bestDistance = SNAP_MM;

		for (const target of hangTargets(layout, position.placed.id)) {
			// Either the underside or the top can be the edge that lands.
			for (const candidate of [target, target - heightMm]) {
				const distance = Math.abs(candidate - hangAtMm);
				if (distance < bestDistance) {
					best = candidate;
					bestDistance = distance;
				}
			}
		}

		return best;
	}

	/**
	 * Tidy up a released drag: if either edge of the cabinet is within `SNAP_MM`
	 * of something worth aligning to, land on it exactly. Deliberately only on
	 * release — a snap that fires mid-drag makes the cabinet stick and jump.
	 */
	function snapX(
		layout: PlannerLayout,
		row: Row,
		widthMm: number,
		xMm: number,
		ignoreId?: string,
		spread = 0,
	): number {
		const targets = snapTargets(layout, row, ignoreId);
		const footprintMm = widthMm + spread * 2;
		// In footprint terms, as `clampX` is, and shifted back at the end.
		const leftMm = xMm - spread;

		let best = leftMm;
		let bestDistance = SNAP_MM;

		for (const target of targets) {
			// Either the left edge or the right edge can be the one that lands.
			for (const candidate of [target, target - footprintMm]) {
				const distance = Math.abs(candidate - leftMm);
				if (distance < bestDistance) {
					best = candidate;
					bestDistance = distance;
				}
			}
		}

		return clampX(layout, row, widthMm, best + spread, ignoreId, xMm, spread);
	}

	/** What this one cabinet's own turn adds either side of its width. */
	function spreadOf(placed: PlacedModule): number {
		const position = positioned(placed);
		return position ? spreadMm(position) : 0;
	}

	/** Mid-drag: follow the pointer as far as the neighbours allow. */
	function moveModule(
		layout: PlannerLayout,
		id: string,
		xMm: number,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found) return layout;

		const settled = clampX(
			layout,
			found.row,
			found.placed.widthMm,
			xMm,
			id,
			found.placed.xMm,
			spreadOf(found.placed),
		);
		return settled === found.placed.xMm
			? layout
			: withX(layout, found.row, id, settled);
	}

	/**
	 * Drag released: settle, then snap flush if it is close to an edge.
	 *
	 * Both axes, when a height is handed in — a drag moves in two dimensions and
	 * "what happens when you let go" should not be split across two call sites.
	 * A height for a cabinet that may not hang is dropped rather than refused,
	 * the same way `dragModule` drops one.
	 */
	function dropModule(
		layout: PlannerLayout,
		id: string,
		xMm: number,
		hangAtMm?: number,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found) return layout;

		const spread = spreadOf(found.placed);
		const settled = clampX(
			layout,
			found.row,
			found.placed.widthMm,
			xMm,
			id,
			found.placed.xMm,
			spread,
		);
		const snapped = snapX(
			layout,
			found.row,
			found.placed.widthMm,
			settled,
			id,
			spread,
		);
		const moved =
			snapped === found.placed.xMm
				? layout
				: withX(layout, found.row, id, snapped);

		if (hangAtMm === undefined || !canHangAt(moved, id)) return moved;
		const position = positioned(found.placed);
		if (!position) return moved;
		return setHangAt(moved, id, snapHangAt(position, moved, hangAtMm));
	}

	/** The leftmost clear position a cabinet of this width could take. */
	function firstFreeXMm(
		layout: PlannerLayout,
		row: Row,
		widthMm: number,
	): number | null {
		for (const gap of freeSpans(layout, row)) {
			if (gap.endMm - gap.startMm >= widthMm) return gap.startMm;
		}
		return null;
	}

	/**
	 * The position a cabinet dropped at `xMm` should actually take: where it was
	 * dropped if that is clear, otherwise the nearest gap that will hold it. A
	 * drop onto an occupied stretch is a near miss, not a mistake.
	 */
	function placementFor(
		layout: PlannerLayout,
		row: Row,
		widthMm: number,
		xMm: number,
	): number | null {
		const wanted = clampToWall(xMm, widthMm, layout.wallWidthMm);

		let best: number | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;

		for (const gap of freeSpans(layout, row)) {
			if (gap.endMm - gap.startMm < widthMm) continue;
			// Nearest spot inside this gap to where the pointer let go.
			const candidate = Math.min(
				Math.max(wanted, gap.startMm),
				gap.endMm - widthMm,
			);
			const distance = Math.abs(candidate - wanted);
			if (distance < bestDistance) {
				best = candidate;
				bestDistance = distance;
			}
		}

		return best;
	}

	/** Is there anywhere left on this wall for one of these? */
	function fits(
		layout: PlannerLayout,
		familyId: string,
		widthMm = defaultWidthMmIn(catalogue, familyId),
	): boolean {
		const found = familyIn(catalogue, familyId);
		if (!found) return false;
		return firstFreeXMm(layout, rowFor(found.kind), widthMm) !== null;
	}

	/**
	 * Place a cabinet. It arrives as a **bare carcass** — the door is a separate
	 * choice the customer drags on afterwards, which is the order they are sold in.
	 */
	function addModule(
		layout: PlannerLayout,
		familyId: string,
		xMm: number,
		id: string = newId(),
		widthMm: number = defaultWidthMmIn(catalogue, familyId),
	): PlannerLayout {
		const found = familyIn(catalogue, familyId);
		if (!found) return layout;

		const row = rowFor(found.kind);
		const at = placementFor(layout, row, widthMm, xMm);
		if (at === null) return layout;

		const placed: PlacedModule = {
			id,
			familyId,
			widthMm,
			// A cabinet is priced all-in with its door, so it always carries one.
			// The first style is the base look; the others are surcharges on it.
			doorStyleId: catalogue.doorStyles[0]?.id ?? null,
			hinge: "left",
			xMm: at,
		};
		const next = { ...layout, [row]: [...layout[row], placed] };
		// A tall unit lands in the floor row but takes the hung row with it, so
		// anything already hanging there has to give way.
		return found.kind === "tall" ? evictBlockedWallUnits(next, placed) : next;
	}

	/**
	 * A tall unit dropped under existing wall cabinets: slide them clear if there
	 * is room, and drop the ones there is no room for. Better than refusing the
	 * drop — the customer asked for the tall unit, and a planner that silently
	 * does nothing reads as broken.
	 */
	function evictBlockedWallUnits(
		layout: PlannerLayout,
		tall: PlacedModule,
	): PlannerLayout {
		const blocked: Span = {
			startMm: tall.xMm,
			endMm: tall.xMm + tall.widthMm,
		};

		let next = layout;
		for (const position of positionsOf(layout, "wall")) {
			const left = position.xMm;
			const right = position.xMm + position.widthMm;
			if (right <= blocked.startMm || left >= blocked.endMm) continue;

			const moved = placementFor(
				removeModule(next, position.placed.id),
				"wall",
				position.widthMm,
				position.xMm,
			);
			next =
				moved === null
					? removeModule(next, position.placed.id)
					: withX(next, "wall", position.placed.id, moved);
		}
		return next;
	}

	/**
	 * Take several cabinets out at once. Everything left stays exactly where it
	 * is — clearing a stretch of wall is usually the first step in rearranging it,
	 * so closing the gap automatically would undo what the customer just asked for.
	 */
	function removeModules(
		layout: PlannerLayout,
		ids: Iterable<string>,
	): PlannerLayout {
		const gone = new Set(ids);
		if (gone.size === 0) return layout;
		return {
			...layout,
			floor: layout.floor.filter((placed) => !gone.has(placed.id)),
			wall: layout.wall.filter((placed) => !gone.has(placed.id)),
		};
	}

	function removeModule(layout: PlannerLayout, id: string): PlannerLayout {
		return removeModules(layout, [id]);
	}

	/**
	 * A copy of one cabinet — same family, size and door — placed as close to the
	 * original as there is room for. Returns `layout` unchanged if `id` is not
	 * placed or nothing on the wall will hold a second one.
	 */
	function duplicateModule(
		layout: PlannerLayout,
		id: string,
		newIdValue: string = newId(),
	): PlannerLayout {
		const source = [...layout.floor, ...layout.wall].find((m) => m.id === id);
		if (!source) return layout;

		const added = addModule(
			layout,
			source.familyId,
			source.xMm + source.widthMm,
			newIdValue,
			source.widthMm,
		);
		if (added === layout) return layout;

		const withHinge = setHinge(added, newIdValue, source.hinge);
		return source.doorStyleId
			? setDoor(withHinge, newIdValue, source.doorStyleId)
			: withHinge;
	}

	function setHangingHeight(
		layout: PlannerLayout,
		hangingHeightMm: number,
	): PlannerLayout {
		return { ...layout, hangingHeightMm };
	}

	/**
	 * The range a cabinet's underside may be dragged through.
	 *
	 * A hung cabinet keeps the hang slider's range, so the gizmo stays a
	 * shortcut rather than a second set of rules. A cabinet on the floor has no
	 * slider to agree with, so its range is the room: the floor, up to wherever
	 * its own top would meet the ceiling.
	 *
	 * The ceiling caps both. A 900-tall wall unit hung at the slider's 1800 in a
	 * 2200 ceiling pokes through it, which the slider's fixed range could never
	 * see and this does.
	 */
	/**
	 * How much vertical room a cabinet takes up where it stands.
	 *
	 * Not its carcass height. A base unit still in the counter run wears a
	 * worktop, and the slab sits *on top* of the carcass rather than inside it,
	 * so a cabinet clamped to the carcass alone stops flush and drives forty
	 * millimetres of worktop through whatever it stopped against — which is the
	 * part you see. One that has left the run has no slab to count, which is
	 * why this reads `inRun` rather than the kind alone.
	 */
	function occupiedHeightMm(position: Positioned): number {
		return (
			position.family.heightMm +
			(position.family.kind === "base" && inRun(position)
				? construction.worktopThicknessMm
				: 0)
		);
	}

	function hangRangeMm(
		position: Positioned,
		layout: PlannerLayout,
		row: Row,
	): { minMm: number; maxMm: number } {
		const headroomMm = Math.max(
			0,
			layout.ceilingHeightMm - position.family.heightMm,
		);
		const rowMinMm =
			row === "wall" ? Math.min(WALL_HANG_LIMITS.minMm, headroomMm) : 0;
		const rowMaxMm =
			row === "wall"
				? Math.min(WALL_HANG_LIMITS.maxMm, headroomMm)
				: headroomMm;

		// Then whatever is actually in the way. A cabinet cannot pass through the
		// one above or below it any more than through the one beside it, and
		// while the floor row could not move vertically nothing had to say so —
		// the first thing a lifted base unit did was drive itself into the wall
		// cabinet over it. This is `clampX`'s rule turned ninety degrees.
		//
		// Where it is now decides which side of an obstacle it stops on, the same
		// reason `clampX` takes a `fromMm`. Anything it already overlaps is
		// neither above nor below and is left out, so a cabinet the catalogue has
		// wedged is held where it is rather than shoved to one end of a gap it
		// does not fit. Its own height counts without a worktop: any raised
		// position has taken it out of the run, so there is no slab up there.
		const fromMm = floorHeightMmOf(position, layout);
		const leftMm = position.xMm;
		const rightMm = position.xMm + position.widthMm;
		let ceilingMm = layout.ceilingHeightMm;
		let floorMm = 0;
		for (const other of positionsOf(
			layout,
			row === "wall" ? "floor" : "wall",
		)) {
			// Touching end to end is not overlapping, so a cabinet passes a
			// neighbour that merely abuts its x span.
			if (other.xMm + other.widthMm <= leftMm || other.xMm >= rightMm) continue;
			const bottomMm = floorHeightMmOf(other, layout);
			if (bottomMm >= fromMm + position.family.heightMm) {
				ceilingMm = Math.min(ceilingMm, bottomMm);
			} else if (bottomMm + occupiedHeightMm(other) <= fromMm) {
				floorMm = Math.max(floorMm, bottomMm + occupiedHeightMm(other));
			}
		}

		const minMm = Math.max(rowMinMm, floorMm);
		const maxMm = Math.min(rowMaxMm, ceilingMm - position.family.heightMm);
		// Boxed in with no room at all: hold it where it is, rather than let an
		// inverted range snap it to one end of a gap it does not fit.
		if (maxMm < minMm) return { minMm: fromMm, maxMm: fromMm };
		return { minMm, maxMm };
	}

	/**
	 * Raise or lower one cabinet out of its row. `null` puts it back.
	 *
	 * Both rows, since `canHangAt` grants both — see there for why. Which array
	 * gets written comes off `find`, so a floor unit's override lands on the
	 * floor unit rather than on nothing.
	 */
	function setHangAt(
		layout: PlannerLayout,
		id: string,
		hangAtMm: number | null,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found) return layout;
		const position = positioned(found.placed);
		if (!position) return layout;

		const next = { ...found.placed };
		if (hangAtMm === null) {
			delete next.hangAtMm;
		} else {
			const range = hangRangeMm(position, layout, found.row);
			const settled = Math.max(
				range.minMm,
				Math.min(range.maxMm, Math.round(hangAtMm)),
			);
			// Dragged back to where it would sit anyway, this is not an override —
			// and it must not be recorded as one. `inRun` reads the difference, so
			// a base unit lowered onto the floor would otherwise stay off the
			// counter run for good: no kick board, no worktop, nothing to say why.
			const restingMm =
				found.row === "wall"
					? layout.hangingHeightMm
					: position.family.floorHeightMm;
			if (settled === restingMm) delete next.hangAtMm;
			else next.hangAtMm = settled;
		}

		return {
			...layout,
			[found.row]: layout[found.row].map((module) =>
				module.id === id ? next : module,
			),
		};
	}

	/**
	 * Turn one cabinet on the spot.
	 *
	 * Normalised into `[0, 360)` and rounded to whole degrees. Zero deletes the
	 * field rather than storing it, so a cabinet turned back is
	 * indistinguishable from one never turned; `inRun` reads that difference.
	 *
	 * `snap` lands it on the nearest eighth-turn within `ROTATION_SNAP_DEG`.
	 * That belongs to the *gesture*, not to the angle — square is what almost
	 * every dragged turn is reaching for and not something a thumb can hit by
	 * hand, but a figure somebody typed is already exactly what they meant, and
	 * a magnet there would drag every small angle back to zero as they typed
	 * the first digit.
	 *
	 * A turn that will not fit is refused outright, and the cabinet keeps the
	 * last angle that did — the same answer `swapWithNeighbour` gives when a
	 * destination is blocked. Not eased down to the largest angle that fits,
	 * because there is no such thing: the footprint grows to 45° and shrinks
	 * again past it, so a cabinet that cannot take 30° may well take 90°.
	 * Stopping at the binding angle and going again beyond it is what dragging
	 * the ring actually feels like.
	 *
	 * ponytail: `exposure.ts` is still 1-D along x, so which sides of a turned
	 * cabinet count as exposed is read off its unrotated width.
	 */
	function setRotation(
		layout: PlannerLayout,
		id: string,
		deg: number,
		snap = false,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found) return layout;

		const wrapped = ((Math.round(deg) % 360) + 360) % 360;
		const eighth = Math.round(wrapped / 45) * 45;
		const settled =
			snap && Math.abs(eighth - wrapped) <= ROTATION_SNAP_DEG
				? eighth % 360
				: wrapped;

		if ((found.placed.rotationDeg ?? 0) === settled) return layout;

		const next = { ...found.placed };
		if (settled === 0) delete next.rotationDeg;
		else next.rotationDeg = settled;

		const turned = {
			...layout,
			[found.row]: layout[found.row].map((module) =>
				module.id === id ? next : module,
			),
		};

		// A turn changes what the cabinet occupies along the wall, so it has to
		// settle again at its own position. Without this, turning one that is
		// already flush swings its corner straight through the wall beside it —
		// nothing moved, so nothing re-checked.
		const slid = moveModule(turned, id, next.xMm);
		if (isClear(slid)) return slid;

		// Sliding is all `clampX` can do, and a packed run has nowhere to slide
		// to. The run gives way instead — see `openRoomFor`. What it has to open
		// is the shortfall between the turned footprint and the free stretch the
		// cabinet is sitting in, not the whole growth, so a run with a gap
		// already beside it barely moves.
		const after = positionsOf(slid, found.row).find(
			(position) => position.placed.id === id,
		);
		if (!after) return layout;
		const spread = spreadMm(after);
		const footprintMm = after.widthMm + spread * 2;
		const centreMm = after.xMm + after.widthMm / 2;
		const gap = freeSpans(slid, found.row, id).find(
			(span) => span.startMm <= centreMm && span.endMm >= centreMm,
		);
		const needMm = footprintMm - (gap ? gap.endMm - gap.startMm : 0);

		const roomy = moveModule(
			openRoomFor(turned, found.row, id, needMm),
			id,
			next.xMm,
		);
		// Still nowhere to put it — the wall itself is full. Keep the angle the
		// cabinet had, which is the same answer `swapWithNeighbour` gives when a
		// destination is blocked.
		return isClear(roomy) ? roomy : layout;
	}

	/**
	 * A hair of tolerance on every edge comparison.
	 *
	 * A footprint is `|w·cosθ| + |d·sinθ|` once cabinets can be turned, so an
	 * edge is a cosine rather than an integer, and one settled flush against its
	 * neighbour lands on the boundary by construction — where the two figures
	 * disagree in the thirteenth decimal place. A move refused for a thousandth
	 * of a millimetre reads as a dead control.
	 */
	const SLACK_MM = 0.5;

	/**
	 * Whether the layout is physically possible: every cabinet inside the wall
	 * and clear of everything that shares its row.
	 *
	 * Checking what has to be true, rather than asking each edit to enumerate
	 * the obstacles it might have disturbed. Two bugs came from that enumeration
	 * being incomplete, and neither was where the edit was looking: a turn that
	 * pushed its neighbours slid the last wall cabinet into a tall unit's span,
	 * and `swapWithNeighbour` — which validated only the cabinet it was asked
	 * about, never the neighbour that also moved — buried a tall unit under the
	 * wall cabinets by swapping it down the run.
	 *
	 * `occupiedSpans` already knows a tall unit stands in both rows, so asking
	 * it once per cabinet is the whole check.
	 */
	function isClear(layout: PlannerLayout): boolean {
		for (const row of ["floor", "wall"] as const) {
			for (const position of positionsOf(layout, row)) {
				const spread = spreadMm(position);
				const startMm = position.xMm - spread;
				const footprintMm = position.widthMm + spread * 2;
				if (
					startMm < -SLACK_MM ||
					startMm + footprintMm > layout.wallWidthMm + SLACK_MM ||
					overlapsAnything(
						startMm + SLACK_MM,
						Math.max(0, footprintMm - SLACK_MM * 2),
						occupiedSpans(layout, row, position.placed.id),
					)
				) {
					return false;
				}
			}
		}
		return true;
	}

	/**
	 * Slide a cabinet's neighbours along the wall to open room beside it.
	 *
	 * A turn grows what a cabinet occupies, and `clampX` can only slide the
	 * cabinet itself — so in a packed run it had nowhere to go and the turn was
	 * refused, while metres of bare wall sat at the end of the run. Refusing was
	 * right and useless: on the kitchen starter it left the drawer base able to
	 * take two angles out of twenty-four.
	 *
	 * So the run gives way instead. Everything past the cabinet moves away from
	 * it, into whatever free wall that side has, and the cabinet re-settles in
	 * the gap that opens. The far side is tried for the remainder, so a cabinet
	 * near the right-hand end pushes left. Only when neither side has the wall
	 * to spare is the turn refused.
	 *
	 * The row keeps its own order and its own gaps: every module on a side
	 * shifts by the same amount in the same direction, so none of them can meet
	 * another, and neither push exceeds the free wall on that side.
	 */
	function openRoomFor(
		layout: PlannerLayout,
		row: Row,
		id: string,
		needMm: number,
	): PlannerLayout {
		if (needMm <= 0) return layout;

		const positions = positionsOf(layout, row);
		const me = positions.find((position) => position.placed.id === id);
		if (!me) return layout;

		const centreMm = me.xMm + me.widthMm / 2;
		const sides = positions
			.filter((position) => position.placed.id !== id)
			.map((position) => {
				const spread = spreadMm(position);
				return {
					id: position.placed.id,
					startMm: position.xMm - spread,
					endMm: position.xMm + position.widthMm + spread,
				};
			});

		const right = sides.filter((side) => side.startMm >= centreMm);
		const left = sides.filter((side) => side.endMm <= centreMm);

		const rightEdgeMm = right.reduce(
			(edge, side) => Math.max(edge, side.endMm),
			me.xMm + me.widthMm,
		);
		const leftEdgeMm = left.reduce(
			(edge, side) => Math.min(edge, side.startMm),
			me.xMm,
		);

		const pushRightMm = Math.min(
			needMm,
			Math.max(0, layout.wallWidthMm - rightEdgeMm),
		);
		const pushLeftMm = Math.min(needMm - pushRightMm, Math.max(0, leftEdgeMm));
		// Not enough wall on either side: the caller refuses the turn.
		if (pushRightMm + pushLeftMm < needMm) return layout;

		const rightIds = new Set(right.map((side) => side.id));
		const leftIds = new Set(left.map((side) => side.id));
		return {
			...layout,
			[row]: layout[row].map((placed) => {
				if (rightIds.has(placed.id))
					return { ...placed, xMm: placed.xMm + pushRightMm };
				if (leftIds.has(placed.id))
					return { ...placed, xMm: placed.xMm - pushLeftMm };
				return placed;
			}),
		};
	}

	/**
	 * Switch the wall row between hanging at a set height and running to the
	 * ceiling. `hangingHeightMm` is deliberately left alone: this is a mode, not
	 * an edit, and a customer who flips it on to look at it must get their own
	 * hang height back when they flip it off.
	 */
	function setWallToCeiling(
		layout: PlannerLayout,
		wallToCeiling: boolean,
	): PlannerLayout {
		return wallToCeiling === layout.wallToCeiling
			? layout
			: { ...layout, wallToCeiling };
	}

	/**
	 * Build the run into the wall, or leave it standing free.
	 *
	 * Adds boards; moves nothing. A customer who wants the cabinets packed against
	 * one end has `closeGaps` for that — rearranging their run behind them because
	 * they ticked a finish option would be the engine overruling the document.
	 */
	function setWallToWall(
		layout: PlannerLayout,
		wallToWall: boolean,
	): PlannerLayout {
		return wallToWall === layout.wallToWall
			? layout
			: { ...layout, wallToWall };
	}

	/**
	 * Turn the kick board on or off. Purely a look: nothing moves, the legs are
	 * simply covered or not, and the price follows because `skirtingSpans` is the
	 * one thing both the scene and the money read.
	 */
	function setBaseSkirting(
		layout: PlannerLayout,
		baseSkirting: boolean,
	): PlannerLayout {
		return baseSkirting === layout.baseSkirting
			? layout
			: { ...layout, baseSkirting };
	}

	/**
	 * Where the underside of the wall row actually sits.
	 *
	 * Derived rather than stored, because everything it depends on is editable:
	 * the customer re-measures the ceiling, or drops in a wall family of a
	 * different height, and a stored figure would quietly go stale. The cabinets
	 * stop `CEILING_TRIM_MM` short of the ceiling — the capping strip fills that,
	 * which is how the run is built.
	 *
	 * The hang limits are not applied here. They exist to keep the *slider*
	 * sensible; in ceiling mode the ceiling and the carcass height are the only
	 * two numbers that get a say.
	 */
	function hangingHeightMmOf(layout: PlannerLayout): number {
		if (!layout.wallToCeiling) return layout.hangingHeightMm;

		const wallHeightMm = Math.max(
			0,
			...positionsOf(layout, "wall").map(
				(position) => position.family.heightMm,
			),
		);
		// Nothing hung yet, so there is no top to line up — leave the stored figure
		// showing rather than inventing one off an empty row.
		if (wallHeightMm === 0) return layout.hangingHeightMm;

		return Math.max(0, layout.ceilingHeightMm - CEILING_TRIM_MM - wallHeightMm);
	}

	/**
	 * Which sides of every cabinet nothing covers — the one answer the price and
	 * the scene both read, so a panel drawn is a panel charged.
	 *
	 * A side is covered by anything touching it that also shares its height,
	 * whichever row that thing lives in. Judging each row alone got a tall unit
	 * wrong in both directions: a wall unit hung flush against one was charged
	 * a panel for a side buried in it, while a base lifted to 1200mm counted as
	 * covered by the base on the floor below it. A tall unit's own side beside a
	 * shorter cabinet counts as covered — EzCabinet's call, 2026-09-13.
	 *
	 * "Touching" is anything closer than one board. A gap too narrow to take a
	 * panel shows no drilled side, and two panels charged for a 2mm gap is a
	 * price the customer would rightly query.
	 */
	function exposureOf(layout: PlannerLayout): Map<string, ExposedSides> {
		const walls = {
			wallWidthMm: layout.wallWidthMm,
			enclosed: layout.wallToWall,
		};
		const touchingMm = constructionOf(catalogue).panelThicknessMm;
		const all = allPositions(layout);
		const heightSpan = (position: Positioned) => {
			const bottomMm = floorHeightMmOf(position, layout);
			return { bottomMm, topMm: bottomMm + position.family.heightMm };
		};

		const exposure = new Map<string, ExposedSides>();
		for (const self of all) {
			const own = heightSpan(self);
			const beside = all.filter((other) => {
				if (other === self) return true;
				const span = heightSpan(other);
				return span.bottomMm < own.topMm && own.bottomMm < span.topMm;
			});
			exposure.set(
				self.placed.id,
				exposedSides(beside, beside.indexOf(self), walls, touchingMm),
			);
		}
		return exposure;
	}

	/**
	 * Every cabinet side that has to be clad.
	 *
	 * A carcass side is drilled with system holes and shows its fixings, so any
	 * side left in the open gets a panel matching the fronts. A side against a
	 * neighbour, or against a return wall when the room has them, is buried and
	 * needs nothing.
	 *
	 * Interior sides count. A cabinet standing beside a gap mid-run has a visible
	 * drilled side exactly like one at the end of the row — the same rule reaches
	 * both, which is why this asks `exposureOf` rather than looking at the ends.
	 */
	function endPanels(layout: PlannerLayout): EndPanel[] {
		const exposure = exposureOf(layout);
		const panels: EndPanel[] = [];

		for (const row of ["floor", "wall"] as const) {
			for (const position of positionsOf(layout, row)) {
				const exposed = exposure.get(position.placed.id);
				for (const side of ["left", "right"] as const) {
					if (!exposed?.[side]) continue;
					panels.push({
						row,
						moduleId: position.placed.id,
						side,
						kind: position.family.kind,
					});
				}
			}
		}

		return panels;
	}

	/**
	 * The kick boards under a run.
	 *
	 * One board per unbroken stretch, the same rule the worktop and the ceiling
	 * trim follow: it is cut to the cabinets it covers, so a gap breaks it rather
	 * than being spanned and charged for. Height is the tallest stand in the
	 * stretch — a board shorter than the legs beside it would leave them showing,
	 * which is the whole thing it exists to prevent. Recess is the *shallowest*
	 * inset, for the same reason one axis over: a single flat board cannot sit
	 * behind one cabinet's feet and in front of another's.
	 *
	 * Lives here rather than in the scene so the geometry and the price read the
	 * same number — including none of it, when the customer has turned the board
	 * off. `standOf` is the source for how a cabinet stands.
	 */
	function skirtingSpans(layout: PlannerLayout): SkirtingSpan[] {
		if (!layout.baseSkirting) return [];

		const spans: SkirtingSpan[] = [];

		for (const position of positionsOf(layout, "floor")) {
			if (!inRun(position)) continue;
			const stand = standOf(position.family, construction);
			if (stand.heightMm <= 0) continue;

			const previous = spans[spans.length - 1];
			if (previous && Math.abs(previous.endMm - position.xMm) < 1) {
				previous.endMm = position.xMm + position.widthMm;
				previous.heightMm = Math.max(previous.heightMm, stand.heightMm);
				previous.depthMm = Math.max(previous.depthMm, position.family.depthMm);
				// The shallowest inset wins: one board across the stretch, and it has
				// to clear the foot standing furthest forward.
				previous.recessMm = Math.min(previous.recessMm, stand.insetMm);
			} else {
				spans.push({
					startMm: position.xMm,
					endMm: position.xMm + position.widthMm,
					heightMm: stand.heightMm,
					depthMm: position.family.depthMm,
					recessMm: stand.insetMm,
				});
			}
		}

		return spans;
	}

	/**
	 * Underside of any placed cabinet above the floor.
	 *
	 * A wall unit's height comes from the layout, everything else's from its own
	 * family — and either can be overridden by a drag on this one cabinet. That
	 * rule used to be written out separately in the scene, in the contact shadows
	 * and in the measuring tool, which meant a change to how the wall row is
	 * positioned had three places to reach and the measuring tool could end up
	 * reporting a number the scene disagreed with. One function now.
	 */
	function floorHeightMmOf(
		position: Positioned,
		layout: PlannerLayout,
	): number {
		if (position.family.kind !== "wall")
			return position.placed.hangAtMm ?? position.family.floorHeightMm;
		// Ceiling mode aligns the tops, so a per-cabinet figure has nothing to
		// say there.
		if (layout.wallToCeiling) return hangingHeightMmOf(layout);
		return position.placed.hangAtMm ?? layout.hangingHeightMm;
	}

	/**
	 * Line the wall cabinets' tops up with the tallest floor unit next to them —
	 * a fridge housing or tall cabinet, whose top is fixed by its own height, not
	 * by the hang slider. Moving that slider off the catalogue's default breaks
	 * this alignment; this is the one-click way back. Does nothing if the room
	 * has no tall unit or no wall cabinet to line up against, and clamps to the
	 * same range the hang slider itself allows.
	 */
	function flushWallToTallTops(layout: PlannerLayout): PlannerLayout {
		const tallTopMm = Math.max(
			0,
			...positionsOf(layout, "floor")
				.filter((p) => p.family.kind === "tall")
				.map((p) => p.family.floorHeightMm + p.family.heightMm),
		);
		if (tallTopMm === 0) return layout;

		const wallHeightMm = Math.max(
			0,
			...positionsOf(layout, "wall").map((p) => p.family.heightMm),
		);
		if (wallHeightMm === 0) return layout;

		const hangingHeightMm = Math.min(
			WALL_HANG_LIMITS.maxMm,
			Math.max(WALL_HANG_LIMITS.minMm, tallTopMm - wallHeightMm),
		);
		return setHangingHeight(layout, hangingHeightMm);
	}

	/** The far end of the longer row — how much wall this design actually needs. */
	function runExtentMm(layout: PlannerLayout): number {
		return Math.max(rowEndMm(layout, "floor"), rowEndMm(layout, "wall"));
	}

	/**
	 * The shortest wall this design fits on.
	 *
	 * A property of the layout rather than a constant, because the run is what
	 * usually decides it: `WALL_LIMITS.minMm` only applies to a room with little
	 * or nothing in it.
	 */
	function minWallWidthMm(layout: PlannerLayout): number {
		return Math.max(WALL_LIMITS.minMm, runExtentMm(layout));
	}

	/**
	 * Set the wall to what the customer measured, down to the length their run
	 * needs.
	 *
	 * This used to let the wall shrink underneath the cabinets on the reasoning
	 * that a measurement is a fact about someone's house, with the UI warning about
	 * the overhang and `closeGaps` as the way back. That only ever looked survivable
	 * because the room was drawn 1.2m wider than the wall: the overrun landed on
	 * visible floor. The shell is now drawn at the true wall length — which is what
	 * makes a run built wall to wall look built in — so an overhanging cabinet
	 * hangs over nothing at all, and reads as a broken renderer rather than a
	 * design that does not fit.
	 *
	 * So the run sets the floor, and the UI says which run is holding it. Shortening
	 * the design is the customer's decision to make, not something to infer from a
	 * number they typed.
	 */
	function setWallWidth(
		layout: PlannerLayout,
		wallWidthMm: number,
	): PlannerLayout {
		// The run's floor is applied last so it always wins.
		const clamped = Math.max(
			minWallWidthMm(layout),
			Math.min(WALL_LIMITS.maxMm, Math.round(wallWidthMm)),
		);
		return clamped === layout.wallWidthMm
			? layout
			: { ...layout, wallWidthMm: clamped };
	}

	/**
	 * Set the room's front-to-back depth to what the customer measured. This is
	 * a 3D-scene dimension only — cabinet depths are fixed per family — but the
	 * room box, camera framing and drag planes all read it, so a shallow galley
	 * kitchen and a deep open one no longer render at the same fixed depth.
	 */
	function setRoomDepth(
		layout: PlannerLayout,
		roomDepthMm: number,
	): PlannerLayout {
		const clamped = Math.min(
			ROOM_DEPTH_LIMITS.maxMm,
			Math.max(ROOM_DEPTH_LIMITS.minMm, Math.round(roomDepthMm)),
		);
		return clamped === layout.roomDepthMm
			? layout
			: { ...layout, roomDepthMm: clamped };
	}

	/**
	 * Set the floor-to-ceiling height the customer measured. Like room depth this
	 * changes nothing a cabinet is made of — it moves the back wall and the camera
	 * framing, which is what makes a tall unit read as tall.
	 */
	function setCeilingHeight(
		layout: PlannerLayout,
		ceilingHeightMm: number,
	): PlannerLayout {
		const clamped = Math.min(
			CEILING_LIMITS.maxMm,
			Math.max(CEILING_LIMITS.minMm, Math.round(ceilingHeightMm)),
		);
		return clamped === layout.ceilingHeightMm
			? layout
			: { ...layout, ceilingHeightMm: clamped };
	}

	/**
	 * How far the run overhangs the wall, if at all.
	 *
	 * `setWallWidth` will not produce this any more and no placement path can, so
	 * in practice it reports zero. It stays as the guard on the invariant — and it
	 * stops being theoretical the moment share links land, since a layout parsed
	 * from JSON has been through no setter at all.
	 */
	function overhangMm(layout: PlannerLayout): number {
		return Math.max(0, runExtentMm(layout) - layout.wallWidthMm);
	}

	/** The modules crossing the end of the wall, for the scene to flag. */
	function overhangingIds(layout: PlannerLayout): ReadonlySet<string> {
		const ids = new Set<string>();
		for (const row of ["floor", "wall"] as const) {
			for (const position of positionsOf(layout, row)) {
				if (position.xMm + position.widthMm > layout.wallWidthMm) {
					ids.add(position.placed.id);
				}
			}
		}
		return ids;
	}

	/**
	 * Pack both rows left, edge to edge, keeping the order the customer arranged.
	 * This is the old always-on behaviour, demoted to one deliberate action: the
	 * customer arranges freely and tidies up when they want a clean elevation.
	 */
	function closeGaps(layout: PlannerLayout): PlannerLayout {
		// The cursor walks **footprints**, not widths. Packing by width slid the
		// next cabinet under a turned one's corner — the run came out flush on
		// paper and superimposed on screen.
		const floor: PlacedModule[] = [];
		// A corner at the start of this wall is where the run begins.
		const startOf = (row: Row) => {
			const span = layout.reserved?.[row];
			return span?.startMm === 0 ? span.endMm : 0;
		};
		let cursor = startOf("floor");
		for (const position of positionsOf(layout, "floor")) {
			const spread = spreadMm(position);
			floor.push({ ...position.placed, xMm: cursor + spread });
			cursor += position.widthMm + spread * 2;
		}

		const packed: PlannerLayout = { ...layout, floor, wall: [] };
		const talls = positionsOf(packed, "floor")
			.filter((position) => position.family.kind === "tall")
			.map((position) => {
				const spread = spreadMm(position);
				return {
					startMm: position.xMm - spread,
					endMm: position.xMm + position.widthMm + spread,
				};
			});

		const wall: PlacedModule[] = [];
		cursor = startOf("wall");
		for (const position of positionsOf(layout, "wall")) {
			const spread = spreadMm(position);
			const footprintMm = position.widthMm + spread * 2;

			// Step past any tall unit, which owns the full height of its span.
			let moved = true;
			while (moved) {
				moved = false;
				for (const tall of talls) {
					if (cursor < tall.endMm && cursor + footprintMm > tall.startMm) {
						cursor = tall.endMm;
						moved = true;
					}
				}
			}

			wall.push({ ...position.placed, xMm: cursor + spread });
			cursor += footprintMm;
		}

		return { ...packed, wall };
	}

	/**
	 * Resize a cabinet in place.
	 *
	 * The **left edge stays put** and it grows to the right, because that is what
	 * the customer means by "make this one wider" — a cabinet that also slid
	 * sideways would move the run under them. If the neighbour is in the way the
	 * resize is refused outright rather than half-applied; `widthOptionsFor` is
	 * what the UI uses to grey those sizes out before they are even offered.
	 */
	function setWidth(
		layout: PlannerLayout,
		id: string,
		widthMm: number,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found || widthMm === found.placed.widthMm) return layout;

		const spans = occupiedSpans(layout, found.row, id);
		const wall = layout.wallWidthMm;
		if (found.placed.xMm + widthMm > wall) return layout;
		if (overlapsAnything(found.placed.xMm, widthMm, spans)) return layout;

		return {
			...layout,
			[found.row]: layout[found.row].map((module) =>
				module.id === id ? { ...module, widthMm } : module,
			),
		};
	}

	/** Every size on this cabinet's ladder, flagged with whether it would fit. */
	function widthOptionsFor(
		layout: PlannerLayout,
		id: string,
	): Array<{ widthMm: number; priceRm: number; fits: boolean }> {
		const found = find(layout, id);
		if (!found) return [];
		const family = familyIn(catalogue, found.placed.familyId);
		if (!family) return [];

		const spans = occupiedSpans(layout, found.row, id);
		return family.sizes.map((size) => ({
			widthMm: size.widthMm,
			priceRm: size.priceRm,
			fits:
				found.placed.xMm + size.widthMm <= layout.wallWidthMm &&
				!overlapsAnything(found.placed.xMm, size.widthMm, spans),
		}));
	}

	/**
	 * Swap what a cabinet *is* without moving it.
	 *
	 * The left edge is the thing the customer is not asking to change, so it
	 * stays and the new family takes the nearest width its own ladder offers.
	 * Refused rather than half-applied when the neighbours leave no room —
	 * same rule as `setWidth`, for the same reason: a swap that silently slid
	 * the run would move cabinets the customer never touched.
	 *
	 * A swap across rows is refused too. The rows are separate arrays and a
	 * wall cabinet standing where a base unit stood is not a resize, it is a
	 * different design decision — remove and add is the honest path for that.
	 */
	function replaceFamily(
		layout: PlannerLayout,
		id: string,
		familyId: string,
	): PlannerLayout {
		const found = find(layout, id);
		const family = familyIn(catalogue, familyId);
		if (!found || !family) return layout;
		if (family.id === found.placed.familyId) return layout;
		if (rowFor(family.kind) !== found.row) return layout;

		const widthMm = family.sizes.reduce(
			(best, size) =>
				Math.abs(size.widthMm - found.placed.widthMm) <
				Math.abs(best - found.placed.widthMm)
					? size.widthMm
					: best,
			family.sizes[0].widthMm,
		);

		const spans = occupiedSpans(layout, found.row, id);
		if (found.placed.xMm + widthMm > layout.wallWidthMm) return layout;
		if (overlapsAnything(found.placed.xMm, widthMm, spans)) return layout;

		return {
			...layout,
			[found.row]: layout[found.row].map((module) =>
				module.id === id ? { ...module, familyId, widthMm } : module,
			),
		};
	}

	/**
	 * Trade places with the cabinet next to it, in one row.
	 *
	 * This is what an arrow press means in a packed run. Sliding by a fixed
	 * step does nothing at all when the neighbour is flush — which in a
	 * starter layout is nearly every cabinet — and a control that is refused
	 * without saying so reads as broken. A swap always moves something.
	 *
	 * The pair keeps its own outer bounds, so a gap between the two stays the
	 * same size and the rest of the run never shifts. Refused when the
	 * destination is blocked by something in the other row: a wall cabinet
	 * cannot take a place where a tall unit stands floor to ceiling.
	 */
	function swapWithNeighbour(
		layout: PlannerLayout,
		id: string,
		direction: 1 | -1,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found) return layout;

		const row = positionsOf(layout, found.row);
		const index = row.findIndex((position) => position.placed.id === id);
		const neighbour = row[index + direction];
		if (index === -1 || !neighbour) return layout;

		const self = row[index];
		const left = direction === 1 ? self : neighbour;
		const right = direction === 1 ? neighbour : self;

		// Footprints throughout, because either one of the pair may be turned and
		// a turned cabinet reaches past its own width. Swapping by width put the
		// wider footprint where only the narrower one fitted.
		const leftSpread = spreadMm(left);
		const rightSpread = spreadMm(right);
		const leftFootMm = left.widthMm + leftSpread * 2;
		const rightFootMm = right.widthMm + rightSpread * 2;
		const leftStartMm = left.xMm - leftSpread;
		const rightStartMm = right.xMm - rightSpread;
		const gapMm = rightStartMm - (leftStartMm + leftFootMm);

		// Each takes the other's place against the pair's outer edges, so the
		// gap between them survives and nothing outside the pair moves.
		const leftToStartMm = leftStartMm + rightFootMm + gapMm;
		const rightToStartMm = leftStartMm;
		const leftToMm = leftToStartMm + leftSpread;
		const rightToMm = rightToStartMm + rightSpread;

		// Both halves move, so both have to be checked — and a tall unit standing
		// in the wall row has to be checked against that row too. Enumerating the
		// obstacles here got it wrong in exactly that case: swapping a base
		// cabinet with the tall beside it buried the tall under the wall
		// cabinets, because only the cabinet named in the call was ever tested.
		// Build the swap and ask whether the result is possible.
		const swapped = withX(
			withX(layout, found.row, left.placed.id, leftToMm),
			found.row,
			right.placed.id,
			rightToMm,
		);
		return isClear(swapped) ? swapped : layout;
	}

	/**
	 * Put a cabinet where a drag has taken it.
	 *
	 * Which axes a cabinet may move on is a layout rule, not a scene detail,
	 * so it is decided here: everything slides along the wall, and everything
	 * has a height of its own to change — see `canHangAt`. A hang height handed
	 * in for a cabinet that cannot take one is dropped rather than refused; the
	 * pointer moves in two dimensions whatever is being dragged, and the caller
	 * should not have to ask what it is holding.
	 *
	 * Ceiling mode ignores the vertical too: lining the tops up is the whole
	 * point of that mode, and `floorHeightMmOf` would overrule the stored
	 * figure anyway. Writing it would leave a number that silently reappears
	 * when the mode is switched off.
	 */
	function dragModule(
		layout: PlannerLayout,
		id: string,
		to: { xMm: number; hangAtMm?: number },
	): PlannerLayout {
		if (!find(layout, id)) return layout;

		const moved = moveModule(layout, id, to.xMm);
		if (to.hangAtMm === undefined || !canHangAt(moved, id)) return moved;
		return setHangAt(moved, id, to.hangAtMm);
	}

	return {
		positionsOf,
		allPositions,
		rowEndMm,
		occupiedSpans,
		freeSpans,
		offsetsOf,
		setGap,
		moveModule,
		dropModule,
		dragModule,
		firstFreeXMm,
		fits,
		addModule,
		removeModules,
		removeModule,
		replaceFamily,
		duplicateModule,
		setHangingHeight,
		setWallToCeiling,
		setWallToWall,
		setBaseSkirting,
		hangingHeightMmOf,
		exposureOf,
		endPanels,
		skirtingSpans,
		floorHeightMmOf,
		flushWallToTallTops,
		runExtentMm,
		minWallWidthMm,
		setWallWidth,
		setRoomDepth,
		setCeilingHeight,
		setHangAt,
		hangRangeMm,
		hangTargets,
		setRotation,
		overhangMm,
		overhangingIds,
		closeGaps,
		setWidth,
		widthOptionsFor,
		swapWithNeighbour,
		isClear,
	};
}

export type PlannerEngine = ReturnType<typeof plannerEngine>;
