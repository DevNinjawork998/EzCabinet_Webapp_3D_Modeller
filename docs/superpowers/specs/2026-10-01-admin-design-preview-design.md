# Admin design preview, drawn the way the planner draws it

**Date:** 2026-10-01
**Status:** approved in chat, awaiting spec review
**Touches:** `src/components/admin/DesignViewer.tsx`, `src/app/admin/cabinet-designs/CabinetDesignsClient.tsx`

## Why

The upload/edit modal on `/admin/cabinet-designs` previews a design file with
three's raw `OBJLoader`: default grey material, a flat ambient + directional
light, the model scaled to an arbitrary 2-unit box. The planner draws the same
file through a completely different path — `buildRenderMesh` buckets triangles
by role, `DesignedCabinet` paints fronts in the customer's finish, and
`StudioLighting` lights it with Lightformers and PBR Neutral tone mapping.

So the admin approves a cabinet that looks nothing like what a customer will
see. Worse, the preview cannot show the one thing that most often goes wrong
at intake: CLAUDE.md known issue 1 — the drafter's group names decide which
triangles take the finish and which hide on the doors toggle. A misnamed door
is invisible in a grey preview and obvious in a painted one.

**Goal:** the admin preview is the planner's rendering of that cabinet — same
mesh conversion, same component, same lighting — with controls to try a finish,
a door style, and the doors shut / open / hidden.

## What the admin said vs. what is assumed

- Said: the preview should use the shades (finishes) in the codebase and look
  aligned with the planner's 3D; option 3 chosen — finishes plus a doors
  toggle.
- Assumed: preview controls are throwaway state. Nothing they pick is saved or
  affects the form's own "Front / finish options" chips.

## Approach

Run `buildRenderMesh` **in the browser** on the file text the viewer already
reads, and render the result with the planner's own `DesignedCabinet` inside the
planner's own `StudioLighting`.

Rejected:

- **Fetch `/api/cabinet-mesh/[id]`.** That mesh only exists after the design is
  saved and converted, so a freshly picked file — the main case — would have
  nothing to show.
- **Paint the raw OBJ by guessing names in the viewer.** A second classifier
  next to `roles.ts`, guaranteed to drift from it, which defeats the point of
  previewing what the planner will do.

`buildRenderMesh` (`lib/mesh/renderMesh.ts`) is pure TypeScript — no `server-only`,
no Node APIs — and is the exact function `convertDesign.ts` runs at publish. The
preview and the publish therefore agree by construction.

## Data flow

```
source: File | "/api/admin/cabinet-designs/[id]/file"
  → objTextFrom(source)                  unchanged
  → buildRenderMesh(text)                lazy import of lib/mesh/renderMesh
       ├─ RenderMesh  → groups: MeshGroup[] → <DesignedCabinet …>
       └─ null        → current OBJLoader path, plus a notice
```

Both a new upload and an edited design take the same path — an edited design's
stored file is re-read and re-converted in the browser, not fetched as a mesh.

**Fallback when `buildRenderMesh` returns `null`** (past `MAX_TRIANGLES`, or
nothing it can read): keep today's grey `OBJLoader` render, and show under it:
*"Won't convert — the planner will draw this one procedurally."* That is what
publish will do with the same file, so the admin learns it before publishing.
The grey path stays because an admin still needs to see *which* file they
picked even when it will not convert.

## Scene

- **Lighting:** `<StudioLighting plan={PREVIEW_PLAN} ceilingHeightMm={2400} quality="low" />`
  with `PREVIEW_PLAN = { template: "rect", widthMm: 2000, depthMm: 2000 }`.
  `Lighting.tsx` is not modified. `quality="low"` sizes the shadow map at
  1024², plenty for one cabinet. `HighQualityEffects` is not mounted.
- **Shadows:** `Canvas shadows={SHADOW_MAP}`, as the planner sets it. A plain
  floor plane (`receiveShadow`, neutral colour) under the cabinet so it sits on
  something instead of floating. `Hinge` and `Slide` already call
  `markShadowsDirty()` while doors and drawers move. `DesignedCabinet` only
  marks it on its network loader (`useDesignMesh`), which the preview bypasses,
  so the viewer calls `markShadowsDirty()` itself whenever its `groups`, door
  style or doors mode change.
