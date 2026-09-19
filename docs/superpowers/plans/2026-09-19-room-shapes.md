# Room Shapes and Click-a-Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer pick a room shape (rectangle or L), edit every wall's length, and build cabinets on any wall — U and galley kitchens included.

**Architecture:** A new pure `lib/planner/floorplan.ts` turns a template + measurements into walls. `room.ts` becomes one run per wall plus corner units keyed by vertex; a corner square is reserved only when both walls meeting at an inside corner hold cabinets (or a corner unit). Each run is still handed to the unchanged one-wall engine in `layout.ts` through `runView`. The scene places each run with a per-wall frame (yaw + translation) instead of a yaw alone.

**Tech Stack:** Next.js App Router, React Three Fiber + drei, three.js, zod 4, vitest, biome.

**Spec:** `docs/superpowers/specs/2026-09-19-room-shapes-design.md`

## Global Constraints

- `lib/planner` stays framework-free: no React, no three.js imports.
- Every `lib/planner` function gets a test before it gets a caller.
- Sentence case in UI copy. Copy lives in `src/lib/copy/en.ts`, `ms.ts`, `zh.ts`; all three must stay the same shape (`Dictionary`).
- Stored orders carry `schemaVersion`; old versions must still parse.
- Price is computed server-side; never trust client geometry.
- All corners are 90°. Templates: `rect`, `l` (with `mirror`).
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Commands: `pnpm test` (vitest run), `pnpm lint` (biome check .), `pnpm typecheck`.
- **Build-state rule:** Tasks 2–4 change shared types, so `pnpm typecheck` is only required to pass from Task 6 on. Each task's vitest targets must pass at the end of that task; the full `pnpm test` must pass from Task 4 on.

## Two corrections to the spec, found while reading the code

1. **`wallToWall` is removed, not kept.** The spec says it "stays the customer's filler toggle", but no filler is drawn or priced anywhere: the flag only decides whether side walls exist (`PlannerScene` walls, `exposureOf` `enclosed`). In a closed floor plan every wall exists, so the flag has no job. v3 drops it from the room document; migrations drop it; the studio's "Open ends / To walls" toggle goes. The one-wall `PlannerLayout` keeps the field (its tests use it) and gains `endWalls`.
2. **Corners are an array, not a `Record`.** `corners: { vertex, floor, wall }[]` — JSON object keys are strings, and an array is simpler to validate with zod.

Also: the camera refits to a newly tapped wall automatically only in elevation view. In 3D it uses the target wall on "reset view", so tapping a wall does not yank the camera.

## File map

| File | Change |
| --- | --- |
| `src/lib/planner/floorplan.ts` | **new** — templates → walls, vertex kinds, frames, wall-length edits |
| `src/lib/planner/__tests__/floorplan.test.ts` | **new** |
| `src/lib/planner/layout.ts` | `reserved` becomes `Span[]` per row; `endWalls` on `PlannerLayout` |
| `src/lib/planner/exposure.ts` | `EndWalls` becomes `{ wallWidthMm, left, right }` |
| `src/lib/planner/room.ts` | rewritten for v3 |
| `src/lib/planner/pricing.ts` | sums every corner worktop |
| `src/lib/orders/layoutSchema.ts` | v3 schema, v1/v2 → v3 transforms |
| `src/lib/orders/validate.ts` | plan validity, corners array |
| `src/components/planner/Room.tsx` | polygon floor, one wall per edge, wall tap |
| `src/components/planner/PlannerScene.tsx` | wall frames, `DropPicker`, camera, puck |
| `src/components/planner/WallLengths.tsx` | **new** — plan-view length labels |
| `src/components/planner/PositionDimensions.tsx` | export `EditableFigure` |
| `src/components/planner/StudioScreen.tsx` | target wall, drop, room panel wiring |
| `src/components/planner/studio/RoomPanel.tsx` | shape thumbnails, per-wall lengths |
| `src/app/[lang]/planner/PlannerApp.tsx`, `QuoteScreen.tsx` | back-wall length from the plan |
| `src/lib/copy/{en,ms,zh}.ts` | copy keys |
| `CLAUDE.md` | room-shapes section |

---
### Task 1: Floor plan module

**Files:**
- Create: `src/lib/planner/floorplan.ts`
- Test: `src/lib/planner/__tests__/floorplan.test.ts`

**Interfaces:**
- Consumes: `WALL_LIMITS` (`layout.ts`), `ROOM_DEPTH_LIMITS` (`catalogue.ts`), `Vec3Mm` (`parts.ts`).
- Produces (later tasks rely on these exact names):
  - `type FloorPlan`, `type RoomShape = "rect" | "l" | "l-mirror"`, `type Vec2 = { xMm; zMm }`, `type WallGeom`, `type WallFrame = { yawRad; xMm; zMm }`
  - `MIN_LEG_MM = 1000`
  - `wallsOf(plan): WallGeom[]` — wall 0 is the back wall
  - `vertexKind(plan, vertex): "inside" | "outside"` — vertex *i* = end of wall *i* = start of wall *i+1*
  - `outlineOf(plan, outsetMm = 0): Vec2[]` — `outlineOf(plan)[i]` is wall *i*'s start
  - `setWallLength(plan, wall, mm): FloorPlan` (clamped), `clampPlan(plan)`, `planIsValid(plan): boolean`
  - `shapeOf(plan): RoomShape`, `reshape(plan, shape): FloorPlan`
  - `frameOf(wall): WallFrame`, `toWorldMm(p: Vec3Mm, f)`, `toLocalMm(p: Vec3Mm, f)`
  - `nearestWall(plan, point: Vec2): { run: number; xMm: number }`

Coordinates: plan millimetres, origin at the centre of the bounding box, `x` to the right, `z` toward the viewer (three.js world axes, scaled ×1000). Winding: facing any wall from inside, its start is on the left.

- [ ] **Step 1: Write the failing test**

`src/lib/planner/__tests__/floorplan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	type FloorPlan,
	frameOf,
	nearestWall,
	outlineOf,
	planIsValid,
	reshape,
	setWallLength,
	shapeOf,
	toLocalMm,
	toWorldMm,
	vertexKind,
	wallsOf,
} from "../floorplan";

const rect: FloorPlan = { template: "rect", widthMm: 4200, depthMm: 3600 };
// The IKEA screenshot: 5500 wide, 5075 deep, 1500 × 3000 notch front-right.
const l: FloorPlan = {
	template: "l",
	widthMm: 5500,
	depthMm: 5075,
	notchWidthMm: 1500,
	notchDepthMm: 3000,
	mirror: false,
};
const lMirror: FloorPlan = { ...l, mirror: true };

const lengths = (plan: FloorPlan) => wallsOf(plan).map((w) => w.lengthMm);
const kinds = (plan: FloorPlan) =>
	wallsOf(plan).map((_, i) => vertexKind(plan, i));

describe("wallsOf", () => {
	it("walks a rectangle back, right, front, left", () => {
		expect(lengths(rect)).toEqual([4200, 3600, 4200, 3600]);
		const [back, right, , left] = wallsOf(rect);
		expect(back.startMm).toEqual({ xMm: -2100, zMm: -1800 });
		expect(back.inward.zMm).toBeCloseTo(1);
		expect(right.inward.xMm).toBeCloseTo(-1);
		expect(left.inward.xMm).toBeCloseTo(1);
	});

	it("chains every wall's end to the next wall's start", () => {
		for (const plan of [rect, l, lMirror]) {
			const walls = wallsOf(plan);
			walls.forEach((wall, i) => {
				expect(walls[(i + 1) % walls.length].startMm).toEqual(wall.endMm);
			});
		}
	});

	it("gives each wall the room's extent out from it", () => {
		expect(wallsOf(rect).map((w) => w.depthMm)).toEqual([3600, 4200, 3600, 4200]);
		// The notch's top wall faces the upper area only.
		expect(wallsOf(l)[2].depthMm).toBe(2075);
	});

	it("turns the side walls the way the L's side run used to turn", () => {
		const walls = wallsOf(rect);
		expect(walls[0].yawRad).toBeCloseTo(0);
		expect(walls[1].yawRad).toBeCloseTo(-Math.PI / 2);
		expect(walls[3].yawRad).toBeCloseTo(Math.PI / 2);
	});

	it("cuts the notch from the front right, or front left when mirrored", () => {
		expect(lengths(l)).toEqual([5500, 2075, 1500, 3000, 4000, 5075]);
		expect(lengths(lMirror)).toEqual([5500, 5075, 4000, 3000, 1500, 2075]);
	});
});

describe("vertexKind", () => {
	it("is inside at every corner of a rectangle", () => {
		expect(kinds(rect)).toEqual(["inside", "inside", "inside", "inside"]);
	});

	it("is outside at the notch's inner corner only", () => {
		expect(kinds(l)).toEqual([
			"inside",
			"inside",
			"outside",
			"inside",
			"inside",
			"inside",
		]);
		expect(kinds(lMirror).indexOf("outside")).toBe(3);
		expect(kinds(lMirror).filter((k) => k === "outside")).toHaveLength(1);
	});
});

describe("frames", () => {
	it("needs no translation for a rectangle's walls", () => {
		for (const wall of wallsOf(rect)) {
			const frame = frameOf(wall);
			expect(frame.xMm).toBeCloseTo(0);
			expect(frame.zMm).toBeCloseTo(0);
		}
	});

	it("puts a run's wall line on its wall", () => {
		for (const plan of [rect, l, lMirror]) {
			for (const wall of wallsOf(plan)) {
				const p = toWorldMm({ x: 0, y: 0, z: -wall.depthMm / 2 }, frameOf(wall));
				expect(p.x).toBeCloseTo((wall.startMm.xMm + wall.endMm.xMm) / 2);
				expect(p.z).toBeCloseTo((wall.startMm.zMm + wall.endMm.zMm) / 2);
			}
		}
	});

	it("round-trips a point", () => {
		const frame = frameOf(wallsOf(l)[3]);
		const back = toLocalMm(toWorldMm({ x: 120, y: 900, z: -40 }, frame), frame);
		expect(back.x).toBeCloseTo(120);
		expect(back.y).toBeCloseTo(900);
		expect(back.z).toBeCloseTo(-40);
	});
});

describe("setWallLength", () => {
	it("moves the parameter the wall is made of", () => {
		expect(setWallLength(rect, 2, 5000)).toMatchObject({ widthMm: 5000 });
		expect(setWallLength(rect, 3, 3000)).toMatchObject({ depthMm: 3000 });
		expect(setWallLength(l, 4, 4500)).toMatchObject({ notchWidthMm: 1000 });
		expect(setWallLength(l, 1, 2500)).toMatchObject({ notchDepthMm: 2575 });
		expect(setWallLength(lMirror, 5, 2500)).toMatchObject({ notchDepthMm: 2575 });
	});

	it("clamps so the room never pinches shut", () => {
		expect(setWallLength(rect, 0, 500)).toMatchObject({ widthMm: 1000 });
		// A notch as wide as the room leaves no leg.
		expect(setWallLength(l, 2, 5000)).toMatchObject({ notchWidthMm: 4500 });
		expect(lengths(setWallLength(l, 2, 5000))[4]).toBe(1000);
	});
});

describe("planIsValid", () => {
	it("accepts what clampPlan leaves alone and refuses the rest", () => {
		expect(planIsValid(rect)).toBe(true);
		expect(planIsValid(l)).toBe(true);
		expect(planIsValid({ ...l, notchWidthMm: 5000 })).toBe(false);
		expect(planIsValid({ ...rect, widthMm: 4200.5 })).toBe(false);
	});
});

describe("reshape", () => {
	it("keeps the back wall and gives a new L a half-size notch", () => {
		expect(reshape(rect, "l")).toEqual({
			template: "l",
			widthMm: 4200,
			depthMm: 3600,
			notchWidthMm: 2100,
			notchDepthMm: 1800,
			mirror: false,
		});
		expect(shapeOf(reshape(l, "l-mirror"))).toBe("l-mirror");
		expect(reshape(l, "rect")).toEqual({
			template: "rect",
			widthMm: 5500,
			depthMm: 5075,
		});
	});
});

describe("outlineOf", () => {
	it("pushes every corner out by the scribe", () => {
		expect(outlineOf(rect, 5)[0]).toEqual({ xMm: -2105, zMm: -1805 });
		// The notch's inner corner moves into the notch, away from the room.
		expect(outlineOf(l, 5)[3]).toEqual({ xMm: 1255, zMm: -457.5 });
	});
});

describe("nearestWall", () => {
	it("reads a floor point as a wall and a distance along it", () => {
		// The left wall runs from the front (z = 1800) to the back.
		expect(nearestWall(rect, { xMm: -2000, zMm: 1000 })).toEqual({
			run: 3,
			xMm: 800,
		});
		expect(nearestWall(rect, { xMm: 100, zMm: -1700 })).toEqual({
			run: 0,
			xMm: 2200,
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/planner/__tests__/floorplan.test.ts`
Expected: FAIL — `Failed to resolve import "../floorplan"`.

- [ ] **Step 3: Write the implementation**

`src/lib/planner/floorplan.ts`:

```ts
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
		? [p(-w, -d), p(w, -d), p(w, d), p(-w + nx, d), p(-w + nx, d - nz), p(-w, d - nz)]
		: [p(-w, -d), p(w, -d), p(w, d - nz), p(w - nx, d - nz), p(w - nx, d), p(-w, d)];
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
					(q.xMm - startMm.xMm) * inward.xMm + (q.zMm - startMm.zMm) * inward.zMm,
			),
		);
		// `dz === 0 ? 0 : -dz`: atan2(-0, -1) is -π, and a front wall at -π
		// rather than π only confuses anyone reading the numbers.
		const yawRad = Math.atan2(dz === 0 ? 0 : -dz, dx);
		return { startMm, endMm, lengthMm, yawRad, inward, depthMm };
	});
}

export function vertexKind(plan: FloorPlan, vertex: number): "inside" | "outside" {
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
			depthMm: clamp(plan.depthMm, ROOM_DEPTH_LIMITS.minMm, ROOM_DEPTH_LIMITS.maxMm),
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
	if (shape === "rect") return clampPlan({ template: "rect", widthMm, depthMm });
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
		xMm: (wall.startMm.xMm + wall.endMm.xMm) / 2 + (wall.inward.xMm * wall.depthMm) / 2,
		zMm: (wall.startMm.zMm + wall.endMm.zMm) / 2 + (wall.inward.zMm * wall.depthMm) / 2,
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
export function nearestWall(plan: FloorPlan, point: Vec2): { run: number; xMm: number } {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/planner/__tests__/floorplan.test.ts`
Expected: PASS, all tests. If a `toEqual` on a `Vec2` fails only by `-0` vs `0`, change that assertion to `toBeCloseTo` per field — do not change the implementation.

