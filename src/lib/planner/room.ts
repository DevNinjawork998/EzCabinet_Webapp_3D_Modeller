import { constructionOf, familyIn, isCorner, WALL_GAP_MM } from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import type { ExposedSides } from "./exposure";
import {
	distanceToWallMm,
	type FloorPlan,
	footprintInPlan,
	frameOf,
	nearestWall,
	setWallLength as planWithWallLength,
	pointInPlan,
	type RoomShape,
	rectCorners,
	rectsOverlap,
	reshape,
	shapeOf,
	toWorldMm,
	type Vec2,
	vertexKind,
	type WallFrame,
	wallsOf,
} from "./floorplan";
import {
	canHangAt,
	depthSpreadMm,
	type EndPanel,
	emptyLayout,
	type HingeSide,
	inRun,
	newId,
	type PlacedModule,
	type PlannerLayout,
	type Positioned,
	plannerEngine,
	type Row,
	rowFor,
	type Span,
	settleTurnDeg,
	spreadMm,
} from "./layout";
import { OVERLAY_OPEN_RAD } from "./swing";

/**
 * A room: a floor plan, and a run of cabinets along each of its walls.
 *
 * The stored document. `plan` says what shape the room is; `runs[i]` is the
 * run along wall i; `corners` holds the corner units, each at a vertex. Every
 * run is still the one-dimensional thing `layout.ts` arranges — it is handed to
 * that engine as an ordinary `PlannerLayout` (`runView`), with the corner
 * squares as reserved spans, and the rows it hands back are written into the
 * room (`withRun`). Every clamp, snap, gap and turn rule is reused unchanged.
 *
 * Each run's `xMm` reads left to right *facing that wall from inside the room*
 * — the winding `floorplan.ts` guarantees — so vertex i is the right end of run
 * i and the left end of run i+1.
 *
 * **A corner square is derived, never stored.** An inside corner reserves its
 * square on both walls only when both walls hold cabinets, or it holds a corner
 * unit. A single wall of cabinets runs right into the corner, as it would in a
 * real kitchen with nothing on the next wall.
 *
 * Pure, like the rest of `lib/planner`.
 */

export type Run = { floor: PlacedModule[]; wall: PlacedModule[] };

/** The corner units at one inside corner. */
export type CornerUnits = {
	vertex: number;
	floor: PlacedModule | null;
	wall: PlacedModule | null;
};

type Settings = Omit<
	PlannerLayout,
	| "floor"
	| "wall"
	| "reserved"
	| "endWalls"
	| "wallWidthMm"
	| "roomDepthMm"
	| "wallToWall"
>;

/**
 * A cabinet standing on its own on the floor, against no wall. `xMm, zMm` are
 * the centre of its footprint in plan millimetres; `rotationDeg` is its yaw
 * from the back wall, in the same sense as a wall's `yawRad`.
 */
export type FreeModule = PlacedModule & { zMm: number };

export type RoomLayout = Settings & {
	plan: FloorPlan;
	/** One per wall of `plan`, in wall order. */
	runs: Run[];
	corners: CornerUnits[];
	/** Base and tall units standing free on the floor. */
	free: FreeModule[];
};

/** A free cabinet as the engine reads it: on the floor, whatever a client
 * sent. A free row never carries `hangAtMm`. */
const grounded = ({ hangAtMm: _lift, ...module }: FreeModule): FreeModule =>
	module;

/** A dropped cabinet whose back edge lands this close to a wall joins it. */
export const SNAP_TO_WALL_MM = 150;

/** Whether a cabinet `depthMm` deep, centred at `centre`, stands further off
 * wall `run` than a drop would snap back to it — a drag past this has left
 * its wall and follows the floor. */
export const offWall = (
	plan: FloorPlan,
	run: number,
	centre: Vec2,
	depthMm: number,
): boolean =>
	distanceToWallMm(plan, run, centre) - depthMm / 2 > SNAP_TO_WALL_MM;

/** Whether `centre` is in the L's notch: inside the plan's bounding box but
 * not in the room. Past an ordinary wall is not — a drag onto a wall readily
 * overshoots it, and that is still a drop on that wall. */
const inNotch = (plan: FloorPlan, centre: Vec2): boolean =>
	Math.abs(centre.xMm) <= plan.widthMm / 2 &&
	Math.abs(centre.zMm) <= plan.depthMm / 2 &&
	!pointInPlan(plan, centre);

/** The wall a cabinet dropped at `centre` joins — the nearest, if its back
 * edge is within `SNAP_TO_WALL_MM` of it (behind a wall counts, by the signed
 * distance) — and the drop point along it; or `null` when it stands free, or
 * when `centre` is in the L's notch. Ignores any turn, as `dropAt` does. */
export function wallToJoin(
	plan: FloorPlan,
	centre: Vec2,
	depthMm: number,
): { run: number; xMm: number } | null {
	if (inNotch(plan, centre)) return null;
	const target = nearestWall(plan, centre);
	return offWall(plan, target.run, centre, depthMm) ? null : target;
}

/** How much of each row an empty corner keeps: the depth of the cabinets that
 * meet there. The seed's depths, not the live catalogue's — see the history of
 * this constant in git for why that is tolerable. */
export const EMPTY_CORNER_MM: Record<Row, number> = { floor: 607, wall: 397 };

const emptyRun = (): Run => ({ floor: [], wall: [] });

/** One wall's layout as the back wall of a rectangular room. `wallToWall` has
 * no meaning in a room with walls all round, so it is dropped. */
export function asRoom(layout: PlannerLayout): RoomLayout {
	const {
		floor,
		wall,
		reserved: _reserved,
		endWalls: _endWalls,
		wallWidthMm,
		roomDepthMm,
		wallToWall: _wallToWall,
		...settings
	} = layout;
	return {
		...settings,
		plan: { template: "rect", widthMm: wallWidthMm, depthMm: roomDepthMm },
		runs: [{ floor, wall }, emptyRun(), emptyRun(), emptyRun()],
		corners: [],
		free: [],
	};
}

export const emptyRoom = (
	...args: Parameters<typeof emptyLayout>
): RoomLayout => asRoom(emptyLayout(...args));

const countOf = (room: RoomLayout) => room.runs.length;
const startVertexOf = (room: RoomLayout, run: number) =>
	(run - 1 + countOf(room)) % countOf(room);
const hasCabinets = (run: Run | undefined) =>
	run !== undefined && run.floor.length + run.wall.length > 0;
const lengthOf = (room: RoomLayout, run: number) =>
	wallsOf(room.plan)[run].lengthMm;

export const cornerAt = (
	room: RoomLayout,
	vertex: number,
): CornerUnits | null =>
	room.corners.find((corner) => corner.vertex === vertex) ?? null;

