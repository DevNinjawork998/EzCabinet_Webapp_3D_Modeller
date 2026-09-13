# Cabinet planner

Public, lead-generation cabinet planner for **EzCabinet Sdn Bhd** (Malaysian cabinet manufacturer). Built by JNS Nexion Enterprise.

An end customer picks a room, arranges cabinets along one wall in 3D, sees a price, and submits a quote request. EzCabinet's sales team receives the lead with a rendered image attached.

**This is a marketing surface, not a production tool.** It must be convincing and fast on mid-range Android in Malaysia. It does not need to be manufacturing-accurate. A human validates every design before it becomes a real order.

Reference product: IKEA's PAX planner. Not the full IKEA room planner — one room, one wall.

## History worth knowing

The first build was a **wardrobe** configurator: a five-step stepper that split one opening into bays, at `/viewer`, on an engine in `lib/wardrobe`. It was superseded by the room planner in August 2026 and deleted (commit `5b2f0e7`). If you find a doc, comment, or branch referring to `/viewer`, `lib/wardrobe`, `components/configurator`, bays, or the `WARDROBE` product — that is the old design. Do not rebuild it. `git show 5b2f0e7^` has it if you need to read it.

The wardrobe survives only as a seed family (`id: "wardrobe"`) in `lib/planner/catalogue.ts`, which tests use as a fixture.

## Status

Phase 0 (catalogue + pricing spec with client) not yet complete — see Open questions. The engine, the planner UI, and the admin catalogue surface are built. `/admin/cabinet-designs` is the one catalogue screen: each uploaded design is one cabinet, filed under the rooms that offer it, and `POST /api/admin/cabinet-designs/publish` rebuilds the catalogue from the design rows (`lib/catalogue/buildCatalogue.ts`). Customers can check out: `POST /api/orders` re-validates and re-prices the design and stores an `Order` (manual bank transfer until a gateway is chosen), `/admin/orders` marks it paid, and **Create delivery** opens the logistics form pre-filled from the design (`lib/orders`). Share links are the remaining Phase 3 work.