- [ ] **Step 5: Lint and commit**

```bash
pnpm biome check --write src/lib/planner/floorplan.ts src/lib/planner/__tests__/floorplan.test.ts
git add src/lib/planner/floorplan.ts src/lib/planner/__tests__/floorplan.test.ts
git commit -m "feat(planner): floor plan templates and the walls they make

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Reserved spans as lists, end walls per end

A U's back wall has a corner at each end, so a run view needs more than one reserved span per row. And whether a wall stands at each end of a run becomes a per-end fact rather than one `wallToWall` flag.

**Files:**
- Modify: `src/lib/planner/layout.ts` (`PlannerLayout` type ~l.95–130, `occupiedSpans` ~l.495, `snapTargets` ~l.691, `exposureOf` ~l.1504, `closeGaps` ~l.1784)
- Modify: `src/lib/planner/exposure.ts` (`EndWalls`, `exposedSides`, `sideGapsMm`)
- Modify (keep compiling until Task 3 rewrites it): `src/lib/planner/room.ts`, `src/components/planner/PlannerScene.tsx` (~l.1199–1241, ~l.1272–1277), `src/components/planner/StudioScreen.tsx` (~l.418–423)
- Test: `src/lib/planner/__tests__/reserved.test.ts`, `src/lib/planner/__tests__/exposure.test.ts`, `src/lib/planner/__tests__/room.test.ts` (lines 86–110 only)

**Interfaces:**
- Produces:
  - `PlannerLayout.reserved?: Partial<Record<Row, Span[]>>`
  - `PlannerLayout.endWalls?: { left: boolean; right: boolean }` — absent means both ends follow `wallToWall`
  - `EndWalls = { wallWidthMm: number; left: boolean; right: boolean }`

- [ ] **Step 1: Write the failing tests**

In `reserved.test.ts`, change the fixture to lists and add a both-ends case:

```ts
const cornered = (floorMm = 607, wallMm = 397): PlannerLayout => ({
	...emptyLayout(3000),
	reserved: {
		floor: [{ startMm: 0, endMm: floorMm }],
		wall: [{ startMm: 0, endMm: wallMm }],
	},
});
```

Append:

```ts
describe("a corner at each end", () => {
	const both = (): PlannerLayout => ({
		...emptyLayout(3000),
		reserved: {
			floor: [
				{ startMm: 0, endMm: 607 },
				{ startMm: 2393, endMm: 3000 },
			],
			wall: [
				{ startMm: 0, endMm: 397 },
				{ startMm: 2603, endMm: 3000 },
			],
		},
	});

	it("stops a cabinet short of the far corner too", () => {
		const next = engine.addModule(both(), "base-cabinet", 2800, "a", 600);
		expect(next.floor[0].xMm).toBe(1793);
		expect(engine.isClear(next)).toBe(true);
	});

	it("packs from the corner at the start", () => {
		let next = engine.addModule(both(), "base-cabinet", 1500, "a", 600);
		next = engine.closeGaps(next);
		expect(next.floor[0].xMm).toBe(607);
	});
});

describe("end walls", () => {
	const flushLeft = (endWalls: { left: boolean; right: boolean }) =>
		engine.addModule(
			// `wallToWall` on, to show `endWalls` wins when both are given.
			{ ...emptyLayout(3000), wallToWall: true, endWalls },
			"base-cabinet",
			0,
			"a",
			600,
		);

	it("bury the end a wall stands at", () => {
		expect(
			engine.exposureOf(flushLeft({ left: true, right: true })).get("a")?.left,
		).toBe(false);
	});

	it("leave an end in the open where no wall stands", () => {
		expect(
			engine.exposureOf(flushLeft({ left: false, right: true })).get("a")?.left,
		).toBe(true);
	});
});
```

In `exposure.test.ts`, replace the two fixtures and the two inline objects:

```ts
const enclosed = { wallWidthMm: WALL_MM, left: true, right: true };
const open = { wallWidthMm: WALL_MM, left: false, right: false };
```

and `{ wallWidthMm: 4200, enclosed: true }` → `{ wallWidthMm: 4200, left: true, right: true }`, `{ wallWidthMm: 4200, enclosed: false }` → `{ wallWidthMm: 4200, left: false, right: false }`. Run `grep -n "enclosed:" src/lib/planner/__tests__/exposure.test.ts` afterwards; it must print nothing.

In `room.test.ts`, the four `runView(...).reserved` expectations (lines ~86–110) become arrays: wrap each expected span in `[ … ]`, e.g.

```ts
expect(runView(lRoom("left"), 0).reserved).toEqual({
	floor: [{ startMm: 0, endMm: 607 }],
	wall: [{ startMm: 0, endMm: 397 }],
});
```

and each `.reserved?.floor` expectation becomes `.reserved?.floor).toEqual([{ … }])`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/planner/__tests__/reserved.test.ts src/lib/planner/__tests__/exposure.test.ts`
Expected: FAIL (spreading a `Span` object, `endWalls` ignored).

- [ ] **Step 3: Implement in `layout.ts` and `exposure.ts`**

`layout.ts`, `PlannerLayout`:

```ts
	/**
	 * Stretches of this wall corners have taken, per row — a run can have a
	 * corner at each end. Only set on a run view built by `room.ts`. They enter
	 * `occupiedSpans`, so everything that settles against a neighbour treats a
	 * corner as one more neighbour and needs no rule of its own.
	 */
	reserved?: Partial<Record<Row, Span[]>>;
	/**
	 * Whether a wall stands at each end of this run. Set by `room.ts` from the
	 * floor plan: a run ending at an inside corner meets a wall, one ending at
	 * the notch's outside corner does not. Absent on a bare one-wall layout,
	 * where both ends follow `wallToWall`.
	 */
	endWalls?: { left: boolean; right: boolean };
```

`occupiedSpans`, replace the `const corner = [...]` block:

```ts
		const corner = [
			...(layout.reserved?.[row] ?? []),
			// A tall unit stands in the hung row too, so that row's corners are in
			// its way as well — the same two-way rule as the wall cabinets above.
			...(row === "floor" && isTallModule(layout, ignoreId)
				? (layout.reserved?.wall ?? [])
				: []),
		];
```

`snapTargets`:

```ts
		for (const span of [
			...(layout.reserved?.floor ?? []),
			...(layout.reserved?.wall ?? []),
		]) {
			edges.push(span.startMm, span.endMm);
		}
```

`exposureOf`:

```ts
		const walls = {
			wallWidthMm: layout.wallWidthMm,
			left: layout.endWalls?.left ?? layout.wallToWall,
			right: layout.endWalls?.right ?? layout.wallToWall,
		};
```

`closeGaps`, `startOf`:

```ts
		const startOf = (row: Row) =>
			layout.reserved?.[row]?.find((span) => span.startMm === 0)?.endMm ?? 0;
```

`exposure.ts`:

```ts
/**
 * The walls at the ends of the run, when the room has them — each end on its
 * own, since a run can stop at a wall at one end and in the open at the other.
 */
export type EndWalls = { wallWidthMm: number; left: boolean; right: boolean };
```

In `exposedSides` replace the `if (walls?.enclosed) { … }` block:

```ts
	if (walls?.left && Math.abs(self.xMm) <= touchingMm) left = false;
	if (walls?.right && Math.abs(walls.wallWidthMm - selfEnd) <= touchingMm)
		right = false;
```

In `sideGapsMm` replace its `if (walls?.enclosed) { … }` block:

```ts
	if (walls?.left) left = Math.min(left, Math.max(0, self.xMm));
	if (walls?.right)
		right = Math.min(right, Math.max(0, walls.wallWidthMm - selfEnd));
```

Update the file's header comment sentence "Pass `EndWalls` and the run's two outer ends stop counting as exposed" to "Pass `EndWalls` and an end with a wall at it stops counting as exposed".

- [ ] **Step 4: Keep today's callers compiling (Task 3 replaces `room.ts`)**

`room.ts`:
- `runView`: `...(floor && wall ? { reserved: { floor: [floor], wall: [wall] } } : {})`
- `fromCorner`: the `reserved` rebuild becomes
  ```ts
  reserved: {
  	floor: view.reserved.floor?.map(flip),
  	wall: view.reserved.wall?.map(flip),
  },
  ```
  and `flip` takes a `Span` (not `Span | undefined`): `const flip = (span: Span): Span => ({ startMm: L - span.endMm, endMm: L - span.startMm });`
- `exposureOf`: `const span = view.reserved?.[row]?.[0];`
- `cornerWorktop`: `const span = view.reserved?.floor?.[0];`
- `cornerShutSides`: `const span = view.reserved?.[row]?.[0];`

`PlannerScene.tsx`:
- In `Run`'s `sideGaps` memo: `walls` becomes `{ wallWidthMm: layout.wallWidthMm, left: layout.endWalls?.left ?? layout.wallToWall, right: layout.endWalls?.right ?? layout.wallToWall }`, and `const span = cornerFilled[row] ? layout.reserved?.[row]?.[0] : undefined;`
- Corner worktop: `{cornerWorktop && layout.reserved?.floor?.[0] && (` and `layout.reserved.floor[0].startMm +`.

`StudioScreen.tsx`, the `cornerMm` computation: `...Object.values(runView(layout, 0).reserved ?? {}).flat().map(`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/planner/__tests__/reserved.test.ts src/lib/planner/__tests__/exposure.test.ts src/lib/planner/__tests__/layout.test.ts src/lib/planner/__tests__/room.test.ts`
Expected: PASS. `pnpm typecheck` should also pass at this point.

- [ ] **Step 6: Commit**

```bash
pnpm biome check --write src/lib/planner src/components/planner
git add src/lib/planner src/components/planner
git commit -m "refactor(planner): a run can hold a corner at each end

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The room document, v3

Rewrites `room.ts` around the floor plan: one run per wall, corner units by vertex, corner squares that switch on when both walls meeting at an inside corner hold cabinets. Also moves `pricing.ts` to the list of corner worktops, since it is `lib/planner` and its tests live beside the room's.

**Files:**
- Rewrite: `src/lib/planner/room.ts`
- Rewrite: `src/lib/planner/__tests__/room.test.ts`
- Modify: `src/lib/planner/pricing.ts` (`worktopFt`)
- Modify: `src/lib/planner/__tests__/pricing.test.ts` (L-room block, end-panel block)

**Interfaces:**
- Consumes (Task 1): `FloorPlan`, `RoomShape`, `wallsOf`, `vertexKind`, `setWallLength` (imported as `planWithWallLength`), `reshape`, `shapeOf`.
- Consumes (Task 2): `PlannerLayout.reserved` lists, `PlannerLayout.endWalls`.
- Produces (module exports):
  - `type Run`, `type CornerUnits = { vertex: number; floor: PlacedModule | null; wall: PlacedModule | null }`
  - `type RoomLayout = Settings & { plan: FloorPlan; runs: Run[]; corners: CornerUnits[] }` where `Settings` = `ceilingHeightMm`, `hangingHeightMm`, `wallToCeiling`, `baseSkirting`
  - `EMPTY_CORNER_MM`, `asRoom(layout)`, `emptyRoom(wallWidthMm, roomDepthMm?, ceilingMm?)`
  - `cornerAt(room, vertex)`, `isActiveCorner(room, vertex)`, `cornerSquareMm(room, vertex, row)`, `cornerSpans(room, run, row): { vertex; atStart; span }[]`, `cornerVertexFor(room, run): number | null`, `nearCornerMm(room, run)`
  - `runView`, `withRun`, `runIndexOf`, `setDoor`, `setHinge`, `setDoors` (unchanged signatures)
  - `roomEngine(catalogue)` returning everything it returned before **except** `minWallWidthMm`, `minRoomDepthMm`, `setWallWidth`, `setRoomDepth`, `setWallToWall`, `setCornerSide`, `cornerWorktop`; **plus** `setWallLength(room, wall, mm)`, `wallLengthRangeMm(room, wall): { minMm; maxMm }`, `cornerPositionsOf(room, run): Positioned[]`, `cornerWorktops(room): { vertex; sizeMm; topMm }[]`. `setShape(room, shape: RoomShape)` keeps its name with the new shape type. `placeCorner(room, familyId, vertex, id?)` takes a vertex.
  - Removed exports: `runYawRad`, `shapeOf` (use `shapeOf(room.plan)` from `floorplan.ts`), `CornerSide`, `Corner`, the old `RoomShape`.

- [ ] **Step 1: Replace `src/lib/planner/__tests__/room.test.ts`**

The old file is built on `{ runs: [main, side], corner }` and `setCornerSide`, none of which exist in v3. Replace it whole:

```ts
import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import type { FloorPlan } from "../floorplan";
import { emptyLayout, type PlacedModule, plannerEngine } from "../layout";
import {
	asRoom,
	cornerVertexFor,
	emptyRoom,
	nearCornerMm,
	type RoomLayout,
	roomEngine,
	runIndexOf,
	runView,
	setDoor,
	withRun,
} from "../room";

const engine = roomEngine(PLANNER_CATALOGUE);
const oneWall = plannerEngine(PLANNER_CATALOGUE);

const base = (id: string, xMm: number, widthMm = 600): PlacedModule => ({
	id,
	familyId: "base-cabinet",
	widthMm,
	doorStyleId: null,
	hinge: "left",
	xMm,
});

/** 4200 × 3600: the back wall is 4200, the left wall (run 3) 3600. */
const kitchen = () => emptyRoom(4200);

/** The old left L, by hand: the back wall and the left wall, meeting at
 * vertex 3 — the start of the back wall and the end of the left wall. */
const lRoom = (main: PlacedModule[] = [], side: PlacedModule[] = []): RoomLayout => {
	const room = kitchen();
	return {
		...room,
		runs: room.runs.map((run, i) =>
			i === 0 ? { floor: main, wall: [] } : i === 3 ? { floor: side, wall: [] } : run,
		),
	};
};

const lPlan: FloorPlan = {
	template: "l",
	widthMm: 5500,
	depthMm: 5075,
	notchWidthMm: 1500,
	notchDepthMm: 3000,
	mirror: false,
};

const xOf = (room: RoomLayout, id: string) =>
	room.runs.flatMap((r) => [...r.floor, ...r.wall]).find((m) => m.id === id)?.xMm;

describe("asRoom", () => {
	it("makes one wall's rows the back wall of a rectangle", () => {
		const room = asRoom(emptyLayout(3000));
		expect(room.plan).toEqual({ template: "rect", widthMm: 3000, depthMm: 3600 });
		expect(room.runs).toHaveLength(4);
		expect(room.runs[0]).toEqual({ floor: [], wall: [] });
		expect(room.corners).toEqual([]);
		expect("wallToWall" in room).toBe(false);
	});
});

describe("runView", () => {
	it("gives each wall its own length, depth and end walls", () => {
		expect(runView(kitchen(), 0)).toMatchObject({
			wallWidthMm: 4200,
			roomDepthMm: 3600,
			endWalls: { left: true, right: true },
		});
		expect(runView(kitchen(), 3)).toMatchObject({
			wallWidthMm: 3600,
			roomDepthMm: 4200,
		});
		expect(runView(kitchen(), 0).reserved).toBeUndefined();
	});

	it("leaves a run ending at the notch's outside corner open at that end", () => {
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		expect(runView(room, 2).endWalls).toEqual({ left: true, right: false });
		expect(runView(room, 3).endWalls).toEqual({ left: false, right: true });
	});
});

describe("a straight run", () => {
	it("edits exactly as the one-wall engine does", () => {
		const flat = oneWall.addModule(emptyLayout(4200), "base-cabinet", 0, "a", 600);
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(runView(room, 0).floor).toEqual(flat.floor);
	});

	it("refuses a run that does not exist", () => {
		const room = kitchen();
		expect(engine.addModule(room, "base-cabinet", 0, "a", 600, 4)).toBe(room);
	});
});

describe("corners switch on when both walls hold cabinets", () => {
	it("reserve nothing while only one wall is used", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(runView(room, 0).reserved).toBeUndefined();
		expect(xOf(room, "a")).toBe(0);
	});

	it("reserve the square on both walls and push both runs clear", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 3000, "s", 600, 3);
		expect(runView(room, 0).reserved?.floor).toEqual([{ startMm: 0, endMm: 607 }]);
		expect(runView(room, 3).reserved?.floor).toEqual([{ startMm: 2993, endMm: 3600 }]);
		expect(xOf(room, "a")).toBe(607);
		expect(xOf(room, "s")).toBe(2393);
	});

	it("refuse the cabinet that would switch one on when a wall cannot give way", () => {
		let room = emptyRoom(4200, 2000);
		room = engine.addModule(room, "base-cabinet", 200, "s1", 900, 3);
		room = engine.addModule(room, "base-cabinet", 1100, "s2", 900, 3);
		expect(engine.addModule(room, "base-cabinet", 0, "a", 600, 0)).toBe(room);
	});

	it("reserve both ends of the back wall in a U", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 1800, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "l", 600, 3);
		room = engine.addModule(room, "base-cabinet", 3000, "r", 600, 1);
		expect(runView(room, 0).reserved?.floor).toEqual([
			{ startMm: 0, endMm: 607 },
			{ startMm: 3593, endMm: 4200 },
		]);
	});

	it("reserve nothing in a galley, whose walls never meet", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "f", 600, 2);
		expect(runView(room, 0).reserved).toBeUndefined();
		expect(runView(room, 2).reserved).toBeUndefined();
	});

	it("never switch on at an outside corner", () => {
		let room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		room = engine.addModule(room, "base-cabinet", 900, "top", 600, 2);
		room = engine.addModule(room, "base-cabinet", 0, "side", 600, 3);
		expect(runView(room, 2).reserved).toBeUndefined();
		expect(runView(room, 3).reserved).toBeUndefined();
	});

	it("free the square when a wall empties, and pull nothing back", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "base-cabinet", 3000, "s", 600, 3);
		room = engine.removeModule(room, "s");
		expect(runView(room, 0).reserved).toBeUndefined();
		expect(xOf(room, "a")).toBe(607);
	});
});

describe("setShape", () => {
	it("turns a rectangle into an L, keeping the back wall", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		const next = engine.setShape(room, "l");
		expect(next.plan.template).toBe("l");
		expect(next.runs).toHaveLength(6);
		expect(next.runs[0]).toBe(room.runs[0]);
	});

	it("refuses while any other wall holds a cabinet", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "s", 600, 3);
		expect(engine.setShape(room, "l")).toBe(room);
	});
});

describe("setWallLength", () => {
	it("moves the parameter the wall is made of", () => {
		const next = engine.setWallLength(kitchen(), 2, 5000);
		expect(next.plan).toMatchObject({ widthMm: 5000 });
		expect(runView(next, 0).wallWidthMm).toBe(5000);
	});

	it("stops at what the wall's cabinets need", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 2400, "a", 600);
		room = engine.setWallLength(room, 0, 1000);
		expect(runView(room, 0).wallWidthMm).toBe(3000);
		expect(engine.wallLengthRangeMm(room, 0)).toEqual({ minMm: 3000, maxMm: 12000 });
	});

	it("keeps a run by its far corner when only that end has one", () => {
		// The back wall and the right wall meet at vertex 0, the back wall's end.
		let room = engine.addModule(kitchen(), "base-cabinet", 3600, "b", 600);
		room = engine.addModule(room, "base-cabinet", 0, "r", 600, 1);
		const before = xOf(room, "b") ?? 0;
		const wider = engine.setWallLength(room, 0, 4700);
		expect(xOf(wider, "b")).toBe(before + 500);
		expect(xOf(wider, "r")).toBe(xOf(room, "r"));
	});
});

describe("corner units", () => {
	it("go to the target wall's start corner, drawn there unturned", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(room.corners).toEqual([
			expect.objectContaining({ vertex: 3, floor: expect.objectContaining({ id: "c" }) }),
		]);
		expect(xOf(room, "a")).toBe(900);
		const [drawn] = engine.cornerPositionsOf(room, 0);
		expect(drawn.xMm).toBe(0);
		expect(drawn.placed.rotationDeg).toBeUndefined();
		expect(engine.cornerPositionsOf(room, 3)).toEqual([]);
	});

	it("pick the end corner when the start is an outside corner", () => {
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		expect(cornerVertexFor(room, 3)).toBe(3);
		expect(cornerVertexFor(room, 2)).toBe(1);
		expect(engine.placeCorner(room, "corner-base", 2)).toBe(room);
	});

	it("go to the wall slot when they hang", () => {
		const room = engine.addModule(kitchen(), "corner-wall", 0, "cw", undefined, 1);
		expect(room.corners[0]).toMatchObject({ vertex: 0, floor: null });
		expect(room.corners[0].wall?.familyId).toBe("corner-wall");
	});

	it("are refused in a full slot", () => {
		const full = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.addModule(full, "corner-base", 0, "d")).toBe(full);
		expect(engine.fits(full, "corner-base")).toBe(false);
	});

	it("ignore a client's own xMm and rotation", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		const floor = room.corners[0].floor;
		if (!floor) throw new Error("fixture lost its corner");
		const tampered: RoomLayout = {
			...room,
			corners: [{ ...room.corners[0], floor: { ...floor, xMm: 1234, rotationDeg: 90 } }],
		};
		const [drawn] = engine.cornerPositions(tampered);
		expect(drawn.placed.xMm).toBe(0);
		expect(drawn.placed.rotationDeg).toBeUndefined();
	});

	it("are priced, listed and removed like any cabinet", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.allPositions(room).map((p) => p.placed.id)).toEqual(["c"]);
		expect(engine.widthOptionsFor(room, "c")).toEqual([
			{ widthMm: 900, priceRm: 1150, fits: true },
		]);
		expect(engine.removeModule(room, "c").corners).toEqual([]);
		expect(setDoor(room, "c", "shaker").corners[0].floor?.doorStyleId).toBe("shaker");
	});
});

describe("exposure", () => {
	it("buries a side flush against a wall", () => {
		const room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		expect(engine.exposureOf(room).get("a")?.left).toBe(false);
	});

	it("leaves the end beside an empty corner square in the open", () => {
		const room = lRoom([base("a", 607)], [base("s", 2393)]);
		expect(engine.exposureOf(room).get("a")?.left).toBe(true);
	});

	it("covers the end beside a corner unit, which wears no panels itself", () => {
		let room = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(engine.exposureOf(room).get("a")?.left).toBe(false);
		expect(engine.exposureOf(room).get("c")).toEqual({ left: false, right: false });
		expect(engine.endPanels(room).some((p) => p.moduleId === "c")).toBe(false);
	});
});

describe("cornerWorktops", () => {
	it("is empty with no active corner", () => {
		expect(engine.cornerWorktops(kitchen())).toEqual([]);
		expect(engine.cornerWorktops(lRoom([base("a", 0)]))).toEqual([]);
	});

	it("closes an empty corner when a base unit meets it", () => {
		expect(engine.cornerWorktops(lRoom([base("a", 607)], [base("s", 2393)]))).toEqual([
			{ vertex: 3, sizeMm: 607, topMm: 880 },
		]);
	});

	it("covers a corner base unit", () => {
		const room = engine.addModule(kitchen(), "corner-base", 0, "c");
		expect(engine.cornerWorktops(room)).toEqual([{ vertex: 3, sizeMm: 900, topMm: 880 }]);
	});
});

describe("where a run starts", () => {
	it("is the start of the wall, unless only the far end is a corner", () => {
		expect(nearCornerMm(kitchen(), 0)).toBe(0);
		const room: RoomLayout = {
			...emptyRoom(5500),
			plan: lPlan,
			runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
		};
		expect(nearCornerMm(room, 3)).toBe(3000);
	});

	it("packs toward a corner at the far end", () => {
		// The left wall's only corner is its far end, vertex 3.
		const room = engine.closeGaps(lRoom([base("a", 607)], [base("s", 1000)]));
		expect(xOf(room, "s")).toBe(2393);
		expect(engine.runExtentMm(room, 3)).toBe(1207);
	});
});

describe("dispatch", () => {
	it("finds, moves and removes across runs", () => {
		const room = lRoom([base("a", 607)], [base("s", 1000)]);
		expect(runIndexOf(room, "s")).toBe(3);
		expect(engine.removeModules(room, ["a", "s"]).runs.every((r) => r.floor.length === 0)).toBe(true);
	});

	it("withRun writes rows only", () => {
		const room = kitchen();
		const view = { ...runView(room, 3), wallWidthMm: 1 };
		const next = withRun(room, 3, { ...view, floor: [base("x", 0)] });
		expect(next.plan).toBe(room.plan);
		expect(next.runs[3].floor).toHaveLength(1);
	});
});

describe("cornerShutSides", () => {
	// The left wall is 3600 long and its corner is its far end.
	const pair = (mainMm: number, sideEndMm: number) =>
		lRoom([base("a", mainMm)], [base("b", sideEndMm - 600)]);
	const both = new Map([
		["a", "left"],
		["b", "right"],
	]);

	it("shuts the leaf each run hinges onto the corner", () => {
		expect(engine.cornerShutSides(pair(607, 2993))).toEqual(both);
	});

	it("still shuts them when a cabinet is nudged a few mm off the square", () => {
		expect(engine.cornerShutSides(pair(611, 2993))).toEqual(both);
		expect(engine.cornerShutSides(pair(750, 2993))).toEqual(both);
	});

	it("lets them open once both are out of each other's reach", () => {
		expect(engine.cornerShutSides(pair(1600, 2000))).toEqual(new Map());
		expect(engine.cornerShutSides(pair(1400, 2200))).toEqual(both);
	});

	it("still shuts them when a cabinet is lifted off the floor", () => {
		const lifted = lRoom([{ ...base("a", 607), hangAtMm: 40 }], [base("b", 2393)]);
		expect(engine.cornerShutSides(lifted)).toEqual(both);
	});

	it("lets them open when a lift clears the other run's doors", () => {
		const hoisted = lRoom([{ ...base("a", 607), hangAtMm: 1500 }], [base("b", 2393)]);
		expect(engine.cornerShutSides(hoisted)).toEqual(new Map());
	});

	it("ignores a turned cabinet", () => {
		const turned = lRoom([{ ...base("a", 607), rotationDeg: 30 }], [base("b", 2393)]);
		expect(engine.cornerShutSides(turned)).toEqual(new Map());
	});

	it("shuts nothing while only one wall holds cabinets", () => {
		expect(engine.cornerShutSides(lRoom([base("a", 607)]))).toEqual(new Map());
	});

	it("opens both once the corner square is deeper than the leaves reach", () => {
		const filled = (squareMm: number): RoomLayout => ({
			...lRoom([base("a", squareMm)], [base("b", 3600 - squareMm - 600)]),
			corners: [{ vertex: 3, floor: base("corner", 0, squareMm), wall: null }],
		});
		expect(engine.cornerShutSides(filled(900))).toEqual(both);
		expect(engine.cornerShutSides(filled(2600))).toEqual(new Map());
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/planner/__tests__/room.test.ts`
Expected: FAIL — `cornerVertexFor` is not exported, `plan` is undefined.

- [ ] **Step 3: Rewrite `src/lib/planner/room.ts`**

Keep the existing file's long comments on `cascadeCorner`, `cornerShutSides` and `cornerWorktop` where the logic is unchanged — they record bugs this code has already been through. The code:

```ts
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

export const cornerAt = (room: RoomLayout, vertex: number): CornerUnits | null =>
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

/** A run whose only corner is at its far end packs and measures from there. */
const packsFromEnd = (room: RoomLayout, run: number) => {
	const spans = cornerSpans(room, run, "floor");
	return spans.length === 1 && !spans[0].atStart;
};

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
	if (!packsFromEnd(room, run)) return view;
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
	const hit = (module: PlacedModule) => (module.id === id ? edit(module) : module);
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

export const setDoor = (room: RoomLayout, id: string, doorStyleId: string | null) =>
	mapModule(room, id, (module) => ({ ...module, doorStyleId }));

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
```

Then `roomEngine`. It keeps the old file's structure; only the pieces below differ. Copy these verbatim from the old file, unchanged: `inRunOf`, the `setting` helper, and the return entries `positionsOf`, `rowEndMm`, `freeSpans`, `offsetsOf`, `setGap` … `swapWithNeighbour`, `removeModule`, `setHangingHeight`, `setWallToCeiling`, `setBaseSkirting`, `setCeilingHeight`, `hangingHeightMmOf`, `floorHeightMmOf`, `flushWallToTallTops`, `overhangMm`, `overhangingIds`, `isClear`, `skirtingSpans`, `endPanels`. Delete `setWallToWall`, `setCornerSide`, `minWallWidthMm`, `minRoomDepthMm`, `resized`, `setWallWidth`, `setRoomDepth`, `cornerNeedMm`, and the old `setShape`.

