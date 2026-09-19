import { ROOM_DEPTH_LIMITS } from "./catalogue";
import { WALL_LIMITS } from "./layout";
import type { Vec3Mm } from "./parts";

/**
 * The room's outline: a template and its measurements, and every wall derived
 * from them.
 *
 * Stored as parameters, never as a list of walls, so the outline always closes
 * and a room that cannot exist cannot be represented. Editing one wall's length
 * moves the parameter that wall is made of, and the walls that share it follow
 * — the way IKEA's room editor behaves.
 *
 * Plan millimetres, centred on the bounding box: x to the right, z toward the
 * viewer — the scene's own axes, scaled by a thousand.
 *
 * **Winding (load-bearing):** facing any wall from inside the room, its start is
 * on the left. So vertex i is wall i's right end and wall i+1's left end, and
 * every inside corner is the *left* corner of the wall after it — which is the
 * corner every drafted corner unit is drawn for.
 *
 * Pure, like the rest of `lib/planner`.
 */

export type FloorPlan =
	| { template: "rect"; widthMm: number; depthMm: number }
	| {
			template: "l";
			widthMm: number;
			depthMm: number;
			notchWidthMm: number;
			notchDepthMm: number;
			/** Notch at the front left instead of the front right. */
			mirror: boolean;
	  };

export type RoomShape = "rect" | "l" | "l-mirror";

export type Vec2 = { xMm: number; zMm: number };

export type WallGeom = {
	startMm: Vec2;
	endMm: Vec2;
	lengthMm: number;
	/** The run group's `rotation.y`: sends local +x along the wall, local +z
	 * into the room. */
	yawRad: number;
	/** Unit normal pointing into the room. */
	inward: Vec2;
	/** How far the room reaches out from this wall. Camera and measuring only —
	 * the job `roomDepthMm` does in a run view. */
	depthMm: number;
};

/** Where a run's group sits: turned by `yawRad`, moved by (xMm, zMm). */
export type WallFrame = { yawRad: number; xMm: number; zMm: number };

/** The narrowest an L's leg may get. Narrower and it is a corridor, not a
 * kitchen. */
export const MIN_LEG_MM = 1000;

function points(plan: FloorPlan): Vec2[] {
	const w = plan.widthMm / 2;
	const d = plan.depthMm / 2;
	const p = (xMm: number, zMm: number): Vec2 => ({ xMm, zMm });
	if (plan.template === "rect") {
		return [p(-w, -d), p(w, -d), p(w, d), p(-w, d)];
	}
	const nx = plan.notchWidthMm;
	const nz = plan.notchDepthMm;
	return plan.mirror
		? [
				p(-w, -d),
				p(w, -d),
				p(w, d),
				p(-w + nx, d),
				p(-w + nx, d - nz),
				p(-w, d - nz),
			]
		: [
				p(-w, -d),
				p(w, -d),
				p(w, d - nz),
				p(w - nx, d - nz),
				p(w - nx, d),
				p(-w, d),
			];
}

export function wallsOf(plan: FloorPlan): WallGeom[] {
	const pts = points(plan);
	return pts.map((startMm, i) => {
		const endMm = pts[(i + 1) % pts.length];
		const dx = endMm.xMm - startMm.xMm;
		const dz = endMm.zMm - startMm.zMm;
		const lengthMm = Math.hypot(dx, dz);
		const inward = { xMm: -dz / lengthMm, zMm: dx / lengthMm };
		const depthMm = Math.max(
			...pts.map(
				(q) =>
					(q.xMm - startMm.xMm) * inward.xMm +
					(q.zMm - startMm.zMm) * inward.zMm,
			),
		);
		// `dz === 0 ? 0 : -dz`: atan2(-0, -1) is -π, and a front wall at -π
		// rather than π only confuses anyone reading the numbers.
		const yawRad = Math.atan2(dz === 0 ? 0 : -dz, dx);
		return { startMm, endMm, lengthMm, yawRad, inward, depthMm };
	});
}