**Confirmed client requirement (resolved):** EzCabinet designs in SketchUp and asked for "upload SketchUp designs so we can maintain new configurations." It is resolved the literal way: the planner **renders the model they drew** — see [3D](#3d). This reversed an earlier decision to rebuild each cabinet procedurally from extracted numbers; that section carries the measurements that changed it.

**The file format is OBJ, not `.skp`, everywhere.** A `.skp` is a SketchUp-proprietary container that in practice needs SketchUp itself to read; the `openskp` reader was deleted in August 2026 along with `lib/skp`. The client exports the design folder as Wavefront OBJ — `.obj` + `.mtl` + textures — and uploads it zipped. `lib/mesh` reads it. Nothing in the app accepts a `.skp` any more: not catalogue import, not the cabinet-design library. If you are adding an upload that takes a design, it takes `.obj`/`.zip`.

## Stack

The dependency list is `package.json`. The two that need saying:

- Mux for the DIY tutorial videos — the one thing in the app that is streamed rather than generated
- Deployed on Vercel, functions pinned to `sin1` (Singapore) — users are in Klang Valley

## Architecture

### The core rule: the layout document is the single source of truth

A design is a set of cabinets placed in rows against one wall. Each placed cabinet references a **family** — one uploaded design — and its width. Everything else — 3D geometry, price, quote, and eventually the cutting list — is **derived** from that JSON. Nothing is stored twice.

```
Layout document (JSON)
  ├─ roomId:     kitchen | living | bedroom | foyer
  ├─ roomDepthMm
  ├─ rows[]:     floor and wall runs
  └─ modules[]:  familyId, widthMm, xMm, doorStyleId
        ↓
  cabinet meshes (fetched)  ·  price (server)  ·  share link  ·  SKU list (Phase 4)
```

### One design, one cabinet

The customer does not drag a slider or step through a size ladder. EzCabinet draws **one export per width** — BC 600, BC 800, BC 900 — and each export is its own cabinet: its own name, all-in price (door included), box and drawn model. A catalogue family is exactly one design with exactly one size, and its id is the design's id. This is deliberate:

- It matches how EzCabinet manufactures — standard modules, each a SKU.
- It is what makes rendering the drafted model 1:1 possible: every cabinet has a real file behind it.
- The price a customer sees is the one the admin typed, and the Phase 4 SKU list falls straight out of the layout.

An earlier design grouped the widths into one family with a ladder, matched by shape. On the client's first uploads it folded BC 600 / 800 / 900 into the seed's invented `base-cabinet`, kept that family's invented prices and box, and no screen could tell which cabinet was real. Do not bring the ladder back.

`familySchema.sizes` is still an array and `layout.ts` still places against it, so a multi-width family (the seed, older published versions) still works; the resize control only shows when a family has more than one size. The add-cabinet menu groups cabinets by the design library's category.

### Directory layout

```text
src/
  lib/planner/           ← PURE TypeScript. No React, no three.js imports.
    layout.ts            ← placement, collision, snapping
    parts.ts             ← every box a cabinet is drawn from, as numbers
    exposure.ts          ← which outer sides of a cabinet nothing sits against
  lib/catalogue/         ← DB-backed catalogue: read path, versions, diffs, blob
    versions.ts          ← createDraftVersion, the one place a DRAFT is numbered
    convertDesign.ts     ← one upload → fit-out + render mesh on the row
    buildCatalogue.ts    ← design rows → the catalogue, rebuilt on every publish
    siteImages.ts        ← homepage/finish photo slots, derived from the catalogue
  lib/logistics/         ← delivery jobs and the logistics partners that move them
    carriers.ts          ← the partner vocabulary; isomorphic, no secrets
    types.ts             ← zod payloads + the CarrierAdapter contract
    measure.ts           ← items => weight, volume, the vehicle that fits
    phone.ts             ← an admin's typing => E.164, which carriers demand
    geocode.ts           ← an address => the pin Lalamove prices against
    status.ts            ← a carrier's word for a state => ours; unknown => null
    http.ts              ← the one outbound fetch: timeout, retry only if safe
    store.ts             ← the single write path for a tracking update
    registry.ts          ← which partners we can reach right now
    tokens.ts            ← a partner's OAuth tokens: one row, refreshed under a lock
    adapters/            ← one file per partner; manual, lalamove and easyparcel are live
  lib/orders/            ← checkout: a customer's design becomes an order
    layoutSchema.ts      ← zod twin of PlannerLayout; stored as { schemaVersion, layout }
    validate.ts          ← can this design be sold as it stands — every rule explicit
    price.ts             ← the planner's price + the flat delivery fee, server-side
    items.ts             ← order → delivery rows: box from the design, weight from its row
    payment.ts           ← manual bank transfer; the seam a gateway plugs into
  lib/mesh/              ← reads an OBJ export into catalogue data
    archive.ts           ← unzip; the .obj text and the texture filenames
    objRead.ts           ← OBJ parse: named boxes in the file's own units
    normalise.ts         ← infers scale and up-axis, never assumes them
    roles.ts             ← what each panel is: naming table, geometric fallback
    strategies.ts        ← flat panels → cabinets, three strategies best-first
    extract.ts           ← cabinets → CatalogueDraft (no money, ever)
    read.ts              ← whole-run intake; no caller since /admin/import went
    measureDesign.ts     ← one file = one cabinet, for the design library
    renderMesh.ts        ← OBJ → grouped binary geometry the planner draws
  components/planner/    ← R3F scene and the planner screens
    DesignedCabinet.tsx  ← draws the drafted mesh; Cabinet.tsx is the fallback
  components/admin/      ← admin chrome, DesignViewer
  app/admin/             ← cabinet designs (the whole catalogue), logistics,
                           site content, tutorials
  app/api/               ← admin + catalogue + site-image endpoints
```

`lib/planner` must stay framework-free. Everything in it is `(layout, catalogue) => result`. This lets us:

- build and test the whole engine against fixtures before any UI exists
- run the same code client-side for instant feedback and server-side as the authority
- lift the folder into Factory Tracker in Phase 4 without dragging UI along

If a change to `lib/planner` requires importing React or three.js, the change is wrong.

### The catalogue is a parameter, never a global

`catalogue.ts` holds the **seed**: the settings a fresh database starts with
(door styles, finishes, rooms), the invented families tests use as fixtures, and
the fallbacks (`CONSTRUCTION`, `RATES`) that fill in whatever a published
catalogue omits. The seed publishes no cabinets. `PLANNER_CATALOGUE` is frozen. Nothing swaps it.

The live catalogue comes from the published `CatalogueVersion` and is passed
explicitly to the three things that consume it:

- `plannerEngine(catalogue)` — the placement functions in `layout.ts`, bound to
  one catalogue. A factory rather than a per-function parameter because
  `positioned` is the only place a `familyId` becomes a `Family`, but nearly
  every export reaches it.
- `computePlannerPrice(layout, finish, catalogue)` — the money path, which also
  takes its rates off that catalogue via `ratesOf`.
- `<CatalogueProvider catalogue={…}>` in `components/planner/CatalogueContext.tsx`
  — the client tree, which reads `useCatalogue()` for palettes and `useEngine()`
  for placement.

This replaced a mutable module palette that `setActivePlannerCatalogue` swapped
in place. It was three bugs at once: a door-price copy that never got swapped, a
global mutated during React's render phase, and a server-rendered starter layout
built from the seed but priced against the published catalogue — which fell
through `?? 0` whenever a publish changed a size ladder. A fourth, quieter bug
rode along with it: `pricing.ts` read worktop, ceiling-trim, skirting and all
three end-panel rates off the module-level `RATES` global rather than the
catalogue argument, so on the server — where price is authoritative — those six
rates always priced at the bundled placeholders regardless of what was
published. "Which catalogue is live" is now a value with an owner.

### Non-negotiables

- **Price is computed server-side.** The client may show an indicative figure; the authoritative number comes from the API. Never trust a client-submitted price.
- **`schemaVersion` on every stored document.** Public share links must survive schema changes. A customer's WhatsApp link rendering wrong is a lost sale.
- **Zod is the single source of truth for types.** Define the schema once, infer TS types from it, validate every API payload. Malformed input on a public endpoint is guaranteed.
- **Sizes are validated against the family's ladder.** Reject off-ladder widths server-side.
- **The catalogue lives in the database.** Cabinets and their prices are `CabinetDesign` rows, rebuilt into a `CatalogueVersion` on every publish — the version table is the price history. The disaster-recovery copy for cabinets is Postgres plus the design files in Blob; `lib/planner/catalogue.ts` seeds only settings. Ship seed changes as their own commit.

## 3D

**The planner draws the model the drafter drew.** EzCabinet designs every
cabinet in SketchUp and exports it as OBJ. That drawing is the deliverable, and
the software's job is to ingest it and put it in front of a customer — not to
re-derive a cabinet somebody has already drawn.

This reverses what this document said until August 2026. The old rule —
*"nothing in the scene is an image or a loaded model"* — rebuilt every cabinet
from eleven extracted numbers, and the visible result was a Häfele Axilo 48
leveller rendered as a plain grey cylinder. The three arguments for it do not
survive contact with the numbers:

| The old objection | What is actually true |
| --- | --- |
| "Heavy web geometry that fights the mobile budget" | The client's whole wall run is **8,058 verts / 13,896 triangles**. As binary that is **176 KB** — about what *one* of their decor photos costs (`Rhone Oak.jpg` is 178 KB). One cabinet is ~25 KB, ~13 KB gzipped. The old figure was measuring OBJ *text*, which is ASCII floats at ~6× the binary. |
| "A baked mesh cannot resize to the size ladder" | True, and irrelevant: a cabinet never resizes. The client draws **one export per width** — BC 800, BC 900, BC 1000 — and each is its own cabinet. |
| "No parameters, so it can never produce a price or a BOM" | Price and BOM come from the layout document and the catalogue row. Geometry never fed them and still does not. The mesh is purely visual. |

### What is drawn from a file, and what is not

| | Source |
| --- | --- |
| Cabinet geometry | **the drafted mesh, 1:1** |
| Room shell — floor, walls, ceiling | procedural. No file describes the customer's room |
| Worktop spanning a run | procedural. It crosses cabinets, so no single export has it |
| Finish, door style | **our** materials, painted per classified mesh group |
| Price | the design row, all-in; door styles add a surcharge |

### Classified at intake, not at runtime

`lib/mesh/renderMesh.ts` converts an upload once, on the server, and the browser
receives grouped binary geometry — never an OBJ, never a loader.

```
BC 800mm.obj  (private Blob — carries their part naming)
      ↓  readObjMesh · normalise · classify        (lib/mesh)
      ↓  bucket triangles by role, write binary
  cabinet mesh  ~42 KB / ~13 KB gzipped
   groups: carcass · door · drawerFront · shelf · hardware · other
      ↓  GET /api/cabinet-mesh/[id]   (public, immutable)
  DesignedCabinet.tsx → BufferGeometry
```

**The mesh is grouped by role, and that is load-bearing.** Two features carry
the sale, and both need to know which triangles are fronts:

- the **finish picker**, which paints the customer's colour onto exactly the
  surfaces a sprayer would paint;
- the **doors-open/hidden toggle**, which hides those groups and nothing else.

`roles.ts` already classifies from the drafter's own group names (`Door_L_`,
`G-UEnd_(R)`). That classification used to be discarded; now it decides the
buckets. The drafter's own materials are dropped — the export carries ~900 KB of
re-encoded texture copies (`RotText12.jpg`) whose names map to nothing, and the
grain tile tinted per finish is both smaller and better.

