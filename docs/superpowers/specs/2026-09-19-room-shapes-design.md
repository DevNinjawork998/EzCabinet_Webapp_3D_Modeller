# Room shapes and click-a-wall — design

Date: 2026-09-19. Status: approved in brainstorming, awaiting spec review.

## Why

A room today is one wall or an L (`runs: [main] | [main, side]` plus one
`corner`, `src/lib/planner/room.ts`). A customer cannot describe the kitchen
they actually have: no L-shaped rooms, no U or galley kitchens, cabinets only
on the back wall and one side. IKEA's kitchen planner lets the customer pick a
room shape, set each wall's length, then click any wall to build on it. This
brings that to the planner.

## Decisions

| Question | Decision |
| --- | --- |
| How free is the outline? | Templates with editable wall lengths. Every corner is 90°. |
| Which templates ship? | `rect`, and `l` (a notch cut from one front corner, mirrorable). A U-room is one more template later. |
| Which walls hold cabinets? | Any wall, any number: U and galley kitchens become possible. |
| Doors and windows? | Later. They will reuse the `reserved` span mechanism. |
| Where is the shape chosen? | In the studio's room panel. No new screen. |
| How is the outline stored? | Template + parameters (not a wall list). Closure is guaranteed by construction; an invalid room cannot be represented. |
| When is a corner square reserved? | Derived, never stored: when both walls meeting at an inside corner hold cabinets, or the corner holds a unit. |
| Can dimensions change later? | Yes, at any time, with cabinets placed. Clamped by what each wall's cabinets need. |

## 1. Floor plan — `src/lib/planner/floorplan.ts` (new, pure)

```ts
type FloorPlan =
  | { template: "rect"; widthMm: number; depthMm: number }
  | {
      template: "l";
      widthMm: number;
      depthMm: number;
      notchWidthMm: number;
      notchDepthMm: number;
      mirror: boolean;
    };

type Vec2 = { xMm: number; zMm: number };
type WallGeom = {
  startMm: Vec2;
  endMm: Vec2;
  lengthMm: number;
  yawRad: number;
  inward: Vec2; // unit normal into the room
  depthMm: number; // extent of the room along `inward`
};

wallsOf(plan): WallGeom[];
vertexKind(plan, i): "inside" | "outside"; // vertex i = end of wall i = start of wall i+1
setWallLength(plan, wall, mm): FloorPlan; // maps the wall to its parameter, clamped
```

- **Wall 0 is the back wall.** A `rect` has four walls, an `l` six. The `l`
  notch is cut from the front-right corner, front-left when `mirror`.
- **Winding rule (load-bearing).** Facing any wall from inside the room, its
  start is on the left. So vertex *i* is wall *i*'s right end and wall *i+1*'s
  left end, and every inside corner is the **left** corner of the wall after it.
  - Corner designs are drawn for the left-hand corner, so a corner unit is
    always drawn at x = 0 on wall *i+1*, unrotated. The `rotationDeg: 270`
    right-corner case disappears.
  - It matches v2's "left to right, facing the wall from inside", so migrated
    runs keep their `xMm`.
- **Wall-length edits.**
  - `rect`: back and front drive `widthMm`; left and right drive `depthMm`.
  - `l`: each wall maps to one parameter or a difference of two (for example
    the front wall is `widthMm − notchWidthMm`).
  - Clamps keep the notch smaller than the room and leave a minimum clear leg
    of 1000 mm. The outer bounds are `WALL_LIMITS` and `ROOM_DEPTH_LIMITS`.
- **`depthMm`** only feeds the camera and the measuring tool, the job
  `roomDepthMm` does in a run view today.