/** Where a wall's number (or its length figure) sits: the wall's midpoint,
 * pushed `insetMm` into the room along its inward normal. Shared by the plan
 * labels, the room-panel map and the 3D floor badges so all three agree on
 * where a wall's marker belongs. */
export function wallLabelMm(wall: WallGeom, insetMm: number): Vec2 {
	return {
		xMm: (wall.startMm.xMm + wall.endMm.xMm) / 2 + wall.inward.xMm * insetMm,
		zMm: (wall.startMm.zMm + wall.endMm.zMm) / 2 + wall.inward.zMm * insetMm,
	};
}

export function vertexKind(
	plan: FloorPlan,
	vertex: number,
): "inside" | "outside" {
	const pts = points(plan);
	const n = pts.length;
	const i = ((vertex % n) + n) % n;
	const [a, b, c] = [pts[i], pts[(i + 1) % n], pts[(i + 2) % n]];
	const cross =
		(b.xMm - a.xMm) * (c.zMm - b.zMm) - (b.zMm - a.zMm) * (c.xMm - b.xMm);
	return cross > 0 ? "inside" : "outside";
}

/**
 * The corners, each pushed `outsetMm` out of the room. `outlineOf(plan)[i]` is
 * wall i's start. Moving each corner by minus the sum of the two inward normals
 * shifts both walls out by the same amount — at an inside corner and at the
 * notch's outside corner alike, since every corner is square.
 */
export function outlineOf(plan: FloorPlan, outsetMm = 0): Vec2[] {
	const pts = points(plan);
	if (outsetMm === 0) return pts;
	const walls = wallsOf(plan);
	const n = walls.length;
	return pts.map((pt, i) => {
		const a = walls[(i - 1 + n) % n].inward;
		const b = walls[i].inward;
		return {
			xMm: pt.xMm - outsetMm * (a.xMm + b.xMm),
			zMm: pt.zMm - outsetMm * (a.zMm + b.zMm),
		};
	});
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Math.round(value)));

export function clampPlan(plan: FloorPlan): FloorPlan {
	if (plan.template === "rect") {
		return {
			...plan,
			widthMm: clamp(plan.widthMm, WALL_LIMITS.minMm, WALL_LIMITS.maxMm),
			depthMm: clamp(
				plan.depthMm,
				ROOM_DEPTH_LIMITS.minMm,
				ROOM_DEPTH_LIMITS.maxMm,
			),
		};
	}
	const widthMm = clamp(plan.widthMm, 2 * MIN_LEG_MM, WALL_LIMITS.maxMm);
	const depthMm = clamp(
		plan.depthMm,
		Math.max(2 * MIN_LEG_MM, ROOM_DEPTH_LIMITS.minMm),
		ROOM_DEPTH_LIMITS.maxMm,
	);
	return {
		...plan,
		widthMm,
		depthMm,
		notchWidthMm: clamp(plan.notchWidthMm, MIN_LEG_MM, widthMm - MIN_LEG_MM),
		notchDepthMm: clamp(plan.notchDepthMm, MIN_LEG_MM, depthMm - MIN_LEG_MM),
	};
}

/** The same limits the editor clamps to, as a yes or no — what checkout asks. */
export function planIsValid(plan: FloorPlan): boolean {
	const clamped = clampPlan(plan) as Record<string, unknown>;
	const given = plan as Record<string, unknown>;
	return Object.entries(clamped).every(([key, value]) => given[key] === value);
}

/** Which parameter each wall is made of. Lengths, in wall order:
 * rect `[W, D, W, D]`; l `[W, D−nz, nx, nz, W−nx, D]`;
 * l mirrored `[W, D, W−nx, nz, nx, D−nz]`. */
function withLength(plan: FloorPlan, wall: number, mm: number): FloorPlan {
	if (plan.template === "rect") {
		return wall % 2 === 0 ? { ...plan, widthMm: mm } : { ...plan, depthMm: mm };
	}
	const { widthMm: W, depthMm: D } = plan;
	const edits = plan.mirror
		? [
				{ widthMm: mm },
				{ depthMm: mm },
				{ notchWidthMm: W - mm },
				{ notchDepthMm: mm },
				{ notchWidthMm: mm },
				{ notchDepthMm: D - mm },
			]
		: [
				{ widthMm: mm },
				{ notchDepthMm: D - mm },
				{ notchWidthMm: mm },
				{ notchDepthMm: mm },
				{ notchWidthMm: W - mm },
				{ depthMm: mm },
			];
	return { ...plan, ...edits[wall] };
}

