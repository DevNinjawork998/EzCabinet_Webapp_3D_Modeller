import { constructionOf, familyIn, isCorner } from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import type { ExposedSides } from "./exposure";
import {
	type FloorPlan,
	setWallLength as planWithWallLength,
	type RoomShape,
	reshape,
	shapeOf,
	vertexKind,
	wallsOf,
} from "./floorplan";
import {
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
	type Span,
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

export type RoomLayout = Settings & {
	plan: FloorPlan;
	/** One per wall of `plan`, in wall order. */
	runs: Run[];
	corners: CornerUnits[];
};

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
	const { plan, runs, corners: _corners, ...settings } = room;
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
	const allClear = (room: RoomLayout) =>
		views(room).every((v) => wall.isClear(v));

	/** An id-addressed edit, applied in the run that holds the id. */
	const inRunOf =
		<A extends unknown[]>(
			edit: (view: PlannerLayout, id: string, ...args: A) => PlannerLayout,
		) =>
		(room: RoomLayout, id: string, ...args: A): RoomLayout => {
			const run = runIndexOf(room, id);
			return run < 0
				? room
				: withRun(room, run, edit(runView(room, run), id, ...args));
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
			floor: [...room.runs.flatMap((run) => run.floor), ...units("floor")],
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
		return allClear(next) ? next : room;
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
		return allClear(next) ? next : room;
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
		return allClear(next) ? next : null;
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
		return exposure;
	}

	function endPanels(room: RoomLayout): EndPanel[] {
		const exposure = exposureOf(room);
		return views(room)
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
		return allClear(next) ? next : room;
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
				: [];
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
		isClear: (room: RoomLayout) =>
			views(room).every((view) => wall.isClear(view)),
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
	};
}

export type RoomEngine = ReturnType<typeof roomEngine>;
