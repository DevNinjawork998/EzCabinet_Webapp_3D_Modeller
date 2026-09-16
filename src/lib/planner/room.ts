import {
	constructionOf,
	familyIn,
	isCorner,
	ROOM_DEPTH_LIMITS,
} from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import type { ExposedSides } from "./exposure";
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
	WALL_LIMITS,
} from "./layout";

/**
 * A room: one wall, or two meeting at a corner.
 *
 * The stored document. Each wall is a **run**, and each run is still the
 * one-dimensional thing the placement engine in `layout.ts` has always
 * arranged — so rather than teaching that engine about corners, a run is handed
 * to it as an ordinary `PlannerLayout` (`runView`) with the corner square as a
 * reserved span, and the rows it hands back are written into the room
 * (`withRun`). Every clamp, snap, gap and turn rule is reused unchanged.
 *
 * Each run's `xMm` reads left to right *facing that wall from inside the
 * room*. The corner therefore sits at the start of the main wall and the end of
 * the side wall for a left corner, and the other way round for a right one —
 * which is what lets the scene draw the side run by turning the same `Run`
 * ninety degrees, without mirroring anything.
 *
 * Pure, like the rest of `lib/planner`.
 */

export type Run = { floor: PlacedModule[]; wall: PlacedModule[] };

export type CornerSide = "left" | "right";

export type Corner = {
	/** Which end of the main wall the side wall stands at. */
	side: CornerSide;
	/** The corner units, one per row, or `null` while a slot is empty. */
	floor: PlacedModule | null;
	wall: PlacedModule | null;
};

type Settings = Omit<PlannerLayout, "floor" | "wall" | "reserved">;

export type RoomLayout = Settings & {
	/** `[main]` for one wall, `[main, side]` for an L. */
	runs: Run[];
	/** Present exactly when there is a side wall. */
	corner: Corner | null;
};

export type RoomShape = "straight" | CornerSide;

/** How much of each row an empty corner keeps: the depth of the cabinets that
 * meet there, so each run stops where the other run's carcasses end. */
export const EMPTY_CORNER_MM: Record<Row, number> = { floor: 607, wall: 397 };

export function asRoom(layout: PlannerLayout): RoomLayout {
	const { floor, wall, reserved: _reserved, ...settings } = layout;
	return { ...settings, runs: [{ floor, wall }], corner: null };
}

export const emptyRoom = (
	...args: Parameters<typeof emptyLayout>
): RoomLayout => asRoom(emptyLayout(...args));

export const shapeOf = (room: RoomLayout): RoomShape =>
	room.corner ? room.corner.side : "straight";

/** The side of the corner square along each wall, in one row. */
export const cornerSquareMm = (room: RoomLayout, row: Row): number =>
	room.corner?.[row]?.widthMm ?? EMPTY_CORNER_MM[row];

const lengthOf = (room: RoomLayout, run: number) =>
	run === 0 ? room.wallWidthMm : room.roomDepthMm;

function reservedSpan(room: RoomLayout, run: number, row: Row): Span | null {
	if (!room.corner) return null;
	const lengthMm = lengthOf(room, run);
	const squareMm = cornerSquareMm(room, row);
	const atStart =
		run === 0 ? room.corner.side === "left" : room.corner.side === "right";
	return atStart
		? { startMm: 0, endMm: squareMm }
		: { startMm: lengthMm - squareMm, endMm: lengthMm };
}

/**
 * One run as the one-wall engine sees it.
 *
 * The side wall's length is the room's depth, and the room it faces is as deep
 * as the main wall is long, so the two figures swap. Its far end is the open
 * front of the room, never a wall, so it is never built wall to wall.
 */
export function runView(room: RoomLayout, run: number): PlannerLayout {
	const { runs, corner: _corner, ...settings } = room;
	const isSide = run === 1;
	const floor = reservedSpan(room, run, "floor");
	const wall = reservedSpan(room, run, "wall");
	return {
		...settings,
		wallWidthMm: isSide ? room.roomDepthMm : room.wallWidthMm,
		roomDepthMm: isSide ? room.wallWidthMm : room.roomDepthMm,
		wallToWall: isSide ? false : room.wallToWall,
		floor: runs[run].floor,
		wall: runs[run].wall,
		...(floor && wall ? { reserved: { floor, wall } } : {}),
	};
}

/** Write a view's rows back. Rows only: a view's swapped axes and reserved
 * spans are derived, and must never land in the document. */
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

/** How far a run's group is turned about the room's vertical axis. Counter-
 * clockwise from above, as three's `rotation.y` is. */
