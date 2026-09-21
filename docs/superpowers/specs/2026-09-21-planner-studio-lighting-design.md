# Planner studio lighting — design

Date: 2026-09-21
Status: approved in brainstorming, not built

## Goal

Make the planner scene read as a professional studio render rather than flat
CG — real reflections, soft believable shadows, contact darkening where
cabinets meet walls and floor — **without changing any functional behaviour**
and without breaking the mid-range-Android budget. This is a finish upgrade:
every interaction that works today works identically afterwards.

Scope is the planner canvas only (`PlannerScene.tsx`). The admin
`DesignViewer.tsx` keeps its own lights; `<StudioLighting />` can be dropped in
there later as a one-line change. `lib/planner` is untouched.

## Decisions

- **Mood: bright studio.** Soft even light, neutral white, gentle shadows.
  Finish colours must stay true to the swatch — that is what is being sold.
- **Budget: tiered.** Cheap upgrades for every device; expensive ones only on
  devices that measure fast enough.
- **Rejected: `AccumulativeShadows`.** Best-looking soft shadows, but it
  re-accumulates over 30–100 frames after every edit and only onto one plane,
  so a drag-heavy editor would visibly "settle" after each move and walls would
  get nothing.

## What is wrong today

- R3F's default ACES tone mapping shifts and washes colours. The comment in
  `PlannerScene.tsx` about Rhone Oak rendering near-white is this, and the light
  intensities were cut to compensate.
- No environment map: every `meshStandardMaterial` — glass, handles, worktop,
  drafted mesh groups — has nothing to reflect, so gloss reads as flat.
- Ambient 0.85 is a flat grey wash over everything.
- Shadows are faked: `<Shadow>` blob pools on the floor, and `WallShadow`
  patches behind wall units that parallax off their cabinet from the side
  (which is why they fade with viewing angle).

## Must not break

The working parts the lighting touches, and how each stays safe. Each row is a
check in Verification.

| Working part | Risk | Safeguard |
|---|---|---|
| Selection, drag-preview, measure overlay, wall-number colours | Tone mapping also recolours UI meshes (`meshBasicMaterial` is tone-mapped by default) | `toneMapped={false}` on every UI/overlay material — they keep today's exact colours |
| Tap, drag, snap (raycasts on invisible hit planes) | Hit planes casting shadow or catching AO | Shadows are opt-in per mesh (`castShadow` only on cabinets and worktops); hit planes untouched; raycasting is independent of lighting |
| Measuring tool | None — snaps to geometry | No change to `snapToCabinet` or `parts.ts` |
| Doors open/hidden toggle | Stale shadow of a hidden door | Shadow redraw on every toggle and during the animation |
| Elevation and plan views (orthographic) | Shadows/AO clutter a technical view | Verified in all three views; if needed, shadows/AO switch off in elevation/plan |
| Finish, door-style, wall-paint colours | Colour shift | Neutral tone mapping plus side-by-side swatch check before merge |
| Procedural fallback (`Cabinet.tsx`) | Looks different from drafted cabinets | Same cast/receive flags on both |
| On-top overlays (`depthTest={false}`) on `high` | AO darkens them | Overlays render outside the AO pass; checked in tier test |
| Weak phones | Frame drops | Costly work is `high`-only and lazy; `low` adds no per-frame work except during a drag |
| Tests, typecheck, Biome | — | Stay green; every PR gated on them |

**Kill switch.** Phase 1 is one component (`<StudioLighting />`); reverting is
a one-line swap back to the old two lights. Phase 2 sits behind the tier, so
`?quality=low` returns to a known-good state.

## Phase 1 — lights, environment, tone mapping (PR 1)

New `components/planner/Lighting.tsx`, exporting `<StudioLighting />`, replaces
the two light lines in `PlannerScene.tsx`.

- **Tone mapping:** `NeutralToneMapping` on the Canvas `gl` (three 0.185 has
  it). Built for product rendering; keeps sRGB swatch and wall-paint colours
  close to what the admin typed.
- **Environment:** drei `<Environment resolution={256} frames={1}
  background={false}>` holding four `<Lightformer>` panels:
  - large soft key above and in front (ceiling softbox),
  - two dimmer strips left and right (edge highlights on doors, handles),
  - faint warm bounce low at the front (kick boards and undersides not dead
    black).

  Rendered once to a cube map at mount, zero per-frame cost, no HDR download
  (a studio HDR is 1–3 MB). `scene.environment` reaches every standard material
  with no material changes.
