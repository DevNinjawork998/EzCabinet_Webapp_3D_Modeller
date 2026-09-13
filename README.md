# Cabinet planner

Lead-generation cabinet planner for **EzCabinet Sdn Bhd**, built by JNS Nexion Enterprise.

A customer picks a room, arranges cabinets against one wall in 3D, sees a price, and requests a quote. Reference product is IKEA's PAX planner — one wall, one room at a time.

This is a marketing surface, not a manufacturing tool. A human validates every design before it becomes an order.

See [CLAUDE.md](./CLAUDE.md) for architecture, conventions, and the full phase plan. This file only covers getting it running.

## Status

Proof of concept.

| Phase | Scope | State |
|---|---|---|
| 0 | Catalogue + pricing spec with client | **Not started** |
| 1 | Layout engine, rules, pricing | Done, tested |
| 2 | Planner UI + 3D scene | Done |
| 3 | Lead capture, share links, admin inbox | Admin catalogue + designs done; lead capture not started |
| 4 | Quote → BOM → Factory Tracker | Not started |

> **Prices shown are not real.** Phase 0 hasn't happened, so every figure in
> `src/lib/planner/catalogue.ts` is a placeholder chosen to exercise the engine.
> No quote from these numbers is valid until EzCabinet confirms their rates.
>
> Kitchen *dimensions* are real — read out of the client's own Mozaik export by
> `lib/skp`. Every other room's dimensions are invented.

## Getting started

Requires Node 20+, pnpm, and Docker for the local database.

```bash
pnpm install
pnpm db:up          # local Postgres
pnpm db:migrate     # apply migrations
pnpm db:seed        # publish catalogue v1 from lib/planner/catalogue.ts
pnpm dev
```

Routes:

- `/` — landing page, prices its hero figure off the live published catalogue.
- `/planner` — the planner. `?room=kitchen|living|bedroom|foyer`.
- `/designs` — public gallery of published cabinet designs.
- `/admin/cabinet-designs`, `/admin/catalogue`, `/admin/import`,
  `/admin/logistics` — the admin surface. Shared-secret login at `/admin/login`;
  set `ADMIN_PASSWORD`. There is no `/admin` index.

## Deliveries

`/admin/logistics` books a pickup with a logistics partner and follows it to
site. The job is typed in by an admin — there is no order table yet (Phase 3),
so nothing feeds it automatically.

Only the partners whose credentials are present appear in the comparison. Out of
the box that is `manual` — the company's own lorry, booked by phone and moved
along its timeline by hand — which is what keeps the screen usable before any
carrier integration exists.

| Variable | For |
|---|---|
| `CRON_SECRET` | The tracking sweep at `/api/cron/track-deliveries`. Vercel sends it as `Authorization: Bearer`; without it the route refuses to run. |
| `LALAMOVE_API_KEY`, `LALAMOVE_API_SECRET` | Lalamove — vehicle class, the one that moves cabinets. A `pk_test…` key selects the sandbox host, anything else production. |
| `GOOGLE_GEOCODING_API_KEY` | Turns a delivery's address into the pin Lalamove prices against. Without it no vehicle partner can quote. |
| `EASYPARCEL_CLIENT_ID`, `EASYPARCEL_CLIENT_SECRET` | EasyParcel — parcels. OAuth app credentials; an admin links an account at `/admin/logistics`. |
| `GDEX_PRIMARY_API_KEY` | GDEX — the Azure APIM subscription key from the developer portal, sent as the `subscription-key` header. **Not** `Ocp-Apim-Subscription-Key`: GDEX renamed APIM's default, so the standard header is ignored and the gateway reports a missing key while a valid one is being sent. `GDEX_SECONDARY_API_SECRET` is that key's rotation spare, not a signing secret, and nothing reads it. |
| `GDEX_USER_TOKEN` | GDEX — the myGDEX account's Integration Token, sent as `User-Token`. From the myGDEX **web application** (User Profile → Integration Token), a different system from the developer portal. |
| `CITYLINK_API_KEY` | City-Link — parcels |
| `<CARRIER>_WEBHOOK_SECRET` | Verifying callbacks from a partner that signs them |