export function isActiveCorner(room: RoomLayout, vertex: number): boolean {
	if (vertexKind(room.plan, vertex) !== "inside") return false;
	const units = cornerAt(room, vertex);
	if (units?.floor || units?.wall) return true;
	return (
		hasCabinets(room.runs[vertex]) &&
		hasCabinets(room.runs[(vertex + 1) % countOf(room)])
	);
}

/** The side of a corner's square along each wall, in one row. */
export const cornerSquareMm = (room: RoomLayout, vertex: number, row: Row) =>
	cornerAt(room, vertex)?.[row]?.widthMm ?? EMPTY_CORNER_MM[row];

/** The active corner squares along one run, in one row, start before end. */
export function cornerSpans(
	room: RoomLayout,
	run: number,
	row: Row,
): { vertex: number; atStart: boolean; span: Span }[] {
	const spans: { vertex: number; atStart: boolean; span: Span }[] = [];
	const start = startVertexOf(room, run);
	if (isActiveCorner(room, start)) {
		spans.push({
			vertex: start,
			atStart: true,
			span: { startMm: 0, endMm: cornerSquareMm(room, start, row) },
		});
	}
	if (isActiveCorner(room, run)) {
		const lengthMm = lengthOf(room, run);
		spans.push({
			vertex: run,
			atStart: false,
			span: {
				startMm: lengthMm - cornerSquareMm(room, run, row),
				endMm: lengthMm,
			},
		});
	}
	return spans;
}

/** Which corner a corner unit added from this wall goes to: its start when
 * that is an inside corner, else its end, else none. */
export function cornerVertexFor(room: RoomLayout, run: number): number | null {
	const start = startVertexOf(room, run);
	if (vertexKind(room.plan, start) === "inside") return start;
	return vertexKind(room.plan, run) === "inside" ? run : null;
}

/** Where a click-added cabinet should land: the start of the wall, unless the
 * start is the notch's outside corner and the end is a real one. */
export const nearCornerMm = (room: RoomLayout, run: number): number =>
	vertexKind(room.plan, startVertexOf(room, run)) === "outside" &&
	vertexKind(room.plan, run) === "inside"
		? lengthOf(room, run)
		: 0;

/** A module seen from the other end of a wall of this length. Its own inverse. */
const mirrorModule =
	(lengthMm: number) =>
	(module: PlacedModule): PlacedModule => ({
		...module,
		xMm: lengthMm - module.xMm - module.widthMm,
		hinge: module.hinge === "left" ? "right" : "left",
		...(module.rotationDeg
			? { rotationDeg: (360 - module.rotationDeg) % 360 }
			: {}),
	});

/** A run anchored at its far corner rather than its near one: either its only
 * active corner span is at that end, or — before any corner has switched
 * on — its start is the notch's outside corner and its end a real one, the
 * same end `nearCornerMm` picks for a click-added cabinet. Packing, extent
 * and a wall-length edit all follow this end, so a run reads the same way
 * whether or not its corner has activated yet. */
function anchoredAtEnd(room: RoomLayout, run: number): boolean {
	const spans = cornerSpans(room, run, "floor");
	if (spans.length > 0) return spans.length === 1 && !spans[0].atStart;
	return (
		vertexKind(room.plan, startVertexOf(room, run)) === "outside" &&
		vertexKind(room.plan, run) === "inside"
	);
}

export function runView(room: RoomLayout, run: number): PlannerLayout {
	const { plan, runs, corners: _corners, free: _free, ...settings } = room;
	const wall = wallsOf(plan)[run];
	const floor = cornerSpans(room, run, "floor").map((c) => c.span);
	const hung = cornerSpans(room, run, "wall").map((c) => c.span);
	return {
		...settings,
		wallWidthMm: wall.lengthMm,
		roomDepthMm: wall.depthMm,
		wallToWall: false,
		endWalls: {
			left: vertexKind(plan, startVertexOf(room, run)) === "inside",
			right: vertexKind(plan, run) === "inside",
		},
		floor: runs[run].floor,
		wall: runs[run].wall,
		...(floor.length > 0 ? { reserved: { floor, wall: hung } } : {}),
	};
}

/** A run's view read from its far end, when that is its only corner, so the
 * one-wall engine — which packs toward x = 0 — packs toward the corner. */
function fromCorner(room: RoomLayout, run: number): PlannerLayout {
	const view = runView(room, run);
	if (!anchoredAtEnd(room, run)) return view;
	const L = view.wallWidthMm;
	const flip = (span: Span): Span => ({
		startMm: L - span.endMm,
		endMm: L - span.startMm,
	});
	return {
		...view,
		floor: view.floor.map(mirrorModule(L)),
		wall: view.wall.map(mirrorModule(L)),
		reserved: {
			floor: view.reserved?.floor?.map(flip),
			wall: view.reserved?.wall?.map(flip),
		},
	};
}

/** Write a view's rows back. Rows only: a view's length, depth, end walls and
 * reserved spans are derived, and must never land in the document. */
export function withRun(
	room: RoomLayout,
	run: number,
	view: PlannerLayout,
): RoomLayout {
	const current = room.runs[run];
	if (!current || (current.floor === view.floor && current.wall === view.wall))
		return room;
	return {
		...room,
		runs: room.runs.map((r, i) =>
			i === run ? { floor: view.floor, wall: view.wall } : r,
		),
	};
}

export const runIndexOf = (room: RoomLayout, id: string): number =>
	room.runs.findIndex(
		(run) =>
			run.floor.some((m) => m.id === id) || run.wall.some((m) => m.id === id),
	);

function mapModule(
	room: RoomLayout,
	id: string,
	edit: (module: PlacedModule) => PlacedModule,
): RoomLayout {
	const hit = (module: PlacedModule) =>
		module.id === id ? edit(module) : module;
	return {
		...room,
		runs: room.runs.map((run) => ({
			floor: run.floor.map(hit),
			wall: run.wall.map(hit),
		})),
		corners: room.corners.map((corner) => ({
			...corner,
			floor: corner.floor && hit(corner.floor),
			wall: corner.wall && hit(corner.wall),
		})),
		free: room.free.map((module) =>
			module.id === id ? { ...edit(module), zMm: module.zMm } : module,
		),
	};
}

export const setDoor = (
	room: RoomLayout,
	id: string,
	doorStyleId: string | null,
) => mapModule(room, id, (module) => ({ ...module, doorStyleId }));

export const setHinge = (room: RoomLayout, id: string, hinge: HingeSide) =>
	mapModule(room, id, (module) => ({ ...module, hinge }));

export function setDoors(
	room: RoomLayout,
	ids: Iterable<string>,
	doorStyleId: string | null,
): RoomLayout {
	let next = room;
	for (const id of ids) next = setDoor(next, id, doorStyleId);
	return next;
}