**Nothing is dropped for being unrecognised.** A record `roles.ts` cannot place
goes to `other` and is still drawn, with a neutral material. `readObj` discards
`G-Object.041` as carrying no readable design intent — but in the client's own
sample job that record *is* the adjustable feet. Unrecognised is not unwanted.

**`Cabinet.tsx` is the fallback, not the primary.** Six procedural boxes rebuilt
from `parts.ts`, still rendered for a family with no published mesh: every
catalogue published before this, and any design whose file would not convert. Do
not delete it — a design that fails to parse must still be sellable.

The custom binary format (`ICBMESH1`: magic, a JSON group table, `Float32`
positions, `Uint32` indices) is hand-rolled for the same reason
`scripts/generate-grain-texture.mjs` hand-rolls a PNG — a GLB writer is a
dependency and an exporter's worth of spec for a file only this app reads.

### Design intake lives in `src/lib/mesh/CLAUDE.md`

How a file becomes a cabinet — scale and up-axis inference, which end is the
wall, panel roles, run grouping, the two intake paths, and the additive merge —
is documented next to the code that does it, and loads when you work there.

### Coverage is the thing to watch

A rung with no `meshDesignId` falls back to procedural geometry, and that is
fine — but it is invisible unless something says so, and the first look at the
planner proved it. One rung of thirty had a design, the kitchen starter layout
happened to place none of them, so every cabinet on screen was fallback and the
generic leg read as a broken feature rather than a missing file.

