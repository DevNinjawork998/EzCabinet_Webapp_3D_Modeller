# L-shape Kitchen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer plan an L-shaped kitchen: a main wall plus a side wall meeting at a corner, which an uploaded corner cabinet design fills.

**Architecture:** The stored document becomes `RoomLayout` — shared room settings, `runs` (one per wall) and a `corner` slot. Each run is presented to the *existing, unchanged* one-wall engine as a `PlannerLayout` view (`runView`), with the corner square handed in as a `reserved` span that every collision rule already respects because it enters `occupiedSpans`. A new `roomEngine` dispatches each edit to the run that holds the cabinet and writes the rows back (`withRun`). The scene draws one `Run` per wall inside a group turned onto its wall; pointer rays are turned back into the run's frame, so dragging, snapping and measuring stay one-dimensional.

**Tech Stack:** Next.js 16 App Router, React 19, @react-three/fiber 9 + drei, three 0.185, zod 4, Prisma 7 (Postgres), vitest, Biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-16-l-shape-kitchen-design.md` (Task 1 amends it — read the amended version).

## Global Constraints

- **The working tree must be clean before Task 1.** `git status` currently shows ~50 modified files, several of which this plan edits (`StudioScreen.tsx`, `PlannerScene.tsx`, `layout.test.ts`, copy files). Ask the user to commit or stash their in-progress work first, or run this plan in a worktree (superpowers:using-git-worktrees). Never `git add -A`; add the files a task names.
- `src/lib/planner` stays framework-free: no React, no three.js imports. Everything there is `(layout, catalogue) => result`.
- Every `lib/planner` function gets a test before it gets a caller (CLAUDE.md convention).
- Seed catalogue changes ship as their own commit, separate from code.
- Zod is the single source of truth for payloads; the checkout API validates every field.
- Price is computed server-side; never trust a client figure.
- Stored order designs carry `schemaVersion`; v1 orders must still read.
- UI copy is sentence case, in `en`, `ms` and `zh` (`src/lib/copy/*.ts`; `Dictionary` is derived from `en`, so `ms`/`zh` fail typecheck if a key is missing).
- Empty corner square: **607 mm floor row, 397 mm wall row** (`EMPTY_CORNER_MM`).
- Corner designs are drawn for the **left** corner; the right corner is the same model turned 270° (never mirrored).
- Commands: `pnpm test` (vitest), `pnpm typecheck`, `pnpm lint` (Biome — run `pnpm biome check --write <files>` to format).
- Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `docs/superpowers/specs/2026-09-16-l-shape-kitchen-design.md` | modify | amendments |
| `src/lib/planner/catalogueSchema.ts` | modify | corner categories in `familySchema.category` |
| `src/lib/planner/catalogue.ts` | modify | `isCorner`; seed `corner-base`, `corner-wall` (separate commit) |
| `src/lib/planner/layout.ts` | modify | export `PlacedModule`/`Span`/`newId`; `reserved` spans; export `isClear` |
| `src/lib/planner/room.ts` | **create** | `RoomLayout`, views, door setters, `roomEngine` |
| `src/lib/planner/__tests__/reserved.test.ts` | **create** | reserved spans in the one-wall engine |
| `src/lib/planner/__tests__/room.test.ts` | **create** | room dispatch, shape, corner, exposure, limits |
| `src/lib/planner/pricing.ts` | modify | price a `RoomLayout` |
| `src/lib/planner/__tests__/pricing.test.ts` | modify | wrap fixtures with `asRoom`; L pricing tests |
| `src/lib/orders/{layoutSchema,validate,price,items}.ts` | modify | v2 design, L validation |
| `src/lib/orders/__tests__/orders.test.ts` | modify | wrap fixtures; v1 upgrade; corner rules |
| `src/app/api/orders/route.ts` | modify | accept `roomLayoutSchema` |
| `prisma/schema.prisma`, `prisma/migrations/20260916000000_corner_categories/migration.sql` | modify/create | enum values |
| `src/lib/catalogue/cabinetDesignLabels.ts`, `src/lib/mesh/measureDesign.ts`, `src/app/api/admin/cabinet-designs/route.ts`, `…/[id]/route.ts` | modify | corner categories |
| `src/lib/mesh/__tests__/cornerMock.ts` | **create** | generates mock corner OBJ text |
| `scripts/generate-corner-mock.ts` | **create** | writes the mock OBJs to disk for upload |
| `src/lib/mesh/__tests__/cornerMock.test.ts` | **create** | the mock measures and classifies |
| `src/components/planner/CatalogueContext.tsx` | modify | `useRoomEngine` |
| `src/app/[lang]/planner/PlannerApp.tsx`, `StudioScreen.tsx`, `QuoteScreen.tsx`, `studio/SelectionPanel.tsx` | modify | hold a `RoomLayout` |
| `src/components/planner/PlannerScene.tsx` | modify | one `Run` per wall, local rays, corner units, corner worktop, side view |
| `src/components/planner/Room.tsx` | modify | per-side walls |
| `src/components/planner/studio/RoomPanel.tsx` | modify | shape control, side wall length |
| `src/lib/copy/{en,ms,zh}.ts` | modify | new strings |
| `CLAUDE.md` | modify | document the room document and open question |

---

### Task 1: Spec amendments, corner categories in the catalogue schema

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-l-shape-kitchen-design.md`
- Modify: `src/lib/planner/catalogueSchema.ts:77-86`
- Modify: `src/lib/planner/catalogue.ts` (add `isCorner`; seed families in a separate commit)
- Test: `src/lib/planner/__tests__/catalogue.test.ts`

**Interfaces:**
- Produces: `isCorner(family: Pick<Family, "category">): boolean` exported from `src/lib/planner/catalogue.ts`; seed families `corner-base` (900×880×900, RM 1150) and `corner-wall` (600×880×600, RM 680) in the kitchen.

- [ ] **Step 1: Amend the spec**

Append this section to the end of `docs/superpowers/specs/2026-09-16-l-shape-kitchen-design.md`:

```markdown
## Amendments (implementation plan, 2026-09-16)

- **Naming.** The stored document is `RoomLayout` (`src/lib/planner/room.ts`):
  shared settings + `runs` + `corner`. `PlannerLayout` stays exactly what it is —
  one wall's layout — and is what `runView` hands the existing engine. This keeps
  the one-wall engine, its tests, the measuring tool and the scene's `Run`
  unchanged. `roomEngine(catalogue)` is the document-level engine.
- **Run coordinates.** Every run's `xMm` is left-to-right *as seen facing that
  wall from inside the room*. So the reserved corner span is: main run `[0, d]`
  for a left corner, `[W − d, W]` for a right one; side run `[D − d, D]` for a
  left corner, `[0, d]` for a right one. (Replaces "return run: always `[0, d]`".)
  With this, the side run is drawn by the same `Run` component turned ±90°, with
  no mirroring.
- **Corner kind.** No new `kind`. A corner design keeps `kind: base | wall` and is
  recognised by `category` (`CORNER_BASE_CABINET`, `CORNER_WALL_CABINET`) via
  `isCorner`. Worktop, hang height and row rules then apply to it unchanged.
- **Corner skirting deferred.** No kick board is drawn or charged along a corner
  unit's faces yet; its shape varies by design (L, diagonal, blind).
- **Ceiling mode.** Each run lines its wall-unit tops up with its own tallest wall
  unit; tops still meet the ceiling in every run.
```

- [ ] **Step 2: Commit the amendment**

```bash
git add docs/superpowers/specs/2026-09-16-l-shape-kitchen-design.md
git commit -m "docs: amend L-shape spec with implementation decisions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Write the failing test**

Append to `src/lib/planner/__tests__/catalogue.test.ts` (add `isCorner` to the existing `../catalogue` import):

```ts
describe("isCorner", () => {
	it("recognises the two corner categories and nothing else", () => {
		expect(isCorner({ category: "CORNER_BASE_CABINET" })).toBe(true);
		expect(isCorner({ category: "CORNER_WALL_CABINET" })).toBe(true);
		expect(isCorner({ category: "BASE_CABINET" })).toBe(false);
		expect(isCorner({ category: undefined })).toBe(false);
	});

	it("parses a family filed under a corner category", () => {
		const corner = PLANNER_CATALOGUE.families.find(
			(family) => family.id === "base-cabinet",
		);
		if (!corner) throw new Error("seed lost base-cabinet");
		expect(
			familySchema.safeParse({ ...corner, category: "CORNER_BASE_CABINET" })
				.success,
		).toBe(true);
	});
});
```

Import `familySchema` from `../catalogueSchema` if the file does not already.

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run src/lib/planner/__tests__/catalogue.test.ts`
Expected: FAIL — `isCorner` is not exported / corner category rejected by the enum.

- [ ] **Step 5: Implement**

In `src/lib/planner/catalogueSchema.ts`, extend the `category` enum in `familySchema`:

```ts
	category: z
		.enum([
			"BASE_CABINET",
			"WALL_CABINET",
			"TALL_CABINET",
			"DRAWER_BASE",
			"FRIDGE_HOUSING",
			"CORNER_BASE_CABINET",
			"CORNER_WALL_CABINET",
		])
		.optional(),
```

In `src/lib/planner/catalogue.ts`, directly after `export const FAMILIES: Family[] = [ … ];` add:

```ts
/**
 * Whether a family fills the corner of an L rather than standing in a run.
 *
 * Read off the design library's category, the one shape question the admin
 * answers explicitly. A corner unit keeps its ordinary `kind` — a corner base
 * is still a base, worktop and all — so nothing else has to learn a new kind.
 */
export const isCorner = (family: Pick<Family, "category">): boolean =>
	family.category === "CORNER_BASE_CABINET" ||
	family.category === "CORNER_WALL_CABINET";
```

- [ ] **Step 6: Run the test and the full suite**

Run: `pnpm vitest run src/lib/planner/__tests__/catalogue.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit the code**

```bash
git add src/lib/planner/catalogueSchema.ts src/lib/planner/catalogue.ts src/lib/planner/__tests__/catalogue.test.ts
git commit -m "feat(catalogue): corner cabinet categories

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Add the seed corner families (catalogue commit)**

In `src/lib/planner/catalogue.ts`, append inside `FAMILIES`, after `fridge-housing` and before the `other rooms` comment:

```ts
	{
		...BASE,
		id: "corner-base",
		label: "Corner base cabinet",
		category: "CORNER_BASE_CABINET",
		// PLACEHOLDER — no corner export from the client yet. An L-shaped unit
		// is as deep as it is wide; drawn for the left-hand corner.
		depthMm: 900,
		drawers: 0,
		note: "L-shaped corner unit, drawn for the left-hand corner",
		sizes: [{ widthMm: 900, priceRm: 1150 }],
	},
	{
		...WALL,
		id: "corner-wall",
		label: "Corner wall cabinet",
		category: "CORNER_WALL_CABINET",
		// PLACEHOLDER — as above.
		depthMm: 600,
		drawers: 0,
		note: "L-shaped corner wall unit, drawn for the left-hand corner",
		sizes: [{ widthMm: 600, priceRm: 680 }],
	},
```

Add `"corner-base", "corner-wall"` to the end of the kitchen's `familyIds`.

- [ ] **Step 9: Run the full suite**

Run: `pnpm test`
Expected: PASS. If a test that loops over *every* seed family now fails (e.g. it places each family on a wall), exclude corners in that loop with `.filter((family) => !isCorner(family))` and a one-line comment: `// Corner units have no place in a run; room.test.ts covers them.`

- [ ] **Step 10: Commit the seed on its own**