export const runYawRad = (room: RoomLayout, run: number): number =>
	run === 0 || !room.corner
		? 0
		: room.corner.side === "left"
			? Math.PI / 2
			: -Math.PI / 2;

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
		corner: room.corner && {
			...room.corner,
			floor: room.corner.floor && hit(room.corner.floor),
			wall: room.corner.wall && hit(room.corner.wall),
		},
	};
}

export const setDoor = (
	room: RoomLayout,
	id: string,
	doorStyleId: string | null,
): RoomLayout => mapModule(room, id, (module) => ({ ...module, doorStyleId }));

export const setHinge = (
	room: RoomLayout,
	id: string,
	hinge: HingeSide,
): RoomLayout => mapModule(room, id, (module) => ({ ...module, hinge }));

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
 * questions take an optional run index, defaulting to the main wall; edits
 * addressed by id go to whichever run holds that id.
 */
export function roomEngine(catalogue: PlannerCatalogue) {
	const wall = plannerEngine(catalogue);

	const views = (room: RoomLayout) => room.runs.map((_, i) => runView(room, i));

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

	/**
	 * Every row of the room pooled into one view, for questions about height
	 * alone. Positions along a wall mean nothing across two walls, so nothing
	 * that reads `xMm` may be asked of this.
	 */
	const pooled = (room: RoomLayout): PlannerLayout => {
		const { reserved: _reserved, ...main } = runView(room, 0);
		const slot = (row: Row) => (room.corner?.[row] ? [room.corner[row]] : []);
		return {
			...main,
			floor: [...room.runs.flatMap((run) => run.floor), ...slot("floor")],
			wall: [...room.runs.flatMap((run) => run.wall), ...slot("wall")],
		};
	};

	/**
	 * The corner units, placed along the main wall so the main run's scene
	 * draws them. Designs are drawn for the left-hand corner; the right-hand one
	 * is the same unit turned a quarter clockwise — never mirrored, which would
	 * flip its faces inside out.
	 */
	function cornerPositions(room: RoomLayout): Positioned[] {
		const corner = room.corner;
		if (!corner) return [];
		return (["floor", "wall"] as const).flatMap((row) => {
			const placed = corner[row];
			const family = placed && familyIn(catalogue, placed.familyId);
			const span = reservedSpan(room, 0, row);
			if (!placed || !family || !span) return [];
			const shown: PlacedModule = {
				...placed,
				xMm: span.startMm,
				...(corner.side === "right" ? { rotationDeg: 270 } : {}),
			};
			return [
				{ placed: shown, family, widthMm: placed.widthMm, xMm: span.startMm },
			];
		});
	}

	/**
	 * Make room for the corner square by sliding cabinets, not whole rows.
	 *
	 * Walks each run's floor and wall cabinets together, ordered by distance
	 * from the corner end, keeping one cursor per row for how far that row is
	 * claimed so far — starting at the square's own edge. A cabinet moves only
	 * if its own footprint starts before the cursor of every row it occupies:
	 * its own row, plus the *other* row too for a tall unit, the same two-way
	 * rule `occupiedSpans` uses, since a tall unit stands floor to ceiling. It
	 * is pushed exactly clear and never pulled toward the corner, and the
	 * cursors of the rows it occupies advance to its new far edge — so a
	 * cabinet already past the square, with a free gap behind it, stays put.
	 * A run with nowhere to slide is not refused here; `isClear` is still the
	 * gate for that, in `placeCorner` and `setShape`.
	 */
	function cascadeCorner(room: RoomLayout): RoomLayout {
		if (!room.corner) return room;
		const { side } = room.corner;
		return room.runs.reduce((next, _, run) => {
			const view = runView(next, run);
			if (!view.reserved) return next;
			const atStart = run === 0 ? side === "left" : side === "right";
			const lengthMm = lengthOf(next, run);

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
				floor: cornerSquareMm(next, "floor"),
				wall: cornerSquareMm(next, "wall"),
			};
			const shiftById = new Map<string, number>();
			for (const entry of entries) {
				const requiredMm = Math.max(...entry.rows.map((row) => cursor[row]));
				const shiftMm = Math.max(0, requiredMm - entry.nearMm);
				if (shiftMm > 0) shiftById.set(entry.id, shiftMm);
				const newFarMm = entry.farMm + shiftMm;
				for (const row of entry.rows)
					cursor[row] = Math.max(cursor[row], newFarMm);
			}
			if (shiftById.size === 0) return next;

			const apply = (module: PlacedModule): PlacedModule => {
				const shiftMm = shiftById.get(module.id);
				return shiftMm
					? { ...module, xMm: module.xMm + (atStart ? shiftMm : -shiftMm) }
					: module;
			};
			return withRun(next, run, {
				...view,
				floor: view.floor.map(apply),
				wall: view.wall.map(apply),
			});
		}, room);
	}

	function placeCorner(
		room: RoomLayout,
		familyId: string,
		id: string = newId(),
	): RoomLayout {
		const family = familyIn(catalogue, familyId);
		if (!room.corner || !family || !isCorner(family)) return room;
		const row: Row = family.kind === "wall" ? "wall" : "floor";
		if (room.corner[row]) return room;
		const placed: PlacedModule = {
			id,
			familyId,
			widthMm: family.sizes[0].widthMm,
			// Priced all-in with its door, like every cabinet — see `addModule`.
			doorStyleId: catalogue.doorStyles[0]?.id ?? null,
			hinge: "left",
			// Unused: a corner unit's place is the corner. `cornerPositions` says where.
			xMm: 0,
		};
		const next = cascadeCorner({
			...room,
			corner: { ...room.corner, [row]: placed },
		});
		return views(next).every((view) => wall.isClear(view)) ? next : room;
	}

	function setCornerSide(room: RoomLayout, side: CornerSide): RoomLayout {
		if (!room.corner || room.corner.side === side) return room;
		const mirror =
			(lengthMm: number) =>
			(module: PlacedModule): PlacedModule => ({
				...module,
				xMm: lengthMm - module.xMm - module.widthMm,
				...(module.rotationDeg
					? { rotationDeg: (360 - module.rotationDeg) % 360 }
					: {}),
			});
		return {
			...room,
			corner: { ...room.corner, side },
			runs: room.runs.map((run, i) => ({
				floor: run.floor.map(mirror(lengthOf(room, i))),
				wall: run.wall.map(mirror(lengthOf(room, i))),
			})),
		};
	}

	/**
	 * One wall or an L. Going straight is refused while the side wall or the
	 * corner holds anything — the same answer `setWallWidth` gives rather than
	 * deleting cabinets the customer placed. Going to an L moves the main run
	 * out of the new corner if it has the wall to, and is refused if not.
	 */
	function setShape(room: RoomLayout, shape: RoomShape): RoomLayout {
		if (shape === shapeOf(room)) return room;
		if (shape === "straight") {
			const side = room.runs[1];
			if (side && (side.floor.length > 0 || side.wall.length > 0)) return room;
			if (room.corner?.floor || room.corner?.wall) return room;
			return { ...room, runs: [room.runs[0]], corner: null };
		}
		if (room.corner) return setCornerSide(room, shape);
		const next = cascadeCorner({
			...room,
			runs: [room.runs[0], { floor: [], wall: [] }],
			corner: { side: shape, floor: null, wall: null },
		});
		return views(next).every((view) => wall.isClear(view)) ? next : room;
	}

	function exposureOf(room: RoomLayout): Map<string, ExposedSides> {
		const touchingMm = constructionOf(catalogue).panelThicknessMm;
		const exposure = new Map<string, ExposedSides>();
		room.runs.forEach((_, run) => {
			const view = runView(room, run);
			for (const [id, sides] of wall.exposureOf(view)) exposure.set(id, sides);
			for (const row of ["floor", "wall"] as const) {
				const span = view.reserved?.[row];
				// An empty corner leaves the ends beside it in the open.
				if (!span || !room.corner?.[row]) continue;
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
	 * The square of worktop over the corner: over a corner base unit, or closing
	 * an empty corner when a base unit in either run meets it. Otherwise there
	 * is no counter to join. The same answer feeds the scene and the price.
	 */
	function cornerWorktop(
		room: RoomLayout,
	): { sizeMm: number; topMm: number } | null {
		if (!room.corner) return null;
		// A non-base corner unit (a tall corner, once drawn) fills the corner
		// without closing it for a worktop — no falling through to the
		// empty-square rule below.
		const occupant =
			room.corner.floor && familyIn(catalogue, room.corner.floor.familyId);
		if (occupant && occupant.kind !== "base") return null;
		const unit = cornerPositions(room).find((p) => p.family.kind === "base");
		if (unit) {
			return {
				sizeMm: unit.widthMm,
				topMm: unit.family.floorHeightMm + unit.family.heightMm,
			};
		}
		for (const view of views(room)) {
			const span = view.reserved?.floor;
			if (!span) continue;
			const meeting = wall
				.positionsOf(view, "floor")
				.find(
					(p) =>
						p.family.kind === "base" &&
						inRun(p) &&
						(Math.abs(p.xMm - span.endMm) < 1 ||
							Math.abs(p.xMm + p.widthMm - span.startMm) < 1),
				);
			if (meeting) {
				return {
					sizeMm: cornerSquareMm(room, "floor"),
					topMm: meeting.family.floorHeightMm + meeting.family.heightMm,
				};
			}
		}
		return null;
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
		if (isCorner(family)) return placeCorner(room, familyId, id);
		if (run >= room.runs.length) return room;
		return withRun(
			room,
			run,
			wall.addModule(runView(room, run), familyId, xMm, id, widthMm),
		);
	}

	function fits(
		room: RoomLayout,
		familyId: string,
		widthMm?: number,
		run = 0,
	): boolean {
		const family = familyIn(catalogue, familyId);
		if (!family) return false;
		if (isCorner(family)) return placeCorner(room, familyId, "probe") !== room;
		if (run >= room.runs.length) return false;
		return wall.fits(runView(room, run), familyId, widthMm);
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
			corner: room.corner && {
				...room.corner,
				floor: keep(room.corner.floor),
				wall: keep(room.corner.wall),
			},
		};
	}

	/** A room-wide setting, set through the main wall's view so it gets the
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

	function minWallWidthMm(room: RoomLayout): number {
		const view = runView(room, 0);
		const floor = wall.minWallWidthMm(view);
		if (!room.corner) return floor;
		const { side } = room.corner;
		return Math.max(
			floor,
			...(["floor", "wall"] as const).map((row) =>
				side === "right"
					? wall.rowEndMm(view, row) + cornerSquareMm(room, row)
					: cornerSquareMm(room, row),
			),
		);
	}

	function minRoomDepthMm(room: RoomLayout): number {
		if (!room.corner) return ROOM_DEPTH_LIMITS.minMm;
		const view = runView(room, 1);
		const { side } = room.corner;
		return Math.max(
			ROOM_DEPTH_LIMITS.minMm,
			...(["floor", "wall"] as const).map((row) =>
				side === "left"
					? wall.rowEndMm(view, row) + cornerSquareMm(room, row)
					: Math.max(wall.rowEndMm(view, row), cornerSquareMm(room, row)),
			),
		);
	}

	function setWallWidth(room: RoomLayout, wallWidthMm: number): RoomLayout {
		const clamped = Math.max(
			minWallWidthMm(room),
			Math.min(WALL_LIMITS.maxMm, Math.round(wallWidthMm)),
		);
		return clamped === room.wallWidthMm
			? room
			: { ...room, wallWidthMm: clamped };
	}

	function setRoomDepth(room: RoomLayout, roomDepthMm: number): RoomLayout {
		const clamped = Math.max(
			minRoomDepthMm(room),
			Math.min(ROOM_DEPTH_LIMITS.maxMm, Math.round(roomDepthMm)),
		);
		return clamped === room.roomDepthMm
			? room
			: { ...room, roomDepthMm: clamped };
	}

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
		runExtentMm: (room: RoomLayout, run = 0) =>
			wall.runExtentMm(runView(room, run)),
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
		closeGaps: (room: RoomLayout) =>
			room.runs.reduce(
				(next, _, run) =>
					withRun(next, run, wall.closeGaps(runView(next, run))),
				room,
			),
		setHangingHeight: setting<"hangingHeightMm", number>(
			"hangingHeightMm",
			wall.setHangingHeight,
		),
		setWallToCeiling: setting<"wallToCeiling", boolean>(
			"wallToCeiling",
			wall.setWallToCeiling,
		),
		setWallToWall: setting<"wallToWall", boolean>(
			"wallToWall",
			wall.setWallToWall,
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
		overhangingIds: (room: RoomLayout): ReadonlySet<string> =>
			new Set(views(room).flatMap((view) => [...wall.overhangingIds(view)])),
		isClear: (room: RoomLayout) =>
			views(room).every((view) => wall.isClear(view)),
		skirtingSpans: (room: RoomLayout, run = 0) =>
			wall.skirtingSpans(runView(room, run)),
		minWallWidthMm,
		minRoomDepthMm,
		setWallWidth,
		setRoomDepth,
		setShape,
		setCornerSide,
		placeCorner,
		cornerPositions,
		exposureOf,
		endPanels,
		cornerWorktop,
	};
}

export type RoomEngine = ReturnType<typeof roomEngine>;