So `/admin/cabinet-designs` shows, on every design row, what it converted to —
its triangle count, or "no mesh — drawn procedurally" — and whether it is live,
edited but unpublished, or leaving at the next publish.

**A design whose file would not convert stays sellable**, drawn procedurally.
Refusing it would make 1:1 a guarantee rather than a maybe; the admin row says
which ones are procedural instead.

### `parts.ts`, and what it is still for

`lib/planner/parts.ts` returns every box in one *procedural* cabinet — sides,
top, bottom, back, legs, shelves, door leaves, drawer fronts — as
`{ role, index, centreMm, sizeMm }` in the cabinet's own frame. `Cabinet.tsx`
renders the fallback from it and `measure.ts` snaps against it. Both used to
derive the interior separately, which left the measuring tool knowing only the
outer bounding box: a shelf gap, a door reveal and a board thickness were all
unmeasurable.

`familySchema.geometry` feeds it: `shelves`, `fixedShelves`, `doorLeaves`,
`drawers`, `hasBack`, `legs`, `legHeightMm`, `legDiameterMm` and `legInsetMm`,
read off the design at intake, so the fallback at least has the right counts and
the right hardware. `standOf` floats a base carcass on feet when the design
recorded them and falls back to the recessed plinth otherwise.

The leg dimensions matter more than they look. On the client's own file the feet
are **2,248 of 2,344 triangles — 96%** of the model; the carcass is 60, the door
24, the shelf 12. They are the one place a fallback visibly differs from the
drawing, which is exactly what got noticed first. `geometryOf` measures them
(57mm across, 17mm in) rather than guessing (50 and 35), so a design whose mesh
failed still falls back with the right feet.

Zero in either field means "not recorded" and `parts.ts` keeps its constants —
which is why they are not defaulted to those constants in the schema. A real
50mm foot and an unrecorded one have to stay distinguishable.