```ts
export function roomEngine(catalogue: PlannerCatalogue) {
	const wall = plannerEngine(catalogue);
	const views = (room: RoomLayout) => room.runs.map((_, i) => runView(room, i));
	const allClear = (room: RoomLayout) => views(room).every((v) => wall.isClear(v));

	// inRunOf — unchanged from the old file.

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
			return [{ placed: { ...rest, xMm: 0 }, family, widthMm: placed.widthMm, xMm: 0 }];
		});
	}

	const cornerPositions = (room: RoomLayout): Positioned[] =>
		room.runs.flatMap((_, run) => cornerPositionsOf(room, run));

	/**
	 * Slide one run's cabinets clear of one corner's square. The old
	 * `cascadeCorner` body, for one end of one run: walk both rows ordered by
	 * distance from that end, one cursor per row, a tall unit claiming both.
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
			{ ...room, corners: [...room.corners.filter((c) => c.vertex !== vertex), slot] },
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
				const followsEnd =
					isActiveCorner(room, i) && !isActiveCorner(room, startVertexOf(room, i));
				if (!followsEnd || shiftMm === 0) return run;
				const shift = (module: PlacedModule) => ({ ...module, xMm: module.xMm + shiftMm });
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
	function setWallLength(room: RoomLayout, wallIndex: number, mm: number): RoomLayout {
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
		maxMm: wallsOf(setWallLength(room, wallIndex, 1e6).plan)[wallIndex].lengthMm,
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
							left: sides.left && Math.abs(position.xMm - spread - span.endMm) > touchingMm,
							right:
								sides.right &&
								Math.abs(position.xMm + position.widthMm + spread - span.startMm) >
									touchingMm,
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

	// endPanels — unchanged from the old file (it reads `exposureOf` and `views`).

	/** The worktop square at each active corner: over a corner base unit, or
	 * closing an empty square that a base unit on either wall meets. */
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
				return [{ vertex, sizeMm: unit.widthMm, topMm: occupant.floorHeightMm + occupant.heightMm }];
			}
			for (const run of [vertex, (vertex + 1) % countOf(room)]) {
				const entry = cornerSpans(room, run, "floor").find((c) => c.vertex === vertex);
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
					return [{
						vertex,
						sizeMm: cornerSquareMm(room, vertex, "floor"),
						topMm: meeting.family.floorHeightMm + meeting.family.heightMm,
					}];
				}
			}
			return [];
		});
	}

	/** See the old file's comment on `cornerShutSides` — same reach rule, now
	 * asked at every active corner rather than the one. */
	function cornerShutSides(room: RoomLayout): Map<string, HingeSide> {
		const shut = new Map<string, HingeSide>();
		const backReach = Math.max(0, -Math.cos(OVERLAY_OPEN_RAD));
		for (let vertex = 0; vertex < countOf(room); vertex++) {
			if (!isActiveCorner(room, vertex)) continue;
			const sides = [
				{ run: vertex, atStart: false },
				{ run: (vertex + 1) % countOf(room), atStart: true },
			];
			for (const row of ["floor", "wall"] as const) {
				const facing = [];
				for (const { run, atStart } of sides) {
					const view = runView(room, run);
					const lengthMm = view.wallWidthMm;
					const distanceOf = (p: Positioned) =>
						atStart ? p.xMm : lengthMm - (p.xMm + p.widthMm);
					let nearest: Positioned | null = null;
					for (const p of wall.positionsOf(view, row)) {
						if (p.placed.rotationDeg) continue;
						if (!nearest || distanceOf(p) < distanceOf(nearest)) nearest = p;
					}
					if (!nearest) continue;
					const leafMm = nearest.widthMm / (nearest.family.geometry?.doorLeaves || 1);
					const dMm = distanceOf(nearest);
					const bottomMm = wall.floorHeightMmOf(nearest, view);
					facing.push({
						position: nearest,
						side: (atStart ? "left" : "right") as HingeSide,
						upMm: [bottomMm, bottomMm + nearest.family.heightMm] as const,
						alongMm: [dMm - leafMm * backReach, dMm + leafMm] as const,
						outMm: [nearest.family.depthMm, nearest.family.depthMm + leafMm] as const,
					});
				}
				if (facing.length < 2) continue;
				const [a, b] = facing;
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
		if (isCorner(family)) return placeCorner(room, familyId, cornerVertexFor(room, run), id);
		if (run >= room.runs.length) return room;
		const view = wall.addModule(runView(room, run), familyId, xMm, id, widthMm);
		if (!wall.isClear(view)) return room;
		const placed = withRun(room, run, view);
		if (placed === room) return room;
		// The first cabinet on a second wall is what switches a corner on.
		const next = cascadeAll(placed);
		return allClear(next) ? next : room;
	}

	function fits(room: RoomLayout, familyId: string, widthMm?: number, run = 0): boolean {
		const family = familyIn(catalogue, familyId);
		if (!family) return false;
		if (isCorner(family)) return placeCorner(room, familyId, cornerVertexFor(room, run), "probe") !== room;
		// Probed through `addModule`, because a cabinet that fits the bare wall
		// can still be refused by the corner it switches on.
		return addModule(room, familyId, nearCornerMm(room, run), "probe", widthMm, run) !== room;
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
				.map((corner) => ({ ...corner, floor: keep(corner.floor), wall: keep(corner.wall) }))
				.filter((corner) => corner.floor || corner.wall),
		};
	}

	const runExtentMm = (room: RoomLayout, run = 0): number =>
		run < room.runs.length ? wall.runExtentMm(fromCorner(room, run)) : 0;

	const closeGaps = (room: RoomLayout) =>
		room.runs.reduce((next, _, run) => {
			const packed = wall.closeGaps(fromCorner(next, run));
			if (!packsFromEnd(next, run)) return withRun(next, run, packed);
			const L = packed.wallWidthMm;
			return withRun(next, run, {
				...packed,
				floor: packed.floor.map(mirrorModule(L)),
				wall: packed.wall.map(mirrorModule(L)),
			});
		}, room);

	return {
		// positionsOf, rowEndMm, freeSpans, offsetsOf — unchanged.
		allPositions: (room: RoomLayout): Positioned[] => [
			...views(room).flatMap((view) => wall.allPositions(view)),
			...cornerPositions(room),
		],
		runExtentMm,
		fits,
		addModule,
		widthOptionsFor: (room: RoomLayout, id: string) => {
			const run = runIndexOf(room, id);
			if (run >= 0) return wall.widthOptionsFor(runView(room, run), id);
			const unit = cornerPositions(room).find((p) => p.placed.id === id);
			return unit
				? [{ widthMm: unit.widthMm, priceRm: unit.family.sizes[0].priceRm, fits: true }]
				: [];
		},
		// setGap … swapWithNeighbour via inRunOf — unchanged.
		removeModules,
		removeModule: (room: RoomLayout, id: string) => removeModules(room, [id]),
		closeGaps,
		// setHangingHeight, setWallToCeiling, setBaseSkirting, setCeilingHeight,
		// hangingHeightMmOf, floorHeightMmOf, flushWallToTallTops, overhangMm,
		// overhangingIds, isClear, skirtingSpans — unchanged.
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
```

Where the block above says "unchanged", paste the old entries exactly — they only call `runView`, `views`, `pooled`, `inRunOf` and `setting`, which keep their names.

- [ ] **Step 4: Run the room tests**

Run: `pnpm vitest run src/lib/planner/__tests__/room.test.ts src/lib/planner/__tests__/floorplan.test.ts src/lib/planner/__tests__/reserved.test.ts`
Expected: PASS. If a cascade expectation is off by the `spreadMm` of a turned cabinet, the fixture is wrong, not the engine — none of these fixtures turn a cabinet except "ignores a turned cabinet".

- [ ] **Step 5: Pricing — every corner's worktop, and the flush-end change**

`src/lib/planner/pricing.ts`, end of `worktopFt`:

```ts
	// Each square where two runs meet is one piece of worktop, counted once.
	const cornersMm = engine
		.cornerWorktops(layout)
		.reduce((total, square) => total + square.sizeMm, 0);
	return ftOf(mm + cornersMm);
```

`src/lib/planner/__tests__/pricing.test.ts`:

1. Remove `setWallToWall` from the import list.
2. Replace the two tests "charges nothing once the run is enclosed and unbroken" and "costs less enclosed than open, by exactly the two buried ends" with:

```ts
	it("charges nothing for a run built wall to wall", () => {
		let run = addModule(setWallWidth(empty(), 1800), "base-cabinet", 0, "b1", 900);
		run = addModule(run, "base-cabinet", 900, "b2", 900);
		expect(price(run).endPanelCount).toBe(0);
		expect(price(run).categories.some((c) => c.id === "endPanels")).toBe(false);
	});

	it("charges the end that stands clear of the wall", () => {
		// Every room has walls now, so the left end, flush with one, is buried;
		// the right end stops 600 short of the other and is clad.
		let run = addModule(setWallWidth(empty(), 2400), "base-cabinet", 0, "b1", 900);
		run = addModule(run, "base-cabinet", 900, "b2", 900);
		expect(price(run).endPanelCount).toBe(1);
	});
```

3. In "clads every exposed side, and says how many", the run starts flush with the left wall, so that end is now buried: `4` → `3` in both `endPanelCount` and `{ count: 4 }`, and update the comment to "3 sides: the floor run's right end, and the lone wall unit's two, which hangs clear of both walls". Check the fixture: if the lone wall unit sits at `x = 0`, its left side is buried too and the figure is `2` — use whatever the fixture gives and say so in the comment.
4. In "prices a tall end above a wall end", both cabinets sit at `x = 0`: the tall one now wears one panel. `RATES.endPanelTallRm * 2` → `RATES.endPanelTallRm * 1`. The `toBeGreaterThan` comparison still holds.
5. Replace the `lWithBases` helper in "an L-shaped room":

```ts
	const lWithBases = () => {
		let room = emptyRoom(4200);
		room = rooms.addModule(room, "base-cabinet", 0, "m", 600);
		// The left wall, run 3: its corner with the back wall is its far end.
		return rooms.addModule(room, "base-cabinet", 3000, "s", 600, 3);
	};
```

The two tests in that block keep their expectations (`600 + 600 + 607`, and `600 + 600 + 900` with the corner unit).

Then run `pnpm vitest run src/lib/planner`. Any other failure must be the same cause — a cabinet flush with a side wall at `x = 0` or at the wall's end — and gets the same treatment: fix the expected number, with a comment naming the buried end. A failure with any other cause is a bug in Step 3.

- [ ] **Step 6: Run the planner suite**

Run: `pnpm vitest run src/lib/planner`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src/lib/planner
git add src/lib/planner
git commit -m "feat(planner): a room is a floor plan with a run on every wall

Corner squares switch on when both walls meeting at an inside corner
hold cabinets. Every room has walls all round, so a cabinet flush with
a side wall no longer wears an end panel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Orders — schema v3, migrations, validation

**Files:**
- Modify: `src/lib/orders/layoutSchema.ts`
- Modify: `src/lib/orders/validate.ts`
- Test: `src/lib/orders/__tests__/orders.test.ts` (the "an L-shaped order", "roomLayoutSchema" and "orderDesignSchema" blocks)

**Interfaces:**
- Consumes: `planIsValid`, `vertexKind`, `wallsOf` (Task 1); `asRoom`, `RoomLayout`, `CornerUnits`, `Run` (Task 3).
- Produces: `ORDER_DESIGN_VERSION = 3`; `roomLayoutSchema` (v3); `orderDesignSchema` accepting versions 1, 2 and 3, always yielding `{ schemaVersion: 3, layout: RoomLayout }`; `plannerLayoutSchema` unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the three blocks named above with:

```ts
describe("an L-shaped order", () => {
	const rooms = roomEngine(catalogue);
	const lKitchen = () => {
		const width = inKitchen.sizes[0].widthMm;
		let room = rooms.addModule(emptyRoom(4200), inKitchen.id, 0, "m", width);
		room = rooms.addModule(room, inKitchen.id, 3600, "s", width, 3);
		return rooms.addModule(room, "corner-base", 0, "c");
	};
	const checkRoom = (room: ReturnType<typeof lKitchen>) =>
		validateOrder(room, "kitchen", finishId, catalogue);

	it("accepts an L the planner built", () => {
		expect(checkRoom(lKitchen())).toEqual({ ok: true });
	});

	it("refuses a corner unit standing in a run", () => {
		const room = structuredClone(lKitchen());
		const unit = room.corners[0].floor;
		if (!unit) throw new Error("fixture lost its corner");
		room.corners = [];
		room.runs[0].floor.push({ ...unit, xMm: 2000 });
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit", moduleId: "c" });
	});

	it("refuses an ordinary cabinet in the corner slot", () => {
		const room = structuredClone(lKitchen());
		const unit = room.corners[0].floor;
		if (!unit) throw new Error("fixture lost its corner");
		room.corners[0].floor = { ...unit, familyId: inKitchen.id, widthMm: inKitchen.sizes[0].widthMm };
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit", moduleId: "c" });
	});

	it("refuses a turned cabinet whose footprint reaches into the corner", () => {
		const room = structuredClone(lKitchen());
		room.runs[0].floor[0].rotationDeg = 45;
		expect(rooms.widthOptionsFor(room, "m")[0]?.fits).toBe(true);
		expect(checkRoom(room)).toEqual({ ok: false, problem: "does_not_fit" });
	});

	it("refuses a cabinet pushed into the corner square", () => {
		const room = structuredClone(lKitchen());
		room.runs[0].floor[0].xMm = 0;
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit" });
	});

	it("refuses a room outside its template's limits", () => {
		const room = structuredClone(lKitchen());
		room.plan = { template: "rect", widthMm: 50_000, depthMm: 3600 };
		expect(checkRoom(room)).toMatchObject({ problem: "out_of_range" });
	});
});

describe("roomLayoutSchema", () => {
	const l = {
		...emptyRoom(5500),
		plan: {
			template: "l" as const,
			widthMm: 5500,
			depthMm: 5075,
			notchWidthMm: 1500,
			notchDepthMm: 3000,
			mirror: false,
		},
		runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
	};

	it("accepts a room the planner made", () => {
		expect(roomLayoutSchema.safeParse(emptyRoom(4200)).success).toBe(true);
		expect(roomLayoutSchema.safeParse(l).success).toBe(true);
	});

	it("refuses a run count that is not the wall count", () => {
		const straight = emptyRoom(4200);
		expect(
			roomLayoutSchema.safeParse({ ...straight, runs: straight.runs.slice(0, 2) }).success,
		).toBe(false);
	});

	it("refuses a corner unit at an outside corner, and two at one corner", () => {
		const slot = { floor: null, wall: null };
		expect(roomLayoutSchema.safeParse({ ...l, corners: [{ vertex: 2, ...slot }] }).success).toBe(false);
		expect(
			roomLayoutSchema.safeParse({ ...l, corners: [{ vertex: 3, ...slot }, { vertex: 3, ...slot }] }).success,
		).toBe(false);
	});

	it("refuses a notch that leaves no room", () => {
		expect(
			roomLayoutSchema.safeParse({ ...l, plan: { ...l.plan, notchWidthMm: 5400 } }).success,
		).toBe(false);
	});
});

describe("orderDesignSchema", () => {
	it("reads an order placed before L-shapes as a rectangle's back wall", () => {
		const layout = twoCabinets();
		const parsed = orderDesignSchema.parse({ schemaVersion: 1, layout });
		expect(parsed.schemaVersion).toBe(3);
		expect(parsed.layout.plan).toEqual({ template: "rect", widthMm: 4200, depthMm: 3600 });
		expect(parsed.layout.runs[0]).toEqual({ floor: layout.floor, wall: layout.wall });
		expect(parsed.layout.corners).toEqual([]);
	});

	it("reads a version-2 L onto the same walls", () => {
		const layout = twoCabinets();
		const side = [{ ...layout.floor[0], id: "s", xMm: 1000 }];
		const unit = { ...layout.floor[0], id: "c", familyId: "corner-base", xMm: 55, rotationDeg: 270 };
		const v2 = (sideOf: "left" | "right") => ({
			schemaVersion: 2,
			layout: {
				...layout,
				runs: [{ floor: layout.floor, wall: [] }, { floor: side, wall: [] }],
				corner: { side: sideOf, floor: unit, wall: null },
			},
		});

		const left = orderDesignSchema.parse(v2("left")).layout;
		expect(left.runs[3].floor).toEqual(side);
		expect(left.corners).toEqual([{ vertex: 3, floor: expect.not.objectContaining({ rotationDeg: 270 }), wall: null }]);

		const right = orderDesignSchema.parse(v2("right")).layout;
		expect(right.runs[1].floor).toEqual(side);
		expect(right.corners[0].vertex).toBe(0);
		expect("wallToWall" in right).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/orders`