/**
 * The placement engine for a whole room, bound to one catalogue.
 *
 * Same names and arguments as `plannerEngine`, taking a `RoomLayout`. Row
 * questions take an optional run index, defaulting to the back wall; edits
 * addressed by id go to whichever run holds that id.
 */
export function roomEngine(catalogue: PlannerCatalogue) {
	const wall = plannerEngine(catalogue);
	const views = (room: RoomLayout) => room.runs.map((_, i) => runView(room, i));
	/** Every run clear, and every free cabinet known and standing somewhere it
	 * can. Strict: what checkout asks. */
	const allClear = (room: RoomLayout) =>
		views(room).every((v) => wall.isClear(v)) && freeIsClear(room);

	/**
	 * Whether an edit may land: every run clear, and no free cabinet newly in
	 * trouble. Not `allClear` — one stale free cabinet (its family gone after a
	 * catalogue change, or a saved design now overlapping) must not freeze
	 * every other edit in the room, so only problems the edit *creates* refuse
	 * it.
	 */
	const accepts = (room: RoomLayout, next: RoomLayout) => {
		if (!views(next).every((v) => wall.isClear(v))) return false;
		if (next.free.length === 0) return true;
		const before = freeProblems(room);
		return [...freeProblems(next)].every((id) => before.has(id));
	};

	/** An id-addressed edit, applied in the run that holds the id. A run edit
	 * that pushes a cabinet into a free one's footprint is refused. */
	const inRunOf =
		<A extends unknown[]>(
			edit: (view: PlannerLayout, id: string, ...args: A) => PlannerLayout,
		) =>
		(room: RoomLayout, id: string, ...args: A): RoomLayout => {
			const run = runIndexOf(room, id);
			if (run < 0) return room;
			const next = withRun(room, run, edit(runView(room, run), id, ...args));
			return next === room || room.free.length === 0 || accepts(room, next)
				? next
				: room;
		};

	/** Every row pooled, for questions about height alone. Nothing that reads
	 * `xMm` may be asked of this. */
	const pooled = (room: RoomLayout): PlannerLayout => {
		const { reserved: _reserved, ...main } = runView(room, 0);
		const units = (row: Row) =>
			room.corners.flatMap((corner) => {
				const unit = corner[row];
				return unit ? [unit] : [];
			});
		return {
			...main,
			floor: [
				...room.runs.flatMap((run) => run.floor),
				...units("floor"),
				...room.free.map(grounded),
			],
			wall: [...room.runs.flatMap((run) => run.wall), ...units("wall")],
		};
	};

	/** The corner units drawn with this run: the ones at its start. Designs are
	 * drawn for the left-hand corner, and by the winding every corner is the
	 * left-hand corner of the wall after it — so no unit is ever turned. */
	function cornerPositionsOf(room: RoomLayout, run: number): Positioned[] {
		const units = cornerAt(room, startVertexOf(room, run));
		if (!units) return [];
		return (["floor", "wall"] as const).flatMap((row) => {
			const placed = units[row];
			const family = placed && familyIn(catalogue, placed.familyId);
			if (!placed || !family) return [];
			// The corner decides where it stands, whatever a client sent.
			const { rotationDeg: _ignored, ...rest } = placed;
			return [
				{
					placed: { ...rest, xMm: 0 },
					family,
					widthMm: placed.widthMm,
					xMm: 0,
				},
			];
		});
	}

	const cornerPositions = (room: RoomLayout): Positioned[] =>
		room.runs.flatMap((_, run) => cornerPositionsOf(room, run));

	/**
	 * A free cabinet as a run of one: a wall exactly its width, with no wall at
	 * either end, holding it square at x = 0. Its turn is the frame's, not its
	 * own — so worktop, kick board and end panels all come out of the one-wall
	 * engine unchanged, and the scene can draw it with `Run` in its own frame.
	 */
	function freeView(room: RoomLayout, id: string): PlannerLayout | null {
		const found = room.free.find((m) => m.id === id);
		if (!found) return null;
		const { reserved: _reserved, ...main } = runView(room, 0);
		const { zMm: _z, rotationDeg: _turn, ...placed } = grounded(found);
		return {
			...main,
			wallWidthMm: found.widthMm,
			endWalls: { left: false, right: false },
			floor: [{ ...placed, xMm: 0 }],
			wall: [],
		};
	}

	const freeViews = (room: RoomLayout): PlannerLayout[] =>
		room.free.flatMap((m) => {
			const view = freeView(room, m.id);
			return view ? [view] : [];
		});

	/** A free cabinet's footprint in plan, or null if it is not free or its
	 * family is unknown. */
	function freeFootprint(room: RoomLayout, id: string): Vec2[] | null {
		const found = room.free.find((m) => m.id === id);
		const family = found && familyIn(catalogue, found.familyId);
		if (!found || !family) return null;
		return rectCorners(
			{ xMm: found.xMm, zMm: found.zMm },
			found.widthMm,
			family.depthMm,
			((found.rotationDeg ?? 0) * Math.PI) / 180,
		);
	}

	/** Every run cabinet's footprint in plan, in one row, its back at the wall
	 * gap — where the scene draws it. Corner units count as their square. */
	function runFootprints(
		room: RoomLayout,
		row: Row,
	): { id: string; corners: Vec2[] }[] {
		const walls = wallsOf(room.plan);
		return room.runs.flatMap((_, run) => {
			const w = walls[run];
			const frame = frameOf(w);
			const backMm = -w.depthMm / 2 + WALL_GAP_MM;
			const at = (
				xMm: number,
				zMm: number,
				widthMm: number,
				depthMm: number,
				turnDeg: number,
			) => {
				const centre = toWorldMm({ x: xMm, y: 0, z: zMm }, frame);
				return rectCorners(
					{ xMm: centre.x, zMm: centre.z },
					widthMm,
					depthMm,
					w.yawRad + (turnDeg * Math.PI) / 180,
				);
			};
			const inRow = wall.positionsOf(runView(room, run), row).map((p) => {
				const turn = p.placed.rotationDeg ?? 0;
				const depthMm = p.family.depthMm;
				return {
					id: p.placed.id,
					corners: at(
						p.xMm + p.widthMm / 2 - w.lengthMm / 2,
						backMm + depthMm / 2 + depthSpreadMm(p.widthMm, depthMm, turn),
						p.widthMm,
						depthMm,
						turn,
					),
				};
			});
			const corners = cornerPositionsOf(room, run)
				.filter((p) => rowFor(p.family.kind) === row)
				.map((p) => ({
					id: p.placed.id,
					corners: at(
						p.widthMm / 2 - w.lengthMm / 2,
						backMm + p.widthMm / 2,
						p.widthMm,
						p.widthMm,
						0,
					),
				}));
			return [...inRow, ...corners];
		});
	}

	/**
	 * The free cabinets standing where they cannot: a wall or corner design,
	 * outside the room, or overlapping another free cabinet or a floor cabinet
	 * on a wall — and a tall one the hung row too. Both of an overlapping pair
	 * are named. A free cabinet whose family is unknown is skipped, as
	 * `positionsOf` skips one in a run; `freeIsClear` is what refuses it.
	 */
	function freeProblems(room: RoomLayout): Set<string> {
		const bad = new Set<string>();
		if (room.free.length === 0) return bad;
		const floor = runFootprints(room, "floor").map((f) => f.corners);
		const hung = runFootprints(room, "wall").map((f) => f.corners);
		const known = room.free.flatMap((m) => {
			const family = familyIn(catalogue, m.familyId);
			const corners = freeFootprint(room, m.id);
			return family && corners ? [{ id: m.id, family, corners }] : [];
		});
		known.forEach((a, i) => {
			const overlaps = (other: Vec2[]) => rectsOverlap(a.corners, other);
			if (
				a.family.kind === "wall" ||
				isCorner(a.family) ||
				!footprintInPlan(room.plan, a.corners) ||
				floor.some(overlaps) ||
				(a.family.kind === "tall" && hung.some(overlaps))
			)
				bad.add(a.id);
			for (const b of known.slice(i + 1)) {
				if (overlaps(b.corners)) {
					bad.add(a.id);
					bad.add(b.id);
				}
			}
		});
		return bad;
	}

	/** Every free cabinet known, and none standing where it cannot. */
	const freeIsClear = (room: RoomLayout): boolean =>
		room.free.every((m) => familyIn(catalogue, m.familyId)) &&
		freeProblems(room).size === 0;

	/** A run or free cabinet by id. Corner units are neither. */
	const findModule = (room: RoomLayout, id: string): PlacedModule | undefined =>
		room.free.find((m) => m.id === id) ??
		room.runs.flatMap((r) => [...r.floor, ...r.wall]).find((m) => m.id === id);

	/** A free cabinet's ladder, each width asked whether it would still stand
	 * where it is. */
	function freeWidthOptions(room: RoomLayout, id: string) {
		const found = room.free.find((m) => m.id === id);
		const family = found && familyIn(catalogue, found.familyId);
		if (!found || !family) return [];
		return family.sizes.map((size) => ({
			widthMm: size.widthMm,
			priceRm: size.priceRm,
			fits: !freeProblems({
				...room,
				free: room.free.map((m) =>
					m.id === id ? { ...m, widthMm: size.widthMm } : m,
				),
			}).has(id),
		}));
	}

	/** Whole degrees in [0, 360). */
	const normalDeg = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;

	/**
	 * Stand a run or free cabinet free on the floor at `centre`. Refused,
	 * unchanged, for a wall or corner unit, outside the room, or overlapping.
	 * Off a wall it keeps facing the way that wall faced it; a free one keeps
	 * its own turn unless handed another.
	 */
	function placeFree(
		room: RoomLayout,
		id: string,
		centre: Vec2,
		rotationDeg?: number,
	): RoomLayout {
		const run = runIndexOf(room, id);
		const free = room.free.find((m) => m.id === id);
		const found = findModule(room, id);
		const family = found && familyIn(catalogue, found.familyId);
		if (!found || !family || family.kind === "wall" || isCorner(family))
			return room;
		const turnDeg = normalDeg(
			rotationDeg ??
				(free
					? (free.rotationDeg ?? 0)
					: (wallsOf(room.plan)[run].yawRad * 180) / Math.PI +
						(found.rotationDeg ?? 0)),
		);
		const module: FreeModule = {
			id,
			familyId: found.familyId,
			widthMm: found.widthMm,
			doorStyleId: found.doorStyleId,
			hinge: found.hinge,
			xMm: centre.xMm,
			zMm: centre.zMm,
			...(turnDeg ? { rotationDeg: turnDeg } : {}),
		};
		// Nothing moved: the same room, so a ring held still costs no render.
		if (
			free &&
			free.xMm === centre.xMm &&
			free.zMm === centre.zMm &&
			(free.rotationDeg ?? 0) === turnDeg
		)
			return room;
		// A free cabinet keeps its place in `free`; one off a wall joins the end.
		const next = free
			? {
					...room,
					free: room.free.map((m) => (m.id === id ? module : m)),
				}
			: (() => {
					const removed = removeModules(room, [id]);
					return { ...removed, free: [...removed.free, module] };
				})();
		// The cabinet being placed must itself land clear, even if it was
		// already in trouble where it stood.
		return accepts(room, next) && !freeProblems(next).has(id) ? next : room;
	}

	/** Turn a free cabinet to `deg` — landed on square when `snap` and near
	 * it, as `setRotation` does for a dragged ring. Refused if it would leave
	 * the room or overlap anything. */
	function rotateFree(
		room: RoomLayout,
		id: string,
		deg: number,
		snap = false,
	): RoomLayout {
		const found = room.free.find((m) => m.id === id);
		if (!found || settleTurnDeg(deg, snap) === (found.rotationDeg ?? 0))
			return room;
		return placeFree(
			room,
			id,
			{ xMm: found.xMm, zMm: found.zMm },
			settleTurnDeg(deg, snap),
		);
	}

	/**
	 * What the scene draws a free cabinet as: its `freeView`, one `Run`, deep
	 * enough that `Run` — which stands a cabinet's back a wall gap in front of
	 * its wall at −depth/2 — centres it on the frame's origin; and the frame,
	 * turned by its yaw and moved to its centre. The price reads the same view.
	 */
	function freeRun(
		room: RoomLayout,
		id: string,
	): { view: PlannerLayout; frame: WallFrame } | null {
		const found = room.free.find((m) => m.id === id);
		const family = found && familyIn(catalogue, found.familyId);
		const view = freeView(room, id);
		if (!found || !family || !view) return null;
		return {
			view: { ...view, roomDepthMm: family.depthMm + 2 * WALL_GAP_MM },
			frame: {
				yawRad: ((found.rotationDeg ?? 0) * Math.PI) / 180,
				xMm: found.xMm,
				zMm: found.zMm,
			},
		};
	}

	/**
	 * Where a dragged cabinet lands on release. Its back edge within
	 * `SNAP_TO_WALL_MM` of the nearest wall joins that wall's run, centred on
	 * the drop point along it; anywhere else in the room it stands free there.
	 */
	function dropAt(room: RoomLayout, id: string, centre: Vec2): RoomLayout {
		const sourceRun = runIndexOf(room, id);
		const found = findModule(room, id);
		const family = found && familyIn(catalogue, found.familyId);
		// In the L's notch is refused, not handed to the wall it happens to be
		// behind. An overshoot past an ordinary wall still joins it.
		if (!found || !family || inNotch(room.plan, centre)) return room;
		const target = wallToJoin(room.plan, centre, family.depthMm);
		if (!target) return placeFree(room, id, centre);
		const xMm = target.xMm - found.widthMm / 2;
		return sourceRun === target.run
			? inRunOf(wall.dropModule)(room, id, xMm)
			: moveToRun(room, id, target.run, target.xMm);
	}

	/**
	 * Make room for one corner's square along one run, by sliding cabinets,
	 * not the whole row.
	 *
	 * Walks the run's floor and wall cabinets together, ordered by distance
	 * from the corner end, keeping one cursor per row for how far that row is
	 * claimed so far — starting at the square's own edge. A cabinet moves only
	 * if its own footprint starts before the cursor of every row it occupies:
	 * its own row, plus the *other* row too for a tall unit, the same two-way
	 * rule `occupiedSpans` uses, since a tall unit stands floor to ceiling. It
	 * is pushed exactly clear and never pulled toward the corner, and the
	 * cursors of the rows it occupies advance to its new far edge — so a
	 * cabinet already past the square, with a free gap behind it, stays put.
	 * A run with nowhere to slide is not refused here; `isClear` is still the
	 * gate for that, in `placeCorner`, `setShape` and `resizedTo`.
	 */
	function cascadeRun(
		room: RoomLayout,
		run: number,
		vertex: number,
		atStart: boolean,
	): RoomLayout {
		const view = runView(room, run);
		const lengthMm = view.wallWidthMm;
		const entries = (["floor", "wall"] as const).flatMap((row) =>
			wall.positionsOf(view, row).map((position) => {
				const spread = spreadMm(position);
				const startMm = position.xMm - spread;
				const endMm = position.xMm + position.widthMm + spread;
				return {
					id: position.placed.id,
					nearMm: atStart ? startMm : lengthMm - endMm,
					farMm: atStart ? endMm : lengthMm - startMm,
					rows:
						position.family.kind === "tall"
							? (["floor", "wall"] as const)
							: ([row] as const),
				};
			}),
		);
		entries.sort((a, b) => a.nearMm - b.nearMm);
		const cursor: Record<Row, number> = {
			floor: cornerSquareMm(room, vertex, "floor"),
			wall: cornerSquareMm(room, vertex, "wall"),
		};
		const shiftById = new Map<string, number>();
		for (const entry of entries) {
			const requiredMm = Math.max(...entry.rows.map((row) => cursor[row]));
			const shiftMm = Math.max(0, requiredMm - entry.nearMm);
			if (shiftMm > 0) shiftById.set(entry.id, shiftMm);
			for (const row of entry.rows)
				cursor[row] = Math.max(cursor[row], entry.farMm + shiftMm);
		}
		if (shiftById.size === 0) return room;
		const apply = (module: PlacedModule): PlacedModule => {
			const shiftMm = shiftById.get(module.id);
			return shiftMm
				? { ...module, xMm: module.xMm + (atStart ? shiftMm : -shiftMm) }
				: module;
		};
		return withRun(room, run, {
			...view,
			floor: view.floor.map(apply),
			wall: view.wall.map(apply),
		});
	}

	/** Make room for one corner's square on both its walls. Whether the result
	 * fits is `isClear`'s question, asked by the callers. */
	function cascadeCorner(room: RoomLayout, vertex: number): RoomLayout {
		if (!isActiveCorner(room, vertex)) return room;
		const ended = cascadeRun(room, vertex, vertex, false);
		return cascadeRun(ended, (vertex + 1) % countOf(ended), vertex, true);
	}

	const cascadeAll = (room: RoomLayout) =>
		room.runs.reduce((next, _, vertex) => cascadeCorner(next, vertex), room);

	function placeCorner(
		room: RoomLayout,
		familyId: string,
		vertex: number | null,
		id: string = newId(),
	): RoomLayout {
		const family = familyIn(catalogue, familyId);
		if (vertex === null || !family || !isCorner(family)) return room;
		if (vertexKind(room.plan, vertex) !== "inside") return room;
		const row: Row = family.kind === "wall" ? "wall" : "floor";
		const existing = cornerAt(room, vertex);
		if (existing?.[row]) return room;
		const placed: PlacedModule = {
			id,
			familyId,
			widthMm: family.sizes[0].widthMm,
			// Priced all-in with its door, like every cabinet — see `addModule`.
			doorStyleId: catalogue.doorStyles[0]?.id ?? null,
			hinge: "left",
			// Unused: a corner unit's place is its corner.
			xMm: 0,
		};
		const slot: CornerUnits = {
			vertex,
			floor: row === "floor" ? placed : (existing?.floor ?? null),
			wall: row === "wall" ? placed : (existing?.wall ?? null),
		};
		const next = cascadeCorner(
			{
				...room,
				corners: [...room.corners.filter((c) => c.vertex !== vertex), slot],
			},
			vertex,
		);
		return accepts(room, next) ? next : room;
	}

	/** Another template. Refused while any wall but the back wall, or any
	 * corner, holds something — the same answer the old L → straight gave rather
	 * than deleting what the customer placed. */
	function setShape(room: RoomLayout, shape: RoomShape): RoomLayout {
		if (shapeOf(room.plan) === shape) return room;
		if (room.runs.slice(1).some(hasCabinets)) return room;
		if (room.corners.some((c) => c.floor || c.wall)) return room;
		const plan = reshape(room.plan, shape);
		const next: RoomLayout = {
			...room,
			plan,
			runs: wallsOf(plan).map((_, i) => (i === 0 ? room.runs[0] : emptyRun())),
			corners: [],
		};
		return accepts(room, next) ? next : room;
	}

	/** The room with a new plan of the same template, or null if a run no longer
	 * fits. A run whose only active corner is its far end moves with it. */
	function resizedTo(room: RoomLayout, plan: FloorPlan): RoomLayout | null {
		if (JSON.stringify(plan) === JSON.stringify(room.plan)) return room;
		const before = wallsOf(room.plan);
		const after = wallsOf(plan);
		const next: RoomLayout = {
			...room,
			plan,
			runs: room.runs.map((run, i) => {
				const shiftMm = after[i].lengthMm - before[i].lengthMm;
				if (!anchoredAtEnd(room, i) || shiftMm === 0) return run;
				const shift = (module: PlacedModule) => ({
					...module,
					xMm: module.xMm + shiftMm,
				});
				return { floor: run.floor.map(shift), wall: run.wall.map(shift) };
			}),
		};
		return accepts(room, next) ? next : null;
	}

	/**
	 * Set one wall's length, down to what its cabinets need. A wall that would
	 * cut through a cabinet stops at the nearest length that does not — found by
	 * bisection, so the answer is whatever `isClear` says and no second rule.
	 */
	function setWallLength(
		room: RoomLayout,
		wallIndex: number,
		mm: number,
	): RoomLayout {
		const current = wallsOf(room.plan)[wallIndex]?.lengthMm;
		if (current === undefined) return room;
		const attempt = (lengthMm: number) =>
			resizedTo(room, planWithWallLength(room.plan, wallIndex, lengthMm));
		const wanted = Math.round(mm);
		const direct = attempt(wanted);
		if (direct) return direct;
		// ponytail: bisection assumes "fits" is monotonic between the current
		// length and the one asked for — true while a wall edit only stretches
		// or squeezes runs; revisit if a template couples walls otherwise.
		let good = current;
		let bad = wanted;
		while (Math.abs(bad - good) > 1) {
			const mid = Math.round((good + bad) / 2);
			if (attempt(mid)) good = mid;
			else bad = mid;
		}
		return good === current ? room : (attempt(good) ?? room);
	}

	/** The range `setWallLength` will actually reach, for the field's limits. */
	const wallLengthRangeMm = (room: RoomLayout, wallIndex: number) => ({
		minMm: wallsOf(setWallLength(room, wallIndex, 0).plan)[wallIndex].lengthMm,
		maxMm: wallsOf(setWallLength(room, wallIndex, 1e6).plan)[wallIndex]
			.lengthMm,
	});

	function exposureOf(room: RoomLayout): Map<string, ExposedSides> {
		const touchingMm = constructionOf(catalogue).panelThicknessMm;
		const exposure = new Map<string, ExposedSides>();
		room.runs.forEach((_, run) => {
			const view = runView(room, run);
			for (const [id, sides] of wall.exposureOf(view)) exposure.set(id, sides);
			for (const row of ["floor", "wall"] as const) {
				for (const { vertex, span } of cornerSpans(room, run, row)) {
					// An empty corner square leaves the end beside it in the open.
					if (!cornerAt(room, vertex)?.[row]) continue;
					for (const position of wall.positionsOf(view, row)) {
						const sides = exposure.get(position.placed.id);
						if (!sides) continue;
						const spread = spreadMm(position);
						exposure.set(position.placed.id, {
							left:
								sides.left &&
								Math.abs(position.xMm - spread - span.endMm) > touchingMm,
							right:
								sides.right &&
								Math.abs(
									position.xMm + position.widthMm + spread - span.startMm,
								) > touchingMm,
						});
					}
				}
			}
		});
		// A corner unit's ends are part of its drawing, not panels fixed to it.
		// ponytail: an assumption until EzCabinet confirms — see CLAUDE.md.
		for (const position of cornerPositions(room)) {
			exposure.set(position.placed.id, { left: false, right: false });
		}
		// A free cabinet is a run of one with no wall at either end: both open.
		for (const view of freeViews(room)) {
			for (const [id, sides] of wall.exposureOf(view)) exposure.set(id, sides);
		}
		return exposure;
	}

	function endPanels(room: RoomLayout): EndPanel[] {
		const exposure = exposureOf(room);
		return [...views(room), ...freeViews(room)]
			.flatMap((view) => wall.endPanels(view))
			.filter((panel) => exposure.get(panel.moduleId)?.[panel.side]);
	}

	/**
	 * The square of worktop at each active corner: over a corner base unit, or
	 * closing an empty corner when a base unit in either run meets it.
	 * Otherwise there is no counter to join. The same answer feeds the scene
	 * and the price.
	 */
	function cornerWorktops(
		room: RoomLayout,
	): { vertex: number; sizeMm: number; topMm: number }[] {
		return room.runs.flatMap((_, vertex) => {
			if (!isActiveCorner(room, vertex)) return [];
			const unit = cornerAt(room, vertex)?.floor;
			const occupant = unit && familyIn(catalogue, unit.familyId);
			// A non-base corner unit fills the corner without closing it.
			if (occupant && occupant.kind !== "base") return [];
			if (unit && occupant) {
				return [
					{
						vertex,
						sizeMm: unit.widthMm,
						topMm: occupant.floorHeightMm + occupant.heightMm,
					},
				];
			}
			for (const run of [vertex, (vertex + 1) % countOf(room)]) {
				const entry = cornerSpans(room, run, "floor").find(
					(c) => c.vertex === vertex,
				);
				if (!entry) continue;
				const meeting = wall
					.positionsOf(runView(room, run), "floor")
					.find(
						(p) =>
							p.family.kind === "base" &&
							inRun(p) &&
							(Math.abs(p.xMm - entry.span.endMm) < 1 ||
								Math.abs(p.xMm + p.widthMm - entry.span.startMm) < 1),
					);
				if (meeting) {
					return [
						{
							vertex,
							sizeMm: cornerSquareMm(room, vertex, "floor"),
							topMm: meeting.family.floorHeightMm + meeting.family.heightMm,
						},
					];
				}
			}
			return [];
		});
	}

	/**
	 * The leaf that has to stay shut on each side of an inside corner.
	 *
	 * Two cabinets on perpendicular walls each hinge a leaf toward the corner
	 * they share, and both leaves swing through the same space: each stands in
	 * the other's frontage, and at full open one of them reaches back across the
	 * other run's carcass. This is not a rendering artefact — those two doors
	 * foul in a real kitchen too, which is why a fitter hinges a corner-adjacent
	 * door away from the corner, or specifies a blind corner deep enough to
	 * swallow both.
	 *
	 * **It is a reach, not a touch.** The first version of this asked whether a
	 * cabinet sat against the corner square, within a millimetre, and nudging
	 * one a few millimetres along the wall turned the whole rule off while the
	 * doors still went through each other. `swingOf` already carries the warning
	 * this ignored: a boolean can only ask "touching?", and that flips to
	 * "clear" the moment a cabinet is slid over while the leaves still collide.
	 * So each leaf is measured by how far it actually sweeps.
	 *
	 * A leaf hinged `d` from the corner, on a carcass `depth` deep, sweeps a
	 * quarter disc of its own width: out to `d + width` along its wall, back to
	 * `d - width·|cos(max angle)|` past its own stile, and from its front face
	 * to one width beyond. Two such boxes — one per run, in the same room frame
	 * with the corner at the origin — either overlap or they do not. Bounding
	 * boxes rather than the swept arcs: the error is towards shutting a leaf
	 * that might just have cleared, which is the safe direction when the
	 * alternative is a door drawn through a cabinet.
	 *
	 * `swingOf` cannot answer this. Its clearance is a distance *along* one run
	 * and it floors every leaf at a right angle by design; this constraint is
	 * perpendicular to that run, so it is settled here and the leaf renders
	 * shut — the same answer `suspectFlap` already gives a leaf that cannot
	 * swing.
	 */
	function cornerShutSides(room: RoomLayout): Map<string, HingeSide> {
		const shut = new Map<string, HingeSide>();
		// How far a leaf swings back past its own hinge stile at full open.
		const backReach = Math.max(0, -Math.cos(OVERLAY_OPEN_RAD));
		for (let vertex = 0; vertex < countOf(room); vertex++) {
			if (!isActiveCorner(room, vertex)) continue;
			const sides = [
				{ run: vertex, atStart: false },
				{ run: (vertex + 1) % countOf(room), atStart: true },
			];
			for (const row of ["floor", "wall"] as const) {
				// The cabinet nearest the corner on each run, and the box its
				// corner-facing leaf sweeps. Nearest and not adjacent: a leaf reaches
				// the same distance whether or not it starts against the square.
				const facing = [];
				for (const { run, atStart } of sides) {
					const view = runView(room, run);
					const lengthMm = view.wallWidthMm;
					const distanceOf = (p: Positioned) =>
						atStart ? p.xMm : lengthMm - (p.xMm + p.widthMm);
					let nearest: Positioned | null = null;
					for (const p of wall.positionsOf(view, row)) {
						// A *turned* cabinet is skipped: its front no longer faces out
						// from its wall, so the sweep below is not the box it sweeps. A
						// *lifted* one is not — `inRun` bundles the two together, and
						// using it here meant hanging a cabinet a few millimetres off the
						// floor switched the rule off while its doors still swung.
						if (p.placed.rotationDeg) continue;
						if (!nearest || distanceOf(p) < distanceOf(nearest)) nearest = p;
					}
					if (!nearest) continue;
					// An unrecorded leaf count reads as one full-width leaf: the widest
					// a front could be, so the doubtful case errs towards shut.
					const leafMm =
						nearest.widthMm / (nearest.family.geometry?.doorLeaves || 1);
					const dMm = distanceOf(nearest);
					// Two leaves at different heights pass each other. Lifting is what
					// a customer reaches for to clear a corner, so the band has to be
					// read per cabinet rather than per row.
					const bottomMm = wall.floorHeightMmOf(nearest, view);
					facing.push({
						position: nearest,
						side: (atStart ? "left" : "right") as HingeSide,
						upMm: [bottomMm, bottomMm + nearest.family.heightMm] as const,
						// Along this run's own wall, measured from the corner.
						alongMm: [dMm - leafMm * backReach, dMm + leafMm] as const,
						// Out from this run's own wall: the front face, plus the leaf.
						outMm: [
							nearest.family.depthMm,
							nearest.family.depthMm + leafMm,
						] as const,
					});
				}
				// One run with nothing near the corner is a leaf swinging into empty
				// space, which is fine.
				if (facing.length < 2) continue;
				const [a, b] = facing;
				// One run's "along" is the other's "out": they share the corner, and
				// their walls are each other's depth axis. The third pair is plain
				// height — leaves that never share a height cannot meet whatever they
				// do in plan.
				const overlaps =
					a.upMm[1] > b.upMm[0] &&
					a.upMm[0] < b.upMm[1] &&
					a.alongMm[1] > b.outMm[0] &&
					a.alongMm[0] < b.outMm[1] &&
					b.alongMm[1] > a.outMm[0] &&
					b.alongMm[0] < a.outMm[1];
				if (!overlaps) continue;
				for (const f of facing) shut.set(f.position.placed.id, f.side);
			}
		}
		return shut;
	}

	function addModule(
		room: RoomLayout,
		familyId: string,
		xMm: number,
		id?: string,
		widthMm?: number,
		run = 0,
	): RoomLayout {
		const family = familyIn(catalogue, familyId);
		if (!family) return room;
		if (isCorner(family))
			return placeCorner(room, familyId, cornerVertexFor(room, run), id);
		if (run >= room.runs.length) return room;
		const view = wall.addModule(runView(room, run), familyId, xMm, id, widthMm);
		if (!wall.isClear(view)) return room;
		const placed = withRun(room, run, view);
		if (placed === room) return room;
		// The first cabinet on a second wall is what switches a corner on.
		const next = cascadeAll(placed);
		return accepts(room, next) ? next : room;
	}

	function fits(
		room: RoomLayout,
		familyId: string,
		widthMm?: number,
		run = 0,
	): boolean {
		const family = familyIn(catalogue, familyId);
		if (!family) return false;
		if (isCorner(family))
			return (
				placeCorner(room, familyId, cornerVertexFor(room, run), "probe") !==
				room
			);
		if (run >= room.runs.length) return false;
		// Probed through `addModule`, because a cabinet that fits the bare wall
		// can still be refused by the corner it switches on.
		return (
			addModule(
				room,
				familyId,
				nearCornerMm(room, run),
				"probe",
				widthMm,
				run,
			) !== room
		);
	}

	/**
	 * Hand a cabinet to another wall — the target a drag is dropped nearest.
	 * Also takes a free cabinet back to a wall. Refused, unchanged, for an
	 * unknown id, a corner unit (never in a run or free), the cabinet's own
	 * wall, or a target with nowhere for it. `xMm` is the pointer's drop point; the cabinet centres on
	 * it, same as `nearestWall` hands back a drop point rather than an edge.
	 */
	function moveToRun(
		room: RoomLayout,
		id: string,
		run: number,
		xMm: number,
	): RoomLayout {
		if (runIndexOf(room, id) === run) return room;
		const found = findModule(room, id);
		if (!found) return room;
		const removed = removeModules(room, [id]);
		const added = addModule(
			removed,
			found.familyId,
			xMm - found.widthMm / 2,
			id,
			found.widthMm,
			run,
		);
		if (added === removed) return room;
		const next = mapModule(added, id, (module) => ({
			...module,
			doorStyleId: found.doorStyleId,
			hinge: found.hinge,
		}));
		// `next` carries no `hangAtMm` yet — `addModule` never sets one, so the
		// cabinet already reads as "hangs with the row" on the destination.
		// Only add the kept height back once it is checked against what is
		// actually there: a custom height valid beside the old neighbours can
		// be invalid beside the new ones (under a tall unit, over a lifted
		// base unit), and `hangRangeMm` is asked here rather than trusted from
		// the source wall.
		if (found.hangAtMm === undefined) return next;
		const hangAtMm = found.hangAtMm;
		const family = familyIn(catalogue, found.familyId);
		const row: Row = family ? rowFor(family.kind) : "floor";
		const view = runView(next, run);
		const position = wall
			.positionsOf(view, row)
			.find((p) => p.placed.id === id);
		const range = position && wall.hangRangeMm(position, view, row);
		const validHere =
			position !== undefined &&
			canHangAt(view, id) &&
			range !== undefined &&
			hangAtMm >= range.minMm &&
			hangAtMm <= range.maxMm;
		if (!validHere) return accepts(room, next) ? next : room;
		const withHang = mapModule(next, id, (module) => ({ ...module, hangAtMm }));
		return accepts(room, withHang)
			? withHang
			: accepts(room, next)
				? next
				: room;
	}

	function removeModules(room: RoomLayout, ids: Iterable<string>): RoomLayout {
		const gone = new Set(ids);
		if (gone.size === 0) return room;
		const keep = (module: PlacedModule | null) =>
			module && !gone.has(module.id) ? module : null;
		return {
			...room,
			runs: room.runs.map((run) => ({
				floor: run.floor.filter((module) => !gone.has(module.id)),
				wall: run.wall.filter((module) => !gone.has(module.id)),
			})),
			corners: room.corners
				.map((corner) => ({
					...corner,
					floor: keep(corner.floor),
					wall: keep(corner.wall),
				}))
				.filter((corner) => corner.floor || corner.wall),
			free: room.free.filter((module) => !gone.has(module.id)),
		};
	}

	/** A room-wide setting, set through the back wall's view so it gets the
	 * one-wall engine's clamping. */
	const setting =
		<K extends keyof Settings, V>(
			key: K,
			edit: (view: PlannerLayout, value: V) => PlannerLayout,
		) =>
		(room: RoomLayout, value: V): RoomLayout => {
			const next = edit(runView(room, 0), value)[
				key
			] as unknown as RoomLayout[K];
			return next === room[key] ? room : { ...room, [key]: next };
		};

	/** How much of a run's length its design needs, measured from the corner
	 * end: a run shrinks and grows at its free end. */
	const runExtentMm = (room: RoomLayout, run = 0): number =>
		run < room.runs.length ? wall.runExtentMm(fromCorner(room, run)) : 0;

	// Packed toward each run's corner: `fromCorner` is its own inverse, and
	// only the rows of the view it returns are written back.
	const closeGaps = (room: RoomLayout) =>
		room.runs.reduce((next, _, run) => {
			const packed = wall.closeGaps(fromCorner(next, run));
			if (!anchoredAtEnd(next, run)) return withRun(next, run, packed);
			const L = packed.wallWidthMm;
			return withRun(next, run, {
				...packed,
				floor: packed.floor.map(mirrorModule(L)),
				wall: packed.wall.map(mirrorModule(L)),
			});
		}, room);

	return {
		positionsOf: (room: RoomLayout, row: Row, run = 0): Positioned[] =>
			run < room.runs.length ? wall.positionsOf(runView(room, run), row) : [],
		allPositions: (room: RoomLayout): Positioned[] => [
			...views(room).flatMap((view) => wall.allPositions(view)),
			...cornerPositions(room),
			...freeViews(room).flatMap((view) => wall.allPositions(view)),
		],
		rowEndMm: (room: RoomLayout, row: Row, run = 0) =>
			wall.rowEndMm(runView(room, run), row),
		freeSpans: (room: RoomLayout, row: Row, run = 0) =>
			wall.freeSpans(runView(room, run), row),
		runExtentMm,
		fits,
		addModule,
		offsetsOf: (room: RoomLayout, id: string) => {
			const run = runIndexOf(room, id);
			return run < 0 ? null : wall.offsetsOf(runView(room, run), id);
		},
		widthOptionsFor: (room: RoomLayout, id: string) => {
			const run = runIndexOf(room, id);
			if (run >= 0) return wall.widthOptionsFor(runView(room, run), id);
			const unit = cornerPositions(room).find((p) => p.placed.id === id);
			return unit
				? [
						{
							widthMm: unit.widthMm,
							priceRm: unit.family.sizes[0].priceRm,
							fits: true,
						},
					]
				: freeWidthOptions(room, id);
		},
		setGap: inRunOf(wall.setGap),
		moveModule: inRunOf(wall.moveModule),
		dropModule: inRunOf(wall.dropModule),
		dragModule: inRunOf(wall.dragModule),
		replaceFamily: inRunOf(wall.replaceFamily),
		duplicateModule: inRunOf(wall.duplicateModule),
		setHangAt: inRunOf(wall.setHangAt),
		setRotation: inRunOf(wall.setRotation),
		setWidth: inRunOf(wall.setWidth),
		swapWithNeighbour: inRunOf(wall.swapWithNeighbour),
		removeModules,
		removeModule: (room: RoomLayout, id: string) => removeModules(room, [id]),
		moveToRun,
		closeGaps,
		setHangingHeight: setting<"hangingHeightMm", number>(
			"hangingHeightMm",
			wall.setHangingHeight,
		),
		setWallToCeiling: setting<"wallToCeiling", boolean>(
			"wallToCeiling",
			wall.setWallToCeiling,
		),
		setBaseSkirting: setting<"baseSkirting", boolean>(
			"baseSkirting",
			wall.setBaseSkirting,
		),
		setCeilingHeight: setting<"ceilingHeightMm", number>(
			"ceilingHeightMm",
			wall.setCeilingHeight,
		),
		hangingHeightMmOf: (room: RoomLayout) =>
			wall.hangingHeightMmOf(pooled(room)),
		floorHeightMmOf: (position: Positioned, room: RoomLayout) =>
			wall.floorHeightMmOf(position, pooled(room)),
		flushWallToTallTops: (room: RoomLayout): RoomLayout => {
			const { hangingHeightMm } = wall.flushWallToTallTops(pooled(room));
			return hangingHeightMm === room.hangingHeightMm
				? room
				: { ...room, hangingHeightMm };
		},
		overhangMm: (room: RoomLayout) =>
			Math.max(0, ...views(room).map((view) => wall.overhangMm(view))),
		/**
		 * How much of this wall a customer could still build on — negative when
		 * the run is longer than the wall.
		 *
		 * Not `wallWidthMm - runExtentMm`: on a wall with a corner at each end (a
		 * U's back wall) `runExtentMm` only measures from the corner it packs
		 * against, so it never counts the far square. Free spans do, because
		 * `occupiedSpans` reads `reserved[row]` — both ends of it — not just the
		 * one the run is anchored to.
		 */
		freeWallMm: (room: RoomLayout, run: number): number => {
			const view = runView(room, run);
			const overhang = wall.overhangMm(view);
			return overhang > 0
				? -overhang
				: wall
						.freeSpans(view, "floor")
						.reduce((total, span) => total + span.endMm - span.startMm, 0);
		},
		overhangingIds: (room: RoomLayout): ReadonlySet<string> =>
			new Set(views(room).flatMap((view) => [...wall.overhangingIds(view)])),
		isClear: allClear,
		skirtingSpans: (room: RoomLayout, run = 0) =>
			wall.skirtingSpans(runView(room, run)),
		setShape,
		setWallLength,
		wallLengthRangeMm,
		placeCorner,
		cornerPositions,
		cornerPositionsOf,
		exposureOf,
		endPanels,
		cornerWorktops,
		cornerShutSides,
		freeView,
		freeRun,
		freeFootprint,
		runFootprints,
		freeIsClear,
		placeFree,
		dropAt,
		rotateFree,
	};
}

export type RoomEngine = ReturnType<typeof roomEngine>;