**Exposed ends wear the door finish.** `exposure.ts` answers which outer sides of
a cabinet have no neighbour touching them, and `PlannerScene` passes it down so
an end-of-run side renders as a veneered end panel rather than plain carcass
board — the most camera-facing surface in the default 3/4 view. Every such side
is also a charged panel, and `exposureOf` in `layout.ts` is the one answer both
the scene and `pricing.ts` read. A side is covered by anything within one board
(`panelThicknessMm`) that shares its height, whichever row it is in — so a wall
unit is buried against a tall unit, and a lifted base is not buried by the one
below it. Two rules EzCabinet confirmed on 2026-09-13: a tall unit's side beside a shorter
cabinet counts as covered, and `G-UEnd_(L)/(R)` is the carcass side, so panels
are charged on top of a design's all-in price, not inside it.

**The measuring tool snaps to whichever geometry is actually drawn.**
`snapToCabinet` takes the drafted mesh's group boxes when one has loaded and
falls back to `cabinetPartsMm` when it has not. That is not a nicety: a
dimension line taken against an idealised shelf while the scene draws the real
one is a wrong number shown to a customer. `PlannerScene` reads the mesh
synchronously through `peekDesignMesh`, because a pointer handler cannot await —
and a null there is correct rather than a race, since no mesh means procedural
boxes are what is on screen.

Onboarding a new design is a **data-entry task, not a 3D-modeling task**: name
it, price it, publish it. That is what lets one person maintain the catalogue.

### Mobile performance rules

Mid-range Android is the target device.

- Lazy-load the 3D bundle behind `Suspense` so it never blocks LCP on the landing page
- `dpr={[1, 2]}`
- No real-time shadows. One directional light, one ambient, one soft blurred plane beneath the unit
- **One grayscale grain texture, tinted per finish via material colour.** `public/grain.png` is 512², ~54KB, generated by `pnpm generate:grain`, and every surface in the scene shares it. Do not ship a separate 2K PBR set per finish — eight finishes of 2K maps will destroy load time on mobile data
- **The floor is a second greyscale tile, `public/floor.png`**, drawn by the same script: SPC planks (1220 × 180mm, staggered joints, micro-bevel) tinted oak in `Room.tsx`. A generated woodgrain is allowed there and only there — the floor is room context, not a board anyone is sold
- **A finish can override that with a real decor photo.** The `finish:<id>` site-image slot feeds both the landing swatch and the 3D door, so uploading one supplier decor scan makes the strip and the cabinet show the same board. The photo becomes the front's `map` with the material colour set to white; the grain tile stays on as the roughness map. Absent an upload, the generated grain tinted by `finish.hex` is the fallback — see `components/planner/grain.ts`.
- **Decor scans are the supplier's IP.** Board suppliers (Max World and the like) publish decor images for their own catalogue; they are production print masters, not stock photography. Get written permission before putting one on a public page — for a fabricator that buys the board this is normally just a request to the rep
- **The geometry is not the problem; the textures are.** Measured on the client's own export: a whole wall run is 176 KB of binary geometry, one cabinet ~25 KB (~13 KB gzipped). One decor scan is 178 KB. Budget accordingly — the reflex to cut triangles is aimed at the wrong thing here.
- **Meshes are served `immutable` and fetched once per SKU.** The pathname carries the source file's sha256, so a given URL's bytes never change; `DesignedCabinet.tsx` caches the *promise*, so four identical base units in a run are one request. Prefetch sibling ladder rungs if changing a width ever feels slow.
- **A design past `MAX_TRIANGLES` (200,000) is refused** and falls back to procedural. That is not a cabinet — it is a whole room, or a file with the furniture library left switched on.
- `InstancedMesh` for shelves/drawers only if a design gets large enough to need it

Two features carry the sale: a **doors-open / doors-hidden toggle** so the customer sees their interior, and a **canvas screenshot** attached to the quote. That screenshot going out over WhatsApp is what closes the lead.

## Where assets live