export const setWallLength = (plan: FloorPlan, wall: number, mm: number) =>
	clampPlan(withLength(plan, wall, mm));

export const shapeOf = (plan: FloorPlan): RoomShape =>
	plan.template === "rect" ? "rect" : plan.mirror ? "l-mirror" : "l";

/** Another template, keeping the back wall's length and the room's depth. */
export function reshape(plan: FloorPlan, shape: RoomShape): FloorPlan {
	const { widthMm, depthMm } = plan;
	if (shape === "rect")
		return clampPlan({ template: "rect", widthMm, depthMm });
	return clampPlan({
		template: "l",
		widthMm,
		depthMm,
		notchWidthMm: plan.template === "l" ? plan.notchWidthMm : widthMm / 2,
		notchDepthMm: plan.template === "l" ? plan.notchDepthMm : depthMm / 2,
		mirror: shape === "l-mirror",
	});
}

/**
 * The group transform that puts a run on its wall. `Run` draws its wall line at
 * local z = −depth/2 and centres the run on local x = 0, so the group sits at
 * the wall's midpoint pushed half a depth into the room. For a rectangle that
 * is always the origin — which is why the old L needed a turn and no move.
 */
export function frameOf(wall: WallGeom): WallFrame {
	return {
		yawRad: wall.yawRad,
		xMm:
			(wall.startMm.xMm + wall.endMm.xMm) / 2 +
			(wall.inward.xMm * wall.depthMm) / 2,
		zMm:
			(wall.startMm.zMm + wall.endMm.zMm) / 2 +
			(wall.inward.zMm * wall.depthMm) / 2,
	};
}

/** A point in a run's own frame, in the room's. Same sense as three's
 * `rotation.y`. */
export function toWorldMm(p: Vec3Mm, f: WallFrame): Vec3Mm {
	const cos = Math.cos(f.yawRad);
	const sin = Math.sin(f.yawRad);
	return {
		x: p.x * cos + p.z * sin + f.xMm,
		y: p.y,
		z: -p.x * sin + p.z * cos + f.zMm,
	};
}

export function toLocalMm(p: Vec3Mm, f: WallFrame): Vec3Mm {
	const cos = Math.cos(f.yawRad);
	const sin = Math.sin(f.yawRad);
	const x = p.x - f.xMm;
	const z = p.z - f.zMm;
	return { x: x * cos - z * sin, y: p.y, z: x * sin + z * cos };
}

/** The wall a floor point is nearest, and how far along it — where a cabinet
 * dropped there should land. */
export function nearestWall(
	plan: FloorPlan,
	point: Vec2,
): { run: number; xMm: number } {
	let best = { run: 0, xMm: 0 };
	let bestMm = Number.POSITIVE_INFINITY;
	wallsOf(plan).forEach((wall, run) => {
		const dx = point.xMm - wall.startMm.xMm;
		const dz = point.zMm - wall.startMm.zMm;
		// The wall's direction is the inward normal turned back a quarter.
		const along = dx * wall.inward.zMm - dz * wall.inward.xMm;
		const off = dx * wall.inward.xMm + dz * wall.inward.zMm;
		const onWall = Math.min(wall.lengthMm, Math.max(0, along));
		const distanceMm = Math.hypot(off, along - onWall);
		if (distanceMm < bestMm) {
			bestMm = distanceMm;
			best = { run, xMm: Math.round(onWall) };
		}
	});
	return best;
}

/** Where a cabinet dragged off `ownRun` should transfer to: the wall a floor
 * point lands nearest, or `null` when that is the wall it is already on. */
export function transferTarget(
	plan: FloorPlan,
	ownRun: number,
	point: Vec2,
): { run: number; xMm: number } | null {
	const target = nearestWall(plan, point);
	return target.run === ownRun ? null : target;
}