- **Scale:** real metres. `DesignedCabinet` draws in its own frame in metres;
  the `FRAME_SIZE` rescale goes away. A small pure helper,
  `previewFrame(groups)`, takes the union of the groups' `bboxMm` and returns
  the offset that centres the cabinet on x/z and stands it on y = 0, plus a
  camera distance from its largest dimension. Orbit target is the cabinet's
  mid-height.
- Kept from today: `dpr={[1, 2]}`, `resize={{ scroll: false, debounce: 0 }}`
  (the zero-size-measure fix for a scrolling overlay), `OrbitControls` with pan
  off, the "drag to rotate · scroll to zoom" hint.

## Controls

A strip directly under the canvas, only when the mesh converted:

| Control | Source | Drives |
|---|---|---|
| Finish swatches | `base.finishes` (`id`, `label`, `hex`) | `finishHex`; `finishPhoto` from `finishPhotos["finish:<id>"]` when one is uploaded |
| Door style chips | `base.doorStyles` | `door` — matters for `glass`, which renders see-through |
| Doors: Shut / Open / Hidden | local | `open` / `doorsHidden` |

Defaults: first finish, first door style, shut. Swatches are small round chips
with the label as `title`/`aria-label`, using the existing `chipClass` styling
for the text chips.

`DesignedCabinet` props left at defaults: `hinge="left"`, `gaps` unbounded,
`sheetOffset={0}`, `selected={false}`, `exposed` omitted — ends render as the
drawn carcass sides, not veneered panels, because end panels are a charged extra
the cabinet does not come with.

## Props

```ts
DesignViewer({
  source: File | string | null,
  className?: string,
  finishes: Finish[],
  doorStyles: DoorStyle[],
  finishPhotos: Record<string, string>,
})
```

`CabinetDesignsClient` passes `base.finishes`, `base.doorStyles` and its
existing `finishPhotos`. While `base` is still loading, it passes the seed's
(`PLANNER_CATALOGUE.finishes` / `.doorStyles`) — `catalogue.ts` is already
framework-free and importable.

## Bundle

Unchanged boundary: `DesignViewer` is imported only by the admin page, behind
`next/dynamic`. `DesignedCabinet`, `StudioLighting` and `lib/mesh/renderMesh`
join that admin-only chunk; nothing new reaches a customer bundle.
`DesignedCabinet`'s `captureError` path is only on its network loader, which the
preview does not use.

`lightingRig.ts`'s shadow-frame counter is module-level and shared by every
canvas (its own `ponytail:` note). The admin page mounts one canvas, so the
preview is safe.

## Errors

- Fetch or archive failure: the existing amber message, unchanged.
- `buildRenderMesh` throws: caught by the same `try`, same amber message.
- `buildRenderMesh` returns `null`: grey fallback + the procedural notice above.

## Testing

- **Unit:** `previewFrame` — a cabinet whose bbox is off-origin comes back
  centred on x/z with its base on y = 0, and the camera distance grows with the
  largest dimension. `buildRenderMesh` itself is already covered by
  `src/lib/mesh/__tests__/renderMesh.test.ts`.
- **Browser** (`/admin/cabinet-designs`, 2560 and 390 wide):
  - edit an existing design — painted preview, not grey;
  - pick a fresh `.obj` — painted preview before saving;
  - switch to a finish with an uploaded decor photo — the photo shows on the fronts;
  - pick the glass door style — fronts go see-through;
  - Shut → Open → Hidden — doors swing, then disappear, carcass stays;
  - an oversized/unreadable file — grey render plus the procedural notice.

## Out of scope

- Veneered end panels, hinge side, neighbour gaps in the preview.
- Saving the previewed finish or door style anywhere.
- Any change to the planner, `Lighting.tsx`, `DesignedCabinet.tsx` or `lib/mesh`.