Expected: FAIL — `schemaVersion` is 2, `corners` undefined.

- [ ] **Step 3: Rewrite `src/lib/orders/layoutSchema.ts`**

```ts
import { z } from "zod";
import { planIsValid, vertexKind, wallsOf } from "@/lib/planner/floorplan";
import type { PlacedModule, PlannerLayout } from "@/lib/planner/layout";
import { asRoom, type CornerUnits, type RoomLayout, type Run } from "@/lib/planner/room";

/**
 * The layout document as it arrives from a customer's browser at checkout —
 * the zod twin of the planner's types. `satisfies` keeps the two from drifting.
 * Zod strips unknown keys, so nothing a client adds rides into the database.
 */
const placedModuleSchema = z.object({
	id: z.string().min(1).max(64),
	familyId: z.string().min(1).max(128),
	widthMm: z.number().positive().max(10_000),
	doorStyleId: z.string().min(1).max(128).nullable(),
	hinge: z.enum(["left", "right"]),
	xMm: z.number().min(0).max(20_000),
	hangAtMm: z.number().min(0).max(10_000).optional(),
	rotationDeg: z.number().int().min(-360).max(360).optional(),
});

const settings = {
	ceilingHeightMm: z.number().positive(),
	hangingHeightMm: z.number().min(0),
	wallToCeiling: z.boolean(),
	baseSkirting: z.boolean(),
};

/** The fields a room had before it had a floor plan (design v1 and v2). */
const legacySettings = {
	...settings,
	wallWidthMm: z.number().positive(),
	roomDepthMm: z.number().positive(),
	wallToWall: z.boolean(),
};

const rowsSchema = {
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
};

/** One wall, as orders stored it before L-shapes (design v1). */
export const plannerLayoutSchema = z.object({
	...legacySettings,
	...rowsSchema,
}) satisfies z.ZodType<PlannerLayout>;

const runSchema = z.object(rowsSchema);

/** One wall or an L, as orders stored it before room shapes (design v2). */
const roomLayoutV2Schema = z
	.object({
		...legacySettings,
		runs: z.array(runSchema).min(1).max(2),
		corner: z
			.object({
				side: z.enum(["left", "right"]),
				floor: placedModuleSchema.nullable(),
				wall: placedModuleSchema.nullable(),
			})
			.nullable(),
	})
	.refine((room) => (room.runs.length === 2) === (room.corner !== null), {
		message: "a side wall and a corner come together",
	});

const planSchema = z
	.union([
		z.object({ template: z.literal("rect"), widthMm: z.number(), depthMm: z.number() }),
		z.object({
			template: z.literal("l"),
			widthMm: z.number(),
			depthMm: z.number(),
			notchWidthMm: z.number(),
			notchDepthMm: z.number(),
			mirror: z.boolean(),
		}),
	])
	// The editor's own clamp, as a yes or no: one set of limits, not two.
	.refine(planIsValid, { message: "a room outside its template's limits" });

/** The room document: a floor plan, a run per wall, corner units by vertex. */
export const roomLayoutSchema = z
	.object({
		...settings,
		plan: planSchema,
		runs: z.array(runSchema).min(4).max(6),
		corners: z
			.array(
				z.object({
					vertex: z.number().int().min(0),
					floor: placedModuleSchema.nullable(),
					wall: placedModuleSchema.nullable(),
				}),
			)
			.max(6),
	})
	.refine((room) => room.runs.length === wallsOf(room.plan).length, {
		message: "one run per wall",
	})
	.refine(
		(room) =>
			room.corners.every(
				(c) => c.vertex < room.runs.length && vertexKind(room.plan, c.vertex) === "inside",
			),
		{ message: "a corner unit stands only in an inside corner" },
	)
	.refine((room) => new Set(room.corners.map((c) => c.vertex)).size === room.corners.length, {
		message: "one slot per corner",
	}) satisfies z.ZodType<RoomLayout>;

/**
 * What an order stores. The version is the promise that an order placed today
 * still reads after the layout changes shape. Versions 1 and 2 are read as a
 * rectangle, so every reader downstream only ever sees version 3.
 */
export const ORDER_DESIGN_VERSION = 3;

export type OrderDesign = {
	schemaVersion: typeof ORDER_DESIGN_VERSION;
	layout: RoomLayout;
};

/** A v2 room onto a rectangle. The v2 side wall was the left wall for a left
 * L and the right wall for a right one; the winding matches, so `xMm` carries
 * over. A corner unit's stored turn was never trusted and is dropped. */
function fromV2(v2: z.infer<typeof roomLayoutV2Schema>): RoomLayout {
	const { wallWidthMm, roomDepthMm, wallToWall: _gone, runs, corner, ...rest } = v2;
	const empty = (): Run => ({ floor: [], wall: [] });
	const next: Run[] = [runs[0], empty(), empty(), empty()];
	const corners: CornerUnits[] = [];
	if (corner && runs[1]) {
		next[corner.side === "left" ? 3 : 1] = runs[1];
		const bare = (unit: PlacedModule | null): PlacedModule | null => {
			if (!unit) return null;
			const { rotationDeg: _turn, ...kept } = unit;
			return kept;
		};
		if (corner.floor || corner.wall) {
			corners.push({
				vertex: corner.side === "left" ? 3 : 0,
				floor: bare(corner.floor),
				wall: bare(corner.wall),
			});
		}
	}
	return {
		...rest,
		plan: { template: "rect", widthMm: wallWidthMm, depthMm: roomDepthMm },
		runs: next,
		corners,
	};
}

export const orderDesignSchema = z.union([
	z.object({ schemaVersion: z.literal(3), layout: roomLayoutSchema }),
	z
		.object({ schemaVersion: z.literal(2), layout: roomLayoutV2Schema })
		.transform(({ layout }) => ({ schemaVersion: 3 as const, layout: fromV2(layout) })),
	z
		.object({ schemaVersion: z.literal(1), layout: plannerLayoutSchema })
		.transform(({ layout }) => ({ schemaVersion: 3 as const, layout: asRoom(layout) })),
]);
```

- [ ] **Step 4: `src/lib/orders/validate.ts`**

Imports: drop `ROOM_DEPTH_LIMITS` and `WALL_LIMITS`; add `import { planIsValid } from "@/lib/planner/floorplan";`.

Range check:

```ts
	if (
		!planIsValid(layout.plan) ||
		!within(layout.ceilingHeightMm, CEILING_LIMITS) ||
		!within(layout.hangingHeightMm, WALL_HANG_LIMITS)
	) {
		return { ok: false, problem: "out_of_range" };
	}
```

The corner rows:

```ts
		...layout.corners.flatMap((corner) =>
			(["floor", "wall"] as const).flatMap((row) => {
				const placed = corner[row];
				return placed ? [{ placed, row, corner: true }] : [];
			}),
		),
```

Update the comment above `isClear` to "A cabinet inside a corner square, or a square grown into a run, is not a design anyone can fit."

- [ ] **Step 5: Find other writers of the version**

Run: `grep -rn "ORDER_DESIGN_VERSION\|schemaVersion: 2\|roomLayoutSchema\|\.corner\b" src --include=*.ts --include=*.tsx | grep -v __tests__`
Every hit outside `layoutSchema.ts` must read the constant or the parsed layout, never a literal `2` or `layout.corner`. Fix any that do. (The checkout route should already write `ORDER_DESIGN_VERSION`.)

- [ ] **Step 6: Run the tests**

Run: `pnpm test`
Expected: PASS, whole suite.

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src/lib/orders
git add src/lib/orders
git commit -m "feat(orders): design v3, reading v1 and v2 orders as rectangles

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The scene — polygon room, wall frames, wall picking, drop, camera

No unit tests: this is three.js wiring over the tested `floorplan.ts`. Verification is typecheck-free-of-scene-errors plus the browser pass in Task 6.

**Files:**
- Rewrite: `src/components/planner/Room.tsx`
- Modify: `src/components/planner/PlannerScene.tsx`
- Create: `src/components/planner/WallLengths.tsx`
- Modify: `src/components/planner/PositionDimensions.tsx` (export `EditableFigure`)

**Interfaces:**
- Consumes: `wallsOf`, `frameOf`, `outlineOf`, `toLocalMm`, `toWorldMm`, `nearestWall`, `WallFrame`, `FloorPlan` (Task 1); `cornerSpans`, `cornerAt`, `runView`, `withRun`, engine `cornerPositionsOf`, `cornerWorktops`, `cornerShutSides`, `exposureOf` (Task 3).
- Produces (`PlannerScene` default export props, used by Task 6):
  - `PlannerView = "3d" | "elevation" | "plan"` (the `"side"` view is gone — elevation now faces whichever wall is targeted)
  - new props `targetRun: number`, `onWallPickAction?: (run: number) => void`, `onWallLengthAction?: (wall: number, mm: number) => void`
  - `pickerRef: RefObject<((clientX: number, clientY: number) => { run: number; xMm: number } | null) | null>`

- [ ] **Step 1: `Room.tsx`**

Keep `FLOOR_TILE_M`, `FLOOR_COLOR`, `floorTexture`, and the `SCRIBE` comment (reworded: the scribe is now applied by pushing the whole outline out by `WALL_GAP_MM`). Replace the component:

```tsx
import { useMemo } from "react";
import { RepeatWrapping, Shape, SRGBColorSpace, type Texture, TextureLoader, Vector2 } from "three";
import { WALL_GAP_MM } from "@/lib/planner/catalogue";
import { type FloorPlan, outlineOf } from "@/lib/planner/floorplan";

const m = (mm: number) => mm / 1000;
const WALL_COLOR = "#e8e6e1";
/** The wall the add menu builds on: tinted just enough to find. */
const TARGET_WALL_COLOR = "#dde7e0";

/**
 * Cutaway room: the floor plan's floor, and one single-sided plane per wall
 * facing into the room. A wall seen from behind simply vanishes, so whichever
 * walls stand between the camera and the room drop out on their own — the
 * whole cutaway effect, for any outline, with no clipping planes.
 *
 * Drawn on the outline pushed out by the scribe gap, so a carcass pushed hard
 * into a corner never shares a plane with the wall behind it.
 */
export function Room({
	plan,
	height,
	targetWall,
	onWallPick,
}: {
	plan: FloorPlan;
	height: number;
	targetWall: number;
	/** Absent while measuring: a tap then picks a point, not a wall. */
	onWallPick?: (wall: number) => void;
}) {
	const outline = useMemo(() => outlineOf(plan, WALL_GAP_MM), [plan]);
	// The floor lies in the shape's XY plane, turned down onto XZ: plan z is
	// shape −y. UVs are the shape's own coordinates, in metres.
	const floorShape = useMemo(
		() => new Shape(outline.map((p) => new Vector2(m(p.xMm), -m(p.zMm)))),
		[outline],
	);
	const floorMap = useMemo(() => {
		const map = floorTexture().clone();
		map.repeat.set(1 / FLOOR_TILE_M.x, 1 / FLOOR_TILE_M.z);
		map.needsUpdate = true;
		return map;
	}, []);

	return (
		<group>
			<mesh rotation={[-Math.PI / 2, 0, 0]}>
				<shapeGeometry args={[floorShape]} />
				<meshStandardMaterial map={floorMap} color={FLOOR_COLOR} roughness={0.7} />
			</mesh>
			{outline.map((start, i) => {
				const end = outline[(i + 1) % outline.length];
				const dx = end.xMm - start.xMm;
				const dz = end.zMm - start.zMm;
				return (
					<mesh
						// A wall's place in the outline is its identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						key={i}
						position={[m((start.xMm + end.xMm) / 2), height / 2, m((start.zMm + end.zMm) / 2)]}
						rotation={[0, Math.atan2(dz === 0 ? 0 : -dz, dx), 0]}
						onClick={
							onWallPick &&
							((e) => {
								// A drag that ended here was an orbit, not a tap.
								if (e.delta > 4) return;
								e.stopPropagation();
								onWallPick(i);
							})
						}
					>
						<planeGeometry args={[m(Math.hypot(dx, dz)), height]} />
						<meshStandardMaterial
							color={i === targetWall ? TARGET_WALL_COLOR : WALL_COLOR}
							roughness={0.95}
						/>
					</mesh>
				);
			})}
		</group>
	);
}
```

The plank rows no longer start whole at the back wall (the old `offset` trick assumed a rectangle). Accepted: nobody counts floor planks.

- [ ] **Step 2: Frames instead of yaws in `PlannerScene.tsx`**

Imports: add `import { frameOf, nearestWall, toLocalMm, toWorldMm, type WallFrame, wallsOf } from "@/lib/planner/floorplan";`; from `@/lib/planner/room` import `cornerAt, cornerSpans, type RoomLayout, runView, withRun` (drop `runYawRad`); from `@/lib/planner/layout` add `type Span`.

Replace `localRay` and `turnMm` (and the `UNTURN` scratch comment) with:

```ts
const UNTURN = new Matrix4();
const UNMOVE = new Matrix4();

/**
 * A world ray expressed in a run's own frame: undo the frame's move, then its
 * turn. A rectangle's runs are only turned, and the back wall neither, so that
 * case returns the ray as is. The result is a shared scratch — read it straight
 * away, never keep it.
 */
function localRay(ray: Ray, frame: WallFrame): Ray {
	if (frame.yawRad === 0 && frame.xMm === 0 && frame.zMm === 0) return ray;
	UNTURN.makeRotationY(-frame.yawRad).multiply(
		UNMOVE.makeTranslation(-m(frame.xMm), 0, -m(frame.zMm)),
	);
	return LOCAL_RAY.copy(ray).applyMatrix4(UNTURN);
}
```

Then in `Run`:
- prop `yaw: number` → `frame: WallFrame` (doc: "Where this run's group stands — see `localRay`.")
- every `localRay(x, yaw)` → `localRay(x, frame)` (three sites: `beginDrag`, `beginRotate`, the window drag move)
- `turnMm(p, -yaw)` → `toLocalMm(p, frame)` (two sites: `snapAt`, `beginDrag`)
- `turnMm(p, yaw)` → `toWorldMm(p, frame)` (two sites in `snapAt`)

Confirm with `grep -n "turnMm\|\byaw\b" src/components/planner/PlannerScene.tsx` — nothing left.

- [ ] **Step 3: Corners per run in `Run`**

Replace the props `cornerFilled: { floor: boolean; wall: boolean }` and `cornerWorktop` doc with:

```ts
	/** The corner squares along this run that hold a unit, per row. A filled
	 * square is a neighbour a door beside it must not swing into. */
	filledSpans: Record<"floor" | "wall", Span[]>;
	/** The worktop square at this run's start corner, if it has one. */
	cornerWorktop: { sizeMm: number; topMm: number } | null;
```

Update the `corners` prop doc: "Corner units at this run's start. Selectable, never dragged."

In the `sideGaps` memo:

```ts
		const walls = {
			wallWidthMm: layout.wallWidthMm,
			left: layout.endWalls?.left ?? layout.wallToWall,
			right: layout.endWalls?.right ?? layout.wallToWall,
		};
		const gaps = new Map<string, SideGaps>();
		for (const row of ["floor", "wall"] as const) {
			const positions = [
				...positionsOf(layout, row),
				...corners.filter((corner) => (corner.family.kind === "wall") === (row === "wall")),
			];
			positions.forEach((position, i) => {
				const own = sideGapsMm(positions, i, walls);
				const end = position.xMm + position.widthMm;
				let { left, right } = own;
				for (const span of filledSpans[row]) {
					if (span.endMm <= position.xMm + 1) left = Math.min(left, position.xMm - span.endMm);
					if (span.startMm >= end - 1) right = Math.min(right, Math.max(0, span.startMm - end));
				}
				gaps.set(position.placed.id, { left, right });
			});
		}
		return gaps;
	}, [layout, positionsOf, corners, filledSpans]);
```

Corner worktop: it now always sits at this run's start, so
`{cornerWorktop && (` and the x position `m(cornerWorktop.sizeMm / 2 - runWidthMm / 2)`.

- [ ] **Step 4: The scene root**

In `PlannerScene` (the default export), add the three props from **Produces**, drop `"side"` from `PlannerView`, and replace the `runs`/`corners`/`cornerFilled`/`cornerWorktop`/`pickerRuns` memos with:

```ts
	const walls = useMemo(() => wallsOf(layout.plan), [layout.plan]);
	const runs = useMemo(
		() => layout.runs.map((_, i) => ({ view: runView(layout, i), frame: frameOf(walls[i]) })),
		[layout, walls],
	);
	const count = layout.runs.length;
	const cornersByRun = useMemo(
		() => layout.runs.map((_, i) => rooms.cornerPositionsOf(layout, i)),
		[rooms, layout],
	);
	const filledByRun = useMemo(
		() =>
			layout.runs.map((_, i) => ({
				floor: cornerSpans(layout, i, "floor").filter((c) => cornerAt(layout, c.vertex)?.floor).map((c) => c.span),
				wall: cornerSpans(layout, i, "wall").filter((c) => cornerAt(layout, c.vertex)?.wall).map((c) => c.span),
			})),
		[layout],
	);
	const worktops = useMemo(() => rooms.cornerWorktops(layout), [rooms, layout]);
	const target = runs[Math.min(targetRun, count - 1)];
```

`main`/`runWidthMm` become the target's: `const runWidthMm = target.view.wallWidthMm;` and every later `main` → `target.view`.

`<Room … />`:

```tsx
			<Room
				plan={layout.plan}
				height={m(layout.ceilingHeightMm)}
				targetWall={targetRun}
				onWallPick={measureMode ? undefined : onWallPickAction}
			/>
```

The runs:

```tsx
			{runs.map(({ view, frame }, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a run's index is its wall
				<group key={i} position={[m(frame.xMm), 0, m(frame.zMm)]} rotation={[0, frame.yawRad, 0]}>
					<Run
						layout={view}
						frame={frame}
						corners={cornersByRun[i]}
						filledSpans={filledByRun[i]}
						cornerWorktop={worktops.find((w) => (w.vertex + 1) % count === i) ?? null}
						/* …and every other prop exactly as before: catalogue, engine,
						   finishHex, …, onLayoutChange (still `withRun(roomRef.current, i, next)`). */
					/>
					{/* PositionDimensions — unchanged */}
				</group>
			))}
			{view === "plan" && onWallLengthAction && (
				<WallLengths
					plan={layout.plan}
					onPickAction={onWallPickAction}
					onLengthAction={onWallLengthAction}
				/>
			)}
```

Delete `NO_CORNERS` if nothing else uses it.

- [ ] **Step 5: `DropPicker` returns a wall**

```tsx
function DropPicker({
	plan,
	pickerRef,
}: {
	plan: FloorPlan;
	pickerRef: React.RefObject<
		((clientX: number, clientY: number) => { run: number; xMm: number } | null) | null
	>;
}) {
	const camera = useThree((s) => s.camera);
	const gl = useThree((s) => s.gl);

	useEffect(() => {
		pickerRef.current = (clientX, clientY) => {
			const rect = gl.domElement.getBoundingClientRect();
			const point = new Vector3(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1,
				0.5,
			).unproject(camera);
			const direction = point.sub(camera.position).normalize();
			// Looking level along the floor there is no floor point to read.
			if (Math.abs(direction.y) < 1e-6) return null;
			const t = -camera.position.y / direction.y;
			// The floor point, in plan millimetres — the scene's world axes.
			return nearestWall(plan, {
				xMm: (camera.position.x + direction.x * t) * 1000,
				zMm: (camera.position.z + direction.z * t) * 1000,
			});
		};
		return () => {
			pickerRef.current = null;
		};
	}, [camera, gl, plan, pickerRef]);

	return null;
}
```

Import `type FloorPlan` from `floorplan.ts`, and render it as `<DropPicker plan={layout.plan} pickerRef={pickerRef} />`.

- [ ] **Step 6: Camera framing follows the target wall**

`FitCamera` props: replace `cornerSide` with `frame: WallFrame`, add `planWidthMm`, `planDepthMm`. Inside the effect, replace the `centre`, `radius` and `direction` blocks:

```ts
		const { runWidthMm, roomDepthMm, ceilingHeightMm, aspect, frame, planWidthMm, planDepthMm } =
			framing.current;
		const width = m(runWidthMm);
		const height = m(ceilingHeightMm);
		const depth = m(roomDepthMm);
		const halfFovV = (camera.fov * Math.PI) / 360;
		const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
		let centre: Vector3;
		let direction: Vector3;
		let radius: number;
		if (view === "plan") {
			// The whole floor plan, from above, back wall at the top.
			centre = new Vector3(0, 0, 0);
			direction = VIEW_DIRECTION.plan;
			radius = Math.hypot(m(planWidthMm), m(planDepthMm)) / 2;
		} else {
			// Framed in the target wall's own frame, then carried into the room's.
			const c = toWorldMm({ x: 0, y: ceilingHeightMm / 2.2, z: 0 }, frame);
			centre = new Vector3(m(c.x), m(c.y), m(c.z));
			direction = VIEW_DIRECTION[view].clone().applyAxisAngle(new Vector3(0, 1, 0), frame.yawRad);
			radius =
				view === "elevation"
					? Math.hypot(width, height) / 2
					: Math.hypot(width, height, depth) / 2;
		}
		const distance = (radius / Math.sin(Math.min(halfFovV, halfFovH))) * 0.95;
```

`framing.current` gains `frame, planWidthMm, planDepthMm`. The effect's dependency list: `[view, refitKey, camera, controls, elevationWall]` where

```ts
	// Elevation is a drawing of one wall, so tapping another wall redraws it.
	// The 3D view keeps the customer's framing until they ask for a reset.
	const elevationWall =
		view === "elevation" ? `${frame.yawRad}:${frame.xMm}:${frame.zMm}` : "";
```

Delete `SIDE_RIGHT_DIRECTION` and `VIEW_DIRECTION.side`.

- [ ] **Step 7: The pan puck, in the target wall's frame**

`PanGizmo` props: replace `cornerSide` with `frame: WallFrame`; keep a `frameRef` like `boundsRef`. Delete `side` from `PAN_AXES` and `panAnchor`'s `view === "side"` branch. Replace `panPlane`:

```ts
/** The surface the puck slides on: the floor, or in elevation the plane of
 * the targeted wall's run. */
const panPlane = (target: Vector3Type, view: PlannerView, yawRad: number) => {
	if (view !== "elevation") return new Plane(new Vector3(0, 1, 0), -PUCK_LIFT);
	const normal = new Vector3(Math.sin(yawRad), 0, Math.cos(yawRad));
	return new Plane(normal, -normal.dot(target));
};
```

Add, inside the component:

```ts
	/** A world point the puck was dragged to, masked to this view's axes and
	 * clamped to the room — both in the target wall's frame, where the axes and
	 * `clampPanTarget`'s box mean something — and carried back out. */
	const panTo = useCallback(
		(point: Vector3Type, anchor: Vector3Type, out: Vector3Type) => {
			const f = frameRef.current;
			const axes = PAN_AXES[view];
			const p = toLocalMm({ x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 }, f);
			const a = toLocalMm({ x: anchor.x * 1000, y: anchor.y * 1000, z: anchor.z * 1000 }, f);
			const clamped = clampPanTarget(
				{ x: axes.x ? p.x : a.x, y: axes.y ? p.y : a.y, z: axes.z ? p.z : a.z },
				boundsRef.current,
			);
			const w = toWorldMm(clamped, f);
			return out.set(m(w.x), m(w.y), m(w.z));
		},
		[view],
	);
```

`release`: `glide.current = panTo(spot.current, controls.target, new Vector3());`
`onMove`: after `hit.add(current.grip)`: `panAnchor(controls.target, view, PUCK_ANCHOR); panTo(hit, PUCK_ANCHOR, spot.current);`
`grab`: `const plane = panPlane(controls.target, view, frameRef.current.yawRad);`
Puck rotation: `view === "elevation" ? [0, frame.yawRad, 0] : [-Math.PI / 2, 0, 0]`. Add `panTo` to the effect and `release` dependency lists.

At the call sites:

```tsx
			<PanGizmo
				bounds={{
					runWidthMm: Math.max(runWidthMm, engine.rowEndMm(target.view, "floor")),
					roomDepthMm: target.view.roomDepthMm,
					ceilingHeightMm: layout.ceilingHeightMm,
					runDepthMm: engine
						.positionsOf(target.view, "floor")
						.reduce((deepest, p) => Math.max(deepest, p.family.depthMm), 0),
				}}
				view={view}
				frame={target.frame}
				refitKey={refitKey}
			/>
			<FitCamera
				runWidthMm={Math.max(runWidthMm, engine.rowEndMm(target.view, "floor"))}
				roomDepthMm={target.view.roomDepthMm}
				ceilingHeightMm={layout.ceilingHeightMm}
				planWidthMm={layout.plan.widthMm}
				planDepthMm={layout.plan.depthMm}
				view={view}
				frame={target.frame}
				refitKey={refitKey}
			/>
```

Also update `lib/planner/camera.ts`'s header comment: "centred on the run" → "in the targeted wall's own frame".

- [ ] **Step 8: Plan-view wall lengths**

In `PositionDimensions.tsx`, `export` `EditableFigure` and `CHIP`.

`src/components/planner/WallLengths.tsx`:

```tsx
"use client";

import { Html } from "@react-three/drei";
import { fill } from "@/lib/copy/fill";
import { type FloorPlan, wallsOf } from "@/lib/planner/floorplan";
import { useCopy } from "./CopyContext";
import { EditableFigure } from "./PositionDimensions";

const m = (mm: number) => mm / 1000;
/** How far inside the room a wall's label sits, clear of the wall itself. */
const INSET_MM = 300;

/**
 * Each wall's length, on the plan, editable in place — the IKEA room editor.
 * Tapping one also makes that wall the one the add menu builds on. The engine
 * clamps whatever is typed, so a wall never shrinks through its cabinets.
 */
export function WallLengths({
	plan,
	onPickAction,
	onLengthAction,
}: {
	plan: FloorPlan;
	onPickAction?: (wall: number) => void;
	onLengthAction: (wall: number, mm: number) => void;
}) {
	const t = useCopy();
	return (
		<>
			{wallsOf(plan).map((wall, i) => (
				<Html
					// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
					key={i}
					position={[
						m((wall.startMm.xMm + wall.endMm.xMm) / 2 + wall.inward.xMm * INSET_MM),
						0.02,
						m((wall.startMm.zMm + wall.endMm.zMm) / 2 + wall.inward.zMm * INSET_MM),
					]}
					center
					zIndexRange={[4, 0]}
				>
					{/* Capture, so the pick happens before the figure stops the
					    event from reaching the scene. */}
					<div onPointerDownCapture={() => onPickAction?.(i)}>
						<EditableFigure
							valueMm={wall.lengthMm}
							label={fill(t.planner.room.wallName, { n: i + 1 })}
							onCommit={(mm) => onLengthAction(i, mm)}
						/>
					</div>
				</Html>
			))}
		</>
	);
}
```

`t.planner.room.wallName` is added in Task 6; until then this file does not typecheck.

- [ ] **Step 9: Commit**