Lalamove, EasyParcel and GDEX are implemented; City-Link is still a stub, and
it is a single file plus its statuses in `lib/logistics/status.ts` — nothing
else changes when one is written. A partner with no credentials is not hidden:
it appears in the comparison as a row saying so, because "switched off" and
"refused this job" must not be the same blank screen.

**GDEX talks to the sandbox only.** The account holds no active subscription to
the live `myGDEX` product, so the base URL is a constant rather than a flag —
see `adapters/gdex.ts`. `pnpm gdex:ping` is the one thing that checks GDEX's
real API shape; like `easyparcel:ping` it needs credentials and is deliberately
kept out of PR CI. Its own `GDEX_LIVE=1` switches that script, not the app.

A delivery is geocoded when it is **saved**, not when it is quoted, so an
address Google cannot place shows as a warning on the job rather than as a
missing row in the partner comparison. Google returning `APPROXIMATE` — it found
the town and nothing finer — counts as a failure, because a lorry sent to the
town centre is a wrong delivery. An admin can paste a `3.1509, 101.5931` pin to
override the result.

Lalamove's webhook goes to `POST /api/webhooks/lalamove`, set in the Partner
Portal or via `PATCH /v3/webhook`. It is authenticated by the `apiKey` in the
payload matching `LALAMOVE_API_KEY`, because Lalamove does not sign callbacks.

Status reaches the app two ways. A partner that supports callbacks posts to
`/api/webhooks/<carrier>`, which sits outside `/api/admin` on purpose (the proxy
would 401 a carrier) and so verifies its own signature. Everything else is
covered by the cron sweep, which polls jobs that are booked but not yet
finished. Both paths write through one function, so the row means the same thing
either way.

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm test` | Vitest, engine tests only |
| `pnpm lint` | Biome check (lint + format) |
| `pnpm db:up` / `db:down` | Local Postgres via docker compose |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:seed` | Seed the published catalogue |
| `pnpm db:studio` | Prisma Studio |
| `pnpm generate:grain` | Regenerates `public/textures/grain-1k.png` |

`generate:grain` is a one-off — the PNG is committed. Only rerun it if you change the generator.

## Layout

```
src/
  lib/planner/         Pure TypeScript engine. No React, no three.js.
    catalogue.ts       Families, sizes, doors, finishes, rates (prices are placeholders)
    catalogueSchema.ts Zod schema for a published catalogue
    layout.ts          Placement, collision, snapping, starter layouts
    pricing.ts         (layout, catalogue) => itemised price
    measure.ts         The in-scene measuring tool
  lib/catalogue/       DB-backed catalogue: read path, versions, diffs, blob storage
  lib/logistics/       Delivery jobs: carrier adapters, quoting, booking, tracking
  lib/skp/             Reads a SketchUp job file into a draft catalogue
  components/planner/  React Three Fiber scene and the planner screens
  app/planner/         The planner route
  app/admin/           Catalogue editor, cabinet designs, .skp import
```

`lib/planner` must stay framework-free. If a change there needs React or three.js, the change is in the wrong place.

## Rules worth knowing before you edit

- **The layout document is the only source of truth.** Geometry, price, and eventually the cutting list are all derived from it. Nothing is stored twice.
- **Price is authoritative server-side.** The client figure is indicative; never trust a client-submitted price. `pricing.ts` takes its catalogue as an argument for exactly this reason — it never reads the live module palette.
- **All 3D geometry is procedural.** A carcass is six boxes, a rail is a cylinder. No imported models — they break parametric resizing and the path to a BOM.
- **The catalogue lives in the database, seeded from the repo.** `lib/planner/catalogue.ts` is the seed and the disaster-recovery copy; the live values come from the published `CatalogueVersion` row. Catalogue changes still ship as their own commit so price history stays greppable.
- **Target device is a mid-range Android on Malaysian mobile data.** One 1K greyscale grain texture tinted per finish, no real-time shadows, 3D bundle lazy-loaded behind `Suspense`.

## Testing

```bash
pnpm test
```

Covers the engine — layout, pricing, measuring, catalogue diffs, and `.skp` extraction — against fixtures in `src/lib/*/__tests__/`. Per CLAUDE.md, every `lib/planner` function gets a test before it gets a caller. There are no UI tests yet.
