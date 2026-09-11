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
	type RoomTypeId,
	roomTypeIn,
	WALL_CABINET_FLOOR_MM,
	WALL_HANG_LIMITS,
} from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import { exposedSides } from "./exposure";
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

type PlacedModule = {
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
};

export type Row = "floor" | "wall";

type Span = { startMm: number; endMm: number };

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
const newId = () => `m${++counter}`;

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
 * The scene needs the same answer `dragModule` acts on — a handle that stands
 * up and offers an axis the engine has stopped granting is worse than no
 * handle — so the rule lives here once and both read it.
 *
 * A floor unit always has one. It used to have none, on the reasoning that a
 * base cabinet stands on the floor and that is that; but the handle offers two
 * axes and one of them did nothing, which reads as a broken control rather
 * than as a rule. `floorHeightMm` was already catalogue data an admin could
 * raise, so "off the floor" was always a state this engine could be in — the
 * customer simply had no way to ask for it.
 *
 * A wall unit's is the one that can be taken away: ceiling mode aligns every
 * wall top to the ceiling, so a per-cabinet height has nothing to say.
 */
export const canHangAt = (layout: PlannerLayout, id: string): boolean => {
	const found = find(layout, id);
	if (!found) return false;
	return found.row === "floor" || !layout.wallToCeiling;
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
		return positionsOf(layout, row).reduce(
			(end, position) => Math.max(end, position.xMm + position.widthMm),
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

		return [...own, ...crossRow]
			.filter((position) => position.placed.id !== ignoreId)
			.map((position) => ({
				startMm: position.xMm,
				endMm: position.xMm + position.widthMm,
			}))
			.sort((a, b) => a.startMm - b.startMm);
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

		const leftEdgeMm = position.xMm;
		const rightEdgeMm = position.xMm + position.widthMm;
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
	 * Settle a cabinet at the position it is being asked for.
	 *
	 * It cannot leave the wall, and it cannot pass through anything: a cabinet
	 * pushed into its neighbour stops flush against it, exactly like pushing a
	 * real carcass down a wall. `fromMm` is where the cabinet currently is, which
	 * is what decides *which side* of an obstacle it stops on — without it, a
	 * cabinet dragged fast enough to jump clean over a neighbour in one frame
	 * would pop out on the far side.
	 */
	function clampX(
		layout: PlannerLayout,
		row: Row,
		widthMm: number,
		xMm: number,
		ignoreId?: string,
		fromMm?: number,
	): number {
		const wanted = clampToWall(xMm, widthMm, layout.wallWidthMm);
		const spans = occupiedSpans(layout, row, ignoreId);
		const origin = fromMm ?? wanted;

		let settled = wanted;
		// One pass per obstacle, repeated until nothing moves: stopping against one
		// neighbour can push the cabinet into the next one along.
		for (let pass = 0; pass < spans.length + 1; pass++) {
			let moved = false;

			for (const span of spans) {
				const left = settled;
				const right = settled + widthMm;
				if (right <= span.startMm || left >= span.endMm) continue;

				// Approaching from the left means stopping before the obstacle.
				const approachingFromLeft = origin + widthMm / 2 < span.startMm;
				settled = approachingFromLeft ? span.startMm - widthMm : span.endMm;
				settled = clampToWall(settled, widthMm, layout.wallWidthMm);
				moved = true;
			}

			if (!moved) break;
		}

		// If it still overlaps, every direction is blocked — leave it where it was.
		return overlapsAnything(settled, widthMm, spans)
			? clampToWall(origin, widthMm, layout.wallWidthMm)
			: settled;
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

		for (const r of [row, other]) {
			for (const position of positionsOf(layout, r)) {
				if (position.placed.id === ignoreId) continue;
				edges.push(position.xMm, position.xMm + position.widthMm);
			}
		}

		return edges;
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
	): number {
		const targets = snapTargets(layout, row, ignoreId);

		let best = xMm;
		let bestDistance = SNAP_MM;

		for (const target of targets) {
			// Either the left edge or the right edge can be the one that lands.
			for (const candidate of [target, target - widthMm]) {
				const distance = Math.abs(candidate - xMm);
				if (distance < bestDistance) {
					best = candidate;
					bestDistance = distance;
				}
			}
		}

		return clampX(layout, row, widthMm, best, ignoreId, xMm);
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
		);
		return settled === found.placed.xMm
			? layout
			: withX(layout, found.row, id, settled);
	}

	/** Drag released: settle, then snap flush if it is close to an edge. */
	function dropModule(
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
		);
		const snapped = snapX(layout, found.row, found.placed.widthMm, settled, id);
		return snapped === found.placed.xMm
			? layout
			: withX(layout, found.row, id, snapped);
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
			doorStyleId: null,
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
	 * Raise or lower one cabinet out of its row. `null` puts it back.
	 *
	 * The two rows are clamped by different rules because they are answering
	 * different questions. A wall unit is held to the same range the hang slider
	 * allows, so a cabinet can never be nudged somewhere the slider could not
	 * have put the whole row — the gizmo is a shortcut, not a second set of
	 * rules. A floor unit has no slider to agree with, so the only rule is the
	 * room: it stays on or above the floor, and its top stays under the ceiling.
	 */
	function setHangAt(
		layout: PlannerLayout,
		id: string,
		hangAtMm: number | null,
	): PlannerLayout {
		const found = find(layout, id);
		if (!found || !canHangAt(layout, id)) return layout;

		const next = { ...found.placed };
		if (hangAtMm === null) {
			delete next.hangAtMm;
		} else {
			next.hangAtMm = Math.round(clampHangAt(layout, found.row, id, hangAtMm));
		}

		return {
			...layout,
			[found.row]: layout[found.row].map((module) =>
				module.id === id ? next : module,
			),
		};
	}

	/**
	 * How high this row lets one cabinet be lifted, and what is in the way.
	 *
	 * Two rules stacked. The row's own comes first: a wall unit is held to the
	 * hang slider's range, so the gizmo stays a shortcut rather than a second
	 * set of rules; a floor unit has no slider to agree with, so its rule is the
	 * room — on or above the floor, top under the ceiling, its own height
	 * deciding where it runs out of headroom.
	 *
	 * Then the other row. A cabinet cannot pass through the one above or below
	 * it any more than it can pass through its neighbour, and until floor units
	 * could move vertically nothing had to say so — a base unit dragged up went
	 * clean through the wall unit over it, worktop and all. This is `clampX`'s
	 * rule turned ninety degrees, anchors and all: it stops flush against the
	 * underside of whatever is above, or the top of whatever is below.
	 */
	/**
	 * How much vertical room a cabinet actually takes up.
	 *
	 * Not its carcass height: a base unit wears a worktop, and the slab sits on
	 * top of the carcass rather than inside it. Clamping to the carcass alone
	 * stopped the cabinet flush and drove forty millimetres of worktop through
	 * the wall unit above — which is the part you see. `Worktop` in the scene
	 * draws from the same two numbers.
	 */
	function occupiedHeightMm(family: Family): number {
		return (
			family.heightMm +
			(family.kind === "base" ? construction.worktopThicknessMm : 0)
		);
	}

	function clampHangAt(
		layout: PlannerLayout,
		row: Row,
		id: string,
		hangAtMm: number,
	): number {
		const own = positionsOf(layout, row).find((p) => p.placed.id === id);
		// An id that is not placed has nothing to clamp against, and nothing to
		// clamp: hand the figure back rather than inventing a bound for it.
		if (!own) return hangAtMm;
		const heightMm = occupiedHeightMm(own.family);

		const rowMinMm = row === "wall" ? WALL_HANG_LIMITS.minMm : 0;
		const rowMaxMm =
			row === "wall"
				? WALL_HANG_LIMITS.maxMm
				: layout.ceilingHeightMm - heightMm;

		// Where it is now decides which side of an obstacle it stops on — the
		// same reason `clampX` takes a `fromMm`. Anything it already overlaps is
		// neither above nor below it and is left out: a cabinet the catalogue has
		// wedged should not be shoved somewhere arbitrary by a drag.
		const fromMm = floorHeightMmOf(own, layout);
		const leftMm = own.xMm;
		const rightMm = own.xMm + own.widthMm;

		let ceilingMm = layout.ceilingHeightMm;
		let floorMm = 0;
		for (const other of positionsOf(
			layout,
			row === "wall" ? "floor" : "wall",
		)) {
			// Touching end to end is not overlapping, so a cabinet is free to pass
			// a neighbour that merely abuts its x span.
			if (other.xMm + other.widthMm <= leftMm || other.xMm >= rightMm) continue;
			const bottomMm = floorHeightMmOf(other, layout);
			const topMm = bottomMm + occupiedHeightMm(other.family);
			if (bottomMm >= fromMm + heightMm) {
				ceilingMm = Math.min(ceilingMm, bottomMm);
			} else if (topMm <= fromMm) {
				floorMm = Math.max(floorMm, topMm);
			}
		}

		const minMm = Math.max(rowMinMm, floorMm);
		const maxMm = Math.min(rowMaxMm, ceilingMm - heightMm);
		// Boxed in with no room to move: hold it where it is. Clamping into an
		// inverted range would snap it to one end of a gap it does not fit.
		if (maxMm < minMm) return fromMm;
		return Math.max(minMm, Math.min(maxMm, hangAtMm));
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
	 * Every cabinet side that has to be clad.
	 *
	 * A carcass side is drilled with system holes and shows its fixings, so any
	 * side left in the open gets a panel matching the fronts. A side against a
	 * neighbour, or against a return wall when the room has them, is buried and
	 * needs nothing.
	 *
	 * Interior sides count. A cabinet standing beside a gap mid-run has a visible
	 * drilled side exactly like one at the end of the row — the same rule reaches
	 * both, which is why this asks `exposedSides` rather than looking at the ends.
	 */
	function endPanels(layout: PlannerLayout): EndPanel[] {
		const walls = {
			wallWidthMm: layout.wallWidthMm,
			enclosed: layout.wallToWall,
		};
		const panels: EndPanel[] = [];

		for (const row of ["floor", "wall"] as const) {
			const positions = positionsOf(layout, row);
			for (const [index, position] of positions.entries()) {
				const exposed = exposedSides(positions, index, walls);
				for (const side of ["left", "right"] as const) {
					if (!exposed[side]) continue;
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
			// A unit lifted off the floor has no feet down there to hide, and a
			// kick board floating in the gap under it would be a board standing
			// on nothing. It gets none, and it breaks the stretch either side —
			// the same way a gap does, and for the same reason.
			if (floorHeightMmOf(position, layout) > position.family.floorHeightMm) {
				continue;
			}
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
	 * family. That rule used to be written out separately in the scene, in the
	 * contact shadows and in the measuring tool, which meant a change to how the
	 * wall row is positioned had three places to reach and the measuring tool
	 * could end up reporting a number the scene disagreed with. One function now.
	 */
	function floorHeightMmOf(
		position: Positioned,
		layout: PlannerLayout,
	): number {
		if (position.family.kind !== "wall") {
			// Lifted off the floor by its handle, or standing at whatever height
			// the catalogue gives the family. Everything downstream — the scene,
			// the contact shadows, the measuring tool, the worktop — reads this
			// one function, so a floor unit dragged upward carries all of them
			// with it.
			return position.placed.hangAtMm ?? position.family.floorHeightMm;
		}
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
		const floor: PlacedModule[] = [];
		let cursor = 0;
		for (const position of positionsOf(layout, "floor")) {
			floor.push({ ...position.placed, xMm: cursor });
			cursor += position.widthMm;
		}

		const packed: PlannerLayout = { ...layout, floor, wall: [] };
		const talls = floor
			.map((placed) => ({
				placed,
				family: familyIn(catalogue, placed.familyId),
			}))
			.filter((entry) => entry.family?.kind === "tall");

		const wall: PlacedModule[] = [];
		cursor = 0;
		for (const position of positionsOf(layout, "wall")) {
			// Step past any tall unit, which owns the full height of its span.
			let moved = true;
			while (moved) {
				moved = false;
				for (const { placed, family: tall } of talls) {
					if (!tall) continue;
					const start = placed.xMm;
					const end = placed.xMm + placed.widthMm;
					if (cursor < end && cursor + position.widthMm > start) {
						cursor = end;
						moved = true;
					}
				}
			}

			wall.push({ ...position.placed, xMm: cursor });
			cursor += position.widthMm;
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
		const gapMm = right.xMm - (left.xMm + left.widthMm);

		// Each takes the other's place against the pair's outer edges, so the
		// gap between them survives and nothing outside the pair moves.
		const leftToMm = left.xMm + right.widthMm + gapMm;
		const rightToMm = left.xMm;

		const spans = occupiedSpans(layout, found.row, id).filter(
			(span) =>
				!(
					span.startMm === neighbour.xMm &&
					span.endMm === neighbour.xMm + neighbour.widthMm
				),
		);
		if (
			overlapsAnything(leftToMm, left.widthMm, spans) ||
			overlapsAnything(rightToMm, right.widthMm, spans)
		) {
			return layout;
		}

		return withX(
			withX(layout, found.row, left.placed.id, leftToMm),
			found.row,
			right.placed.id,
			rightToMm,
		);
	}

	/**
	 * Put a cabinet where a drag has taken it.
	 *
	 * Which axes a cabinet may move on is a layout rule, not a scene detail,
	 * so it is decided here: everything slides along the wall, and only a hung
	 * cabinet has a height of its own to change. A hang height handed in for a
	 * floor unit is dropped rather than refused — the pointer moves in two
	 * dimensions whatever is being dragged, and the caller should not have to
	 * ask what it is holding.
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

	/**
	 * The room's own starter, so no room ever opens on a blank wall — the same
	 * rule the wardrobe configurator follows. Dropped at 0 each time, so each one
	 * takes the leftmost gap that holds it and the run comes out packed from the
	 * left without a tidy-up pass.
	 */
	function starterFor(roomId: RoomTypeId): PlannerLayout {
		const room = roomTypeIn(catalogue, roomId);
		let layout = emptyLayout(room.defaultWallWidthMm);
		for (const item of room.starter) {
			layout = addModule(layout, item.familyId, 0, newId(), item.widthMm);
		}
		return layout;
	}

	return {
		positionsOf,
		allPositions,
		rowEndMm,
		occupiedSpans,
		freeSpans,
		offsetsOf,
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
		overhangMm,
		overhangingIds,
		closeGaps,
		setWidth,
		widthOptionsFor,
		starterFor,
		swapWithNeighbour,
	};
}

export type PlannerEngine = ReturnType<typeof plannerEngine>;