```bash
git add src/lib/planner/catalogue.ts src/lib/planner/__tests__
git commit -m "catalogue(seed): corner base and corner wall fixtures

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Reserved spans in the one-wall engine

**Files:**
- Modify: `src/lib/planner/layout.ts`
- Test: `src/lib/planner/__tests__/reserved.test.ts` (create)

**Interfaces:**
- Produces (exported from `layout.ts`): `type PlacedModule`, `type Span = { startMm: number; endMm: number }`, `newId(): string`, optional `PlannerLayout.reserved?: Partial<Record<Row, Span>>`, and `isClear(layout: PlannerLayout): boolean` on the object `plannerEngine` returns.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/planner/__tests__/reserved.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import { emptyLayout, type PlannerLayout, plannerEngine } from "../layout";

/**
 * A corner reaches the one-wall engine as a reserved stretch of wall. These pin
 * that every existing rule treats it as one more neighbour — nothing about a
 * corner is special once it is a span.
 */
const engine = plannerEngine(PLANNER_CATALOGUE);

const cornered = (floorMm = 607, wallMm = 397): PlannerLayout => ({
	...emptyLayout(3000),
	reserved: {
		floor: { startMm: 0, endMm: floorMm },
		wall: { startMm: 0, endMm: wallMm },
	},
});

describe("a reserved corner span", () => {
	it("is where a cabinet dropped at the corner stops short of", () => {
		const next = engine.addModule(cornered(), "base-cabinet", 0, "a", 600);
		expect(next.floor[0].xMm).toBe(607);
	});

	it("stops a drag flush against it", () => {
		const placed = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		expect(engine.moveModule(placed, "a", 100).floor[0].xMm).toBe(607);
	});

	it("is per row: a wall unit stops at the wall row's corner", () => {
		const next = engine.addModule(cornered(), "wall-cabinet", 0, "w", 400);
		expect(next.wall[0].xMm).toBe(397);
	});

	it("keeps a dragged tall unit out of the hung row's corner too", () => {
		const placed = engine.addModule(
			cornered(300, 700),
			"tall-cabinet",
			1000,
			"t",
			600,
		);
		expect(engine.moveModule(placed, "t", 0).floor[0].xMm).toBe(700);
	});

	it("blocks the far end when the corner is on the right", () => {
		const layout: PlannerLayout = {
			...emptyLayout(3000),
			reserved: { floor: { startMm: 2393, endMm: 3000 } },
		};
		const next = engine.addModule(layout, "base-cabinet", 2800, "a", 600);
		expect(next.floor[0].xMm).toBe(1793);
	});

	it("is the anchor a gap is measured to", () => {
		const placed = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		expect(engine.offsetsOf(placed, "a")).toMatchObject({
			leftAnchorMm: 607,
			leftMm: 393,
		});
	});

	it("is where closing the gaps packs from", () => {
		let layout = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		layout = engine.addModule(layout, "base-cabinet", 2000, "b", 600);
		expect(engine.closeGaps(layout).floor.map((m) => m.xMm)).toEqual([
			607, 1207,
		]);
	});

	it("makes a layout with a cabinet inside it impossible", () => {
		const layout: PlannerLayout = {
			...cornered(),
			floor: [
				{
					id: "a",
					familyId: "base-cabinet",
					widthMm: 600,
					doorStyleId: null,
					hinge: "left",
					xMm: 0,
				},
			],
		};
		expect(engine.isClear(layout)).toBe(false);
		expect(engine.isClear({ ...layout, reserved: undefined })).toBe(true);
	});

	it("is a snap target", () => {
		const placed = engine.addModule(cornered(), "base-cabinet", 1000, "a", 600);
		expect(engine.dropModule(placed, "a", 640).floor[0].xMm).toBe(607);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/planner/__tests__/reserved.test.ts`
Expected: FAIL — typecheck-level `reserved` unknown is tolerated by vitest, so the failures are behavioural: cabinets land at `0`, `isClear` is not a function.

- [ ] **Step 3: Implement in `src/lib/planner/layout.ts`**

3a. Export the module type and span type. Change `type PlacedModule = {` to `export type PlacedModule = {`, and `type Span = { startMm: number; endMm: number };` to `export type Span = { startMm: number; endMm: number };`.

3b. Export the id counter: change `const newId = () => \`m${++counter}\`;` to `export const newId = () => \`m${++counter}\`;`.

3c. Add to `PlannerLayout`, after `wall: PlacedModule[];`:

```ts
	/**
	 * Stretches of this wall a corner has taken, per row. Only set on a run view
	 * built by `room.ts`; a straight wall has none. They enter `occupiedSpans`,
	 * so everything that settles against a neighbour — clamping, snapping, gaps,
	 * `isClear` — treats a corner as one more neighbour and needs no rule of
	 * its own.
	 */
	reserved?: Partial<Record<Row, Span>>;
```

3d. Replace the body of `occupiedSpans` from `return [...own, ...crossRow]` to the end of the function with:

```ts
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
```

3e. In `snapTargets`, after `const edges = [0, layout.wallWidthMm];` add:

```ts
		// A corner's edge is somewhere a run is meant to start.
		for (const span of [layout.reserved?.floor, layout.reserved?.wall]) {
			if (span) edges.push(span.startMm, span.endMm);
		}
```

3f. In `closeGaps`, pack from the corner when it sits at the start of the wall. Replace the first `let cursor = 0;` with:

```ts
		// A corner at the start of this wall is where the run begins.
		const startOf = (row: Row) => {
			const span = layout.reserved?.[row];
			return span?.startMm === 0 ? span.endMm : 0;
		};
		let cursor = startOf("floor");
```

and the second `cursor = 0;` (before the wall loop) with `cursor = startOf("wall");`.

3g. Add `isClear,` to the object `plannerEngine` returns (after `swapWithNeighbour,`).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/lib/planner/__tests__/reserved.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm biome check --write src/lib/planner/layout.ts src/lib/planner/__tests__/reserved.test.ts
git add src/lib/planner/layout.ts src/lib/planner/__tests__/reserved.test.ts
git commit -m "feat(planner): a reserved span is a neighbour to every placement rule

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The room document and its per-run dispatch

**Files:**
- Create: `src/lib/planner/room.ts`
- Test: `src/lib/planner/__tests__/room.test.ts` (create)

**Interfaces:**
- Consumes: `PlannerLayout`, `PlacedModule`, `Span`, `Row`, `HingeSide`, `emptyLayout`, `plannerEngine`, `newId` from `layout.ts`.
- Produces (from `room.ts`):
  - types `Run`, `CornerSide = "left" | "right"`, `Corner`, `RoomLayout`, `RoomShape = "straight" | CornerSide`
  - `EMPTY_CORNER_MM: Record<Row, number>` = `{ floor: 607, wall: 397 }`
  - `asRoom(layout: PlannerLayout): RoomLayout`, `emptyRoom(wallWidthMm, roomDepthMm?, ceilingHeightMm?): RoomLayout`
  - `shapeOf(room): RoomShape`, `cornerSquareMm(room, row): number`
  - `runView(room, run: number): PlannerLayout`, `withRun(room, run, view): RoomLayout`, `runIndexOf(room, id): number`, `runYawRad(room, run): number`
  - `setDoor(room, id, doorStyleId)`, `setHinge(room, id, hinge)`, `setDoors(room, ids, doorStyleId)`
  - `roomEngine(catalogue)` — in this task: `positionsOf(room,row,run=0)`, `allPositions(room)`, `rowEndMm(room,row,run=0)`, `freeSpans(room,row,run=0)`, `runExtentMm(room,run=0)`, `fits(room,familyId,widthMm?,run=0)`, `addModule(room,familyId,xMm,id?,widthMm?,run=0)`, `offsetsOf(room,id)`, `widthOptionsFor(room,id)`, `setGap`, `moveModule`, `dropModule`, `dragModule`, `replaceFamily`, `duplicateModule`, `setHangAt`, `setRotation`, `setWidth`, `swapWithNeighbour` (all `(room, id, …same args as plannerEngine)`), `removeModules(room, ids)`, `removeModule(room,id)`, `closeGaps(room)`, `setHangingHeight`, `setWallToCeiling`, `setWallToWall`, `setBaseSkirting`, `setCeilingHeight`, `hangingHeightMmOf(room)`, `floorHeightMmOf(position, room)`, `flushWallToTallTops(room)`, `overhangMm(room)`, `overhangingIds(room)`, `isClear(room)`, `skirtingSpans(room, run=0)`, `minWallWidthMm(room)`, `minRoomDepthMm(room)`, `setWallWidth(room,mm)`, `setRoomDepth(room,mm)`. Task 4 adds the corner functions and exposure.
  - `type RoomEngine = ReturnType<typeof roomEngine>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/planner/__tests__/room.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import {
	emptyLayout,
	type PlacedModule,
	plannerEngine,
} from "../layout";
import {
	asRoom,
	emptyRoom,
	type RoomLayout,
	roomEngine,
	runIndexOf,
	runView,
	runYawRad,
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

/** A 4200 × 3600 room turned into an L by hand, so these tests do not lean on
 * `setShape` (Task 4). */
const lRoom = (
	side: "left" | "right",
	main: PlacedModule[] = [],
	sideRun: PlacedModule[] = [],
): RoomLayout => ({
	...emptyRoom(4200),
	runs: [
		{ floor: main, wall: [] },
		{ floor: sideRun, wall: [] },
	],
	corner: { side, floor: null, wall: null },
});

describe("asRoom", () => {
	it("makes one wall's rows the only run", () => {
		const room = asRoom(emptyLayout(3000));
		expect(room.runs).toEqual([{ floor: [], wall: [] }]);
		expect(room.corner).toBeNull();
		expect(runView(room, 0)).toEqual(emptyLayout(3000));
	});
});

describe("a straight room", () => {
	it("edits exactly as the one-wall engine does", () => {
		const flat = oneWall.addModule(emptyLayout(4200), "base-cabinet", 0, "a", 600);
		const room = engine.addModule(emptyRoom(4200), "base-cabinet", 0, "a", 600);
		expect(runView(room, 0)).toEqual(flat);
	});

	it("has no side run to add to", () => {
		const room = emptyRoom(4200);
		expect(engine.addModule(room, "base-cabinet", 0, "a", 600, 1)).toBe(room);
	});
});

describe("runView", () => {
	it("swaps the room's axes for the side wall and never encloses it", () => {
		const room = { ...lRoom("right"), wallToWall: true };
		expect(runView(room, 1)).toMatchObject({
			wallWidthMm: 3600,
			roomDepthMm: 4200,
			wallToWall: false,
		});
		expect(runView(room, 0)).toMatchObject({ wallWidthMm: 4200, wallToWall: true });
	});

	it("reserves the corner at the start of the main wall for a left corner", () => {
		expect(runView(lRoom("left"), 0).reserved).toEqual({
			floor: { startMm: 0, endMm: 607 },
			wall: { startMm: 0, endMm: 397 },
		});
	});

	it("reserves the far end of the side wall for a left corner", () => {
		expect(runView(lRoom("left"), 1).reserved?.floor).toEqual({
			startMm: 2993,
			endMm: 3600,
		});
	});

	it("mirrors both for a right corner", () => {
		const room = lRoom("right");
		expect(runView(room, 0).reserved?.floor).toEqual({
			startMm: 3593,
			endMm: 4200,
		});
		expect(runView(room, 1).reserved?.floor).toEqual({ startMm: 0, endMm: 607 });
	});
});

describe("dispatch", () => {
	it("finds the run holding an id", () => {
		const room = lRoom("right", [base("m", 1000)], [base("s", 1000)]);
		expect(runIndexOf(room, "m")).toBe(0);
		expect(runIndexOf(room, "s")).toBe(1);
		expect(runIndexOf(room, "nope")).toBe(-1);
	});

	it("moves a side-wall cabinet against that wall's own corner", () => {
		const room = lRoom("right", [], [base("s", 1000)]);
		expect(engine.moveModule(room, "s", 0).runs[1].floor[0].xMm).toBe(607);
	});

	it("adds to the run it is told to", () => {
		const room = engine.addModule(lRoom("left"), "base-cabinet", 3500, "s", 600, 1);
		expect(room.runs[1].floor[0].xMm).toBe(2393);
		expect(room.runs[0].floor).toEqual([]);
	});

	it("leaves the room untouched for an unknown id", () => {
		const room = lRoom("left");
		expect(engine.moveModule(room, "nope", 10)).toBe(room);
	});

	it("withRun writes rows only, never the view's swapped axes", () => {
		const room = lRoom("left");
		const view = { ...runView(room, 1), floor: [base("s", 0)] };
		const next = withRun(room, 1, view);
		expect(next.wallWidthMm).toBe(4200);
		expect(next.roomDepthMm).toBe(3600);
		expect(next.runs[1].floor).toHaveLength(1);
	});

	it("lists positions of every run", () => {
		const room = lRoom("left", [base("m", 1000)], [base("s", 1000)]);
		expect(engine.allPositions(room).map((p) => p.placed.id).sort()).toEqual([
			"m",
			"s",
		]);
	});

	it("removes across runs", () => {
		const room = lRoom("left", [base("m", 1000)], [base("s", 1000)]);
		const next = engine.removeModules(room, ["m", "s"]);
		expect(next.runs.map((r) => r.floor.length)).toEqual([0, 0]);
	});
});

describe("room-wide settings", () => {
	it("clamps the ceiling the way the one-wall engine does", () => {
		expect(engine.setCeilingHeight(emptyRoom(4200), 99_999).ceilingHeightMm).toBe(
			oneWall.setCeilingHeight(emptyLayout(4200), 99_999).ceilingHeightMm,
		);
	});

	it("will not shorten the main wall through a right-hand corner", () => {
		const room = lRoom("right", [base("m", 2000)]);
		expect(engine.minWallWidthMm(room)).toBe(2600 + 607);
		expect(engine.setWallWidth(room, 1000).wallWidthMm).toBe(3207);
	});

	it("will not shorten the room through the side wall's cabinets", () => {
		const room = lRoom("left", [], [base("s", 1000)]);
		expect(engine.minRoomDepthMm(room)).toBe(1600 + 607);
		expect(engine.setRoomDepth(room, 100).roomDepthMm).toBe(2207);
	});
});

describe("runYawRad", () => {
	it("turns the side wall onto the side it is on", () => {
		expect(runYawRad(lRoom("left"), 0)).toBe(0);
		expect(runYawRad(lRoom("left"), 1)).toBeCloseTo(Math.PI / 2);
		expect(runYawRad(lRoom("right"), 1)).toBeCloseTo(-Math.PI / 2);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/planner/__tests__/room.test.ts`