```bash
pnpm biome check --write src/components/planner src/lib/planner/camera.ts
git add src/components/planner src/lib/planner/camera.ts
git commit -m "feat(planner): draw any floor plan and put each run on its wall

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Studio — target wall, shape picker, wall lengths, copy

**Files:**
- Modify: `src/lib/copy/en.ts`, `src/lib/copy/ms.ts`, `src/lib/copy/zh.ts`
- Rewrite: `src/components/planner/studio/RoomPanel.tsx`
- Modify: `src/components/planner/StudioScreen.tsx`
- Modify: `src/app/[lang]/planner/PlannerApp.tsx` (~l.196), `src/components/planner/QuoteScreen.tsx` (~l.298)

**Interfaces:**
- Consumes: Task 3's engine (`setShape`, `setWallLength`, `wallLengthRangeMm`, `cornerVertexFor`), Task 5's `PlannerScene` props.
- Produces: the finished feature. `pnpm typecheck` must pass at the end of this task.

- [ ] **Step 1: Copy**

In each dictionary, under `planner.room`, **delete** `shapeStraight`, `shapeLeft`, `shapeRight`, `shapeRefused`, `sideWallLength`, `roomDepth`, `wallLength`, `narrowWallNote`, `openEnds`, `toWalls`, `runAria`, `noPanelNeededNote`, `panelNeededNote`; under `planner.view` delete `side`; under `planner.panel` delete `sideHint`; under `planner.addCabinets` delete `mainWall`, `sideWall`. Keep `shape`, `shapeLocked` (reworded below), `ceiling`, `fitFree`, `fitOver`, `overhangWarning`, `targetWall`.

Add:

| key | en | ms | zh |
| --- | --- | --- | --- |
| `planner.room.shapeRect` | Rectangle | Segi empat | 矩形 |
| `planner.room.shapeL` | L-shaped | Bentuk L | L 形 |
| `planner.room.shapeLMirror` | L-shaped, mirrored | Bentuk L, bertentangan | L 形（镜像） |
| `planner.room.shapeLocked` (reworded) | Clear every wall but the back wall to change the room's shape. | Kosongkan semua dinding kecuali dinding belakang untuk menukar bentuk bilik. | 清空后墙以外的所有墙面，才能更改房间形状。 |
| `planner.room.wallName` | Wall {n} | Dinding {n} | 墙 {n} |
| `planner.room.wallsHint` | Tap a wall in the room, or a length in the plan view, to change it. | Ketik dinding dalam bilik, atau ukuran dalam pandangan pelan, untuk mengubahnya. | 点按房间中的墙面，或平面图中的尺寸，即可修改。 |
| `planner.addCabinets.targetWallHint` | Adding to wall {n}. Tap another wall in the room to build there. | Menambah ke dinding {n}. Ketik dinding lain dalam bilik untuk membina di sana. | 正在添加到墙 {n}。点按房间中的另一面墙即可在那里布置。 |

Check the placeholder syntax against an existing key that `fill` fills (e.g. `fitFree`) and match it — `{n}` above assumes single braces.

Then: `grep -rnE "shapeStraight|shapeLeft|shapeRight|shapeRefused|sideWallLength|roomDepth\b|wallLength\b|narrowWallNote|openEnds|toWalls|runAria|noPanelNeededNote|panelNeededNote|sideHint|mainWall|sideWall|view\.side" src --include=*.tsx --include=*.ts | grep -v "src/lib/copy/"` — every hit is fixed in the steps below; none may remain at the end.

- [ ] **Step 2: `RoomPanel.tsx`**

```tsx
"use client";

import { fill } from "@/lib/copy/fill";
import { CEILING_LIMITS, type RoomTypeId } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { outlineOf, type RoomShape, reshape, wallsOf } from "@/lib/planner/floorplan";
import type { RoomLayout } from "@/lib/planner/room";
import { useCopy } from "../CopyContext";
import { DimensionField } from "../DimensionField";
import { chip } from "./chrome";

const SHAPES: RoomShape[] = ["rect", "l", "l-mirror"];

/** A shape's outline, drawn from the template itself so the picture can never
 * disagree with the room it makes. Inline SVG, per CLAUDE.md: no WebGL
 * context per thumbnail. */
function ShapeThumb({ shape }: { shape: RoomShape }) {
	const plan = reshape({ template: "rect", widthMm: 3000, depthMm: 3000 }, shape);
	const points = outlineOf(plan).map((p) => `${p.xMm},${p.zMm}`).join(" ");
	return (
		<svg viewBox="-1700 -1700 3400 3400" className="h-8 w-8" aria-hidden="true">
			<polygon points={points} fill="none" stroke="currentColor" strokeWidth={160} />
		</svg>
	);
}

/**
 * The Room panel body: which room, what shape, how long each wall is, and
 * whether the targeted wall's run fits on it.
 */
export function RoomPanel({
	catalogue,
	roomId,
	layout,
	freeMm,
	overhangMm,
	shape,
	reachable,
	wallRanges,
	targetWall,
	onShapeAction,
	onChangeRoomAction,
	onWallLengthAction,
	onTargetWallAction,
	onCeilingAction,
	onOpenDefaultsAction,
}: {
	catalogue: PlannerCatalogue;
	roomId: RoomTypeId;
	layout: RoomLayout;
	/** Wall left over on the targeted wall, negative when its run is longer. */
	freeMm: number;
	overhangMm: number;
	shape: RoomShape;
	/** Which shapes a press would actually reach. */
	reachable: Record<RoomShape, boolean>;
	/** Per wall, the lengths `setWallLength` will actually reach. */
	wallRanges: { minMm: number; maxMm: number }[];
	targetWall: number;
	onShapeAction: (shape: RoomShape) => void;
	onChangeRoomAction: (id: RoomTypeId) => void;
	onWallLengthAction: (wall: number, mm: number) => void;
	onTargetWallAction: (wall: number) => void;
	onCeilingAction: (mm: number) => void;
	onOpenDefaultsAction: () => void;
}) {
	const t = useCopy();
	const shapeLabel: Record<RoomShape, string> = {
		rect: t.planner.room.shapeRect,
		l: t.planner.room.shapeL,
		"l-mirror": t.planner.room.shapeLMirror,
	};

	return (
		<div className="flex flex-col gap-4">
			{/* The room-type chips — copy this block unchanged from the old file. */}

			<div className="flex flex-col gap-1.5">
				<p className="text-[12px] text-neutral-600">{t.planner.room.shape}</p>
				<div className="flex flex-wrap gap-1">
					{SHAPES.map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={shape === option}
							aria-label={shapeLabel[option]}
							title={shapeLabel[option]}
							disabled={option !== shape && !reachable[option]}
							onClick={() => onShapeAction(option)}
							className={`${chip(shape === option)} disabled:cursor-not-allowed disabled:text-neutral-300`}
						>
							<ShapeThumb shape={option} />
						</button>
					))}
				</div>
				{SHAPES.some((option) => option !== shape && !reachable[option]) && (
					<p className="text-[11px] text-neutral-500 leading-4">{t.planner.room.shapeLocked}</p>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<p className="text-[11px] text-neutral-500 leading-4">{t.planner.room.wallsHint}</p>
				{wallsOf(layout.plan).map((wall, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
						key={i}
						onFocusCapture={() => onTargetWallAction(i)}
						className={i === targetWall ? "rounded-lg bg-[#eef3ef] p-1" : "p-1"}
					>
						<DimensionField
							label={fill(t.planner.room.wallName, { n: i + 1 })}
							valueMm={wall.lengthMm}
							minMm={wallRanges[i]?.minMm ?? wall.lengthMm}
							maxMm={wallRanges[i]?.maxMm ?? wall.lengthMm}
							stepMm={50}
							onChangeAction={(mm) => onWallLengthAction(i, mm)}
						/>
					</div>
				))}
			</div>

			<DimensionField
				label={t.planner.room.ceiling}
				valueMm={layout.ceilingHeightMm}
				minMm={CEILING_LIMITS.minMm}
				maxMm={CEILING_LIMITS.maxMm}
				stepMm={50}
				onChangeAction={onCeilingAction}
			/>

			{/* The fit block (fitOver / fitFree, overhangWarning, moreSettings
			    button) — copy unchanged from the old file. */}
		</div>
	);
}
```

Paste the two blocks the comments name from the old file verbatim, and keep its header comment, reworded for walls.

- [ ] **Step 3: `StudioScreen.tsx`**

Imports: from `@/lib/planner/room` import `cornerVertexFor, emptyRoom, nearCornerMm, type RoomLayout, runIndexOf, runView, setDoors, setHinge` (drop `shapeOf`); add `import { type RoomShape, shapeOf } from "@/lib/planner/floorplan";`.

Delete `runModes` and the `PanelToggle` that uses it (the "Run" open-ends/to-walls control). Delete the `hasSide` parameter and the `side` entry from `views`, and the `side` branch in `viewBody`'s hint.

From the `useRoomEngine()` destructure remove `minWallWidthMm`, `minRoomDepthMm`, `setRoomDepth`, `setWallToWall`, `setWallWidth`; add `setWallLength`, `wallLengthRangeMm`.

State:

```ts
	const pickerRef = useRef<
		((x: number, y: number) => { run: number; xMm: number } | null) | null
	>(null);
	// …
	const [view, setView] = useState<PlannerView>("3d");
	// Which wall the add menu builds on. Tapping a wall in the room sets it.
	const [targetRun, setTargetRun] = useState(0);
	// A shape change can leave fewer walls than the index held.
	const run = Math.min(targetRun, layout.runs.length - 1);
```

Replace every use of `shownView` with `view`.

The fit figures:

```ts
	const overhang = overhangMm(layout);
	// The targeted wall: its corner squares are not free wall.
	const targetView = runView(layout, run);
	const cornerMm = (targetView.reserved?.floor ?? []).reduce(
		(total, span) => total + span.endMm - span.startMm,
		0,
	);
	const freeMm = Math.round(
		targetView.wallWidthMm - Math.max(cornerMm, runExtentMm(layout, run)),
	);
	// Every wall with a run on it, from its corner.
	const runMetres = layout.runs
		.map((_, i) => runExtentMm(layout, i))
		.filter((mm) => mm > 0)
		.map((mm) => `${(mm / 1000).toFixed(2)} m`)
		.join(" + ");
```

(Remove `minWallMm`.)

`dropCarcass`:

```ts
	const dropCarcass = (familyId: string, clientX: number, clientY: number) => {
		// Dropped near a wall is dropped on that wall.
		const hit = pickerRef.current?.(clientX, clientY) ?? { run, xMm: 0 };
		track("cabinet_added", { family: familyId, via: "drag" });
		setTargetRun(hit.run);
		setLayoutAction((prev) =>
			addModule(prev, familyId, hit.xMm, undefined, undefined, hit.run),
		);
	};
```

`roomBody`:

```tsx
	const roomBody = (
		<RoomPanel
			catalogue={catalogue}
			roomId={roomId}
			layout={layout}
			freeMm={freeMm}
			overhangMm={overhang}
			shape={shapeOf(layout.plan)}
			reachable={{
				rect: setShape(layout, "rect") !== layout || shapeOf(layout.plan) === "rect",
				l: setShape(layout, "l") !== layout || shapeOf(layout.plan) === "l",
				"l-mirror": setShape(layout, "l-mirror") !== layout || shapeOf(layout.plan) === "l-mirror",
			}}
			wallRanges={layout.runs.map((_, i) => wallLengthRangeMm(layout, i))}
			targetWall={run}
			onShapeAction={(shape: RoomShape) => {
				if (setShape(layout, shape) === layout) return;
				track("room_shape_changed", { shape });
				setLayoutAction((prev) => setShape(prev, shape));
			}}
			onChangeRoomAction={onChangeRoomAction}
			onWallLengthAction={(wall, mm) => setLayoutAction((prev) => setWallLength(prev, wall, mm))}
			onTargetWallAction={setTargetRun}
			onCeilingAction={(mm) => setLayoutAction((prev) => setCeilingHeight(prev, mm))}
			onOpenDefaultsAction={() => setTool("defaults")}
		/>
	);
```

`wallLengthRangeMm` bisects twice per wall per render — at most 12 bisections of ~14 steps over ≤ 6 short runs. If the panel ever feels slow on a phone, memoise on `layout`.

`addBody`: replace the `{layout.corner && ( … target wall chips … )}` block with

```tsx
			<p className="text-[11px] text-neutral-500 leading-4">
				{fill(t.planner.addCabinets.targetWallHint, { n: run + 1 })}
			</p>
```

and the corner-category guard with `if (category.startsWith("CORNER_") && cornerVertexFor(layout, run) === null) return null;`.

`<PlannerScene … />`: add

```tsx
						targetRun={run}
						onWallPickAction={setTargetRun}
						onWallLengthAction={(wall, mm) =>
							setLayoutAction((prev) => setWallLength(prev, wall, mm))
						}
```

Finally `grep -n "layout\.corner\|wallWidthMm\|roomDepthMm\|wallToWall" src/components/planner/StudioScreen.tsx` — fix any remaining hit the same way (the back wall's length is `runView(layout, 0).wallWidthMm`).

- [ ] **Step 4: The other readers of the old fields**

`PlannerApp.tsx` ~l.196 and `QuoteScreen.tsx` ~l.298: `layout.wallWidthMm` → `wallsOf(layout.plan)[0].lengthMm` (import `wallsOf` from `@/lib/planner/floorplan`). Then:

Run: `grep -rnE "\.corner\b|wallWidthMm|roomDepthMm|wallToWall|runYawRad|setCornerSide|cornerWorktop\b|minRoomDepthMm|setRoomDepth" src --include=*.tsx | grep -v __tests__`
Every remaining hit must be on a `PlannerLayout` (a run view), not a `RoomLayout`.

- [ ] **Step 5: Typecheck, lint, test**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all three PASS.

- [ ] **Step 6: Browser check**

Start the dev server (`pnpm dev`) and open the kitchen planner. Record a GIF of steps 2–6.

1. The room opens as a rectangle with four walls; the back wall is tinted as the target.
2. Room panel → pick **L-shaped**. The floor becomes an L; six walls. In **plan** view, each wall shows its length; set the notch's top wall (wall 3) to 1500 and see walls 2 and 4 follow.
3. Tap the left wall in 3D; the tint moves; add a base cabinet from the menu — it lands on the left wall. Add one to the back wall: both slide clear of the corner square.
4. Tap the right wall; add a cabinet: a U. The back wall shows squares at both ends.
5. Drag a design from the menu and drop it near the right wall: it lands there, and the right wall becomes the target.
6. Doors → open. The leaves beside both corners stay shut; the others open.
7. Elevation view faces the targeted wall; tap another wall and elevation redraws to it.
8. Check out: `POST /api/orders` returns 201, and the stored design's `schemaVersion` is 3.
9. `/admin/orders`: an order placed before this change still renders.

Expected: all nine as described. Any failure goes back to the task that owns it.

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src
git add src
git commit -m "feat(planner): pick a room shape, set each wall, build on any wall

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Rewrite the architecture notes**

1. In the room-document code block under "The core rule", replace the `RoomLayout` sketch with:

```
Room document (JSON) — RoomLayout, src/lib/planner/room.ts
  ├─ roomId:     kitchen | living | bedroom | foyer
  ├─ plan:       { template: rect | l, widthMm, depthMm, notch…, mirror }   lib/planner/floorplan.ts
  ├─ ceilingHeightMm, hangingHeightMm, …   shared settings
  ├─ runs[]:     one per wall of the plan; each { floor[], wall[] }
  │                modules: familyId, widthMm, xMm, doorStyleId
  └─ corners[]:  { vertex, floor, wall } — corner units, inside corners only