| Kind | Home | Why |
| --- | --- | --- |
| Grain/laminate textures | `/public` | Static, versioned with code, free off Vercel CDN |
| Palette thumbnails | Inline SVG (`components/planner/thumbs.tsx`) | Drawn from the family's own proportions. Never boot a WebGL context per thumbnail. |
| Design exports (`.obj`, or `.zip` with textures) | Vercel Blob, **private** | The source file carries the client's module standard, layer structure and part naming. Never public, never in `/public`. Reachable only under `/api/admin`. |
| Derived render meshes (`.icbmesh`) | Vercel Blob, served **public** via `/api/cabinet-mesh/[id]` | The geometry a customer's browser draws, so it has to get out — but only as triangles, with the drafter's materials and every part name stripped. The store is private-access-only, so the route is the hole, exactly like site images. Regenerable from the source, so it is cache, not record. |
| Homepage / room / finish photos | Vercel Blob, public | Slot-keyed (`hero`, `room:<id>`, `finish:<id>`), uploaded at `/admin/site-content`. Slots are derived from the live catalogue, not hardcoded, so adding a finish adds its photo slot |
| Canvas screenshots | Vercel Blob | User-generated at runtime, one per lead |
| Quote PDFs | Vercel Blob | Same |
| Tutorial videos | **Mux**, not Blob | Needs transcoding, adaptive bitrate and a poster frame. Blob would serve one giant MP4 to a phone on Malaysian mobile data |
| Catalogue versions, designs, tutorials, site-image slots, leads, Blob URLs | Postgres | |

Test: if you could delete it and rebuild it from a `git clone`, it belongs in the repo, not Blob.

**Never base64 images into a Postgres column.** A design export is ~2 MB; a screenshot is tens of KB; a render mesh is ~42 KB. All of them live in Blob and only the pathname lives in a column. `CabinetDesign.meshGroups` is the one piece of derived geometry in Postgres, and it is a role/triangle-count summary for the review table — the planner never reads it, because the binary carries its own group table.

## UX flow

Three screens. Rooms open on an **empty wall**: there is no invented starter run to price, and one assembled from whatever designs exist would look random. Blank canvases still cost conversion, which is what the preset designs below are for.

1. **Start** — pick a room; a room with no designs yet is shown as coming soon and cannot be picked
2. **Studio** — drag cabinets in from a menu grouped by category, choose door style and finish, measure. A placed cabinet always wears a door style — its price includes the door
3. **Checkout** — price breakdown and delivery fee, place the order → `/[lang]/order/[token]`, which shows bank transfer details until an admin marks it paid

**An order is priced on the server, never by the client.** `POST /api/orders` (public, guarded by BotID) runs `validateOrder` — the engine forgives an unknown family or an off-ladder width silently, which is fine on a canvas and wrong for a payment — then `priceOrder` against the published catalogue, and stores the design as `{ schemaVersion, layout }` with the catalogue version it was priced against. A paid order's **Create delivery** (`/admin/logistics?fromOrder=`) fills the delivery form with one row per cabinet at its designed size and the design row's weight; the delivery create route refuses an order that is not paid.

**No login to configure.** The email/WhatsApp gate sits at **"save & share"**, not at entry — by then the customer has sunk time into a design and will trade a phone number to keep it.

Save writes the layout to Postgres under a `nanoid` slug, returns a short URL, creates the lead record, and attaches the screenshot. Then a `wa.me` deep link with the design URL prefilled.

Ship 8–10 **preset designs** as their own indexable routes ("2.4m 3-door kitchen run", etc). Each is an SEO landing page and an entry point into the planner — solves the blank-canvas problem and the traffic problem together.

### The studio's own chrome

- **A breadcrumb header** (`PlannerHeader.tsx`) instead of a stepper — the planner is one screen you stay on, not a wizard.
- **3D / elevation / plan toggle** (`PlannerView` in `PlannerScene.tsx`). Elevation and plan are orthographic and axis-locked: the point of an elevation is that it stays square, so one stray drag must not knock it off.
- **Room dimensions are editable in place** (`DimensionField.tsx`), ceiling height among them — it is a layout dimension in `PlannerLayout`, clamped by `CEILING_LIMITS`, not a constant, because it decides whether a tall unit fits.

### Tutorials

`/tutorials` is a public DIY video library; `/admin/tutorials` uploads to Mux with `@mux/upchunk` (direct-to-Mux, so the video never passes through a function) and polls `[id]/status` until the asset is ready. `lib/mux.ts` is `server-only` — those are write credentials for the video account and must never reach a customer's bundle.