Expected: FAIL — `Cannot find module '../room'`.

- [ ] **Step 3: Implement `src/lib/planner/room.ts`**

```ts
import { familyIn, isCorner, ROOM_DEPTH_LIMITS } from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import {
	emptyLayout,
	type HingeSide,
	type PlacedModule,
	type PlannerLayout,
	plannerEngine,
	type Positioned,
	type Row,
	type Span,
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
	const atStart = run === 0 ? room.corner.side === "left" : room.corner.side === "right";
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
	const hit = (module: PlacedModule) => (module.id === id ? edit(module) : module);
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

	function addModule(
		room: RoomLayout,
		familyId: string,
		xMm: number,
		id?: string,
		widthMm?: number,
		run = 0,
	): RoomLayout {
		const family = familyIn(catalogue, familyId);
		if (!family || isCorner(family) || run >= room.runs.length) return room;
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
		if (!family || isCorner(family) || run >= room.runs.length) return false;
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
			const next = edit(runView(room, 0), value)[key];
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
		return clamped === room.wallWidthMm ? room : { ...room, wallWidthMm: clamped };
	}

	function setRoomDepth(room: RoomLayout, roomDepthMm: number): RoomLayout {
		const clamped = Math.max(
			minRoomDepthMm(room),
			Math.min(ROOM_DEPTH_LIMITS.maxMm, Math.round(roomDepthMm)),
		);
		return clamped === room.roomDepthMm ? room : { ...room, roomDepthMm: clamped };
	}

	return {
		positionsOf: (room: RoomLayout, row: Row, run = 0): Positioned[] =>
			run < room.runs.length ? wall.positionsOf(runView(room, run), row) : [],
		allPositions: (room: RoomLayout): Positioned[] =>
			views(room).flatMap((view) => wall.allPositions(view)),
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
			return run < 0 ? [] : wall.widthOptionsFor(runView(room, run), id);
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
		setHangingHeight: setting("hangingHeightMm", wall.setHangingHeight),
		setWallToCeiling: setting("wallToCeiling", wall.setWallToCeiling),
		setWallToWall: setting("wallToWall", wall.setWallToWall),
		setBaseSkirting: setting("baseSkirting", wall.setBaseSkirting),
		setCeilingHeight: setting("ceilingHeightMm", wall.setCeilingHeight),
		hangingHeightMmOf: (room: RoomLayout) => wall.hangingHeightMmOf(pooled(room)),
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
		isClear: (room: RoomLayout) => views(room).every((view) => wall.isClear(view)),
		skirtingSpans: (room: RoomLayout, run = 0) =>
			wall.skirtingSpans(runView(room, run)),
		minWallWidthMm,
		minRoomDepthMm,
		setWallWidth,
		setRoomDepth,
	};
}

export type RoomEngine = ReturnType<typeof roomEngine>;
```

Note on `setting`: TS may not infer `V` from `wall.setWallToCeiling` etc.; if typecheck complains, give each an explicit type argument, e.g. `setting<"wallToCeiling", boolean>("wallToCeiling", wall.setWallToCeiling)`.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run src/lib/planner/__tests__/room.test.ts && pnpm typecheck && pnpm biome check --write src/lib/planner/room.ts src/lib/planner/__tests__/room.test.ts`
Expected: PASS. (`minWallWidthMm` for a right corner: base at 2000 w600 ends at 2600, + 607 = 3207.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/planner/room.ts src/lib/planner/__tests__/room.test.ts
git commit -m "feat(planner): a room is runs, each placed by the one-wall engine

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Shape, corner units, exposure and the corner worktop

**Files:**
- Modify: `src/lib/planner/room.ts`
- Test: `src/lib/planner/__tests__/room.test.ts`

**Interfaces:**
- Consumes: Task 3's `roomEngine` internals; `spreadMm`, `inRun`, `newId`, `type EndPanel` from `layout.ts`; `constructionOf` from `catalogue.ts`; `type ExposedSides` from `exposure.ts`.
- Produces (added to `roomEngine`'s return): `setShape(room, shape: RoomShape)`, `setCornerSide(room, side)`, `placeCorner(room, familyId, id?)`, `cornerPositions(room): Positioned[]` (in main-run coordinates; right-corner units carry `rotationDeg: 270`), `exposureOf(room): Map<string, ExposedSides>`, `endPanels(room): EndPanel[]`, `cornerWorktop(room): { sizeMm: number; topMm: number } | null`. `addModule`/`fits` route corner families to `placeCorner`; `allPositions` includes corner units; `widthOptionsFor` answers for corner units.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/planner/__tests__/room.test.ts`:

```ts
const kitchen = () => emptyRoom(4200);

describe("setShape", () => {
	it("an L adds an empty side wall and corner", () => {
		const room = engine.setShape(kitchen(), "left");
		expect(room.runs).toHaveLength(2);
		expect(room.corner).toEqual({ side: "left", floor: null, wall: null });
	});

	it("moves a cabinet already in the corner out of it", () => {
		const straight = engine.addModule(kitchen(), "base-cabinet", 0, "a", 600);
		const room = engine.setShape(straight, "left");
		expect(room.runs[0].floor[0].xMm).toBe(607);
	});

	it("refuses to go straight while the side wall holds a cabinet", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "s", 600, 1);
		expect(engine.setShape(room, "straight")).toBe(room);
		const cleared = engine.removeModule(room, "s");
		expect(engine.setShape(cleared, "straight").runs).toHaveLength(1);
	});

	it("refuses to go straight while the corner holds a unit", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(engine.setShape(room, "straight")).toBe(room);
	});
});

describe("setCornerSide", () => {
	it("keeps every cabinet the same distance from the corner", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 1000, "m", 600);
		room = engine.addModule(room, "base-cabinet", 1000, "s", 600, 1);
		const flipped = engine.setShape(room, "right");
		expect(flipped.corner?.side).toBe("right");
		expect(flipped.runs[0].floor[0].xMm).toBe(4200 - 1000 - 600);
		expect(flipped.runs[1].floor[0].xMm).toBe(3600 - 1000 - 600);
		expect(engine.isClear(flipped)).toBe(true);
	});
});

describe("corner units", () => {
	it("fill their row's slot and push both runs clear of the bigger square", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(room.corner?.floor?.familyId).toBe("corner-base");
		expect(room.runs[0].floor[0].xMm).toBe(900);
		expect(room.runs.flatMap((run) => run.floor)).toHaveLength(1);
	});

	it("go to the wall slot when they hang", () => {
		const room = engine.addModule(
			engine.setShape(kitchen(), "right"),
			"corner-wall",
			0,
			"cw",
		);
		expect(room.corner?.wall?.familyId).toBe("corner-wall");
		expect(room.corner?.floor).toBeNull();
	});

	it("are refused on a straight wall and in a full slot", () => {
		const straight = kitchen();
		expect(engine.addModule(straight, "corner-base", 0)).toBe(straight);
		expect(engine.fits(straight, "corner-base")).toBe(false);

		const full = engine.addModule(engine.setShape(kitchen(), "left"), "corner-base", 0, "c");
		expect(engine.addModule(full, "corner-base", 0, "d")).toBe(full);
		expect(engine.fits(full, "corner-base")).toBe(false);
	});

	it("are refused when a run cannot give way", () => {
		// A side wall packed from the front to the corner has nowhere to slide.
		let room = engine.setShape({ ...kitchen(), roomDepthMm: 2000 }, "right");
		room = engine.addModule(room, "base-cabinet", 607, "s1", 900, 1);
		room = engine.addModule(room, "base-cabinet", 1507, "s2", 400, 1);
		expect(engine.fits(room, "corner-base")).toBe(false);
	});

	it("sit at the corner end of the main wall, turned for a right corner", () => {
		const left = engine.addModule(engine.setShape(kitchen(), "left"), "corner-base", 0, "c");
		expect(engine.cornerPositions(left)[0]).toMatchObject({ xMm: 0 });
		expect(engine.cornerPositions(left)[0].placed.rotationDeg).toBeUndefined();

		const right = engine.setShape(left, "right");
		expect(engine.cornerPositions(right)[0]).toMatchObject({ xMm: 3300 });
		expect(engine.cornerPositions(right)[0].placed.rotationDeg).toBe(270);
	});

	it("are priced, listed and removed like any cabinet", () => {
		const room = engine.addModule(engine.setShape(kitchen(), "left"), "corner-base", 0, "c");
		expect(engine.allPositions(room).map((p) => p.placed.id)).toEqual(["c"]);
		expect(engine.widthOptionsFor(room, "c")).toEqual([
			{ widthMm: 900, priceRm: 1150, fits: true },
		]);
		expect(engine.removeModule(room, "c").corner?.floor).toBeNull();
		expect(setDoor(room, "c", "shaker").corner?.floor?.doorStyleId).toBe("shaker");
	});
});

describe("exposure beside the corner", () => {
	it("an empty corner leaves the end beside it in the open", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		expect(engine.exposureOf(room).get("a")?.left).toBe(true);
		expect(engine.endPanels(room).some((p) => p.moduleId === "a" && p.side === "left")).toBe(true);
	});

	it("a corner unit covers the end beside it and wears no panels itself", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		room = engine.addModule(room, "corner-base", 0, "c");
		expect(engine.exposureOf(room).get("a")?.left).toBe(false);
		expect(engine.exposureOf(room).get("c")).toEqual({ left: false, right: false });
		expect(engine.endPanels(room).some((p) => p.moduleId === "c")).toBe(false);
	});
});

describe("cornerWorktop", () => {
	it("is none on a straight wall or an L with no base beside the corner", () => {
		expect(engine.cornerWorktop(kitchen())).toBeNull();
		expect(engine.cornerWorktop(engine.setShape(kitchen(), "left"))).toBeNull();
	});

	it("closes an empty corner when a base unit meets it", () => {
		let room = engine.setShape(kitchen(), "left");
		room = engine.addModule(room, "base-cabinet", 0, "a", 600);
		expect(engine.cornerWorktop(room)).toEqual({ sizeMm: 607, topMm: 880 });
	});

	it("covers a corner base unit", () => {
		const room = engine.addModule(engine.setShape(kitchen(), "left"), "corner-base", 0, "c");
		expect(engine.cornerWorktop(room)).toEqual({ sizeMm: 900, topMm: 880 });
	});
});
```

Add `setDoor` to the `../room` import at the top of the file. The seed's door style ids are whatever `PLANNER_CATALOGUE.doorStyles` holds — if `"shaker"` is not one of them, use `PLANNER_CATALOGUE.doorStyles[1].id` instead.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/planner/__tests__/room.test.ts`
Expected: FAIL — `engine.setShape is not a function`.

- [ ] **Step 3: Implement in `src/lib/planner/room.ts`**

3a. Imports: add `constructionOf` to the `./catalogue` import; add `type EndPanel`, `inRun`, `newId`, `spreadMm` to the `./layout` import; add `import type { ExposedSides } from "./exposure";`.

3b. Inside `roomEngine`, after `pooled`, add:

```ts
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
			return [{ placed: shown, family, widthMm: placed.widthMm, xMm: span.startMm }];
		});
	}

	/**
	 * Slide one row of every run away from the corner until nothing is inside
	 * its square. Every module in the row moves by the same amount, so the run
	 * keeps its own order and gaps; `isClear` decides afterwards whether the
	 * wall had the room.
	 */
	function clearCorner(room: RoomLayout, row: Row): RoomLayout {
		return room.runs.reduce((next, _, run) => {
			const view = runView(next, run);
			const span = view.reserved?.[row];
			if (!span) return next;
			const atStart = span.startMm === 0;
			const needMm = Math.max(
				0,
				...wall.positionsOf(view, row).map((position) => {
					const spread = spreadMm(position);
					return atStart
						? span.endMm - (position.xMm - spread)
						: position.xMm + position.widthMm + spread - span.startMm;
				}),
			);
			if (needMm === 0) return next;
			const shiftMm = atStart ? needMm : -needMm;
			return withRun(next, run, {
				...view,
				[row]: view[row].map((module) => ({ ...module, xMm: module.xMm + shiftMm })),
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
		const next = clearCorner({ ...room, corner: { ...room.corner, [row]: placed } }, row);
		return views(next).every((view) => wall.isClear(view)) ? next : room;
	}

	function setCornerSide(room: RoomLayout, side: CornerSide): RoomLayout {
		if (!room.corner || room.corner.side === side) return room;
		const mirror = (lengthMm: number) => (module: PlacedModule): PlacedModule => ({
			...module,
			xMm: lengthMm - module.xMm - module.widthMm,
			...(module.rotationDeg ? { rotationDeg: (360 - module.rotationDeg) % 360 } : {}),
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
		const next = clearCorner(
			clearCorner(
				{
					...room,
					runs: [room.runs[0], { floor: [], wall: [] }],
					corner: { side: shape, floor: null, wall: null },
				},
				"floor",
			),
			"wall",
		);
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
						left: sides.left && Math.abs(position.xMm - spread - span.endMm) > touchingMm,
						right:
							sides.right &&
							Math.abs(position.xMm + position.widthMm + spread - span.startMm) >
								touchingMm,
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
```

