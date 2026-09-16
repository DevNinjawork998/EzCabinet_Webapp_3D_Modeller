# L-shape kitchen — design

Date: 2026-09-16 · Status: approved in brainstorming, awaiting spec review

## Goal

The planner lays cabinets along one wall. Most kitchens in bungalows and larger
houses are L-shaped. The customer can now choose **straight** or **L**: a main
wall plus a return wall at its left or right end, meeting at a corner that a
dedicated corner cabinet fills.

U-shape is out of scope, but the data model must admit it without a reshape.

## Decisions

| Question | Decision |
| --- | --- |
| Shapes offered | Straight and L. U later. |
| What fills the corner | A **corner design** uploaded by the admin, like every other cabinet — categories `CORNER_BASE_CABINET` and `CORNER_WALL_CABINET`. |
| Corner before one is placed | The square stays reserved and empty; both runs stop at it. The L is usable before any corner design exists. |
| Model | Runs, each still one-dimensional (approach 1). Rejected: a separate `returnRun` field (branches everywhere, reshapes again for U); free 2D placement (throws away snapping, gaps, worktop spans, exposure). |
| Mock data | No real corner export exists yet. A script generates mock corner OBJs in the client's part naming, uploaded through the normal admin flow. |

## 1. Data model

```ts
type Run = { floor: PlacedModule[]; wall: PlacedModule[] };

type PlannerLayout = {
  wallWidthMm; roomDepthMm; ceilingHeightMm; hangingHeightMm;
  wallToCeiling; baseSkirting; wallToWall;      // unchanged, shared by all runs
  runs: [Run] | [Run, Run];   // [main] = straight, [main, return] = L
  corner: {
    side: "left" | "right";   // which end of the main wall the return wall is at
    floor: PlacedModule | null;
    wall: PlacedModule | null;
  } | null;                   // null exactly when runs.length === 1
};
```

- **Main run**: the back wall, length `wallWidthMm`, `xMm` from its left end — as today.
- **Return run**: the side wall on `corner.side`, length `roomDepthMm`, `xMm` from the corner outward toward the front of the room. No new room dimension.
- **Corner square**, per row: the placed corner unit's `widthMm` (a corner unit is square, width = depth), or when the slot is empty the default row depth — 607 floor, 397 wall (the seed `BASE`/`WALL` depths).
- A corner family may only sit in a corner slot, and a corner slot only holds a corner family of that row.
- A straight layout is `runs: [main], corner: null` and behaves exactly as today.
- `emptyLayout` returns a straight layout.

## 2. Engine (`lib/planner/layout.ts`)

Stays framework-free: `(layout, catalogue) => result`.

**Each run is a straight layout.** Engine functions take `(layout, id)` and ids are
unique across the whole layout, so:

- `runOf(layout, id)` — which run holds this module.
- `runView(layout, i)` — a single-wall `PlannerLayout` built from the shared
  settings plus that run's rows, `wallWidthMm` set to the run's length.
- `withRun(layout, i, view)` — writes the view's rows back.

Public functions resolve the run, operate on its view with the existing code, and
write back. Clamp, snap, gaps, rotation, `openRoomFor`, `closeGaps` and `isClear`
are not rewritten.

**The corner square is a reserved span, not a coordinate shift.** `xMm` stays in
true wall coordinates on both runs. The square enters each row's
`occupiedSpans`:

- main run: `[0, d]` when `side` is left, `[W − d, W]` when right;
- return run: always `[0, d]`.

Everything that already respects a neighbour — clamp, snap-to-edge, `freeSpans`,
`isClear`, gap chips — respects the corner through that span. A tall unit is
checked against both rows' corner spans, the same cross-row rule it already has
against wall units.

**New functions**

- `setShape(layout, "straight" | "L", side?)` — adds an empty return run and an
  empty corner, or removes them. Removing is refused while the return run or the
  corner holds anything.
- `setCornerSide(layout, side)` — moves the return wall to the other end; main-run
  modules are mirrored (`x → W − x − width`) so the run keeps its relation to the
  corner.