This is the one place the app streams something it did not generate. It is a separate surface from the planner and shares nothing with it.

### Telemetry

PostHog **Cloud EU**, installed from the Vercel Marketplace, so we can see where customers drop out of the funnel and what broke in their browser. Vercel Web Analytics was rejected for this: anonymous aggregate counts, no per-visitor journeys, no replay, no alerts.

- **One module:** `lib/analytics.ts` — `track`, `captureError`, consent. `posthog-js` is imported on idle, never on the LCP path. `<Analytics>` mounts in `app/[lang]/layout.tsx` only; **admin is not tracked**.
- **Through our origin:** `next.config.ts` rewrites `/api/ph/*` to the EU hosts, so ad blockers do not hide drop-offs. `/api/` already bypasses the locale redirect and the admin gate. The region is hardcoded there and in `analytics.ts` because PostHog fixes it at install.
- **Consent (PDPA s.129):** cookieless until the visitor accepts (`opt_out_capturing_by_default` + `cookieless_mode: "on_reject"` — drop the first and "pending" sets cookies). Accepting enables cookies and the error-triggered replay. `/[lang]/privacy` is a **draft** for EzCabinet's counsel.
- **Never send form fields.** No `identify()` with phone or email, nothing a customer types in any event payload. Replay masks inputs.
- **Journey events** are a typed union in `analytics.ts`, fired from existing handlers — one per customer decision, never per pointer move. `quote_submitted` fires after `POST /api/orders` answers 201 — a placed order, not a button press.
- **Breakage:** `error.tsx`, `global-error.tsx`, WebGL context loss in `PlannerScene`, and mesh-load failures in `DesignedCabinet` (the procedural fallback hides them on screen).
- **Alerts → Slack:** PostHog error-tracking alerts (new/reopened issue, spike) and a funnel insight alert; server 5xx via the Vercel rule in `docs/ops/vercel-5xx-alert.json`.

## Auth

None for the public planner. The admin surface is a **shared-secret cookie** (`lib/adminAuth.ts`, HMAC over `ADMIN_PASSWORD`, gated in `proxy.ts`) — three internal users, one locked door, no user table. Upgrade to per-user accounts (Auth.js or Better Auth) when the Phase 3 lead inbox needs to know *which* admin did something.

## Relationship to Factory Tracker

Separate repository, deliberately. Factory Tracker is an authenticated B2B dashboard where bundle size barely matters; this is a public marketing surface where three.js weight decides whether the lead ever loads the page. Different audiences, deploy cadences, and risk profiles. A planner hotfix must not redeploy a system the factory floor depends on.

Phase 4 integration is a **versioned HTTP contract**, not a monorepo. Factory Tracker exposes `POST /api/v1/production-orders`; the planner calls it with a signed payload. Extract a shared types package only if that becomes painful.

Separate Postgres database from Factory Tracker.

## Phasing

| Phase | Work |
| --- | --- |
| 0 | Catalogue + pricing spec workshop with client, including the design-intake process |
| 1 | Layout schema, rules, pricing — headless, tested against fixtures ✅ |
| 2 | Planner UI + 3D scene ✅ |
| 3 | Lead capture, share links, admin inbox (admin catalogue + designs ✅; paid checkout, orders admin, order → delivery pre-fill ✅; share links and a real payment gateway not started) |
| 4 | Approved quote → **SKU list** → production job in Factory Tracker |

**Phase 4 changed shape when the planner started rendering the drafted model.** A derived cut list is no longer available, because the app no longer derives the cabinet — it draws the one the client already drew. What Factory Tracker receives is a SKU list (`1× BC 800mm`). For a factory that manufactures to standard modules that is arguably the more useful payload, but it is a change to the contract and **the client should hear it**.

## Known issues

Recorded rather than fixed. Do not paper over them; fix them deliberately.