3c. Route corner families. In `addModule`, replace the guard line with:

```ts
		if (!family) return room;
		if (isCorner(family)) return placeCorner(room, familyId, id);
		if (run >= room.runs.length) return room;
```

In `fits`, replace the guard line with:

```ts
		if (!family) return false;
		if (isCorner(family)) return placeCorner(room, familyId, "probe") !== room;
		if (run >= room.runs.length) return false;
```

3d. In the returned object: change `allPositions` to

```ts
		allPositions: (room: RoomLayout): Positioned[] => [
			...views(room).flatMap((view) => wall.allPositions(view)),
			...cornerPositions(room),
		],
```

change `widthOptionsFor` to

```ts
		widthOptionsFor: (room: RoomLayout, id: string) => {
			const run = runIndexOf(room, id);
			if (run >= 0) return wall.widthOptionsFor(runView(room, run), id);
			const unit = cornerPositions(room).find((p) => p.placed.id === id);
			return unit
				? [{ widthMm: unit.widthMm, priceRm: unit.family.sizes[0].priceRm, fits: true }]
				: [];
		},
```

and add `setShape, setCornerSide, placeCorner, cornerPositions, exposureOf, endPanels, cornerWorktop,` to it.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run src/lib/planner/__tests__/room.test.ts && pnpm test && pnpm typecheck && pnpm biome check --write src/lib/planner/room.ts src/lib/planner/__tests__/room.test.ts`
Expected: PASS. If "are refused when a run cannot give way" passes vacuously because the second add was refused, assert `room.runs[1].floor` has length 2 before the `fits` expectation and pick widths that fill `[607, 2000]` exactly (900 + 493 is not on the ladder — use 900 then 400 as written: 607+900=1507, 1507+400=1907, leaving 93 mm, which is less than the 293 mm a 900 corner needs).

- [ ] **Step 5: Commit**

```bash
git add src/lib/planner/room.ts src/lib/planner/__tests__/room.test.ts
git commit -m "feat(planner): L shape, corner units, and what a corner covers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Price a room

**Files:**
- Modify: `src/lib/planner/pricing.ts`
- Test: `src/lib/planner/__tests__/pricing.test.ts`

**Interfaces:**
- Consumes: `roomEngine`, `type RoomLayout`, `asRoom` from `room.ts`.
- Produces: `worktopFt(room: RoomLayout, catalogue)`, `ceilingTrimFt(room, catalogue)`, `skirtingFt(room, catalogue)`, `endPanelPriceRm(room, catalogue)`, `computePlannerPrice(room: RoomLayout, finish, catalogue)` — same return shapes as today.

- [ ] **Step 1: Point the existing tests at rooms, and add the L tests**

In `src/lib/planner/__tests__/pricing.test.ts`, replace the `from "../pricing"` import block with:

```ts
import {
	ceilingTrimFt as roomCeilingTrimFt,
	computePlannerPrice as roomPrice,
	endPanelPriceRm as roomEndPanelPriceRm,
	MM_PER_FT,
	skirtingFt as roomSkirtingFt,
	WORKTOP_RM_PER_FT,
	worktopFt as roomWorktopFt,
} from "../pricing";
import { asRoom, emptyRoom, roomEngine } from "../room";
import type { PlannerCatalogue } from "../catalogueSchema";

/** These tests were written against one wall; a straight room is one run. */
const worktopFt = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomWorktopFt(asRoom(l), c);
const ceilingTrimFt = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomCeilingTrimFt(asRoom(l), c);
const skirtingFt = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomSkirtingFt(asRoom(l), c);
const endPanelPriceRm = (l: PlannerLayout, c: PlannerCatalogue) =>
	roomEndPanelPriceRm(asRoom(l), c);
const computePlannerPrice = (
	l: PlannerLayout,
	f: Parameters<typeof roomPrice>[1],
	c: PlannerCatalogue,
) => roomPrice(asRoom(l), f, c);
```