- `placeCorner(layout, row, familyId)` / `removeCorner(layout, row)` — fills or
  empties a slot. A bigger square than the default is made room for with
  `openRoomFor` on each run; refused only if either run cannot give way.
- `addModule` takes a run index. A drag stays inside its run; moving a cabinet
  between walls is delete and re-add.
- `allModules(layout)` — every placed module across runs and corner slots, for
  consumers that do not care where a cabinet is.
- `minWallWidthMm` and the room-depth minimum include the corner square on their
  run.

## 3. Scene

- One group per run. Main run as today. The return run's group is turned 90° and
  set against the side wall, local x starting at the corner. `Room.tsx` draws the
  corner-side wall whenever the layout is L.
- **Corner unit convention**: the admin draws the unit for the **left** corner —
  back-left, open toward the room. The right corner uses the same mesh turned
  90°, not mirrored: an L-shaped corner unit is symmetric about its diagonal, and a
  mirror would flip triangle winding.
- Picking, drag, snapping, gap chips and the measure tool map the pointer into the
  run's local x through the group's inverse matrix, so they stay one-dimensional.
- Views: 3D frames both walls; plan shows the L; elevation gains a main/side
  toggle, because an elevation is square to one wall.

## 4. Worktop, skirting, exposure, price

- **Worktop**: spans per run as today. A square slab covers the corner when a base
  unit on either run touches the square; pricing counts the square once. Drawn and
  billed slab still read the same predicate.
- **Skirting**: per run as today, plus a kick board along a corner unit's two
  front faces.
- **Exposure**: a filled corner covers the adjacent run ends; an empty corner
  leaves them exposed and charged. A corner unit is never charged end panels — its
  ends belong to the design. *Assumption; confirm with EzCabinet (add to CLAUDE.md
  open questions).*
- **Price**: the corner unit is a cabinet line at its design's all-in price, plus
  the door-style surcharge like any other.
- **Orders**: `validate.ts`, `price.ts` and `items.ts` read `allModules`.
  `validate.ts` also rejects a non-corner family in a corner slot and a corner
  family in a run. `ORDER_DESIGN_VERSION` becomes 2; a stored v1 design
  (`{ floor, wall }`) upgrades on read to `runs: [{ floor, wall }], corner: null`.
  No layout is persisted anywhere else (no drafts in browser storage).

## 5. UI

- **Room panel**: shape control — Straight / L, corner left / L, corner right. The
  side wall's length is the existing room depth field. Straight is disabled, with
  a reason, while the side wall or corner holds cabinets.
- **Add-cabinet menu**: a "Main wall / Side wall" picker, shown only for L. Corner
  categories appear in their own "Corner" group; choosing one fills the slot. The
  group is hidden for straight layouts and disabled when the slot is full.
- **Selection panel**: as today; a corner unit shows no hinge or rotation control.
- All new copy in `en`, `ms` and `zh`.

## 6. Admin, mock designs, tests

- Prisma migration adds `CORNER_BASE_CABINET` and `CORNER_WALL_CABINET`;
  `cabinetDesignLabels` maps them to new kinds `corner-base` / `corner-wall`
  (`rowFor` → floor / wall). The upload form notes "draw for the left corner".
- `scripts/generate-corner-mock.mjs` writes two OBJ files in the client's part
  naming (`G-UEnd_(L)`, `G-UBack`, `Door_L_`, …) so `roles.ts` classifies them:
  a 900×900×870 L-shaped base and a 600×600×720 wall corner. Uploaded through
  `/admin/cabinet-designs`; replaced when real exports arrive.
- Tests first, per convention:
  - `layout.test.ts`: corner blocks both runs in both rows; tall unit vs wall-row
    corner; place and remove a corner, including `openRoomFor` on each run;
    `setShape` refusal; `setCornerSide` mirroring; straight layouts unchanged.
  - `pricing.test.ts`: corner worktop square counted once; corner line priced.
  - Exposure beside a filled and an empty corner.
  - Orders: v1 upgrade; corner family in the wrong slot rejected.
  - Mesh: the mock OBJ measures 900×900×870 and classifies its roles.

## Out of scope

- U-shape (a third run and second corner fit the model).
- Dragging a cabinet between walls.
- Share links.

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