1. **Drafter naming is load-bearing now.** `roles.ts` classifies mesh groups from the drafter's own names, and that classification decides which triangles take the customer's finish and which disappear on the doors-hidden toggle. A renamed group used to cost an inferred shelf count; it now costs the finish picker on that cabinet. The review table shows the classification before publish and the fallback is one material across the whole mesh, but this belongs in the Phase 0 conversation about drafting conventions.
2. **Until the first publish after the one-design-one-cabinet change, the live catalogue is the old one** — seed families with invented prices, and the junk `Testing123` among them. The first publish from `/admin/cabinet-designs` rebuilds it from design rows and removes them all. Set the base door style's surcharge to RM 0 before that publish, or every cabinet is charged its door twice.
3. **EasyParcel's webhooks are unsigned.** Nothing in their payload identifies the sender, so the callback URL carries a secret query token and that is the entire check — see `verifyWebhook` in `adapters/easyparcel.ts`.
4. **`pnpm easyparcel:ping` is the only thing that checks EasyParcel's real API shape**; CI runs against recorded fixtures and cannot see a renamed field. Run it before a release that touches `lib/logistics`, or wire it to a scheduled workflow with the credentials as repository secrets. It is deliberately not in PR CI: it needs secrets in the runner, it fails on EasyParcel's downtime rather than on our bugs, and a partner outage must not block an unrelated merge.

## Open questions — resolve before trusting pricing.ts

- **How does EzCabinet actually price cabinets?** The engine models it **per design, all-in** — each uploaded design carries its own price with its door included, door styles add a per-width surcharge, worktop by the running foot. A customer cannot take a door off to pay less. Confirm that matches their price list.
- **Does the public tool show a firm price or an indicative range?** Sales teams often resist public exact pricing. This is a business decision and it changes the UI.
- **Their real module range** — which widths exist for each cabinet — which is now simply which designs they upload.
- **Their real module standard** for living room, bedroom, and foyer. Only the kitchen dimensions come from a real design export; the rest are invented.
- **What does `Door_L_` mean?** The left-hand leaf of a pair, or a door hinged
  on its left stile? `hingeSideFromName` reads the token, but only trusts it for
  a *lone* door — on a pair the outward rule already answers it, and guessing
  the convention would be reading handedness into what may only be position.
  Their answer decides whether a single door's drawn name can seed its swing.
- **Design-intake cadence.** How often do new exports arrive, and will the panel naming (`G-UEnd_(L)`, `G-Door(R)`, …) stay stable? Extraction depends on it, so a change in their drawing habits is a change to `lib/mesh`.
- **The workshop's real street address and phone.** `WORKSHOP_ADDRESS` is
  `"EzCabinet Sdn Bhd, Klang Valley, Selangor"`, which does not geocode
  to a pin, so Lalamove cannot price a pickup from it — every delivery would be
  quoted from wherever that phrase happens to resolve to. `WORKSHOP_PHONE` is a
  placeholder, and it is the number a Lalamove driver rings from the loading bay.
  `WORKSHOP_POSTCODE`, `WORKSHOP_CITY` and `WORKSHOP_STATE` are placeholders
  derived from `WORKSHOP_PIN`, and EasyParcel prices the origin zone off them —
  a wrong postcode there is a wrong price on every parcel quote.
- Does Prisma Postgres offer an ap-southeast region? If not, quote submission eats a transpacific round trip.
- Does EzCabinet have an EasyParcel account, and who tops up the wallet? `submit_orders` deducts at booking time and a shipment cannot be booked against an empty wallet.
- **Which Malaysian payment gateway?** Orders take payment by manual bank transfer until one is chosen (Billplz, Curlec, senangPay, iPay88, …). `BANK_TRANSFER` in `lib/orders/payment.ts` is a placeholder account, and the confirmation page shows it to customers — fill it in before checkout goes live.
- **The delivery fee.** `RATES.deliveryFlatRm` is `85`, the figure from the client's Order Confirmation design; set the real one in the catalogue settings. It is flat — one fee whatever the load or the distance.
- **What happens when a paid design changes at re-measure?** The customer pays full price up front; there is no refund or top-up flow, so a re-measure that changes the cabinets is handled outside the app today.
- **Weights.** Parcel partners price by the kilogram. A design row's optional weight pre-fills its delivery rows; every design without one leaves the admin typing it per delivery.
- **The privacy notice at `/[lang]/privacy` is a draft.** EzCabinet is the PDPA data controller: their counsel approves the wording, and the PostHog DPA should be signed in their legal name. Ask too whether behavioural analytics counts as "systematic monitoring" under the DPO guideline.

## Conventions

- Sentence case in UI copy. Prices in RM.
- Every `lib/planner` function gets a test before it gets a caller.
- Commit catalogue changes separately from code changes so price history is greppable.