(If the file already imports `PlannerCatalogue`, don't import it twice. If any call passes fewer arguments than these wrappers take, make that parameter optional with `= PLANNER_CATALOGUE`.)

Append:

```ts
describe("an L-shaped room", () => {
	const rooms = roomEngine(PLANNER_CATALOGUE);
	const finish = PLANNER_CATALOGUE.finishes[0].id;

	const lWithBases = () => {
		let room = rooms.setShape(emptyRoom(4200), "left");
		room = rooms.addModule(room, "base-cabinet", 0, "m", 600);
		room = rooms.addModule(room, "base-cabinet", 3600, "s", 600, 1);
		return room;
	};

	it("runs the worktop along both walls and across the corner once", () => {
		expect(roomWorktopFt(lWithBases(), PLANNER_CATALOGUE)).toBeCloseTo(
			(600 + 600 + 607) / MM_PER_FT,
		);
	});

	it("charges a corner unit as a cabinet, and its square of worktop", () => {
		const room = rooms.addModule(lWithBases(), "corner-base", 0, "c");
		const price = roomPrice(room, finish, PLANNER_CATALOGUE);
		expect(price.cabinets.map((line) => line.id).sort()).toEqual(["c", "m", "s"]);
		expect(price.worktopFt).toBeCloseTo((600 + 600 + 900) / MM_PER_FT);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/planner/__tests__/pricing.test.ts`
Expected: FAIL — the L tests fail (the one-wall pricing reads `layout.floor`, which a room does not have); the older tests may also fail for the same reason.

- [ ] **Step 3: Implement in `src/lib/planner/pricing.ts`**

- Replace the `layout` import: import `type PlannerLayout` no longer; import `inRun, type Positioned` from `./layout` as before, and add `import { type RoomLayout, roomEngine } from "./room";`. Remove `plannerEngine` from the `./layout` import if nothing else uses it.
- In all five exported functions change the parameter type `layout: PlannerLayout` to `layout: RoomLayout` and every `plannerEngine(catalogue)` to `roomEngine(catalogue)`.
- `worktopFt` body:

```ts
	const engine = roomEngine(catalogue);
	const mm = layout.runs
		.flatMap((_, run) => engine.positionsOf(layout, "floor", run))
		.filter((position) => position.family.kind === "base")
		// A cabinet lifted off the floor or turned off the wall has left the
		// counter run, and the scene draws no slab over it. The same predicate
		// on both sides is what keeps the drawn slab and the billed slab the
		// same slab — see `inRun`.
		.filter(inRun)
		.reduce((total, position) => total + position.widthMm, 0);
	// The square where two runs meet is one piece of worktop, counted once.
	return ftOf(mm + (engine.cornerWorktop(layout)?.sizeMm ?? 0));
```

- `ceilingTrimFt` body after the `wallToCeiling` guard:

```ts
	const engine = roomEngine(catalogue);
	const mm = [
		...layout.runs.flatMap((_, run) => engine.positionsOf(layout, "wall", run)),
		...engine.cornerPositions(layout).filter((p) => p.family.kind === "wall"),
	].reduce((total, position) => total + position.widthMm, 0);
	return ftOf(mm);
```

- `skirtingFt` body:

```ts
	const engine = roomEngine(catalogue);
	const mm = layout.runs
		.flatMap((_, run) => engine.skirtingSpans(layout, run))
		.reduce((total, span) => total + (span.endMm - span.startMm), 0);
	return ftOf(mm);
```

- In `computePlannerPrice`, replace the `placed` array with `const placed: Positioned[] = engine.allPositions(layout);`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/lib/planner/__tests__/pricing.test.ts && pnpm test`
Expected: pricing tests PASS. `pnpm typecheck` will now FAIL in the orders code and UI callers that still pass a `PlannerLayout` — expected; Tasks 6 and 8 fix them. Confirm the only errors are in `src/lib/orders`, `src/app`, `src/components`.

- [ ] **Step 5: Commit**

```bash
pnpm biome check --write src/lib/planner/pricing.ts src/lib/planner/__tests__/pricing.test.ts
git add src/lib/planner/pricing.ts src/lib/planner/__tests__/pricing.test.ts
git commit -m "feat(pricing): price every run of a room, and the corner once

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Orders store and validate a room (design v2)

**Files:**
- Modify: `src/lib/orders/layoutSchema.ts`, `src/lib/orders/validate.ts`, `src/lib/orders/price.ts`, `src/lib/orders/items.ts`, `src/app/api/orders/route.ts`
- Test: `src/lib/orders/__tests__/orders.test.ts`

**Interfaces:**
- Consumes: `RoomLayout`, `asRoom`, `roomEngine`, `isCorner`.
- Produces: `roomLayoutSchema` (zod, `satisfies z.ZodType<RoomLayout>`), `ORDER_DESIGN_VERSION = 2`, `OrderDesign = { schemaVersion: 2; layout: RoomLayout }`, `orderDesignSchema` accepting v1 and v2 and always outputting v2; `validateOrder(layout: RoomLayout, …)`, `priceOrder(layout: RoomLayout, …)`, `deliveryItemsFor(layout: RoomLayout, …)`.

- [ ] **Step 1: Point the tests at rooms and add the new ones**

In `src/lib/orders/__tests__/orders.test.ts`:
- Change `import { plannerLayoutSchema } from "../layoutSchema";` to `import { orderDesignSchema, plannerLayoutSchema, roomLayoutSchema } from "../layoutSchema";`.
- Add `import { asRoom, emptyRoom, roomEngine } from "@/lib/planner/room";`.
- Change `check` to `validateOrder(asRoom(layout), "kitchen", finishId, cat)`.
- Wrap every other `validateOrder(`, `priceOrder(`, `deliveryItemsFor(` and `computePlannerPrice(` call in this file so its layout argument is `asRoom(<layout>)`.

Append:

```ts
describe("an L-shaped order", () => {
	const rooms = roomEngine(catalogue);
	const lKitchen = () => {
		let room = rooms.setShape(emptyRoom(4200), "left");
		room = rooms.addModule(room, inKitchen.id, 0, "m", inKitchen.sizes[0].widthMm);
		return rooms.addModule(room, "corner-base", 0, "c");
	};
	const checkRoom = (room: ReturnType<typeof lKitchen>) =>
		validateOrder(room, "kitchen", finishId, catalogue);

	it("accepts an L the planner built", () => {
		expect(checkRoom(lKitchen())).toEqual({ ok: true });
	});

	it("refuses a corner unit standing in a run", () => {
		const room = lKitchen();
		const corner = room.corner?.floor;
		if (!corner) throw new Error("fixture lost its corner");
		const tampered = {
			...room,
			corner: { ...room.corner!, floor: null },
			runs: [{ ...room.runs[0], floor: [...room.runs[0].floor, { ...corner, xMm: 2000 }] }, room.runs[1]],
		};
		expect(checkRoom(tampered)).toMatchObject({ problem: "does_not_fit", moduleId: "c" });
	});

	it("refuses an ordinary cabinet in the corner slot", () => {
		const room = lKitchen();
		const tampered = {
			...room,
			corner: { ...room.corner!, floor: { ...room.corner!.floor!, familyId: inKitchen.id, widthMm: inKitchen.sizes[0].widthMm } },
		};
		expect(checkRoom(tampered)).toMatchObject({ problem: "does_not_fit", moduleId: "c" });
	});

	it("refuses a cabinet pushed into the corner square", () => {
		const room = structuredClone(lKitchen());
		room.runs[0].floor[0].xMm = 0;
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit" });
	});
});

describe("roomLayoutSchema", () => {
	it("refuses a side wall with no corner, and a corner with no side wall", () => {
		const straight = emptyRoom(4200);
		expect(
			roomLayoutSchema.safeParse({ ...straight, runs: [straight.runs[0], { floor: [], wall: [] }] }).success,
		).toBe(false);
		expect(
			roomLayoutSchema.safeParse({ ...straight, corner: { side: "left", floor: null, wall: null } }).success,
		).toBe(false);
	});
});

describe("orderDesignSchema", () => {
	it("reads an order placed before L-shapes as a one-wall room", () => {
		const layout = twoCabinets();
		const parsed = orderDesignSchema.parse({ schemaVersion: 1, layout });
		expect(parsed.schemaVersion).toBe(2);
		expect(parsed.layout.runs).toEqual([{ floor: layout.floor, wall: layout.wall }]);
		expect(parsed.layout.corner).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/orders/__tests__/orders.test.ts`
Expected: FAIL — `roomLayoutSchema` not exported; validators read `layout.floor`.

- [ ] **Step 3: `src/lib/orders/layoutSchema.ts`**

Replace from `export const plannerLayoutSchema` to the end of the file with:

```ts
const settings = {
	wallWidthMm: z.number().positive(),
	roomDepthMm: z.number().positive(),
	ceilingHeightMm: z.number().positive(),
	hangingHeightMm: z.number().min(0),
	wallToCeiling: z.boolean(),
	baseSkirting: z.boolean(),
	wallToWall: z.boolean(),
};

/** One wall, as orders stored it before L-shapes (design v1). */
export const plannerLayoutSchema = z.object({
	...settings,
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
}) satisfies z.ZodType<PlannerLayout>;

const runSchema = z.object({
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
});

/** The room document: one wall, or two meeting at a corner. */
export const roomLayoutSchema = z
	.object({
		...settings,
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
	}) satisfies z.ZodType<RoomLayout>;

/**
 * What an order stores. The version is the promise that an order placed today
 * still reads after the layout changes shape — CLAUDE.md's `schemaVersion`
 * rule. Version 1 stored one wall's rows at the top level; it is read as a
 * one-wall room, so every reader downstream only ever sees version 2.
 */
export const ORDER_DESIGN_VERSION = 2;

export type OrderDesign = {
	schemaVersion: typeof ORDER_DESIGN_VERSION;
	layout: RoomLayout;
};

export const orderDesignSchema = z.union([
	z.object({ schemaVersion: z.literal(2), layout: roomLayoutSchema }),
	z
		.object({ schemaVersion: z.literal(1), layout: plannerLayoutSchema })
		.transform(({ layout }) => ({
			schemaVersion: 2 as const,
			layout: asRoom(layout),
		})),
]);
```

Update the file's imports: `import type { PlannerLayout } from "@/lib/planner/layout";` and `import { asRoom, type RoomLayout } from "@/lib/planner/room";`.

- [ ] **Step 4: `src/lib/orders/validate.ts`**

- Imports: add `isCorner` to the `@/lib/planner/catalogue` import; replace the `@/lib/planner/layout` import with `import { rowFor, WALL_LIMITS } from "@/lib/planner/layout";` and add `import { type RoomLayout, roomEngine } from "@/lib/planner/room";`.
- Signature: `layout: RoomLayout`.
- Replace the `rows` construction with:

```ts
	const rows = [
		...layout.runs.flatMap((run) => [
			...run.floor.map((placed) => ({ placed, row: "floor" as const, corner: false })),
			...run.wall.map((placed) => ({ placed, row: "wall" as const, corner: false })),
		]),
		...(["floor", "wall"] as const).flatMap((row) => {
			const placed = layout.corner?.[row];
			return placed ? [{ placed, row, corner: true }] : [];
		}),
	];
```

- `const engine = plannerEngine(catalogue);` → `const engine = roomEngine(catalogue);`
- In the loop, destructure `corner` too (`for (const { placed, row, corner } of rows)`) and directly after `if (rowFor(family.kind) !== row) return fail("does_not_fit");` add:

```ts
		// A corner unit belongs in the corner and only there.
		if (isCorner(family) !== corner) return fail("does_not_fit");
```

- After the `overhanging` check, before `return { ok: true };`, add:

```ts
	// A cabinet inside the corner square, or a corner square grown into a run,
	// is not a design anyone can fit.
	if (!engine.isClear(layout)) return { ok: false, problem: "does_not_fit" };
```

- [ ] **Step 5: `price.ts`, `items.ts`, route**

- `src/lib/orders/price.ts`: `import type { RoomLayout } from "@/lib/planner/room";`, parameter `layout: RoomLayout`, drop the `PlannerLayout` import.
- `src/lib/orders/items.ts`: `import { type RoomLayout, roomEngine } from "@/lib/planner/room";`, parameter `layout: RoomLayout`, `plannerEngine(catalogue).allPositions(layout)` → `roomEngine(catalogue).allPositions(layout)`; drop the layout import.
- `src/app/api/orders/route.ts`: import `roomLayoutSchema` instead of `plannerLayoutSchema`, and use it for the body's `layout` field.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run src/lib/orders && pnpm test`
Expected: PASS. `pnpm typecheck` errors remain only under `src/components` and `src/app/[lang]` (Task 8).

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src/lib/orders src/app/api/orders/route.ts
git add src/lib/orders src/app/api/orders/route.ts
git commit -m "feat(orders): store and validate a room, reading v1 orders as one wall

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Corner categories in the design library, and a mock corner design

**Files:**
- Modify: `prisma/schema.prisma:62-68`
- Create: `prisma/migrations/20260916000000_corner_categories/migration.sql`
- Modify: `src/lib/catalogue/cabinetDesignLabels.ts`, `src/lib/mesh/measureDesign.ts:28-33`, `src/app/api/admin/cabinet-designs/route.ts:19-25`, `src/app/api/admin/cabinet-designs/[id]/route.ts:20-27`
- Create: `src/lib/mesh/__tests__/cornerMock.ts`, `src/lib/mesh/__tests__/cornerMock.test.ts`, `scripts/generate-corner-mock.ts`

**Interfaces:**
- Produces: `cornerObj(size: { sizeMm: number; heightMm: number; armMm: number; legMm: number }): string` — OBJ text in millimetres, Y up, +z toward the room, drawn for the left corner.

- [ ] **Step 1: Write the failing mesh test**

Create `src/lib/mesh/__tests__/cornerMock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { measureDesign } from "../measureDesign";
import { buildRenderMesh } from "../renderMesh";
import { cornerObj } from "./cornerMock";

/**
 * EzCabinet has not drawn a corner unit yet. The mock stands in for one, in
 * their own part naming, so the upload path can be exercised end to end. These
 * pin that it reads as the thing it pretends to be.
 */
const base = cornerObj({ sizeMm: 900, heightMm: 870, armMm: 600, legMm: 100 });

describe("the mock corner base", () => {
	it("measures as a square unit", () => {
		const measured = measureDesign(base);
		expect(measured).toMatchObject({ widthMm: 900, heightMm: 870, depthMm: 900 });
	});

	it("classifies its fronts, so the finish picker and door toggle reach them", () => {
		const roles = buildRenderMesh(base)?.groups.map((group) => group.role) ?? [];
		expect(roles).toContain("door");
		expect(roles).toContain("carcass");
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/mesh/__tests__/cornerMock.test.ts`
Expected: FAIL — `Cannot find module './cornerMock'`.

- [ ] **Step 3: Write the generator**

Create `src/lib/mesh/__tests__/cornerMock.ts`:

```ts
/**
 * A mock L-shaped corner unit as OBJ text, in EzCabinet's SketchUp part naming.
 *
 * Millimetres, Y up, +z out into the room, drawn for the **left-hand** corner:
 * one arm runs along the back wall (x), the other along the left wall (z), and
 * the doors face into the L. Every part is a box, which is all `readObj` reads.
 *
 * Throwaway: replace with the client's real export when they draw one.
 */
type Box = { name: string; min: [number, number, number]; max: [number, number, number] };

function boxObj(box: Box, offset: number): string {
	const [x0, y0, z0] = box.min;
	const [x1, y1, z1] = box.max;
	const v = [
		[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
		[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
	];
	const faces = [
		[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2],
		[2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1],
	];
	return [
		`o ${box.name}`,
		...v.map((p) => `v ${p.join(" ")}`),
		...faces.map((f) => `f ${f.map((i) => i + offset).join(" ")}`),
	].join("\n");
}

export function cornerObj({
	sizeMm: s,
	heightMm: h,
	armMm: a,
	legMm: l,
}: {
	sizeMm: number;
	heightMm: number;
	armMm: number;
	legMm: number;
}): string {
	const t = 16; // board
	const boxes: Box[] = [
		{ name: "G-UBack", min: [0, l, 0], max: [s, h, t] },
		{ name: "G-UBack_Return", min: [0, l, 0], max: [t, h, s] },
		{ name: "G-UEnd_(R)", min: [s - t, l, 0], max: [s, h, a] },
		{ name: "G-UEnd_(L)", min: [0, l, s - t], max: [a, h, s] },
		{ name: "G-Bottom", min: [0, l, 0], max: [s, l + t, a] },
		{ name: "G-Bottom_Return", min: [0, l, a], max: [a, l + t, s - t] },
		{ name: "G-Top", min: [0, h - t, 0], max: [s, h, a] },
		{ name: "G-Top_Return", min: [0, h - t, a], max: [a, h, s - t] },
		{ name: "G-Adjustable_Shelf", min: [t, (l + h) / 2, t], max: [s - t, (l + h) / 2 + t, a - t] },
		{ name: "Door_L_", min: [a, l + t, a - 18], max: [s - t, h - t, a] },
		{ name: "Door_R_", min: [a - 18, l + t, a], max: [a, h - t, s - t] },
		// A wall unit hangs, so it has no feet.
		...(l > 0
			? [
					[40, 40],
					[s - 90, 40],
					[40, s - 90],
					[a - 90, a - 90],
				]
			: []
		).map(([x, z], i) => ({
			name: `Leveller_${i + 1}`,
			min: [x, 0, z] as [number, number, number],
			max: [x + 50, l, z + 50] as [number, number, number],
		})),
	];
	return [
		"# Mock corner unit — see src/lib/mesh/__tests__/cornerMock.ts",
		...boxes.map((box, i) => boxObj(box, i * 8)),
		"",
	].join("\n");
}
```

- [ ] **Step 4: Run the mesh test and watch it fail for the real reason**

Run: `pnpm vitest run src/lib/mesh/__tests__/cornerMock.test.ts`
Expected: FAIL — `measureDesign` reports `{ widthMm: 900, heightMm: 900, depthMm: 870 }`. This is not a mock bug; it is a genuine intake bug every real corner export would hit. `inferUpAxis` in `src/lib/mesh/normalise.ts` settles **depth first as the smallest extent**, which holds for a run and for every single unit so far (BC 800 is 800 × 870 × 588) but not for a corner unit: its footprint is square (900 × 900) and it is *shorter* than it is deep (870), so height is taken for depth and the cabinet is read lying on its back. A 600 × 720 × 600 wall corner has the opposite problem: width and depth tie, `indexOf` picks the first (x, the wall axis), and the axis permutation becomes a reflection — the mesh would render with inward normals.

- [ ] **Step 5: Teach `inferUpAxis` about square footprints and ties**

In `src/lib/mesh/normalise.ts`, add above `inferUpAxis`:

```ts
/**
 * Two extents within this fraction of each other are the same extent.
 *
 * A corner unit's footprint is drawn square on purpose — 900 by 900 — so the
 * two are equal to the drafter's precision. Tight enough that a BC 600 (600
 * wide, 588 deep) still reads as two different sizes.
 */
const SAME_EXTENT = 0.005;

const sameExtent = (a: number, b: number) =>
	Math.abs(a - b) <= Math.max(a, b) * SAME_EXTENT;
```

Then replace the first three lines of `inferUpAxis`'s body (`const axes = …`, `const spans = …`, `const depthAxis = …`) with:

```ts
	const axes = [0, 1, 2] as const;
	const spans = axes.map((axis) => spanOf(parts, axis));
	const [low, mid, high] = [...axes].sort((a, b) => spans[a] - spans[b]);

	// A corner unit: its footprint is square and it is no taller than it is
	// deep, so the smallest extent is its *height* and "depth first" would lay
	// it on its back. The square pair is the floor plan, so up is the odd one out.
	if (sameExtent(spans[mid], spans[high]) && !sameExtent(spans[low], spans[mid])) {
		return {
			upAxis: low,
			// Of the two equal floor axes, the later one is depth: every exporter
			// seen so far runs along the wall on x, and taking x for depth would
			// turn the axis permutation into a mirror image.
			depthAxis: Math.max(mid, high) as 0 | 1 | 2,
			confident: spans[low] * scaleFactor <= CEILING_MM,
		};
	}

	// Width and depth tied (a square wall corner): same rule, later axis is depth.
	const depthAxis = (
		sameExtent(spans[low], spans[mid]) ? Math.max(low, mid) : low
	) as 0 | 1 | 2;
```

Leave the rest of the function (plate voting between the two remaining axes, the confidence checks) unchanged.

Add to `src/lib/mesh/__tests__/cornerMock.test.ts`:

```ts
describe("the mock corner wall unit", () => {
	const wall = cornerObj({ sizeMm: 600, heightMm: 720, armMm: 350, legMm: 0 });

	it("measures with width and depth in the right slots", () => {
		expect(measureDesign(wall)).toMatchObject({
			widthMm: 600,
			heightMm: 720,
			depthMm: 600,
		});
	});
});

describe("the render mesh of a corner base", () => {
	it("stands up, sized [width, depth, height]", () => {
		expect(buildRenderMesh(base)?.sizeMm).toEqual([900, 900, 870]);
	});
});
```

- [ ] **Step 6: Run every mesh test**

Run: `pnpm vitest run src/lib/mesh`
Expected: PASS — the corner tests and every existing pipeline, measureDesign, renderMesh and roles test (no existing fixture has a square footprint or a tied width/depth, so their inferred axes do not move). If an existing test fails, the tolerance is catching a real cabinet: print its spans and tighten `SAME_EXTENT` rather than special-casing the test.

- [ ] **Step 7: The script that writes the files for upload**

Create `scripts/generate-corner-mock.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cornerObj } from "../src/lib/mesh/__tests__/cornerMock";

/**
 * Writes two mock corner designs to upload at /admin/cabinet-designs:
 *   pnpm tsx scripts/generate-corner-mock.ts [outDir]
 * File them as "Corner base cabinet" and "Corner wall cabinet", Kitchen.
 */
const outDir = process.argv[2] ?? "corner-mocks";
mkdirSync(outDir, { recursive: true });
writeFileSync(
	join(outDir, "CB 900mm.obj"),
	cornerObj({ sizeMm: 900, heightMm: 870, armMm: 600, legMm: 100 }),
);
writeFileSync(
	join(outDir, "CW 600mm.obj"),
	cornerObj({ sizeMm: 600, heightMm: 720, armMm: 350, legMm: 0 }),
);
console.log(`wrote ${outDir}/CB 900mm.obj and ${outDir}/CW 600mm.obj`);
```

With `legMm: 0` the generator draws no levellers. Run once: `pnpm tsx scripts/generate-corner-mock.ts /tmp/corner-mocks` — expected output names both files.

- [ ] **Step 8: Database enum and migration**

In `prisma/schema.prisma`, add to `enum CabinetCategory` after `FRIDGE_HOUSING`:

```prisma
  CORNER_BASE_CABINET
  CORNER_WALL_CABINET
```

Create `prisma/migrations/20260916000000_corner_categories/migration.sql`:

```sql
-- Corner units for L-shaped kitchens.
ALTER TYPE "CabinetCategory" ADD VALUE 'CORNER_BASE_CABINET';
ALTER TYPE "CabinetCategory" ADD VALUE 'CORNER_WALL_CABINET';
```

Run: `pnpm prisma generate`. If a local database is running (`pnpm db:up`), also `pnpm prisma migrate deploy`. Do not run migrations against any remote database.

- [ ] **Step 9: Labels, measure type, API enums**

`src/lib/catalogue/cabinetDesignLabels.ts` — add `| "CORNER_BASE_CABINET" | "CORNER_WALL_CABINET"` to `Category`, and to each record:

```ts
// CATEGORIES (append)
	"CORNER_BASE_CABINET",
	"CORNER_WALL_CABINET",
// CATEGORY_LABELS
	CORNER_BASE_CABINET: "Corner base cabinet (draw for the left corner)",
	CORNER_WALL_CABINET: "Corner wall cabinet (draw for the left corner)",
// CATEGORY_SWATCH
	CORNER_BASE_CABINET: "#bfb6a6",
	CORNER_WALL_CABINET: "#98a3ad",
// CATEGORY_TO_KIND
	CORNER_BASE_CABINET: "base",
	CORNER_WALL_CABINET: "wall",
```

`src/lib/mesh/measureDesign.ts` — add the same two members to `DesignCategory`.

Both admin API routes — append `"CORNER_BASE_CABINET", "CORNER_WALL_CABINET",` to the `category` `z.enum([...])` list.

`src/lib/copy/en.ts`, `ms.ts`, `zh.ts` — the planner's `addCabinets.categories` must now carry the new keys (typecheck enforces it):

```ts
// en
				CORNER_BASE_CABINET: "Corner base cabinets",
				CORNER_WALL_CABINET: "Corner wall cabinets",
// ms
				CORNER_BASE_CABINET: "Kabinet sudut bawah",
				CORNER_WALL_CABINET: "Kabinet sudut dinding",
// zh
				CORNER_BASE_CABINET: "转角地柜",
				CORNER_WALL_CABINET: "转角吊柜",
```

- [ ] **Step 10: Tests**

Run: `pnpm test`
Expected: PASS (including `buildCatalogue.test.ts`). `pnpm typecheck` errors remain only in the Task 8 UI files.

- [ ] **Step 11: Commit**

```bash
pnpm biome check --write src/lib/catalogue/cabinetDesignLabels.ts src/lib/mesh src/app/api/admin/cabinet-designs scripts/generate-corner-mock.ts src/lib/copy
git add prisma/schema.prisma prisma/migrations/20260916000000_corner_categories src/lib/catalogue/cabinetDesignLabels.ts src/lib/mesh/measureDesign.ts src/lib/mesh/normalise.ts src/lib/mesh/__tests__/cornerMock.ts src/lib/mesh/__tests__/cornerMock.test.ts scripts/generate-corner-mock.ts src/app/api/admin/cabinet-designs src/lib/copy/en.ts src/lib/copy/ms.ts src/lib/copy/zh.ts
git commit -m "feat(designs): corner categories and a mock corner export

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The client holds a room (still drawn as one wall)

**Files:**
- Modify: `src/components/planner/CatalogueContext.tsx`, `src/app/[lang]/planner/PlannerApp.tsx`, `src/components/planner/StudioScreen.tsx`, `src/components/planner/QuoteScreen.tsx`, `src/components/planner/studio/SelectionPanel.tsx`, `src/components/planner/studio/RoomPanel.tsx`, `src/components/planner/PlannerScene.tsx` (root component only)

**Interfaces:**
- Consumes: `roomEngine`, `RoomLayout`, `emptyRoom`, `runView`, `withRun`, `runIndexOf`, `setDoors`, `setHinge` from `room.ts`.
- Produces: `useRoomEngine(): RoomEngine` from `CatalogueContext.tsx`; `PlannerScene`'s `layout` prop and `onLayoutChangeAction` are `RoomLayout`; `RoomPanel`'s `layout` prop is `RoomLayout`.

This task changes types, not behaviour: after it the planner looks and works exactly as before. Straight rooms only (no UI can make an L yet).

- [ ] **Step 1: `CatalogueContext.tsx`**

```ts
import { type RoomEngine, roomEngine } from "@/lib/planner/room";
// …
type CatalogueValue = {
	catalogue: PlannerCatalogue;
	engine: PlannerEngine;
	rooms: RoomEngine;
};
// in the useMemo:
		() => ({
			catalogue,
			engine: plannerEngine(catalogue),
			rooms: roomEngine(catalogue),
		}),
// at the bottom:
/** The one-wall engine: what the scene's `Run` places a single wall with. */
export const useEngine = (): PlannerEngine => useCatalogueValue().engine;
/** The room engine: what everything holding the stored document uses. */
export const useRoomEngine = (): RoomEngine => useCatalogueValue().rooms;
```

- [ ] **Step 2: `PlannerApp.tsx`**

- `import { emptyLayout, type PlannerLayout } from "@/lib/planner/layout";` → `import { emptyRoom, type RoomLayout } from "@/lib/planner/room";`
- Replace every `PlannerLayout` in the file with `RoomLayout` and `emptyLayout(` with `emptyRoom(`.
- `useEngine()` → `useRoomEngine()` (update the import from `CatalogueContext`).

- [ ] **Step 3: `QuoteScreen.tsx` and `SelectionPanel.tsx`**

- `QuoteScreen.tsx`: `import type { RoomLayout } from "@/lib/planner/room";`, `layout: RoomLayout`, `useEngine()` → `useRoomEngine()`.
- `SelectionPanel.tsx`: replace the `PlannerLayout` type import with `import type { RoomLayout } from "@/lib/planner/room";` and `layout: RoomLayout` (it only reads `hangingHeightMm`).

- [ ] **Step 4: `RoomPanel.tsx`**

`import { WALL_LIMITS } from "@/lib/planner/layout";` + `import type { RoomLayout } from "@/lib/planner/room";`, `layout: RoomLayout`.

- [ ] **Step 5: `StudioScreen.tsx`**

- Imports: remove `type PlannerLayout`, `setDoors`, `setHinge` from the `@/lib/planner/layout` import (keep `rowFor`, `type Positioned` and whatever else it still uses); add `import { runIndexOf, type RoomLayout, setDoors, setHinge } from "@/lib/planner/room";`; `useEngine` → `useRoomEngine`.
- Replace every `PlannerLayout` type with `RoomLayout`.
- `RunList`'s `onResetAction`: `emptyLayout(room.defaultWallWidthMm)` → `emptyRoom(room.defaultWallWidthMm)` (import `emptyRoom` from `@/lib/planner/room`; drop the `emptyLayout` import).
- The initial tool: `layout.floor.length + layout.wall.length === 0` → `allPositions(layout).length === 0` (move the `useRoomEngine()` destructuring above this `useState` if it is below it; it already is above — check).
- `neighboursOf`:

```ts
	const neighboursOf = (position: Positioned) => {
		const run = Math.max(0, runIndexOf(layout, position.placed.id));
		const row = positionsOf(layout, rowFor(position.family.kind), run);
```

- `replaceOptionsFor`: a run cabinet must never be swapped into a corner design, nor a corner unit into an ordinary one (the one-wall `replaceFamily` knows nothing of corners, and checkout would refuse the result). Add `isCorner(family) === isCorner(position.family) &&` as the first condition of its `.filter`, importing `isCorner` from `@/lib/planner/catalogue`.
- `gapCount`: count every run:

```ts
	const gapCount = layout.runs.reduce(
		(total, _, run) =>
			total +
			(["floor", "wall"] as const).reduce(
				(sum, row) =>
					sum +
					freeSpans(layout, row, run).filter(
						(gap) => gap.endMm < rowEndMm(layout, row, run) && gap.startMm > 0,
					).length,
				0,
			),
		0,
	);
```

- [ ] **Step 6: `PlannerScene.tsx` root only**

In the default export `PlannerScene`:
- Props: `layout: RoomLayout;` and `onLayoutChangeAction: (next: RoomLayout) => void;` (import `type RoomLayout, runView, withRun` from `@/lib/planner/room`).
- At the top of the body add `const main = runView(layout, 0);` and change `const runWidthMm = layout.wallWidthMm;` to `const runWidthMm = main.wallWidthMm;`.
- `positioned`/`offsets`: use `main` — `engine.allPositions(main)`, `engine.offsetsOf(main, lonelyId)`.
- `<Room … sideWalls={layout.wallToWall} />` unchanged.
- `<Run layout={main} … onLayoutChange={(next) => onLayoutChangeAction(withRun(layout, 0, next))} />`
- `<PositionDimensions … layout={main} onLayoutChange={(next) => onLayoutChangeAction(withRun(layout, 0, next))} />`
- `PanGizmo`/`FitCamera`: `engine.rowEndMm(main, "floor")`, `engine.positionsOf(main, "floor")`.

- [ ] **Step 7: Typecheck, test, lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all clean. Fix any remaining `PlannerLayout`→`RoomLayout` mismatch the compiler names; do not change engine behaviour to satisfy a type.

- [ ] **Step 8: Smoke test in the browser**

Run `pnpm dev`, open `http://localhost:3000/en/planner`, pick Kitchen, add three cabinets, drag one, resize one, measure, open the quote. Expected: identical to before; no console errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/planner/CatalogueContext.tsx "src/app/[lang]/planner/PlannerApp.tsx" src/components/planner/StudioScreen.tsx src/components/planner/QuoteScreen.tsx src/components/planner/studio/SelectionPanel.tsx src/components/planner/studio/RoomPanel.tsx src/components/planner/PlannerScene.tsx
git commit -m "refactor(planner): the studio holds a room document

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Draw every wall, the corner units and the corner worktop

**Files:**
- Modify: `src/components/planner/PlannerScene.tsx`, `src/components/planner/Room.tsx`

**Interfaces:**
- Consumes: `runView`, `runYawRad`, `withRun` from `room.ts`; `useRoomEngine`.
- Produces: `pickerRef` signature `(clientX: number, clientY: number, run: number) => number`; `Room` prop `walls: { left: boolean; right: boolean }` replacing `sideWalls`; new `PlannerView` member `"side"`.

- [ ] **Step 1: `Room.tsx` — draw each side wall on its own**

Replace the prop `sideWalls = false` / `sideWalls?: boolean` with:

```ts
	walls = { left: false, right: false },
}: {
	width: number;
	depth: number;
	height: number;
	/** Which side walls stand: both for a run built wall to wall, the corner's
	 * side for an L. */
	walls?: { left: boolean; right: boolean };
}) {
```

and the `{sideWalls && (<> …two meshes… </>)}` block with the two meshes each guarded: `{walls.left && (<mesh …left…/>)}` and `{walls.right && (<mesh …right…/>)}` (same positions/rotations/materials as today).

- [ ] **Step 2: Ray helpers take a ray, and a run's ray is turned into its frame**

In `PlannerScene.tsx`:
- Add `Matrix4` and `type Ray` to the `three` import.
- Change `runPointFromRay(e: ThreeEvent<PointerEvent>, planeZ, runWidthMm)` to take `ray: Ray` as its first parameter and read `const { origin, direction } = ray;`. Same for `planPointFromRay(ray: Ray, planeY)`.
- Add below them:

```ts
/**
 * A world ray expressed in a run's own frame.
 *
 * A run's group is only ever turned about the room's vertical axis, never
 * moved — `runView` swaps the room's axes so the turn alone puts the side wall
 * in place — so undoing the turn is the whole transform. The main wall's yaw is
 * zero and its ray is returned as is.
 */
function localRay(e: ThreeEvent<PointerEvent>, yaw: number): Ray {
	return yaw === 0
		? e.ray
		: e.ray.clone().applyMatrix4(new Matrix4().makeRotationY(-yaw));
}

/** A millimetre point turned about the room's vertical axis. */
function turnMm(p: Vec3Mm, yaw: number): Vec3Mm {
	if (yaw === 0) return p;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return { x: p.x * cos + p.z * sin, y: p.y, z: -p.x * sin + p.z * cos };
}
```

- [ ] **Step 3: `Run` learns its yaw, its corner units and the room's exposure**

Add props to `Run`:

```ts
	/** How far this run's group is turned — see `localRay`. */
	yaw: number;
	/** Corner units to draw with this run. Selectable, never dragged: a corner
	 * unit's place is the corner. Empty for every run but the main wall. */
	corners: Positioned[];
	/** The room's answer, not this run's: a corner unit covers the end beside it. */
	exposure: Map<string, ExposedSides>;
	/** The worktop square over the corner, drawn with the main wall. */
	cornerWorktop: { sizeMm: number; topMm: number } | null;
```

(Import `type ExposedSides` from `@/lib/planner/exposure` if not already.)

Inside `Run`:
- Every `runPointFromRay(e, …)` → `runPointFromRay(localRay(e, yaw), …)`; every `planPointFromRay(e, …)` → `planPointFromRay(localRay(e, yaw), …)`.
- In `snapAt`, turn the hit into the run's frame and the answer back out. Replace the `hitMm` construction with:

```ts
		const hitMm: Vec3Mm = turnMm(
			{ x: e.point.x * 1000, y: e.point.y * 1000, z: e.point.z * 1000 },
			-yaw,
		);
```

  and wherever `snapAt` returns a `SnapPoint` built from local geometry, return it with `point: turnMm(point, yaw)` *before* `constrainToAxis` is applied (the anchor is in world space). Concretely: in the rotated-cabinet branch set `point: turnMm(hitMm, yaw)`; after `const snap = snapToCabinet(…)` add `const worldSnap = { ...snap, point: turnMm(snap.point, yaw) };` and use `worldSnap` in the final `return`.
- The exposure memo: the prop is now the answer, so the memo only computes gaps. Replace `const { map: exposure, gaps: sideGaps } = useMemo(() => { … return { map, gaps }; }, [layout, positionsOf, exposureOf]);` with `const sideGaps = useMemo(() => { … return gaps; }, [layout, positionsOf]);` — delete the `const map = exposureOf(layout);` line inside it — and remove `exposureOf` from the engine destructuring. `exposure.get(...)` further down now reads the prop.
- Cabinets: change `{allPositions(layout).map((position) => (` to `{[...allPositions(layout), ...corners].map((position) => (`. In its `onPointerDown`, guard the drag: wrap the `beginDrag(…)` call in `if (!corners.includes(position)) { … }`. For corner positions `floorHeightMmOf(position, layout)` still works (kind is base/wall).
- `MoveHandle` list: `allPositions(layout).filter(...)` stays as is (corners are not in it, so they get no handle).
- After `<Worktop … />` add:

```tsx
			{cornerWorktop && layout.reserved?.floor && (
				<mesh
					position={[
						m(layout.reserved.floor.startMm + cornerWorktop.sizeMm / 2 - runWidthMm / 2),
						m(cornerWorktop.topMm + construction.worktopThicknessMm / 2),
						m((cornerWorktop.sizeMm + 20) / 2),
					]}
				>
					<boxGeometry
						args={[
							m(cornerWorktop.sizeMm),
							m(construction.worktopThicknessMm),
							m(cornerWorktop.sizeMm + 20),
						]}
					/>
					<WorktopMaterial
						width={m(cornerWorktop.sizeMm)}
						depth={m(cornerWorktop.sizeMm + 20)}
					/>
				</mesh>
			)}
```

  (`20` is the same front overhang `Worktop` uses.) For a right corner the reserved floor span is `[W − d, W]`, so the same expression puts the square at the right end.

- [ ] **Step 4: `DropPicker` answers along a chosen run**

Replace `DropPicker`'s props and body:

```tsx
function DropPicker({
	runs,
	pickerRef,
}: {
	/** Per run: its yaw and its length, in `layout.runs` order. */
	runs: { yaw: number; lengthMm: number }[];
	pickerRef: React.RefObject<
		((clientX: number, clientY: number, run: number) => number) | null
	>;
}) {
	const camera = useThree((s) => s.camera);
	const gl = useThree((s) => s.gl);

	useEffect(() => {
		pickerRef.current = (clientX, clientY, run) => {
			const rect = gl.domElement.getBoundingClientRect();
			const ndc = new Vector3(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1,
				0.5,
			);
			const point = ndc.unproject(camera);
			const direction = point.sub(camera.position).normalize();
			// Read against the floor: only the position along the wall matters,
			// and which row the cabinet joins is decided by what was dragged.
			const t =
				Math.abs(direction.y) < 1e-6 ? 0 : -camera.position.y / direction.y;
			const worldX = camera.position.x + direction.x * t;
			const worldZ = camera.position.z + direction.z * t;
			const { yaw, lengthMm } = runs[run] ?? runs[0];
			// The floor point in the run's own frame: undo its turn.
			const localX = worldX * Math.cos(yaw) - worldZ * Math.sin(yaw);
			return localX * 1000 + lengthMm / 2;
		};
		return () => {
			pickerRef.current = null;
		};
	}, [camera, gl, runs, pickerRef]);

	return null;
}
```

- [ ] **Step 5: The root draws one group per run, and a side view**

In the default export `PlannerScene`:
- Replace Task 8's `main`-only wiring. Use `const rooms = useRoomEngine();` and:

```tsx
	const main = runView(layout, 0);
	const runWidthMm = main.wallWidthMm;
	const exposure = useMemo(() => rooms.exposureOf(layout), [rooms, layout]);
	const runs = useMemo(
		() =>
			layout.runs.map((_, i) => ({
				view: runView(layout, i),
				yaw: runYawRad(layout, i),
			})),
		[layout],
	);
	const pickerRuns = useMemo(
		() => runs.map(({ view, yaw }) => ({ yaw, lengthMm: view.wallWidthMm })),
		[runs],
	);
	const lonelyRun = lonelyId
		? runs.findIndex(({ view }) =>
				[...view.floor, ...view.wall].some((m) => m.id === lonelyId),
			)
		: -1;
```

  and compute `positioned`/`offsets` against `runs[lonelyRun].view` when `lonelyRun >= 0` (otherwise `undefined`/`null`).
- `props.layout.prop` for `onLayoutChangeAction` wiring must read the latest room: keep a ref `const roomRef = useRef(layout); roomRef.current = layout;` and write back with `onLayoutChangeAction(withRun(roomRef.current, i, next))`.
- Replace the single `<Run …/>` and `<PositionDimensions …/>` with:

```tsx
			{runs.map(({ view, yaw }, i) => (
				<group key={i} rotation={[0, yaw, 0]}>
					<Run
						layout={view}
						yaw={yaw}
						corners={i === 0 ? rooms.cornerPositions(layout) : []}
						exposure={exposure}
						cornerWorktop={i === 0 ? rooms.cornerWorktop(layout) : null}
						catalogue={catalogue}
						engine={engine}
						finishHex={finishHex}
						finishPhoto={finishPhoto}
						selectedIds={selectedIds}
						openIds={openIds}
						doorsHidden={doorsHidden}
						doorTargetId={doorTargetId}
						measureMode={measureMode}
						measureAxis={measureAxis}
						measureAnchor={measureAnchor}
						onLayoutChange={(next) =>
							onLayoutChangeAction(withRun(roomRef.current, i, next))
						}
						onSelect={onSelectAction}
						onMeasurePick={onMeasurePickAction ?? (() => {})}
						onMeasureHover={setHoverPoint}
						construction={construction}
					/>
					{i === lonelyRun && positioned && offsets && (
						<PositionDimensions
							onLayoutChange={(next) =>
								onLayoutChangeAction(withRun(roomRef.current, i, next))
							}
							position={positioned}
							offsets={offsets}
							layout={view}
							engine={engine}
						/>
					)}
				</group>
			))}
```

  `PositionDimensions` and `MeasureOverlay` draw in world coordinates computed from the unturned run frame; inside the turned group the dimension lines land on the side wall. `MeasureOverlay` stays outside the groups (its points are world points — Step 3 turned them).
- `<Room … walls={{ left: layout.wallToWall || layout.corner?.side === "left", right: layout.wallToWall || layout.corner?.side === "right" }} />`
- `<DropPicker runs={pickerRuns} pickerRef={pickerRef} />`, and update the `pickerRef` prop type to `(clientX: number, clientY: number, run: number) => number`.
- The side view. Change `export type PlannerView = "3d" | "elevation" | "plan";` to add `| "side"`, then:
  - `VIEW_DIRECTION`: add `side: new Vector3(1, 0, 0),` with the comment `/** Facing a left-hand side wall; a right-hand one is looked at from the other side. */`.
  - `PAN_AXES`: add `side: { x: false, y: true, z: true },`.
  - `panAnchor`: `return view === "elevation" || view === "side" ? out.copy(target) : …`.
  - `panPlane`: `view === "side" ? new Plane(new Vector3(1, 0, 0), -target.x) : view === "elevation" ? … : …`.
  - Every other `view === "elevation"` test in the file that means "a flat wall view" (the puck's `rotation` at ~line 496) becomes `view === "elevation" || view === "side"`. The puck is single-sided and must face the camera: in the side view give it `[0, cornerSide === "right" ? -Math.PI / 2 : Math.PI / 2, 0]`, which means `PanGizmo` takes the same `cornerSide` prop as `FitCamera` below; `panPlane` is unaffected (a plane's normal sign does not change where it is).
  - `FitCamera`: add a prop `cornerSide: "left" | "right" | null`. Radius: `view === "side" ? Math.hypot(depth, height) / 2`. Direction: `const direction = view === "side" && cornerSide === "right" ? SIDE_RIGHT_DIRECTION : VIEW_DIRECTION[view];` with module-level `const SIDE_RIGHT_DIRECTION = new Vector3(-1, 0, 0);`, used in `addScaledVector(direction, distance)`. Pass `cornerSide={layout.corner?.side ?? null}` to both `FitCamera` and `PanGizmo`.
  - `OrbitControls` `enableRotate={view === "3d"}` already locks the side view.

- [ ] **Step 6: Typecheck, test, lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: clean. Every holder of `pickerRef` needs the new signature — `StudioScreen`'s `useRef` type, and `QuoteScreen` if it passes one to `PlannerScene`. `dropCarcass` passes `0` as the run for now (Task 10 wires the wall picker).

- [ ] **Step 7: Verify in the browser with a hand-made L**

Temporarily, in `PlannerApp.tsx`'s `initialRooms`, wrap the kitchen with `roomEngine(catalogue).setShape(emptyRoom(room.defaultWallWidthMm), "left")` (do **not** commit this). Run `pnpm dev`, open the kitchen and check:
1. The left side wall is drawn; the 3D view shows both walls.
2. Add a cabinet (click in the menu): it lands on the main wall past the empty corner (607 mm from the left wall).
3. Using the browser console is not available for layout edits, so also temporarily add a side-run cabinet in the same `initialRooms` line (`.addModule(…, "base-cabinet", 2000, "s", 600, 1)` via the room engine) and reload: it stands against the left wall, doors facing into the room.
4. Drag the side-wall cabinet toward the back: it follows the pointer along the side wall and stops 607 mm from the back wall.
5. Measure a side-wall cabinet: the dimension line lands on it.
6. Switch the temporary shape to `"right"` and repeat 1–4 on the right wall.
7. If the seed catalogue is the one running (no published version locally), add `corner-base` to the temporary chain: it renders in the back-left corner as an L; with `"right"` it renders back-right, turned (not mirrored). If it appears turned the wrong way, change `270` in `cornerPositions` to `90` and update its test.

Revert the temporary `initialRooms` change.

- [ ] **Step 8: Commit**

```bash
pnpm biome check --write src/components/planner/PlannerScene.tsx src/components/planner/Room.tsx src/components/planner/StudioScreen.tsx
git add src/components/planner/PlannerScene.tsx src/components/planner/Room.tsx src/components/planner/StudioScreen.tsx
git commit -m "feat(planner): draw each wall of the room, its corner and corner worktop

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The customer's controls

**Files:**
- Modify: `src/components/planner/studio/RoomPanel.tsx`, `src/components/planner/StudioScreen.tsx`, `src/lib/copy/en.ts`, `src/lib/copy/ms.ts`, `src/lib/copy/zh.ts`

**Interfaces:**
- Consumes: `rooms.setShape`, `shapeOf`, `rooms.minRoomDepthMm`, `rooms.fits(…, run)`, `rooms.addModule(…, run)`, `pickerRef(x, y, run)`.
- Produces: `RoomPanel` props `shape: RoomShape`, `canStraighten: boolean`, `minDepthMm: number`, `onShapeAction: (shape: RoomShape) => void`.

- [ ] **Step 1: Copy**

`src/lib/copy/en.ts` — in `planner.room` add:

```ts
			shape: "Layout",
			shapeStraight: "One wall",
			shapeLeft: "L, corner on the left",
			shapeRight: "L, corner on the right",
			shapeLocked: "Clear the side wall and corner to go back to one wall.",
			sideWallLength: "Side wall length",
```

in `planner.addCabinets` add:

```ts
			targetWall: "Add to",
			mainWall: "Main wall",
			sideWall: "Side wall",
```

in `planner.view` add `side: "Side wall",` and in `planner.panel` add `sideHint: "Flat onto the side wall.",`.

`ms.ts` (same keys):

```ts
			shape: "Susun atur",
			shapeStraight: "Satu dinding",
			shapeLeft: "L, sudut di kiri",
			shapeRight: "L, sudut di kanan",
			shapeLocked: "Kosongkan dinding sisi dan sudut untuk kembali ke satu dinding.",
			sideWallLength: "Panjang dinding sisi",
// addCabinets
			targetWall: "Tambah ke",
			mainWall: "Dinding utama",
			sideWall: "Dinding sisi",
// view
			side: "Dinding sisi",
// panel
			sideHint: "Pandangan rata ke dinding sisi.",
```

`zh.ts`:

```ts
			shape: "布局",
			shapeStraight: "一字型",
			shapeLeft: "L型，转角在左",
			shapeRight: "L型，转角在右",
			shapeLocked: "清空侧墙和转角后，才能改回一字型。",
			sideWallLength: "侧墙长度",
// addCabinets
			targetWall: "添加到",
			mainWall: "主墙",
			sideWall: "侧墙",
// view
			side: "侧墙",
// panel
			sideHint: "正对侧墙的立面图。",
```

- [ ] **Step 2: `RoomPanel.tsx` — the shape control**

Add `import type { RoomLayout, RoomShape } from "@/lib/planner/room";` (replacing the type-only `RoomLayout` import). New props:

```ts
	/** One wall, or which side the corner of an L is on. */
	shape: RoomShape;
	/** Whether one wall is still reachable — not while the side wall or corner
	 * holds anything. */
	canStraighten: boolean;
	/** The shortest room the side wall's cabinets fit in. */
	minDepthMm: number;
	onShapeAction: (shape: RoomShape) => void;
```

Directly after the room-type chips `</div>` insert:

```tsx
			<div className="flex flex-col gap-1.5">
				<p className="text-[12px] text-neutral-600">{t.planner.room.shape}</p>
				<div className="flex flex-wrap gap-1">
					{(
						[
							["straight", t.planner.room.shapeStraight],
							["left", t.planner.room.shapeLeft],
							["right", t.planner.room.shapeRight],
						] as const
					).map(([option, label]) => (
						<button
							key={option}
							type="button"
							aria-pressed={shape === option}
							disabled={option === "straight" && shape !== "straight" && !canStraighten}
							onClick={() => onShapeAction(option)}
							className={`${chip(shape === option)} disabled:cursor-not-allowed disabled:text-neutral-300`}
						>
							{label}
						</button>
					))}
				</div>
				{shape !== "straight" && !canStraighten && (
					<p className="text-[11px] text-neutral-500 leading-4">
						{t.planner.room.shapeLocked}
					</p>
				)}
			</div>
```

Change the room-depth field to:

```tsx
			<DimensionField
				label={shape === "straight" ? t.planner.room.roomDepth : t.planner.room.sideWallLength}
				valueMm={layout.roomDepthMm}
				minMm={minDepthMm}
				maxMm={ROOM_DEPTH_LIMITS.maxMm}
				stepMm={50}
				onChangeAction={onDepthAction}
			/>
```

- [ ] **Step 3: `StudioScreen.tsx` — wire the shape, the wall picker, corners and the side view**

- Imports: add `shapeOf` to the `@/lib/planner/room` import; import `chip` from `./studio/chrome` if not already imported.
- Destructure `setShape` and `minRoomDepthMm` from `useRoomEngine()`.
- State: `const [targetRun, setTargetRun] = useState(0);` and `const run = layout.corner ? targetRun : 0;`
- `RoomPanel` gains:

```tsx
			shape={shapeOf(layout)}
			canStraighten={setShape(layout, "straight") !== layout}
			minDepthMm={minRoomDepthMm(layout)}
			onShapeAction={(shape) => {
				track("room_shape_changed", { shape });
				setLayoutAction((prev) => setShape(prev, shape));
			}}
```

  If `track`'s event union in `src/lib/analytics.ts` does not accept `"room_shape_changed"`, add it there as `| { event: "room_shape_changed"; props: { shape: "straight" | "left" | "right" } }` following the existing union's shape (check how other events are declared and copy that form exactly).
- `dropCarcass`: `const runXMm = pickerRef.current?.(clientX, clientY, run) ?? 0;` and `addModule(prev, familyId, runXMm, undefined, undefined, run)`.
- In `addBody`, before `{CATEGORIES.map(…)}` insert:

```tsx
			{layout.corner && (
				<div className="flex flex-col gap-1.5">
					<p className="font-semibold text-[11px] text-neutral-600 uppercase tracking-[0.06em]">
						{t.planner.addCabinets.targetWall}
					</p>
					<div className="flex gap-1">
						{[t.planner.addCabinets.mainWall, t.planner.addCabinets.sideWall].map(
							(label, index) => (
								<button
									key={label}
									type="button"
									aria-pressed={run === index}
									onClick={() => setTargetRun(index)}
									className={chip(run === index)}
								>
									{label}
								</button>
							),
						)}
					</div>
				</div>
			)}
```

- In the category loop, first line inside the callback: `if (category.startsWith("CORNER_") && !layout.corner) return null;`
- `fits(layout, familyId)` → `fits(layout, familyId, undefined, run)`; the click handler's `addModule(prev, familyId, 0)` → `addModule(prev, familyId, 0, undefined, undefined, run)`.
- Views: change `views` to take the room:

```ts
const views = (
	t: Dictionary,
	hasSide: boolean,
): { id: PlannerView; label: string }[] => [
	{ id: "3d", label: t.planner.view.threeD },
	{ id: "elevation", label: t.planner.view.elevation },
	...(hasSide ? [{ id: "side" as const, label: t.planner.view.side }] : []),
	{ id: "plan", label: t.planner.view.plan },
];
```

- A corner unit has no hinge and no turn to offer: its doors are part of the drawing and its place is the corner. Find where the selection's hinge control is rendered (`grep -n "setHinge(prev" src/components/planner/StudioScreen.tsx`) and where the rotate control is (`grep -n "setRotation" src/components/planner/StudioScreen.tsx src/components/planner/studio/SelectionPanel.tsx`), and guard each rendered control with `!isCorner(selected.family)` (import from `@/lib/planner/catalogue`). Move/resize/swap already do nothing for a corner unit — the room engine leaves the room unchanged for an id in no run — so hide those verbs the same way if they render for it.
- Views: call it as `views(t, layout.corner !== null)` (every call site), and extend the hint chain: `option.id === "side" ? t.planner.panel.sideHint : …`. Add an effect so a straightened room leaves the side view:

```ts
	useEffect(() => {
		if (view === "side" && !layout.corner) setView("elevation");
	}, [view, layout.corner]);
```

- [ ] **Step 4: Typecheck, test, lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: clean.

- [ ] **Step 5: Verify in the browser**

`pnpm dev` → `/en/planner` → Kitchen:
1. Room tool → Layout → "L, corner on the left": side wall appears; the depth field reads "Side wall length".
2. Add tool → "Add to: Side wall" → add a base cabinet: it lands on the side wall. Drag it; drag one on the main wall.
3. Corner categories show only in the L. With a published corner design (or the seed), add one: it fills the corner and the worktop joins across it.
4. Try "One wall": disabled with the explanation. Delete the side-wall cabinets and the corner unit: "One wall" works again.
5. Switch between left and right corners with cabinets placed: they stay the same distance from the corner.
6. View → Side wall: a square-on view of the side wall; pan the puck up/down/along.
7. Open the quote: every cabinet, the corner unit and the worktop footage are listed.
8. `/ms/planner` and `/zh/planner`: the new labels are translated.
9. Resize the browser to ~400px wide and repeat 1–2 once.

- [ ] **Step 6: Commit**

```bash
pnpm biome check --write src/components/planner/studio/RoomPanel.tsx src/components/planner/StudioScreen.tsx src/lib/copy src/lib/analytics.ts
git add src/components/planner/studio/RoomPanel.tsx src/components/planner/StudioScreen.tsx src/lib/copy/en.ts src/lib/copy/ms.ts src/lib/copy/zh.ts src/lib/analytics.ts
git commit -m "feat(planner): choose an L, add to either wall, view the side wall

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: End-to-end with an uploaded corner design, and the docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Upload the mock corner designs locally**

With the local database up (`pnpm db:up`, `pnpm prisma migrate deploy`) and `pnpm dev` running:
1. `pnpm tsx scripts/generate-corner-mock.ts /tmp/corner-mocks`
2. `/admin/cabinet-designs` → upload `CB 900mm.obj` as "Corner base cabinet (draw for the left corner)", room Kitchen, price RM 1150; upload `CW 600mm.obj` as the corner wall cabinet, RM 680.
3. The design rows show a triangle count (a mesh converted), not "no mesh — drawn procedurally".
4. Publish.
5. Planner → Kitchen → L → add both corner units. The drawn meshes appear in the corner, doors facing into the L; toggle doors hidden — the corner doors disappear; change finish — the corner fronts take it.
6. Check out the L design (manual bank transfer): the order is created (201) and its admin page lists the corner units.

If step 3 shows "no mesh", read the conversion error in the server log before touching anything; the mock must pass `cornerMock.test.ts` first.

- [ ] **Step 2: Document the room in `CLAUDE.md`**

- In **The core rule** diagram, replace the layout document block with:

```text
Room document (JSON) — RoomLayout, src/lib/planner/room.ts
  ├─ roomId:     kitchen | living | bedroom | foyer
  ├─ wallWidthMm, roomDepthMm, ceilingHeightMm, …   shared settings
  ├─ runs[]:     one per wall — [main] or [main, side]; each { floor[], wall[] }
  │                modules: familyId, widthMm, xMm, doorStyleId
  └─ corner:     { side: left|right, floor, wall } | null — the L's corner units
```

- Under **Directory layout**, add below `layout.ts`:

```text
    room.ts              ← the stored document: runs + corner; each run placed by layout.ts
```

- Add a subsection after **One design, one cabinet**:

```markdown
### One wall or an L

A room is **runs**. Each run is still the one-dimensional thing `layout.ts`
places: `runView` hands a run to that engine as an ordinary `PlannerLayout`,
with the corner square as a `reserved` span, and `withRun` writes its rows back.
No placement rule knows about corners — a corner is one more neighbour in
`occupiedSpans`. A run's `xMm` reads left to right facing that wall from inside
the room, which is what lets the scene draw the side wall with the same `Run`
turned ±90°.

A **corner unit** is an uploaded design filed as `CORNER_BASE_CABINET` or
`CORNER_WALL_CABINET` (`isCorner`), drawn for the **left-hand** corner. The right
corner turns it 270°, never mirrors it. An empty corner still reserves 607 mm
(floor) / 397 mm (wall), so an L is usable before any corner design exists.
Stored orders are design v2; v1 reads as a one-wall room.
```

- Under **Open questions**, add:

```markdown
- **Are a corner unit's ends charged as end panels?** The engine assumes not —
  its ends are part of the drawing (`exposureOf` in `room.ts`). Confirm with
  EzCabinet, and ask whether a kick board runs along a corner unit's faces
  (not drawn or charged yet).
```

- In **Phasing**, Phase 3 row: append `; L-shaped kitchens ✅`.

- [ ] **Step 3: Final checks**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the room document, L shapes and corner units

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