- **Lights re-balanced:** ambient drops to ~0.2 or goes; the directional light
  stays as key. Final intensities are tuned by eye against real finishes, not
  fixed here.
- **UI materials:** `toneMapped={false}` on overlay/UI materials (see Must not
  break) lands in this PR, since tone mapping is what would recolour them.

No new dependencies. Frame rate unchanged.

## Phase 2 — shadows and quality tiers (PR 2)

### Shadow map, drawn only on change

- **Cast + receive:** cabinets (drafted mesh and procedural fallback),
  worktops. **Receive only:** floor, walls — walls never cast. **Neither:**
  measuring overlay, selection outlines, badges, drag previews, hit planes.
- **Key light high, near-overhead, slight forward tilt.** Rooms have walls all
  round; a front light would backlight every far-wall cabinet and throw shadows
  into the room. Overhead treats every wall alike: shadow under wall units onto
  the worktop, a line at the floor, a hint on the wall behind.
- **Frustum fitted to the room:** orthographic shadow camera sized from the
  min/max of `outlineOf(plan)` plus ceiling height, refitted when the plan
  changes. 1024² on `low`, 2048² on `high`.
- **`gl.shadowMap.autoUpdate = false`.** `needsUpdate = true` on: layout change
  (add, move, resize, shape, wall length); doors open/hidden, and every frame
  while the door animation runs; every frame during a drag. Orbit, pan and zoom
  need no redraw — the light is fixed in world space — so most of a session
  costs zero shadow work.
- **Filtering:** soft filtering per whatever three 0.185 recommends
  (`PCFSoftShadowMap` is being phased out — check at implementation). Bias and
  normalBias tuned against 18 mm panels.

### Fake shadows

- `WallShadow` is **deleted** — the real shadow does its job.
- Floor `<Shadow>` pools stay, fainter, on `low` as cheap contact darkening;
  off on `high`, where N8AO would double-darken them.

### Tiers

| | low (default) | high |
|---|---|---|
| Environment, neutral tone mapping, soft key | yes | yes |
| Shadow map | 1024² | 2048² |
| Floor blob pools | on | off |
| N8AO ambient occlusion | no | yes |

- Every device starts `low`. drei `<PerformanceMonitor>`: `onIncline` → `high`,
  `onDecline` → `low`, `onFallback` → locked `low` for the session. No
  user-agent sniffing. Tier is view state in `PlannerScene`, never on the
  layout.
- `high` dynamically imports `HighQualityEffects.tsx`, which pulls
  `@react-three/postprocessing` + `n8ao` (new deps, ~30–40 KB gzipped), N8AO in
  half-resolution mode. `low` devices never download it.
- Dev-only `?quality=high|low` forces a tier for testing.

### Screenshot rule (requirement for later)

Quote screenshot capture is not built — `preserveDrawingBuffer` is set but
nothing reads the canvas. Whoever builds it renders the captured frame at
`high` settings regardless of the device's tier. Not built here: it would have
no caller.

## Out of scope

- `frameloop="demand"` — real battery win on phones, but breaks
  `PerformanceMonitor` measurement and touches every animation. Own task.
- Admin `DesignViewer` lighting.
- A warm/evening mood preset.

## Verification

No `lib/planner` change, so no engine tests. The frustum fit is a min/max over
existing `outlineOf`, no new helper. Verification is visual and measured:

1. Before/after screenshots of the same kitchen (straight run, wall units, a
   glass door) in 3D, elevation and plan, plus one L room, against `pnpm dev`.
2. Each finish's door beside its swatch — neutral tone mapping must keep them
   visibly matched.
3. Functional regression pass, every row of Must not break: select, drag along
   a wall, drag to another wall, drop free-standing, resize, measure, doors
   open/hidden, wall paint, room shape and wall lengths, all three views.
   Behaviour identical to `main`; overlay colours identical.
4. Chrome DevTools, 4× CPU throttle, mobile viewport: frame time idle-orbiting
   and dragging, before and after. Pass: no measurable idle-orbit regression;
   drag stays ≥ ~30 fps on `low`.
5. `?quality=high|low`: AO chunk loads only on `high` (network tab); blob pools
   off on `high`; overlays not darkened.
6. `pnpm test`, typecheck, Biome green.

## CLAUDE.md change (PR 2)

Under "Mobile performance rules", replace *"No real-time shadows. One
directional light, one ambient, one soft blurred plane beneath the unit"* with:
one shadow-casting key light; shadow map redrawn only on change, never per
frame; environment from Lightformers, no HDR files; neutral tone mapping; AO
only on the `high` tier, lazy-loaded; a captured screenshot always renders at
`high`.