```

2. Replace the section "### One wall or an L" with "### Room shapes", covering: templates + editable lengths, all corners square; the winding rule and why corner units are never turned; corner squares derived (both walls hold cabinets, or a unit); outside corners reserve nothing and leave run ends open; every room has walls all round, so a cabinet flush with a side wall wears no end panel; stored orders are design v3, v1 and v2 read as rectangles.
3. Add `floorplan.ts ← template + measurements → walls, corners, frames` to the directory listing under `lib/planner/`.
4. Known issue 6: "an L corner unit's two touching leaves" still applies; replace "is not turned for a right-hand corner" with "is never turned — every corner is the left-hand corner of the wall after it".
5. Under "Open questions", add: **Flush ends are no longer charged.** Every room now has side walls, so a cabinet flush against one wears no end panel; an old design re-priced can drop a panel. Tell EzCabinet.
6. In "The studio's own chrome", replace "3D / elevation / plan toggle" wording: elevation faces the targeted wall; the side view is gone. Add a line: "**Room shape and wall lengths** are in the Room panel and, in plan view, on the walls themselves (`WallLengths.tsx`)."

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: room shapes, the floor plan and design v3

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Drag a cabinet to another wall (added 2026-09-19, user request)

Today a placed cabinet stores only `xMm` along its own wall, `hangAtMm` and `rotationDeg`. The drag solves the pointer against the cabinet's own wall plane, so it can never leave its wall. The user chose: **dragging a cabinet across the room hands it to the wall it is dropped nearest.** It still stands against a wall. There is no data-format change and no island or pull-off.

**Files:**
- Modify: `src/lib/planner/floorplan.ts` (+ `transferTarget`), `src/lib/planner/__tests__/floorplan.test.ts`
- Modify: `src/lib/planner/room.ts` (+ engine `moveToRun`), `src/lib/planner/__tests__/room.test.ts`
- Modify: `src/components/planner/PlannerScene.tsx` (drag release → transfer; target-wall preview tint), `src/components/planner/StudioScreen.tsx` (retarget after a transfer)

**Interfaces:**
- `transferTarget(plan: FloorPlan, ownRun: number, point: Vec2): { run: number; xMm: number } | null`: `nearestWall(plan, point)`, or `null` when that is `ownRun`.
- Engine `moveToRun(room: RoomLayout, id: string, run: number, xMm: number): RoomLayout`:
  - Returns `room` unchanged if the id is unknown, is a corner unit, is already on `run`, or the cabinet does not fit on the new wall.
  - Otherwise it removes the cabinet from its run and places it on `run`. The xMm is centred on the pointer: `xMm − widthMm/2`, clamped by the one-wall engine.
  - It keeps `id`, `familyId`, `widthMm`, `doorStyleId`, `hinge` and `hangAtMm`, and drops `rotationDeg`.
  - It runs the same corner cascade and `allClear` gate as `addModule`.

- [ ] **Step 1: Failing tests.**
  - floorplan: `transferTarget(rect, 0, { xMm: -2000, zMm: 1000 })` → `{ run: 3, xMm: 800 }`; the same point with ownRun 3 → `null`.
  - room:
    1. A base cabinet on the back wall moved to run 3 at x=1500 lands on run 3, is gone from run 0, and keeps id, door and hinge.
    2. A turned cabinet loses `rotationDeg`.
    3. Moving onto a full wall returns the room unchanged (`toBe`).
    4. Moving a corner unit returns the room unchanged.
    5. Moving the second wall's only cabinet away frees the corner square (the first wall's cabinet stays where it is).
    6. Moving onto a wall that meets a used wall activates that corner and cascades.
- [ ] **Step 2:** Run them and watch them fail (`transferTarget`/`moveToRun` not found).
- [ ] **Step 3:** Implement. `moveToRun` = `removeModules` → `addModule(room, familyId, xMm − width/2, id, widthMm, run)` → restore door, hinge and hangAt via `mapModule`, then return the original room if the add was refused.
- [ ] **Step 4: Scene.**
  - At `Run`'s drag release (the window `pointerup` that ends a `move` drag), read the pointer's floor point with the same ray→floor maths `DropPicker` uses, in world mm.
  - Call `transferTarget(layout.plan, i, point)`.
  - If it returns a wall, call `onLayoutChangeAction(rooms.moveToRun(roomRef.current, id, target.run, target.xMm))` and `onWallPickAction?.(target.run)`, instead of committing the along-wall drag.
  - While dragging, pass the would-be target run to `<Room>` as a preview tint (a lighter green than the target tint). Keep the preview in a ref plus light state so the room doesn't re-render per pointer move; update it only when the candidate run changes.
  - Measure mode and rotate/lift gestures are unaffected. Only a `move` drag transfers.
- [ ] **Step 5: Gates and browser.**
  - `pnpm vitest run --dir src`, `pnpm typecheck` and `pnpm lint` all pass.
  - Browser, recorded as a GIF:
    - Drag a back-wall cabinet toward the left wall: the left wall previews, and on release the cabinet stands on the left wall.
    - Dropping onto a full wall snaps it back.
    - The corner square switches on or off as walls fill and empty.
    - Undo still works, if the studio has undo.
- [ ] **Step 6:** Commit, ending the message with the two attribution lines.

---

### Task 9: Free-standing cabinets — engine, schema, pricing (added 2026-09-19, user decision)

Spec §5. TDD throughout; `lib/planner` stays framework-free. Runs after Task 8's fix round is committed.

**Files:** `src/lib/planner/room.ts`, `src/lib/planner/floorplan.ts` (pure geometry helpers), `src/lib/planner/pricing.ts`, `src/lib/orders/layoutSchema.ts`, `src/lib/orders/validate.ts`, their tests.

**Interfaces (produce exactly these):**
- `floorplan.ts`:
  - `pointInPlan(plan, p: Vec2): boolean` — ray casting against `outlineOf(plan)`; points on the boundary count as inside.
  - `rectCorners(centre: Vec2, widthMm, depthMm, yawRad): Vec2[]` — 4 corners, where the front faces local +z turned by yaw (same sense as `WallGeom.yawRad`).
  - `rectsOverlap(a: Vec2[], b: Vec2[]): boolean` — SAT for two convex quads; touching edges do not overlap (use a 0.5 mm slack like `layout.ts`'s `SLACK_MM`).
  - `distanceToWallMm(plan, wall, p: Vec2): number` — perpendicular distance from `p` to wall `wall`'s line, measured inward.
- `room.ts`:
  - `export type FreeModule = PlacedModule & { zMm: number }` (for a free module, `xMm`/`zMm` are the footprint centre in plan mm, and `rotationDeg` is yaw from the back wall in degrees).
  - `RoomLayout.free: FreeModule[]`; `asRoom`/`emptyRoom` set `[]`; `mapModule`/`setDoor`/`setHinge`/`removeModules`/`runIndexOf`-style lookups include `free`.
  - `export const SNAP_TO_WALL_MM = 150`.
  - Engine:
    - `freeFootprint(room, id): Vec2[] | null`
    - `runFootprints(room, row): { id; corners: Vec2[] }[]` — each run cabinet's world footprint via `frameOf` + `toWorldMm`, with its back at the wall gap.
    - `freeIsClear(room): boolean`
    - `placeFree(room, id, centre: Vec2, rotationDeg?): RoomLayout` — moves a run or free cabinet to free at `centre`. It refuses (returns `room`) for a wall/corner family, when outside, or when overlapping. A run → free move sets `rotationDeg` to the wall's yaw in degrees + the cabinet's own turn.
    - `dropAt(room, id, centre: Vec2): RoomLayout` — the unified release. Nearest wall via `nearestWall`. If `distanceToWallMm(...) − depthMm/2 <= SNAP_TO_WALL_MM`, it calls `moveToRun(room, id, run, alongMm)`: from free too, in which case `moveToRun` must accept free ids, and a same-run move re-places it along its wall. Otherwise it calls `placeFree`.
    - `rotateFree(room, id, deg)` — refused if the result overlaps or leaves the room.
  - `allPositions` includes free cabinets as `Positioned` (`xMm: 0`); `exposureOf` marks free cabinets `{ left: true, right: true }`.
  - `endPanels` includes both sides of each free cabinet.
- `pricing.ts`: `worktopFt` and `skirtingFt` add each free **base** cabinet's width. End panels come through `endPanels`.
- `layoutSchema.ts`: `free: z.array(placedModuleSchema.extend({ xMm: z.number().min(-20_000).max(20_000), zMm: z.number().min(-20_000).max(20_000) })).max(30).default([])` on the v3 room; `fromV2` sets `free: []`. It must still satisfy `z.ZodType<RoomLayout>` — use `z.input`/`z.output` care as needed.
- `validate.ts`: free rows go through the same per-cabinet checks. A wall/corner family in `free` → `does_not_fit`. `!freeIsClear` → `does_not_fit`.

**Tests first (minimum):**
- floorplan: `pointInPlan` (rect inside/outside; the L's notch is outside); `rectsOverlap` (disjoint, overlapping, touching-not-overlapping, rotated 45°); `distanceToWallMm`.
- room:
  - A run base cabinet dropped at the room centre becomes free: it is gone from the run, is in `free`, and keeps id/door/hinge.
  - A drop 100 mm (back edge) from the left wall joins run 3.
  - A drop 400 mm off joins nothing and stays free.
  - A free → free move.
  - A free cabinet dragged back to a wall joins that wall's run.
  - Refusals: a wall unit; a corner unit; outside the L's notch; overlapping another free cabinet; overlapping a run cabinet.
  - `rotateFree` refused into a wall.
  - Removing a free cabinet.
  - `exposureOf`/`endPanels` give 2 panels.
- pricing: one free base cabinet 600 → worktop 600 mm, skirting 600 mm, 2 base end panels; a free tall unit → 2 tall panels, no worktop.
- orders: a v3 design without `free` parses to `free: []`; a free wall unit → `does_not_fit`; a free cabinet outside the room → `does_not_fit`; overlapping free cabinets → `does_not_fit`.

**Gates:** `pnpm vitest run --dir src`. `pnpm typecheck` may fail only in `src/components` (Task 10 wires it); report the list.

### Task 10: Free-standing cabinets — scene and studio (added 2026-09-19)

**Files:** `src/components/planner/PlannerScene.tsx`, `StudioScreen.tsx` (and only what else typecheck forces).

- **Drawing.** Each free cabinet is drawn as a one-cabinet `Run`:
  - Build a `PlannerLayout` view: `wallWidthMm = widthMm`, `roomDepthMm = depthMm + 2 × WALL_GAP_MM`, the cabinet at `xMm 0`, `endWalls {false,false}`, no `reserved`.
  - Give it a frame `{ yawRad: rotationDeg·π/180, xMm, zMm }` (the cabinet's local centre is then at the frame origin).
  - Add a `freeStanding` prop to `Run` that skips the bare-wall catcher plane, and makes drags solve against the floor plane.
- **Drag.**
  - A free cabinet follows the pointer's floor point (via `floorPointFromRay`) live. Keep the preview position in a ref plus a light state update; no three.js allocations per move.
  - A wall cabinet whose floor point goes more than `SNAP_TO_WALL_MM + depth/2` from its own wall switches to the same floor-following preview.
  - On release, call `rooms.dropAt(room, id, centre)`. If the result is the same room (refused), snap back.
  - After a drop, retarget the wall when it joined one.
- **Rotate.** The rotate ring on a free cabinet calls `rotateFree`.
- **Everything else keys by id** (selection, doors open, measure): check free cabinets work with them. Measure snapping on a free cabinet may use the surface point only (as turned cabinets already do).
- **Gates:** `pnpm vitest run --dir src`, `pnpm typecheck` and `pnpm lint` all pass.
- **Browser pass** (GIF), checking each of these:
  - Drag a base cabinet to the centre of the room: it stays there, has its own worktop, and the price adds 2 end panels.
  - Drag it to within 100 mm of a wall: it joins that wall's run.
  - Drop it overlapping another cabinet: it snaps back.
  - Drop it into the L's notch (outside the room): it snaps back.
  - A wall unit cannot go free.
  - Rotate a free cabinet.
  - Checkout with a free cabinet returns 201.

Then Task 7 (docs) covers §5 as well: the CLAUDE.md "Room shapes" section, and the open question "is a free-standing cabinet's back charged as a panel?".

---

### Task 11: Keep a dragged cabinet inside the room (added 2026-09-19, user report)

While being dragged on the floor, a free cabinet (or a floor cabinet floated off its wall) follows the pointer with no limit, so it visibly passes through a wall before release. Fix: the floor-follow preview is clamped so the rotated footprint stays inside the room. It slides along a wall instead of passing through it. The drop uses the same clamped centre, so a cabinet pushed against a wall lands with its back at the wall and joins it under the 150 mm rule.

**Files:** `src/lib/planner/floorplan.ts` (+ test), `src/components/planner/PlannerScene.tsx` (floor-follow drag), `src/lib/planner/room.ts` (only if `dropAt` needs the clamped centre).

**Interface:** `clampIntoPlan(plan: FloorPlan, centre: Vec2, widthMm: number, depthMm: number, yawRad: number): Vec2`. It returns `centre` unchanged (same object) when the footprint (`rectCorners`) is already inside (`footprintInPlan`). Otherwise it pushes the centre along each offending wall's inward normal by that wall's penetration, running two passes so a corner of the room is resolved. `// ponytail:` note: two passes resolve every 90° corner; a general polygon would need iteration to convergence.

**Tests first:**
- Rect 4200×3600, a 600×580 cabinet at yaw 0 with centre `{0, −1900}` (through the back wall) → its back edge sits on the back wall (`zMm = −1800 + 290`) and x is unchanged.
- A centre past both the back and left walls ends in that corner.
- An inside centre returns the same object.
- A 45°-turned cabinet against a wall: its corner touches and doesn't cross.
- L notch: a centre inside the notch is pushed out of it, onto the nearer of the two notch walls.

**Scene:**
- The floor-follow drag (free cabinets, and floor cabinets floated off their wall) positions the preview at `clampIntoPlan(...)` of the pointer-derived centre.
- The release passes that same clamped centre to `dropAt`.
- No new three.js allocations per move.

**Gates:** `pnpm vitest run --dir src`, `pnpm typecheck` and `pnpm lint` all pass.

**Browser:**
- Drag a free cabinet hard into the back wall: it stops at the wall, and on release joins it.
- Drag into a room corner: it stops in the corner.
- Drag toward the L's notch: it stays out of it.