- **Outside corners** (the notch's inner corner) never hold a corner unit and
  never reserve anything. A run ending there has an open end.

## 2. Room document — `src/lib/planner/room.ts`

```ts
type RoomLayout = Settings & {
  plan: FloorPlan;
  runs: Run[]; // runs[i] belongs to wall i
  corners: Record<number, { floor: PlacedModule | null; wall: PlacedModule | null }>; // keyed by vertex
};
```

`Settings` keeps `ceilingHeightMm`, `hangingHeightMm`, `wallToCeiling`,
`baseSkirting` and `wallToWall`. `wallWidthMm` and `roomDepthMm` leave the
room document. `runView(room, i)` derives them from wall *i*, so the one-wall
placement engine in `layout.ts` is unchanged.

### Active corners

An inside vertex is **active** when walls *i* and *i+1* both hold cabinets, or
the vertex holds a corner unit.

- An active corner reserves the square on both walls: `EMPTY_CORNER_MM`
  (607 floor / 397 wall), or the unit's width when one is placed.
- Activating it runs today's `cascadeCorner` for that vertex. It slides
  cabinets clear, and `isClear` refuses the edit when a wall has no room.
- Adding the first cabinet to the second wall is what activates a corner, so
  `addModule` returns the room unchanged when the cascade cannot clear.
- Removing the last cabinet from either wall frees the square. Nothing is
  pulled back toward the corner.

### Engine changes

- `layout.ts`: `reserved?: Partial<Record<Row, Span>>` becomes
  `Partial<Record<Row, Span[]>>`, because a U's back wall has corners at both
  ends. Its consumers are `occupiedSpans`, `freeSpans`, `closeGaps`, exposure,
  `PlannerScene` and `StudioScreen`.
- `exposure.ts`: `EndWalls` becomes `{ left: boolean; right: boolean }`, meaning
  a wall stands at that end, instead of one `enclosed` flag. A run end at an
  inside vertex has a wall; at an outside vertex it is open. `wallToWall` stays
  the customer's filler toggle.
- These become per-vertex with their maths unchanged (it is already written
  with the corner at the origin): `cascadeCorner`,
  `placeCorner(room, familyId, vertex)`, `cornerPositions`, `exposureOf`,
  `endPanels`, `cornerShutSides`, `nearCornerMm`. `cornerWorktop` returns a
  list.
- `setShape` becomes `setPlan(room, plan)`: refused while any wall but the
  back wall holds cabinets or any corner holds a unit.
- `setWallWidth` / `setRoomDepth` become `setWallLength(room, wall, mm)`:
  - The floor is what the run's cabinets plus its corner squares need.
  - A run whose far-end corner is active shifts with it (today's `resized`
    rule). Every other run keeps its `xMm` from the wall's start.
- `fromCorner` keeps mirroring a run whose only corner is at its far end. A run
  with corners at both ends packs from its start.

### Price behaviour change

Migrated straight rooms now have side walls. A cabinet flush against one
(within one board) stops being charged an end panel. This is more accurate,
and **EzCabinet should be told** before a re-priced old design surprises them.

## 3. Order schema — `src/lib/orders/layoutSchema.ts`

- `ORDER_DESIGN_VERSION = 3`.
- The zod schema for v3:
  - `plan` is a discriminated union on `template`, with bounds on every
    parameter (for example, the notch is smaller than the room).
  - A refine requires `runs.length === wallsOf(plan).length`.
  - Corner keys must be inside vertices.
- v1 and v2 are transformed to v3 on read:

  | Stored | Becomes |
  | --- | --- |
  | straight | `rect(wallWidthMm, roomDepthMm)`, run on wall 0, walls 1–3 empty |
  | L, left | side run on wall 3, corner at vertex 3 |
  | L, right | side run on wall 1, corner at vertex 0 |

  `xMm` carries over unchanged. A stored `rotationDeg` on a corner unit is
  dropped; it was already never trusted.
- `validate.ts` iterates `runs` and `corners` with the same rules: known
  family, on-ladder width, corner designs only in a corner slot.
- `pricing.ts` sums the worktop square of every active corner.

## 4. Scene and studio UI

- **`Room.tsx`:** the floor is a `ShapeGeometry` of the polygon, with plank UVs
  in metres. Each wall is one single-sided plane facing into the room. The
  cutaway still needs no special code: back-facing walls vanish. The target
  wall gets a faint tint.
- **`PlannerScene.tsx`:** each run's group takes its position and `rotation.y`
  from its `WallGeom`, placing the wall line where `Run` already expects it
  (local `z = −depth/2`). This replaces `runYawRad`.
- **Wall picking:** tapping a wall, in 3D or plan view, makes it the target wall.
  It is off in measure mode and while dragging. The run chips in `StudioScreen`
  go.
- **Adding cabinets:** the add menu adds to the target wall at `nearCornerMm`.
  A corner design goes to the target wall's start vertex when that is an inside
  corner, otherwise its end vertex.
- **`DropPicker`:** returns `{ run, xMm }` for the wall nearest the floor point,
  so a design dragged in lands on the wall it is dropped near.
- **Camera** (`FitCamera`, `PanGizmo`, `lib/planner/camera.ts`): the 3D and
  elevation views frame the target wall, and plan view fits the polygon's
  bounding box. `cornerSide` goes.
- **`RoomPanel.tsx`:**
  - The straight / L chips become shape thumbnails (rect, L, L mirrored),
    drawn as inline SVG in the style of `thumbs.tsx`.
  - The width / depth fields become one length field per wall.
- **Plan-view dimensions:** each wall has a `DimensionField` at its midpoint
  (drei `Html`, in the pattern of `PositionDimensions.tsx`) calling
  `setWallLength`. It is clamped by the engine, so it never goes shorter than
  the wall's cabinets need.

## Testing

`lib/planner` gets its tests before any caller, per CLAUDE.md:

- **`floorplan.test.ts`:** each template closes; vertex kinds; the winding rule
  (each wall's start is the previous wall's end, inward normals point in);
  `setWallLength` maps and clamps.
- **`reserved.test.ts`, `exposure.test.ts`:** still pass with span lists and
  per-end walls.
- **`room.test.ts`:**
  - U kitchen: a rect with cabinets on walls 3, 0 and 1, and the back wall
    reserved at both ends.
  - Galley: walls 0 and 2, no corners.
  - L room: a run ending at the outside corner is open and reserves nothing.
  - Activation: the cascade slides cabinets, and a full wall is refused.
  - `setWallLength` with cabinets placed.
- **Migration:** v2 straight, L-left and L-right (with a corner unit) put every
  cabinet in the same world position after migration, and price identically
  apart from the flush-end panel change above.

Then `pnpm test`, `pnpm lint` and `pnpm typecheck`. In the browser:

1. Pick the L and edit the notch in plan view.
2. Tap each wall and build a U.
3. Drag a design in near a side wall.
4. Open doors at both corners.
5. Check out: `POST /api/orders` returns 201 with `schemaVersion: 3`.
6. Open an old v2 order in `/admin/orders`.

## Order of work

Each step is its own commit.

1. `floorplan.ts` and its tests.
2. `reserved` as span lists; `EndWalls` per end.
3. `room.ts` v3, the order schema v3 and migrations, `validate.ts`,
   `pricing.ts`.
4. Scene: the polygon room, wall frames, wall picking, `DropPicker`, camera.
5. The room panel's shape picker and the plan-view dimension fields.
6. CLAUDE.md: "One wall or an L" becomes "Room shapes"; update known issue 6.

## Not in scope

Openings, the U-room template, freeform or angled walls, and a per-wall "open"
flag. Add the last when an open-plan room needs it.

## 5. Free-standing cabinets (added 2026-09-19, user decision)

A cabinet can stand anywhere on the floor, not only against a wall.

- **Document:** `RoomLayout.free: FreeModule[]`, where `FreeModule = PlacedModule` with `xMm, zMm` = the centre of its footprint in plan mm, and `rotationDeg` = its yaw relative to the back wall. In zod it is optional and defaults to `[]`, so saved v3 designs still parse with no version bump.
- **Who may go free:** base and tall units only. Wall-hung units need a wall; corner units need their corner.
- **Drop rule:** on release, if the cabinet's back edge is within **150 mm** (`SNAP_TO_WALL_MM`) of the nearest wall, it joins that wall's run (the Task 8 `moveToRun` path). Otherwise it becomes, or stays, free at the drop point. A cabinet going from a wall to free keeps facing the way its wall faced it.
- **Validity:** a free cabinet's rotated footprint must lie inside the room outline. It must not overlap another free cabinet or the footprint of any floor-row cabinet in a run; a free tall unit also must not overlap wall-row footprints. An invalid drop snaps back.
- **Pricing:** a free cabinet is priced as a run of one: its own worktop (base only, by width), its own kick board (base only, by width), and both sides charged as end panels. **The exposed back is not charged** — an open question for EzCabinet.
- **Checkout:** `validateOrder` checks free cabinets like run cabinets (known family, on-ladder width, room offers it, kind base/tall, not a corner design) plus inside-the-room and no-overlap.
- **Scene:** a free cabinet is drawn as a one-cabinet run with its own frame (yaw = its rotation, position = its centre), so the worktop, kick board, end panels and doors reuse `Run` unchanged. Dragging reads the floor plane; a wall cabinet dragged more than the snap distance off its wall follows the pointer on the floor.
