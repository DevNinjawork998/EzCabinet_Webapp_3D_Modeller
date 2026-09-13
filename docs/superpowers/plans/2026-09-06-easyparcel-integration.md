# EasyParcel Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> On approval, copy this file to `docs/superpowers/plans/2026-09-06-easyparcel-integration.md` so it travels with the repo.

**Goal:** Replace the EasyParcel stub adapter with a working parcel partner — OAuth-connected, quoting, booking, tracking and cancelling through EasyParcel's `2026-06` Open API.

**Architecture:** EasyParcel becomes the second live `CarrierAdapter` alongside Lalamove, following the same shape: pure payload builders + a thin `call()` wrapper over `carrierFetch`. Two things the existing contract cannot express get widened rather than worked around — OAuth tokens (a DB row instead of an env var) and a webhook with no signature (a secret in the registered URL, so `verifyWebhook` learns to see the request URL). EasyParcel prices by postcode and state, not by coordinate, so the geocode that already runs at job-save time starts keeping the address components it currently discards.

**Tech Stack:** TypeScript, Zod, Prisma/Postgres, Next.js App Router route handlers, Vitest.

**Spec:** EasyParcel Open API docs — https://easyparcel.github.io/OpenAPI/ (version `2026-06`). Endpoint shapes quoted in this plan were read off that page directly, not from a summary.

---

## Context

`src/lib/logistics/adapters/easyparcel.ts` is a `stubAdapter` today. Its own comment says why: *"The request and response shapes are not public enough to write against."* They are now. EasyParcel publishes a full Open API reference, and this plan implements against it.

EasyParcel matters because of the split `carriers.ts` already draws: Lalamove is the `vehicle` partner that moves finished carcasses, and the `parcel` partners carry "hardware, samples and spare doors." Today every one of those small jobs is booked as `manual` — phoned in, no price, no tracking. EasyParcel is the one parcel partner with an API we can reach, and it fronts City-Link, DHL eCommerce, Skynet, J&T and the rest, so one integration covers the whole parcel side rather than three more adapters.

Four decisions were confirmed with the user before writing this plan:

1. **OAuth tokens live in a DB row**, with in-app connect/callback routes, so an admin can re-authorise from the admin page when the refresh token expires.
2. **Postcode, city and state come from the existing geocode** — Google already returns `address_components` on the call `geocode.ts` makes at save time.
3. **Standard shipping only.** EasyParcel's `/ondemand/*` API resells Lalamove and pandaGo; this app already talks to Lalamove directly, and routing it through a middleman would put two Lalamove prices on one comparison screen.
4. **Sandbox first.** Real calls, fake money. EasyParcel's sandbox never advances a shipment's status, so the tracking path is verified against recorded payloads in tests rather than live.

## Global Constraints

- **API version is `2026-06`.** Base URL `https://api.easyparcel.com`, all endpoints under `/open_api/2026-06/`. The docs page shows `shipment/details` under a `2026-03` URL inside the 2026-06 section — that is a typo on their page; use `2026-06` and fall back to `2026-03` only if it 404s.
- **All units convert at the boundary.** This codebase is millimetres and the catalogue carries no weights; EasyParcel is **centimetres and kilograms**. Convert in the adapter, never in `measure.ts`.
- **`lib/logistics` stays framework-free except where it is already not.** `carriers.ts`, `measure.ts`, `phone.ts`, `status.ts` and the new `malaysia.ts` are pure and isomorphic. Anything holding a credential or touching Prisma is `import "server-only"` at the top of the file.
- **Zod is the source of truth for every payload that crosses the process boundary** — EasyParcel replies, the OAuth token response, the webhook body. Infer TS types from the schema; never cast.
- **Booking spends money and is never retried.** `carrierFetch` only retries calls marked `idempotent: true`. Quotes, tracking reads and token refreshes are idempotent. `submit_orders` is not.
- **Sentence case in UI copy. Prices in RM.**
- Every new `lib/logistics` function gets a test before it gets a caller.
- `pnpm biome check --write .` and `pnpm test` clean before every commit; `pnpm tsc --noEmit` clean before every commit that changes types.

## How EasyParcel differs from Lalamove

`adapters/lalamove.ts` is the reference implementation and this adapter copies its shape deliberately — pure exported payload builders, a thin private `call()`, `readReply` over Zod instead of a cast, a `…NotDeliverable` error for job-shaped failures, `trace` at every step. What follows is where the two APIs genuinely diverge, and what each divergence costs.

| | Lalamove v3 | EasyParcel `2026-06` | Consequence |
| --- | --- | --- | --- |
| **Auth** | HMAC-SHA256 over `ts\r\nVERB\r\npath\r\n\r\nbody`, key + secret from env | OAuth 2.0 authorization code, `Bearer` token, 10 h access / ~1 y refresh | The only difference the `CarrierAdapter` contract cannot absorb. Needs `tokens.ts`, a DB row, and a human click-through — **Task 3**. |
| **Sandbox vs live** | Decided by the key: `pk_test…` picks the sandbox host | Same host, same app; decided by which **account** an admin links at connect time | The adapter cannot tell you which one it is on. Nothing in code can assert it, so the admin page says "connected", never "connected to live". |
| **Addressing** | `stops[].coordinates` required; the address line is a label the driver reads | `postcode` + `subdivision_code` + `country`; coordinates are never sent | Opposite requirements from the same form. Both are read out of one Google reply at save time — **Task 2**. |
| **Weight** | Optional, and deliberately omitted (`item.weight` is an undocumented per-city enum) | **Required.** No weight, no quote | An unweighed job quotes on Lalamove and is refused by EasyParcel, with a message saying so on the row. |
| **Schedule** | `scheduleAt` optional; omitting it means "as soon as possible" | `collection_date` **required**, `YYYY-MM-DD` | A job with a null `scheduledAt` still needs a date. `collectionDate()` defaults to today in Kuala Lumpur. |
| **Phone** | E.164 whole: `+60123456789` | Split: `phone_number_country_code: "MY"` + `phone_number: "123456789"` | `toE164` is reused for both; EasyParcel strips the `+60` after it. |
| **Quote** | One price. `quotationId` valid **5 minutes**, plus two `stopId`s that must be carried into the order | A marketplace — one rate per courier service. No documented expiry; the booking is keyed on `service_id` alone | `quoteRef` packs three values for Lalamove and one for EasyParcel. See the re-quote note below. |
| **Failure signalling** | Non-2xx only | **HTTP 200 with per-element `status: "error"` and an `errors[]` array** | `carrierFetch` treats 200 as success, so every EasyParcel reply must additionally be checked at `data[0].status`. This is the easiest thing to get wrong in the whole integration. |
| **Booking retry** | Not idempotent — a retry is a second lorry | Not idempotent — a retry deducts the wallet twice and prints two consignment notes | Same posture. `idempotent` stays `false` on both `book` paths. |
| **Cancel** | `DELETE /v3/orders/{id}`; refused once a driver has been matched >5 min | `POST /shipment/cancel` with a `cancel_list[]` and a required `remark`; refunds to the wallet | Same contract (`cancel?()`), different verb and a mandatory reason string. |
| **Tracking read** | `GET /v3/orders/{id}`, then a second call for the driver | `POST /shipment/details` with the shipment number, one call | EasyParcel's is simpler but costs a token read (occasionally a refresh transaction) per poll. Still inside the cron's 50-job cap. |
| **Driver telemetry** | Name, phone, plate, live coordinates | **None.** A parcel network has no driver to report | `TrackingUpdate.driverName` / `latitude` / … stay `undefined` for EasyParcel, so `applyTrackingUpdate` leaves those columns alone and the admin panel's driver block renders empty. Correct, not missing. |
| **Status vocabulary** | Seven words; **no in-transit state** — a Lalamove job goes `PICKED_UP` → `COMPLETED` | Numeric codes `0/2/3/4/5/6/7/8/11`, and `4` really is in-transit | Both go through `CARRIER_STATUS_MAPS` and `mapCarrierStatus` unchanged. EasyParcel's table is keyed on the stringified code, because the *text* belongs to the courier, not to EasyParcel. |
| **Webhook identity** | Unsigned, but the body carries the `apiKey` the order was placed with | **Unsigned and carries nothing.** No HMAC, no header, no timestamp | The only check left is a secret we put in the registered URL, which is the upgrade path `lalamove.ts`'s own comment already names. `verifyWebhook` gains a `url` argument — **Task 6**. |
| **Webhook noise** | 10 event types, 2 carry an order | 5 topics, 4 carry a `shipment_number`, 1 (OnDemand) does not | The `{ kind: "ignored" }` member added in `cf31ac1` covers EasyParcel unchanged. Same lesson, second partner. |
| **Order id** | `orderId`, one opaque string | `shipment_number` (`ES-YYMM-XXXXX`) for `details`/`cancel`, `awb_number` for `tracking_status` | `carrierOrderId` holds the shipment number; using `details` rather than `tracking_status` for the poll is what keeps it to one column. |
| **Printable label** | None — a driver turns up | `awb_url`, and the courier will not collect a box without it taped on | The one field `CarrierBooking` does not have. Adds `labelUrl` — **Task 5**. |

### The one behavioural difference worth deciding on

`book/route.ts` re-quotes immediately before booking and uses the **fresh** quote's `quoteRef`, discarding the one the admin clicked. For Lalamove that is mandatory: the `quotationId` expires in five minutes and the `stopId`s must match it.

For EasyParcel it means the admin can see *"City-Link — RM 9.80"*, click book, and have the re-quote's `cheapest()` return DHL at RM 9.75 — booked with a different courier than the row said, and under the 10% guard the route uses to catch a price move.

This plan leaves that behaviour alone and documents it, for three reasons: `cheapest()` is deterministic on the same rates, EasyParcel's rates move daily at most, and the booking confirmation shows the courier that was actually booked. The alternative — threading the admin's chosen `quoteRef` through `bookInputSchema` and into `book()` — would have to be conditional per carrier, because Lalamove must *not* honour a stale ref. Record it as a `ponytail:` comment on `cheapest()` naming that as the upgrade path, and revisit if a courier swap ever surprises anyone.

### What needs no change at all

`http.ts`, `store.ts`, `measure.ts`, `phone.ts`, `trace.ts`, `registry.ts`, `carriers.ts`'s carrier list, `quotes/route.ts`, `cron/track-deliveries/route.ts` and `applyTrackingUpdate` all take the second live partner without edits. That is the contract working — the churn is confined to the four places the two APIs genuinely disagree: credentials, addressing, the webhook's identity, and the printable label.

## Testing strategy

Three layers, and the split matters because only two of them can run in CI.

**1. Pure functions — unit tests.** `subdivisionCode`, `mmToCm`, `parcelOf`, `quotationBody`, `submitBody`, `collectionDate`, `cheapest`, `willExpireSoon`, the status table. No I/O, fast, and where most of the assertions live. This is the layer the repo already has for Lalamove.

**2. The wire — stubbed-`fetch` tests.** Every adapter method, every route the integration adds, exercised end to end with `vi.stubGlobal("fetch", …)`. This is the layer that answers *"is the API being called as intended"* in CI, and it asserts **both directions**:

- **What we send** — the exact URL, the `Authorization` header, and the serialised request body, read off `fetchMock.mock.calls[0]`. `lalamove.test.ts` already does this (it re-derives the HMAC from `init.body` to prove the signed bytes are the sent bytes); EasyParcel's equivalents assert the Bearer token and the JSON payload.
- **What we do with the reply** — the response fixtures are copied **verbatim from EasyParcel's own documented samples** into `__tests__/fixtures/easyparcel.ts`, so a Zod schema that drifts from their real shape fails a test rather than a booking. Every failure mode gets a case too: the HTTP-200-with-`status: "error"` shape, a reply missing a field, a token that has expired.

**3. The real API — a smoke script, not a test.** `scripts/easyparcel-ping.mjs`, run as `pnpm easyparcel:ping`, mirroring `scripts/lalamove-ping.mjs`. It calls the sandbox with real credentials and prints what comes back verbatim. This is what catches EasyParcel changing a field name — the thing layer 2 structurally cannot see, because layer 2's fixtures are our belief about their API rather than their API.

**Deliberately not done: live API calls in PR CI.** They need secrets in the runner, they fail on EasyParcel's downtime rather than on our bugs, and `submit_orders` spends wallet credit on every run. The ping script is the escape hatch, and the right place for it is a scheduled job or a pre-release check — noted in Task 8 rather than wired up, because that is an ops decision.

**CI itself does not exist yet.** There is no `.github/` in this repo. Task 8 adds `lint · typecheck · test`, which is what makes every test above actually gate a merge — without it these are tests someone remembers to run.

## File Structure

**New:**

| File | Responsibility |
| --- | --- |
| `src/lib/logistics/malaysia.ts` | Malaysian state name → ISO 3166-2 code (`"Selangor"` → `"MY-10"`). Pure, isomorphic. |
| `src/lib/logistics/oauth.ts` | The OAuth 2.0 half that touches no database: URLs, the token schema, the token-endpoint call, expiry maths. Testable with a stubbed `fetch`. |
| `src/lib/logistics/tokens.ts` | The thin half that does: read the row, refresh under a lock, write it back. `server-only`. |
| `src/app/api/admin/logistics/easyparcel/connect/route.ts` | Redirects the admin to EasyParcel's login. |
| `src/app/api/admin/logistics/easyparcel/callback/route.ts` | Exchanges the returned code for the first token pair. |
| `src/lib/logistics/__tests__/fixtures/easyparcel.ts` | Every EasyParcel payload this integration parses, copied verbatim from their docs. One place, so a shape change is one edit. |
| `src/lib/logistics/__tests__/malaysia.test.ts` | |
| `src/lib/logistics/__tests__/oauth.test.ts` | |
| `src/lib/logistics/__tests__/tokens.test.ts` | |
| `src/lib/logistics/__tests__/easyparcel.test.ts` | |
| `scripts/easyparcel-ping.mjs` | Live smoke test against the sandbox, mirroring `scripts/lalamove-ping.mjs`. Run by a human or a nightly job, never in PR CI. |
| `.github/workflows/ci.yml` | lint · typecheck · test on every push and PR. The repo has no CI today. |

**Modified:**

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | `Delivery`: six place columns + `labelUrl`. New `CarrierToken` model. |
| `src/lib/logistics/geocode.ts` | Parse `address_components`; return postcode, city, state. |
| `src/lib/logistics/carriers.ts` | `WORKSHOP_POSTCODE` / `_CITY` / `_STATE`, and `pickupPlace()` beside `pickupPin()`. |
| `src/lib/logistics/types.ts` | `DeliveryJob` place fields; `CarrierBooking.labelUrl`; `verifyWebhook` gains a `url` parameter. |
| `src/lib/logistics/status.ts` | Fill `CARRIER_STATUS_MAPS.easyparcel`. |
| `src/lib/logistics/store.ts` | `toJob` carries the place fields. |
| `src/lib/logistics/adapters/easyparcel.ts` | Replace the stub with the real adapter. |
| `src/app/api/admin/deliveries/route.ts`, `[id]/route.ts` | Persist the place columns on create and edit. |
| `src/app/api/admin/deliveries/[id]/book/route.ts` | Persist `labelUrl`. |
| `src/app/api/webhooks/[carrier]/route.ts` | Pass the request URL to `verifyWebhook`. |
| `src/app/admin/logistics/LogisticsManager.tsx` | "Print AWB label" link; EasyParcel connection state. |
| `CLAUDE.md` | Logistics section + open questions. |

---

## Task 1: Malaysian state codes

EasyParcel takes `subdivision_code` as ISO 3166-2 (`"MY-10"`). Google's geocoder returns a state *name*. This is the table between them, and it is the only new pure module the integration needs.

**Files:**
- Create: `src/lib/logistics/malaysia.ts`
- Test: `src/lib/logistics/__tests__/malaysia.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `subdivisionCode(stateName: string): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/logistics/__tests__/malaysia.test.ts
import { describe, expect, it } from "vitest";
import { subdivisionCode } from "../malaysia";

describe("subdivisionCode", () => {
	it("maps the states Google actually returns", () => {
		expect(subdivisionCode("Selangor")).toBe("MY-10");
		expect(subdivisionCode("Johor")).toBe("MY-01");
		expect(subdivisionCode("Sarawak")).toBe("MY-13");
	});

	it("is case and whitespace insensitive", () => {
		expect(subdivisionCode("  selangor ")).toBe("MY-10");
	});

	it("accepts the names Google and the post office disagree about", () => {
		// Google says "Penang"; EasyParcel's own examples say "Pulau Pinang".
		expect(subdivisionCode("Penang")).toBe("MY-07");
		expect(subdivisionCode("Pulau Pinang")).toBe("MY-07");
		expect(subdivisionCode("Malacca")).toBe("MY-04");
		expect(subdivisionCode("Melaka")).toBe("MY-04");
	});

	it("handles the federal territories, prefix and all", () => {
		expect(subdivisionCode("Kuala Lumpur")).toBe("MY-14");
		expect(subdivisionCode("Federal Territory of Kuala Lumpur")).toBe("MY-14");
		expect(subdivisionCode("Wilayah Persekutuan Kuala Lumpur")).toBe("MY-14");
		expect(subdivisionCode("Putrajaya")).toBe("MY-16");
		expect(subdivisionCode("Labuan")).toBe("MY-15");
	});

	it("passes an ISO code straight through", () => {
		expect(subdivisionCode("MY-10")).toBe("MY-10");
	});

	it("returns null for a name it does not know", () => {
		expect(subdivisionCode("Singapore")).toBeNull();
		expect(subdivisionCode("")).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/malaysia.test.ts`
Expected: FAIL — `Failed to resolve import "../malaysia"`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/logistics/malaysia.ts
/**
 * A Malaysian state's name in ISO 3166-2, which is the only spelling EasyParcel
 * accepts for `subdivision_code`.
 *
 * Pure and isomorphic — no credentials, no I/O. It exists because the two ends
 * of this integration name the same thirteen states differently: Google's
 * geocoder returns `administrative_area_level_1` as a display name, and the
 * display name it picks is not stable across Malay and English, nor across
 * "Penang" and "Pulau Pinang".
 *
 * Null rather than a guess. A wrong subdivision is a quote for the wrong zone,
 * which is a real price the admin would act on — better a carrier row that says
 * the state could not be read.
 */

const CODES: Record<string, string> = {
	johor: "MY-01",
	kedah: "MY-02",
	kelantan: "MY-03",
	melaka: "MY-04",
	malacca: "MY-04",
	"negeri sembilan": "MY-05",
	pahang: "MY-06",
	"pulau pinang": "MY-07",
	penang: "MY-07",
	perak: "MY-08",
	perlis: "MY-09",
	selangor: "MY-10",
	terengganu: "MY-11",
	sabah: "MY-12",
	sarawak: "MY-13",
	"kuala lumpur": "MY-14",
	labuan: "MY-15",
	putrajaya: "MY-16",
};

/**
 * The three federal territories arrive with a prefix as often as without it,
 * and in either language. Stripping the prefix is cheaper than six more keys.
 */
const PREFIX =
	/^(wilayah persekutuan|federal territory of|w\.?p\.?|ft)\s+/;

export function subdivisionCode(stateName: string): string | null {
	const trimmed = stateName.trim();
	if (trimmed === "") return null;

	// An ISO code that has already been resolved once passes through unchanged,
	// so a stored value can be re-read without a second lookup.
	if (/^MY-\d{2}$/i.test(trimmed)) return trimmed.toUpperCase();

	const key = trimmed.toLowerCase().replace(PREFIX, "");
	return CODES[key] ?? null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/malaysia.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/malaysia.ts src/lib/logistics/__tests__/malaysia.test.ts
git commit -m "feat(logistics): read a Malaysian state name as an ISO subdivision"
```

---

## Task 2: A delivery remembers its postcode, city and state

EasyParcel prices by postcode and subdivision, not by coordinate. The geocode that already runs at save time receives all three inside `address_components` and throws them away. This task keeps them.

`labelUrl` rides along in the same migration rather than waiting for Task 5, so the schema is touched once.

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/logistics/geocode.ts`
- Modify: `src/lib/logistics/carriers.ts`
- Modify: `src/lib/logistics/types.ts` (the `DeliveryJob` type only)
- Modify: `src/lib/logistics/store.ts` (`toJob` only)
- Modify: `src/app/api/admin/deliveries/route.ts`, `src/app/api/admin/deliveries/[id]/route.ts`
- Test: `src/lib/logistics/__tests__/geocode.test.ts` (extend), `src/lib/logistics/__tests__/carriers.test.ts` (extend)

**Interfaces:**
- Consumes: `subdivisionCode` from Task 1.
- Produces:
  - `GeocodeResult` gains `postcode: string | null`, `city: string | null`, `state: string | null` (state already an ISO code).
  - `StoredPin` gains the same three fields.
  - `DeliveryJob` gains `sitePostcode`, `siteCity`, `siteState`, `pickupPostcode`, `pickupCity`, `pickupState`, all `string | null`.
  - `pickupPlace(address, stored): { postcode, city, state } | null` in `carriers.ts`.
  - `WORKSHOP_POSTCODE`, `WORKSHOP_CITY`, `WORKSHOP_STATE` in `carriers.ts`.

- [ ] **Step 1: Write the failing geocode test**

Append to `src/lib/logistics/__tests__/geocode.test.ts`. Match the existing file's `fetch` mocking style — read the top of that file first and reuse whatever helper it already has for stubbing a Google reply.

```ts
describe("geocodeAddress address components", () => {
	it("keeps the postcode, city and ISO state", async () => {
		// Stub fetch with the shape below, then:
		const found = await geocodeAddress("Jalan PJU 5/20, Kota Damansara");
		expect(found?.postcode).toBe("47810");
		expect(found?.city).toBe("Petaling Jaya");
		expect(found?.state).toBe("MY-10");
	});

	it("returns nulls for the components Google omits, not a throw", async () => {
		// Stub a result whose address_components has only `country`.
		const found = await geocodeAddress("Somewhere vague but precise");
		expect(found?.postcode).toBeNull();
		expect(found?.city).toBeNull();
		expect(found?.state).toBeNull();
	});
});
```

The Google reply to stub — the `address_components` array is what this task adds to the parse:

```json
{
  "status": "OK",
  "results": [{
    "formatted_address": "Jalan PJU 5/20, Kota Damansara, 47810 Petaling Jaya, Selangor",
    "geometry": {
      "location": { "lat": 3.1509, "lng": 101.5931 },
      "location_type": "ROOFTOP"
    },
    "address_components": [
      { "long_name": "47810", "short_name": "47810", "types": ["postal_code"] },
      { "long_name": "Petaling Jaya", "short_name": "PJ", "types": ["locality"] },
      { "long_name": "Selangor", "short_name": "Selangor", "types": ["administrative_area_level_1", "political"] },
      { "long_name": "Malaysia", "short_name": "MY", "types": ["country", "political"] }
    ]
  }]
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/geocode.test.ts`
Expected: FAIL — `postcode` is `undefined`.

- [ ] **Step 3: Extend the geocode parse**

In `src/lib/logistics/geocode.ts`, add `address_components` to `responseSchema.results[]` and a reader beside it. Everything else in the file — the `PRECISE` gate, the null-on-anything-unexpected contract, `resolveCoordinates`' three rules — stays exactly as it is.

```ts
import { subdivisionCode } from "./malaysia";

// …inside the result object in responseSchema:
	address_components: z
		.array(
			z.object({
				long_name: z.string(),
				short_name: z.string(),
				types: z.array(z.string()),
			}),
		)
		.default([]),
```

```ts
type Component = { long_name: string; short_name: string; types: string[] };

/**
 * Google returns the address broken into components; we keep the three
 * EasyParcel prices against.
 *
 * `locality` is the city in Klang Valley, but Google drops it for some
 * addresses and puts the town in `administrative_area_level_2` instead — so
 * both are read, most specific first. Everything is nullable: a component
 * Google did not return is a field EasyParcel will refuse the job for, and the
 * adapter says so on the comparison row. Filling it with a plausible guess
 * would produce a quote for the wrong zone instead.
 */
function readPlace(components: Component[]) {
	const first = (type: string) =>
		components.find((c) => c.types.includes(type)) ?? null;

	const state = first("administrative_area_level_1");
	const city = first("locality") ?? first("administrative_area_level_2");

	return {
		postcode: first("postal_code")?.long_name ?? null,
		city: city?.long_name ?? null,
		// Stored as the ISO code, not the display name: the name is what varies
		// between Google's answers and EasyParcel is the only consumer.
		state: state ? subdivisionCode(state.long_name) : null,
	};
}
```

Return it from `geocodeAddress`:

```ts
		return {
			lat: best.geometry.location.lat,
			lng: best.geometry.location.lng,
			formattedAddress: best.formatted_address,
			...readPlace(best.address_components),
		};
```

Widen the two types in the same file:

```ts
export type GeocodeResult = {
	lat: number;
	lng: number;
	formattedAddress: string;
	postcode: string | null;
	city: string | null;
	state: string | null;
};

export type StoredPin = {
	lat: number | null;
	lng: number | null;
	geocodedFor: string | null;
	postcode: string | null;
	city: string | null;
	state: string | null;
};
```

And carry them through `resolveCoordinates`' three branches. The rules do not change — only the payload widens:

```ts
export async function resolveCoordinates(
	address: string,
	current: StoredPin,
	override: { lat: number; lng: number } | null,
): Promise<StoredPin> {
	if (override) {
		// An admin-typed pin overrides the *coordinates*, not the postcode — they
		// are correcting where the map dropped the marker, not telling us the job
		// moved to another state. The stored place is kept when the address is
		// unchanged and re-read from the geocode when it is not.
		const place =
			current.geocodedFor === address
				? current
				: ((await geocodeAddress(address)) ?? {
						postcode: null,
						city: null,
						state: null,
					});
		return {
			lat: override.lat,
			lng: override.lng,
			geocodedFor: address,
			postcode: place.postcode,
			city: place.city,
			state: place.state,
		};
	}
	if (current.geocodedFor === address && current.lat !== null) {
		return current;
	}
	const found = await geocodeAddress(address);
	return found
		? {
				lat: found.lat,
				lng: found.lng,
				geocodedFor: address,
				postcode: found.postcode,
				city: found.city,
				state: found.state,
			}
		: {
				lat: null,
				lng: null,
				geocodedFor: null,
				postcode: null,
				city: null,
				state: null,
			};
}
```

- [ ] **Step 4: Run the geocode tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/geocode.test.ts`
Expected: PASS. Fix any existing test in that file that constructs a `StoredPin` literal — they now need the three new fields.

- [ ] **Step 5: Add the workshop's place and `pickupPlace`**

In `src/lib/logistics/carriers.ts`, beside `WORKSHOP_PIN` and `WORKSHOP_PHONE`:

```ts
/**
 * The workshop's postcode, town and state.
 *
 * EasyParcel prices by postcode and subdivision rather than by coordinate, so
 * these are to a parcel quote what `WORKSHOP_PIN` is to a Lalamove one: without
 * them the sender half of the request cannot be built at all.
 *
 * ponytail: derived from `WORKSHOP_PIN`, which sits in the Dengkil/Sepang area
 * of Selangor, and placeholders until the client confirms the street address —
 * the same open question `WORKSHOP_ADDRESS` and `WORKSHOP_PHONE` carry. A wrong
 * postcode here is a quote for the wrong origin zone on every parcel job.
 */
export const WORKSHOP_POSTCODE = "43800";
export const WORKSHOP_CITY = "Dengkil";
export const WORKSHOP_STATE = "MY-10";

export type Place = {
	postcode: string | null;
	city: string | null;
	state: string | null;
};

/**
 * The place to quote a pickup from: what the geocode stored, then the
 * workshop's own, then nothing.
 *
 * Same shape and same reasoning as `pickupPin` — the address check is what
 * keeps an edited pickup from silently inheriting the workshop's postcode.
 */
export function pickupPlace(address: string, stored: Place): Place | null {
	if (stored.postcode !== null && stored.state !== null) return stored;
	return address.trim() === WORKSHOP_ADDRESS
		? {
				postcode: WORKSHOP_POSTCODE,
				city: WORKSHOP_CITY,
				state: WORKSHOP_STATE,
			}
		: null;
}
```

Add cases to `src/lib/logistics/__tests__/carriers.test.ts` mirroring whatever it already asserts about `pickupPin`: a stored place wins; the workshop address with an empty stored place gets the constants; another address with an empty stored place gets `null`.

- [ ] **Step 6: Migrate the schema**

In `prisma/schema.prisma`, on `model Delivery`, beside the existing `siteLat`/`siteGeocodedFor` block:

```prisma
  /// What EasyParcel prices against. Lalamove takes coordinates and reads the
  /// address line as a label; a parcel network does the opposite — it wants a
  /// postcode and an ISO 3166-2 subdivision and has no use for a pin. Both are
  /// read out of the same Google reply at save time, so a job carries whichever
  /// half the partner it ends up on needs.
  sitePostcode      String?
  siteCity          String?
  siteState         String?
  pickupPostcode    String?
  pickupCity        String?
  pickupState       String?
  /// The consignment note to print and tape to the box. Distinct from
  /// `trackingUrl`, which is the page the customer watches: a parcel that
  /// leaves the workshop without its AWB affixed does not get collected.
  labelUrl          String?
```

Run: `pnpm prisma migrate dev --name delivery_place_and_label`
Then: `pnpm prisma generate`

- [ ] **Step 7: Carry the fields through `DeliveryJob` and `toJob`**

In `src/lib/logistics/types.ts`, add to the `DeliveryJob` type after the lat/lng block:

```ts
	/**
	 * Null when the geocode did not return them — see `lib/logistics/geocode.ts`.
	 * A parcel partner refuses the job rather than guessing.
	 */
	sitePostcode: string | null;
	siteCity: string | null;
	siteState: string | null;
	pickupPostcode: string | null;
	pickupCity: string | null;
	pickupState: string | null;
```

And in `src/lib/logistics/store.ts`, add the six matching lines to `toJob`.

- [ ] **Step 8: Persist them on create and edit**

In both `src/app/api/admin/deliveries/route.ts` (POST) and `src/app/api/admin/deliveries/[id]/route.ts` (PATCH):

- The `blank` seed in the POST route becomes `{ lat: null, lng: null, geocodedFor: null, postcode: null, city: null, state: null }`.
- The PATCH route's two `resolveCoordinates` current-pin literals gain `postcode: existing.sitePostcode, city: existing.siteCity, state: existing.siteState` (and the `pickup*` equivalents).
- Both `prisma` calls gain the six columns from the resolved `site` / `pickup` results, next to the `siteLat` / `siteGeocodedFor` lines already there.

- [ ] **Step 9: Verify the whole suite**

Run: `pnpm tsc --noEmit && pnpm test`
Expected: PASS. Any type error here is a `DeliveryJob` or `StoredPin` literal in a test fixture that needs the new fields — add them as `null`.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/logistics src/app/api/admin/deliveries
git commit -m "feat(logistics): keep the postcode and state the geocode already returns"
```

---

## Task 3: The OAuth connection

EasyParcel authenticates with OAuth 2.0 authorization code — a human clicks through an EasyParcel login once, and the app then holds a 10-hour access token and a ~1-year refresh token.

The token pair goes in a DB row rather than an env var for two reasons. EasyParcel's docs say the token endpoint returns *"the new Refresh token for the next refresh"* — if it rotates, an env var goes stale the first time it is used and there is no way to write one back from a serverless function. And a row is shared across Fluid Compute instances, so a refresh by one is a refresh for all.

It is split across two files on purpose. Everything that can be tested by stubbing `fetch` lives in `oauth.ts` and has no `prisma` import; only the read-refresh-write lives in `tokens.ts`. That is what lets the token exchange — the part most likely to be wrong — be covered by the same house pattern as every other test here, instead of needing a database in CI.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/logistics/oauth.ts`, `src/lib/logistics/tokens.ts`
- Create: `src/app/api/admin/logistics/easyparcel/connect/route.ts`
- Create: `src/app/api/admin/logistics/easyparcel/callback/route.ts`
- Create: `src/lib/logistics/__tests__/fixtures/easyparcel.ts`
- Test: `src/lib/logistics/__tests__/oauth.test.ts`, `src/lib/logistics/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: `carrierFetch` (`src/lib/logistics/http.ts`), `prisma` (`@/lib/catalogue/db`), `trace`.
- Produces from `oauth.ts` (no database, no `server-only`):
  - `tokenResponseSchema`, `type TokenResponse`
  - `willExpireSoon(expiresAt: Date, now?: Date): boolean`
  - `expiryFrom(seconds: number): Date`
  - `easyparcelAppConfigured(): boolean`
  - `easyparcelRedirectUri(): string`
  - `easyparcelLoginUrl(state: string): string`
  - `requestToken(params: Record<string, string>): Promise<TokenResponse>`
- Produces from `tokens.ts` (`server-only`):
  - `accessTokenFor(carrierId: string): Promise<string>` — throws `CarrierNotConfigured` when there is no connection.
  - `hasConnection(carrierId: string): Promise<boolean>`
  - `exchangeCode(code: string, connectedBy: string): Promise<void>` — the first authorisation.

- [ ] **Step 1: Add the model and migrate**

In `prisma/schema.prisma`:

```prisma
/// One logistics partner's OAuth tokens.
///
/// A row rather than an environment variable because the refresh token rotates:
/// EasyParcel hands back a new one on every refresh, and an env var cannot be
/// written from a function. One row per carrier, `carrierId` as the id, so a
/// second OAuth partner needs no migration.
///
/// These are booking credentials. Nothing outside `lib/logistics/tokens.ts`
/// reads this table, and that file is `server-only`.
model CarrierToken {
  carrierId             String   @id
  accessToken           String
  refreshToken          String
  accessTokenExpiresAt  DateTime
  refreshTokenExpiresAt DateTime
  /// The admin who clicked through the authorisation. Admin auth is one shared
  /// password, so this name is the whole record of who connected the account.
  connectedBy           String?
  connectedAt           DateTime @default(now())
  updatedAt             DateTime @updatedAt
}
```

Run: `pnpm prisma migrate dev --name carrier_token && pnpm prisma generate`

- [ ] **Step 2: Start the fixtures file**

Every EasyParcel payload this integration parses lives here, copied verbatim from their documented samples. One file, so a shape change is one edit rather than a hunt through four test files — and so a reviewer can diff our belief about their API against their docs directly.

```ts
// src/lib/logistics/__tests__/fixtures/easyparcel.ts
/**
 * EasyParcel's own documented response samples, verbatim.
 *
 * Verbatim is the point. These are not payloads shaped to make our schemas
 * pass — they are what https://easyparcel.github.io/OpenAPI/ prints for the
 * `2026-06` version, trimmed only of fields no schema in this repo reads. A
 * test built on a hand-written response proves the parser matches itself; one
 * built on theirs proves it matches them.
 *
 * When EasyParcel changes a shape, `pnpm easyparcel:ping` is what notices and
 * this file is what gets corrected.
 */

export const tokenReply = {
	token_type: "Bearer",
	expires_in: 36000,
	expires_at: "2026-09-06T13:03:23.013Z",
	access_token: "at_sandbox",
	refresh_token: "rt_sandbox",
	refresh_token_expires_in: 31557600,
	refresh_token_expires_at: "2027-09-06T09:03:23.013Z",
	app: {
		client_id: "your client-id",
		callbackUrls: [],
		redirectUris: ["https://your-app/callback"],
	},
};

export const quotationReply = {
	status_code: 200,
	request_id: "1770285829860.591d8c4f-ca8d-4e8b-9871-28e86ae541d9",
	message: "1 request success, 0 request error.",
	data: [
		{
			status: "success",
			input: {},
			quotations: [
				{
					courier: {
						service_id: "EP-CS096",
						service_name: "Aramex (Pick Up)",
						courier_id: "EP-CR0AP",
						courier_name: "Aramex",
						courier_logo: "https://s3-ap-southeast-1.amazonaws.com/…/Aramex.jpg",
						delivery_duration: null,
						service_tag: [{ name: "Service Methods", value: "Pick Up from Door" }],
						is_pickup: true,
						is_dropoff: false,
					},
					pricing: {
						currency: "MYR",
						total_amount: "10.84",
						shipment_price: "9.80",
						shipment_tax: "0.59",
						total_features_price: "0.45",
						total_features_tax: "0.00",
					},
					features: [],
				},
				{
					courier: {
						service_id: "EP-CS09C",
						service_name: "City-Link (Drop Off)",
						courier_id: "EP-CR0CL",
						courier_name: "City-Link Express",
						courier_logo: "https://s3-ap-southeast-1.amazonaws.com/…/CityLink.jpg",
						delivery_duration: "1-3 working days",
						service_tag: [{ name: "Service Methods", value: "Drop-Off" }],
						is_pickup: false,
						is_dropoff: true,
					},
					pricing: { currency: "MYR", total_amount: "8.20" },
					features: [],
				},
			],
			errors: [],
		},
	],
};

/** Their documented failure shape — HTTP 200, and the error is inside `data`. */
export const quotationRefusal = {
	status_code: 200,
	message: "0 request success, 1 request error.",
	data: [
		{
			status: "error",
			input: {},
			quotations: [],
			errors: ["No courier service available for this destination"],
		},
	],
};

export const submitReply = {
	status_code: 200,
	message: "1 request success, 0 request error.",
	data: [
		{
			status: "success",
			shipment_number: "ES-2602-VC4KV",
			courier: "DHL eCommerce",
			awb_number: "7028021894371796",
			awb_url:
				"https://app.easyparcel.com/portal/v2/public/label/ES-2602-VC4KV/3972206?format=A4",
			awb_urls_by_format: {
				A4: "https://app.easyparcel.com/portal/v2/public/label/ES-2602-VC4KV/3972206?format=A4",
				A5: "",
				A6: "https://app.easyparcel.com/portal/v2/public/label/ES-2602-VC4KV/3972206?format=A6",
			},
			tracking_url:
				"https://app.easyparcel.com/tools/easytrack/details?courier=DHLeC&awb=7028021894371796",
			weight: 4,
			height: 30,
			length: 40,
			width: 20,
			pricing_breakdown: { currency_code: "MYR", total_paid_amount: "13.42" },
			reference: "Delivery 41",
			errors: [],
		},
	],
};

/** A wallet with nothing in it is the failure an admin will actually hit. */
export const submitRefusal = {
	status_code: 200,
	message: "0 request success, 1 request error.",
	data: [
		{
			status: "error",
			shipment_number: null,
			errors: ["Insufficient credit balance"],
		},
	],
};

export const detailsReply = {
	status_code: 200,
	message: "success",
	data: [
		{
			shipment_number: "ES-2602-VC4KV",
			order_number: "EI-2602-U8FZW",
			shipment_details: {
				weight: 1.5,
				height: 5,
				length: 5,
				width: 5,
				shipment_status_code: 3,
				shipment_status: "Collected",
				awb_number: "7028021894371796",
				tracking_url:
					"https://app.easyparcel.com/tools/easytrack/details?courier=DHLeC&awb=7028021894371796",
			},
		},
	],
};

export const cancelReply = {
	status_code: 200,
	message: "1 requests success, 0 request error.",
	data: [
		{
			status: "success",
			message: "Shipment Cancelled",
			shipment_number: "ES-2602-VC4KV",
		},
	],
};

/** The five webhook topics, from their sample block. */
export const webhooks = {
	statusUpdate: {
		topic: "shipment.status.update",
		awb_number: "238725129086",
		event_date: "2026-09-06 11:40:00",
		shipment_number: "ES-2504-G7FDF",
		shipment_status: "Cancelled",
		shipment_status_code: 0,
	},
	awbUpdate: {
		topic: "shipment.awb.update",
		shipment_number: "ES-2504-G7FDF",
		uuid: "webhook-test-uuid-123",
		timestamp: "2026-09-06 11:40:00",
		awb_number: "23872512999",
		awb_url: "http://demo.connect.easyparcel.my/?ac=AWBLabel&id=QmIxTE43",
		tracking_url:
			"https://easyparcel.com/my/en/track/details/?courier=Skynet&awb=23877001999",
	},
	trackingUpdate: {
		topic: "shipment.tracking.update",
		shipment_number: "ES-2504-G7FDF",
		uuid: "webhook-test-uuid-123",
		timestamp: "2026-09-06 11:40:00",
		awb_number: "238725129086",
		latest_shipment_status_code: 5,
		latest_tracking_status: "Deliverd To Suntech",
		status_log: [],
	},
	ondemandUpdate: {
		topic: "ondemand.status.update",
		order_number: "EODWEBHOOK-TEST-001",
		status: 2,
		event_date: "2026-09-06 04:21:07",
	},
};
```

- [ ] **Step 3: Write the failing OAuth test**

This is the wire test for the token endpoint — the call most likely to be wrong, and the one no unit test of a schema would catch.

```ts
// src/lib/logistics/__tests__/oauth.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	easyparcelAppConfigured,
	easyparcelLoginUrl,
	easyparcelRedirectUri,
	requestToken,
	tokenResponseSchema,
	willExpireSoon,
} from "../oauth";
import { tokenReply } from "./fixtures/easyparcel";

/** Queue one JSON response per call, in order. Same helper as lalamove.test.ts. */
function stubResponses(...bodies: unknown[]) {
	const fetchMock = vi.fn(async (..._args: unknown[]) => {
		const next = bodies.shift() ?? {};
		return new Response(JSON.stringify(next), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.stubEnv("EASYPARCEL_CLIENT_ID", "cid");
	vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "csecret");
	vi.stubEnv("APP_URL", "https://planner.example.com");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("easyparcelAppConfigured", () => {
	it("is false when either half of the app credentials is missing", () => {
		vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "");
		expect(easyparcelAppConfigured()).toBe(false);
	});

	it("is true with both", () => {
		expect(easyparcelAppConfigured()).toBe(true);
	});
});

describe("easyparcelLoginUrl", () => {
	it("sends the client id, the redirect uri and the CSRF state", () => {
		const url = new URL(easyparcelLoginUrl("nonce-1"));
		expect(url.origin + url.pathname).toBe(
			"https://api.easyparcel.com/oauth/login",
		);
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("state")).toBe("nonce-1");
		expect(url.searchParams.get("redirect_uri")).toBe(easyparcelRedirectUri());
	});

	it("builds the redirect uri off APP_URL, because it must match what is registered", () => {
		expect(easyparcelRedirectUri()).toBe(
			"https://planner.example.com/api/admin/logistics/easyparcel/callback",
		);
	});
});

describe("requestToken", () => {
	it("posts form-encoded parameters, not JSON", async () => {
		const fetchMock = stubResponses(tokenReply);

		await requestToken({ grant_type: "authorization_code", code: "abc" });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe("https://api.easyparcel.com/oauth/token");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
		const sent = new URLSearchParams(init.body as string);
		expect(sent.get("grant_type")).toBe("authorization_code");
		expect(sent.get("code")).toBe("abc");
	});

	it("authenticates the app with Basic base64(id:secret)", async () => {
		const fetchMock = stubResponses(tokenReply);

		await requestToken({ grant_type: "refresh_token", refresh_token: "rt" });

		const headers = (fetchMock.mock.calls[0][1] as RequestInit)
			.headers as Record<string, string>;
		expect(headers.authorization).toBe(
			`Basic ${Buffer.from("cid:csecret").toString("base64")}`,
		);
	});

	it("returns their documented token reply, parsed", async () => {
		stubResponses(tokenReply);

		const token = await requestToken({ grant_type: "refresh_token" });

		expect(token.access_token).toBe("at_sandbox");
		expect(token.refresh_token).toBe("rt_sandbox");
		expect(token.expires_in).toBe(36000);
	});

	it("names the payload when the reply is not the shape we expect", async () => {
		stubResponses({ status_code: 401, message: "Unauthorized access" });

		await expect(requestToken({ grant_type: "refresh_token" })).rejects.toThrow(
			/not the shape we expect/,
		);
	});
});

describe("tokenResponseSchema", () => {
	it("survives a reply that omits the optional app block", () => {
		const parsed = tokenResponseSchema.parse({
			access_token: "at",
			refresh_token: "rt",
			expires_in: 36000,
			refresh_token_expires_in: 31557600,
		});
		expect(parsed.expires_in).toBe(36000);
	});

	it("refuses a reply with no access token", () => {
		expect(() => tokenResponseSchema.parse({ token_type: "Bearer" })).toThrow();
	});
});

describe("willExpireSoon", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
	});

	it("is false for a token with hours left", () => {
		expect(willExpireSoon(new Date("2026-09-06T09:00:00Z"))).toBe(false);
	});

	it("is true inside the safety margin, so a call never races the expiry", () => {
		expect(willExpireSoon(new Date("2026-09-06T00:00:30Z"))).toBe(true);
	});

	it("is true for a token that already expired", () => {
		expect(willExpireSoon(new Date("2026-09-05T23:00:00Z"))).toBe(true);
	});
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/oauth.test.ts`
Expected: FAIL — `Failed to resolve import "../oauth"`.

- [ ] **Step 5: Write `oauth.ts`**

```ts
// src/lib/logistics/oauth.ts
import { z } from "zod";
import { carrierFetch } from "./http";

/**
 * EasyParcel's OAuth 2.0 half that touches no database.
 *
 * Split out of `tokens.ts` so it can be tested the way everything else in this
 * folder is — a stubbed `fetch` and no Prisma client. The token exchange is the
 * single call most likely to be wrong (form-encoded body, Basic app auth, a
 * reply shape we do not control), so it is the call that most needs to be
 * covered without a database in the way.
 *
 * Deliberately not `server-only`: it reads the client secret from the
 * environment, and a client bundle has no environment to read it from, but the
 * file that holds the credentials for real is `tokens.ts` and that one is.
 */

export const OAUTH_BASE = "https://api.easyparcel.com";

const CLIENT_ID = () => process.env.EASYPARCEL_CLIENT_ID ?? "";
const CLIENT_SECRET = () => process.env.EASYPARCEL_CLIENT_SECRET ?? "";

export function easyparcelAppConfigured(): boolean {
	return CLIENT_ID() !== "" && CLIENT_SECRET() !== "";
}

/**
 * The URL EasyParcel sends the admin back to. Must match a redirect URI
 * registered on the app in their Developer Hub, byte for byte — a mismatch is
 * an error on their login page, not in our logs.
 */
export function easyparcelRedirectUri(): string {
	const base = process.env.APP_URL ?? "http://localhost:3000";
	return `${base}/api/admin/logistics/easyparcel/callback`;
}

export function easyparcelLoginUrl(state: string): string {
	const url = new URL(`${OAUTH_BASE}/oauth/login`);
	url.searchParams.set("client_id", CLIENT_ID());
	url.searchParams.set("redirect_uri", easyparcelRedirectUri());
	url.searchParams.set("state", state);
	return url.toString();
}

/**
 * Their token reply. `expires_at` is present in the documented sample but is
 * only ever derived from `expires_in`, so it is optional here and the seconds
 * are what we compute from — one clock (ours) rather than two.
 */
export const tokenResponseSchema = z.object({
	token_type: z.string().optional(),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	expires_at: z.string().optional(),
	refresh_token_expires_in: z.number().int().positive(),
	refresh_token_expires_at: z.string().optional(),
	app: z.looseObject({}).optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * How close to the expiry counts as expired.
 *
 * A token with twenty seconds left is a token that expires mid-request. Sixty
 * seconds is enough for the slowest call `carrierFetch` will wait for.
 */
const MARGIN_MS = 60_000;

export function willExpireSoon(expiresAt: Date, now = new Date()): boolean {
	return expiresAt.getTime() - now.getTime() <= MARGIN_MS;
}

function expiryFrom(seconds: number): Date {
	return new Date(Date.now() + seconds * 1000);
}

/** `Basic base64(client_id:client_secret)` — how their token endpoint authenticates the app. */
function basicAuth(): string {
	const raw = `${CLIENT_ID()}:${CLIENT_SECRET()}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/**
 * Their token endpoint takes form-encoded parameters, not JSON — so this is the
 * one call in the logistics module that does not go through `carrierFetch`'s
 * JSON body path. The string body form exists for exactly this.
 */
export async function requestToken(
	params: Record<string, string>,
): Promise<TokenResponse> {
	const body = new URLSearchParams(params).toString();
	const reply = await carrierFetch<unknown>(`${OAUTH_BASE}/oauth/token`, {
		carrierId: "easyparcel",
		method: "POST",
		headers: {
			authorization: basicAuth(),
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
		// Safe to send twice: an authorization code that has already been spent
		// comes back as a 4xx, which is not retried.
		idempotent: true,
	});
	const parsed = tokenResponseSchema.safeParse(reply);
	if (!parsed.success) {
		throw new Error(
			`EasyParcel's token reply was not the shape we expect: ${JSON.stringify(reply)?.slice(0, 200)}`,
		);
	}
	return parsed.data;
}

```

- [ ] **Step 6: Run the OAuth tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/oauth.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Write the failing token-store test**

`tokens.ts` is the only file in this integration that cannot be tested with a stubbed `fetch` alone — it reads and writes a row. `vi.mock` on the db module is a new pattern for this repo, so it gets a comment saying why; the alternative is a Postgres service in CI for one file's worth of logic.

```ts
// src/lib/logistics/__tests__/tokens.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenReply } from "./fixtures/easyparcel";

/**
 * The one mocked module in this folder.
 *
 * `tokens.ts` is read-check-refresh-write around a single row, and the check is
 * the part worth testing: that a live token is returned without a call, that an
 * expiring one is refreshed and written back, and that a dead refresh token
 * reports itself as not configured rather than looping. A fake row is enough
 * for all three, and it keeps CI free of a database.
 */
const row = {
	current: null as null | Record<string, unknown>,
};

vi.mock("@/lib/catalogue/db", () => ({
	prisma: {
		$transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
		carrierToken: {
			findUnique: async () => row.current,
			upsert: async ({ create, update }: never) => {
				row.current = { ...(row.current ?? {}), ...(update ?? create) };
				return row.current;
			},
		},
	},
}));

const tx = {
	$executeRaw: async () => 1,
	carrierToken: {
		findUnique: async () => row.current,
		update: async ({ data }: { data: Record<string, unknown> }) => {
			row.current = { ...(row.current ?? {}), ...data };
			return row.current;
		},
	},
};

const { accessTokenFor, exchangeCode, hasConnection } = await import("../tokens");
const { CarrierNotConfigured } = await import("../types");

function stubToken() {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify(tokenReply), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

beforeEach(() => {
	vi.stubEnv("EASYPARCEL_CLIENT_ID", "cid");
	vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "csecret");
	row.current = null;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("accessTokenFor", () => {
	it("returns a live token without calling EasyParcel", async () => {
		row.current = {
			carrierId: "easyparcel",
			accessToken: "still_good",
			refreshToken: "rt",
			accessTokenExpiresAt: hours(5),
			refreshTokenExpiresAt: hours(8000),
		};
		const fetchMock = stubToken();

		expect(await accessTokenFor("easyparcel")).toBe("still_good");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refreshes an expiring token and writes the rotated pair back", async () => {
		row.current = {
			carrierId: "easyparcel",
			accessToken: "about_to_die",
			refreshToken: "rt_old",
			accessTokenExpiresAt: hours(0),
			refreshTokenExpiresAt: hours(8000),
		};
		const fetchMock = stubToken();

		expect(await accessTokenFor("easyparcel")).toBe("at_sandbox");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// Rotation is the whole reason this lives in a row rather than an env var.
		expect(row.current.refreshToken).toBe("rt_sandbox");
	});

	it("reports not configured when nobody has connected an account", async () => {
		await expect(accessTokenFor("easyparcel")).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
	});

	it("reports not configured when the refresh token has itself expired", async () => {
		row.current = {
			carrierId: "easyparcel",
			accessToken: "dead",
			refreshToken: "rt_dead",
			accessTokenExpiresAt: hours(-1),
			refreshTokenExpiresAt: hours(-1),
		};
		const fetchMock = stubToken();

		await expect(accessTokenFor("easyparcel")).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
		// A year is up; retrying with a dead token would just fail slower.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports not configured when the app credentials are absent", async () => {
		vi.stubEnv("EASYPARCEL_CLIENT_ID", "");
		await expect(accessTokenFor("easyparcel")).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
	});
});

describe("exchangeCode", () => {
	it("stores the first token pair and who connected it", async () => {
		stubToken();
		await exchangeCode("auth-code", "admin");
		expect(row.current?.accessToken).toBe("at_sandbox");
		expect(row.current?.connectedBy).toBe("admin");
	});
});

describe("hasConnection", () => {
	it("is false with no row", async () => {
		expect(await hasConnection("easyparcel")).toBe(false);
	});

	it("is false once the refresh token has expired — it needs re-authorising", async () => {
		row.current = { refreshTokenExpiresAt: hours(-1) };
		expect(await hasConnection("easyparcel")).toBe(false);
	});

	it("is true while the refresh token is alive", async () => {
		row.current = { refreshTokenExpiresAt: hours(8000) };
		expect(await hasConnection("easyparcel")).toBe(true);
	});
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/tokens.test.ts`
Expected: FAIL — `Failed to resolve import "../tokens"`.

- [ ] **Step 9: Write `tokens.ts`**

```ts
// src/lib/logistics/tokens.ts
import "server-only";
import { prisma } from "@/lib/catalogue/db";
import {
	easyparcelAppConfigured,
	easyparcelRedirectUri,
	expiryFrom,
	requestToken,
	type TokenResponse,
	willExpireSoon,
} from "./oauth";
import { trace } from "./trace";
import { CarrierNotConfigured } from "./types";

/**
 * Where a logistics partner's OAuth tokens are read, refreshed and written.
 *
 * One file, for the same reason `store.ts` is one file: two callers refreshing
 * a rotating credential in two places is a credential neither of them holds any
 * more. Every EasyParcel call goes through `accessTokenFor`.
 */

async function write(carrierId: string, token: TokenResponse, connectedBy?: string) {
	const data = {
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		accessTokenExpiresAt: expiryFrom(token.expires_in),
		refreshTokenExpiresAt: expiryFrom(token.refresh_token_expires_in),
		...(connectedBy ? { connectedBy } : {}),
	};
	await prisma.carrierToken.upsert({
		where: { carrierId },
		create: { carrierId, ...data },
		update: data,
	});
}

/** The first authorisation: an admin has just come back from EasyParcel's login. */
export async function exchangeCode(
	code: string,
	connectedBy: string,
): Promise<void> {
	const token = await requestToken({
		grant_type: "authorization_code",
		code,
		redirect_uri: easyparcelRedirectUri(),
	});
	await write("easyparcel", token, connectedBy);
	trace("easyparcel.connected", { connectedBy });
}

export async function hasConnection(carrierId: string): Promise<boolean> {
	const row = await prisma.carrierToken.findUnique({ where: { carrierId } });
	return row !== null && row.refreshTokenExpiresAt.getTime() > Date.now();
}

/**
 * One lock id for all carrier tokens.
 *
 * ponytail: a single advisory lock serialises every refresh in the app, which
 * is correct and slightly coarse. It is here because the refresh token rotates:
 * two instances refreshing at once means the loser presents a token EasyParcel
 * has already invalidated, and the connection is dead until someone
 * re-authorises. Hash the carrierId into the lock id if a second OAuth partner
 * ever makes the contention real.
 */
const LOCK_ID = 8_215_041;

/**
 * A usable access token, refreshing it if it is close to expiry.
 *
 * The whole read-check-refresh-write runs inside one transaction holding a
 * Postgres advisory lock — see `LOCK_ID`. The lock is released when the
 * transaction ends, including when it throws.
 */
export async function accessTokenFor(carrierId: string): Promise<string> {
	if (!easyparcelAppConfigured()) throw new CarrierNotConfigured(carrierId);

	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ID})`;

		const row = await tx.carrierToken.findUnique({ where: { carrierId } });
		if (!row) throw new CarrierNotConfigured(carrierId);

		if (!willExpireSoon(row.accessTokenExpiresAt)) return row.accessToken;

		if (row.refreshTokenExpiresAt.getTime() <= Date.now()) {
			// A year is up. Nothing here can fix it — an admin has to click through
			// EasyParcel's login again.
			throw new CarrierNotConfigured(carrierId);
		}

		trace("easyparcel.refresh", { carrierId });
		const token = await requestToken({
			grant_type: "refresh_token",
			refresh_token: row.refreshToken,
			redirect_uri: easyparcelRedirectUri(),
		});

		await tx.carrierToken.update({
			where: { carrierId },
			data: {
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				accessTokenExpiresAt: expiryFrom(token.expires_in),
				refreshTokenExpiresAt: expiryFrom(token.refresh_token_expires_in),
			},
		});

		return token.access_token;
	});
}
```

- [ ] **Step 10: Run the token tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/tokens.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 11: Write the connect route**

```ts
// src/app/api/admin/logistics/easyparcel/connect/route.ts
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
	easyparcelAppConfigured,
	easyparcelLoginUrl,
} from "@/lib/logistics/tokens";

export const runtime = "nodejs";

/**
 * Send the admin to EasyParcel's login so they can link the account.
 *
 * Under `/api/admin`, so `proxy.ts` has already checked the admin cookie — and
 * so has the callback, which the browser reaches with the same cookie.
 *
 * `state` is a nonce in a short-lived cookie, checked on the way back. It is
 * the CSRF guard EasyParcel's own docs ask for: without it, anyone can feed
 * this app an authorization code for an account we did not choose.
 */
export async function GET() {
	if (!easyparcelAppConfigured()) {
		return NextResponse.json({ error: "not_configured" }, { status: 409 });
	}

	const state = randomUUID();
	const response = NextResponse.redirect(easyparcelLoginUrl(state));
	response.cookies.set("easyparcel_oauth_state", state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 600,
	});
	return response;
}
```

- [ ] **Step 12: Write the callback route**

```ts
// src/app/api/admin/logistics/easyparcel/callback/route.ts
import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/logistics/tokens";

export const runtime = "nodejs";

/**
 * Where EasyParcel sends the admin back with an authorization code.
 *
 * Always redirects to the logistics page rather than rendering — this is a
 * browser round trip, and the admin should land back where they started with a
 * banner saying what happened.
 */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const code = url.searchParams.get("code") ?? "";
	const state = url.searchParams.get("state") ?? "";

	const expected = request.headers
		.get("cookie")
		?.match(/easyparcel_oauth_state=([^;]+)/)?.[1];

	const done = (result: string) => {
		const back = new URL("/admin/logistics", url.origin);
		back.searchParams.set("easyparcel", result);
		const response = NextResponse.redirect(back);
		response.cookies.delete("easyparcel_oauth_state");
		return response;
	};

	// An unmatched state means this code did not come from a link we issued.
	if (code === "" || state === "" || state !== expected) {
		return done("failed");
	}

	try {
		// Admin auth is one shared password, so there is no name to record beyond
		// the fact that someone holding it did this.
		await exchangeCode(code, "admin");
	} catch {
		return done("failed");
	}

	return done("connected");
}
```

- [ ] **Step 13: Verify**

Run: `pnpm tsc --noEmit && pnpm test && pnpm biome check --write .`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/logistics/oauth.ts src/lib/logistics/tokens.ts src/lib/logistics/__tests__ src/app/api/admin/logistics
git commit -m "feat(logistics): hold a carrier's OAuth tokens and let an admin connect one"
```

---

## Task 4: EasyParcel quotes

The pure payload builders plus `quote()`. This is the task that makes an EasyParcel row appear on the comparison screen with a price on it.

`POST /open_api/2026-06/shipment/quotations` takes sender and receiver as `{ postcode, subdivision_code, country }` and the parcel as `{ weight, width, height, length, parcel_value }` — kilograms and centimetres. It returns a `quotations[]` array, one entry per courier service, each with a `courier.service_id` and a `pricing.total_amount`.

**Files:**
- Rewrite: `src/lib/logistics/adapters/easyparcel.ts`
- Test: `src/lib/logistics/__tests__/easyparcel.test.ts`

**Interfaces:**
- Consumes: `accessTokenFor`, `hasConnection`, `easyparcelAppConfigured` (Task 3); `pickupPlace`, `WORKSHOP_*` (Task 2); `carrierFetch`, `trace`, `toE164`.
- Produces (all exported for testing):
  - `EasyParcelNotDeliverable extends Error`
  - `mmToCm(mm: number): number`
  - `parcelOf(job: DeliveryJob): { weight, length, width, height }`
  - `quotationBody(job: DeliveryJob): object`
  - `cheapest(quotations: Quotation[]): Quotation | null`
  - `easyparcelAdapter.quote`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/logistics/__tests__/easyparcel.test.ts
import { describe, expect, it } from "vitest";
import {
	cheapest,
	EasyParcelNotDeliverable,
	mmToCm,
	parcelOf,
	quotationBody,
} from "../adapters/easyparcel";
import type { DeliveryItem, DeliveryJob } from "../types";
import { WORKSHOP_ADDRESS } from "../carriers";

const door: DeliveryItem = {
	label: "Spare door 400mm",
	qty: 2,
	widthMm: 400,
	heightMm: 720,
	depthMm: 20,
	weightKg: 3.5,
};

const job = (over: Partial<DeliveryJob> = {}): DeliveryJob => ({
	id: "cl_abc",
	number: 41,
	customerName: "Siti",
	customerPhone: "012-345 6789",
	siteAddress: "Jalan PJU 5/20, Kota Damansara",
	addressNotes: "Gate code 1234",
	pickupAddress: WORKSHOP_ADDRESS,
	siteLat: 3.1509,
	siteLng: 101.5931,
	pickupLat: 2.9848868,
	pickupLng: 101.861807,
	sitePostcode: "47810",
	siteCity: "Petaling Jaya",
	siteState: "MY-10",
	pickupPostcode: null,
	pickupCity: null,
	pickupState: null,
	items: [door],
	totalWeightKg: 7,
	totalVolumeM3: 0.012,
	scheduledAt: null,
	...over,
});

describe("mmToCm", () => {
	it("converts and rounds to the millimetre EasyParcel can express", () => {
		expect(mmToCm(400)).toBe(40);
		expect(mmToCm(725)).toBe(72.5);
	});

	it("never returns zero — a courier rejects a parcel with no dimension", () => {
		expect(mmToCm(2)).toBeGreaterThan(0);
	});
});

describe("parcelOf", () => {
	it("takes the whole job's weight and the largest item's box", () => {
		expect(parcelOf(job())).toEqual({
			weight: 7,
			length: 72,
			width: 40,
			height: 2,
		});
	});

	it("refuses a job nobody has weighed", () => {
		expect(() => parcelOf(job({ totalWeightKg: null }))).toThrow(
			EasyParcelNotDeliverable,
		);
	});

	it("refuses a carcass — that is a lorry job, not a parcel", () => {
		const carcass: DeliveryItem = {
			label: "BC 800mm",
			qty: 1,
			widthMm: 800,
			heightMm: 720,
			depthMm: 560,
			weightKg: 45,
		};
		expect(() =>
			parcelOf(job({ items: [carcass], totalWeightKg: 45 })),
		).toThrow(EasyParcelNotDeliverable);
	});

	it("refuses a job with no items at all", () => {
		expect(() => parcelOf(job({ items: [] }))).toThrow(EasyParcelNotDeliverable);
	});
});

describe("quotationBody", () => {
	it("sends both ends as postcode, subdivision and country", () => {
		const body = quotationBody(job());
		expect(body.shipment[0].receiver).toEqual({
			postcode: "47810",
			subdivision_code: "MY-10",
			country: "MY",
		});
		// The pickup row stored nothing, so the workshop's own place is used.
		expect(body.shipment[0].sender.subdivision_code).toBe("MY-10");
		expect(body.shipment[0].sender.postcode).toBe("43800");
	});

	it("refuses a site address the geocode could not place", () => {
		expect(() =>
			quotationBody(job({ sitePostcode: null, siteState: null })),
		).toThrow(EasyParcelNotDeliverable);
	});

	it("refuses a pickup that is neither the workshop nor placed", () => {
		expect(() =>
			quotationBody(job({ pickupAddress: "Somewhere else entirely" })),
		).toThrow(EasyParcelNotDeliverable);
	});
});

describe("cheapest", () => {
	const rate = (id: string, amount: string) => ({
		courier: {
			service_id: id,
			service_name: `${id} service`,
			courier_id: `c-${id}`,
			courier_name: id,
			delivery_duration: null,
			is_pickup: true,
			is_dropoff: false,
		},
		pricing: { currency: "MYR", total_amount: amount },
	});

	it("picks the lowest total", () => {
		const best = cheapest([rate("A", "12.40"), rate("B", "9.80")]);
		expect(best?.courier.service_id).toBe("B");
	});

	it("ignores a rate with an unreadable price rather than sorting it first", () => {
		const best = cheapest([rate("A", ""), rate("B", "9.80")]);
		expect(best?.courier.service_id).toBe("B");
	});

	it("prefers a pickup service over a drop-off at the same price", () => {
		const dropoff = { ...rate("A", "9.80") };
		dropoff.courier.is_pickup = false;
		dropoff.courier.is_dropoff = true;
		const best = cheapest([dropoff, rate("B", "9.80")]);
		expect(best?.courier.service_id).toBe("B");
	});

	it("returns null when nothing came back", () => {
		expect(cheapest([])).toBeNull();
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcel.test.ts`
Expected: FAIL — `mmToCm`, `parcelOf`, `quotationBody`, `cheapest` are not exported.

- [ ] **Step 3: Write the adapter's quote half**

Replace `src/lib/logistics/adapters/easyparcel.ts` entirely.

```ts
import "server-only";
import { z } from "zod";
import {
	pickupPlace,
	WORKSHOP_ADDRESS,
	WORKSHOP_CITY,
	WORKSHOP_PHONE,
	WORKSHOP_POSTCODE,
	WORKSHOP_STATE,
} from "../carriers";
import { carrierFetch } from "../http";
import { easyparcelAppConfigured } from "../oauth";
import { accessTokenFor } from "../tokens";
import { trace } from "../trace";
import type {
	CarrierAdapter,
	CarrierQuote,
	DeliveryJob,
} from "../types";

/**
 * EasyParcel — the parcel partner, and the one that fronts every Malaysian
 * courier at once.
 *
 * Shaped like `lalamove.ts` because the differences are all at the edges: pure
 * payload builders, a thin signed `call()`, and every reply parsed with Zod
 * rather than cast. The three differences that matter:
 *
 * - **OAuth, not a key.** `accessTokenFor` holds the token pair in a DB row and
 *   refreshes it — see `lib/logistics/tokens.ts`.
 * - **Postcodes, not coordinates.** A parcel network prices zone to zone and
 *   has no use for a pin, which is the opposite of what Lalamove wants.
 * - **One quote is a whole marketplace.** `POST /shipment/quotations` comes back
 *   with a rate per courier service. `CarrierQuote` is one row, so `cheapest`
 *   picks one — and `quoteRef` carries its `service_id` to the booking.
 */

const VERSION = "2026-06";
const BASE = `https://api.easyparcel.com/open_api/${VERSION}`;
const COUNTRY = "MY";

/**
 * A job EasyParcel cannot be asked about — unweighed, unplaced, or simply too
 * big for a parcel network.
 *
 * Same role as `LalamoveNotDeliverable`: the cause is the job, not the
 * environment, and `quotes/route.ts` puts the message straight onto that
 * carrier's comparison row where the admin can act on it.
 */
export class EasyParcelNotDeliverable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EasyParcelNotDeliverable";
	}
}

/**
 * The point past which a consignment stops being a parcel.
 *
 * `carriers.ts` already draws this line — the `vehicle` partners move finished
 * carcasses and the `parcel` ones carry hardware, samples and spare doors. These
 * are the caps that make that comment enforceable rather than advisory: an
 * 800mm base unit fails the girth and weight limits of every courier on the
 * platform, and asking anyway returns a price nobody will honour at the counter.
 *
 * ponytail: one conservative pair of numbers across all couriers rather than
 * per-courier limits from `courier/list`. Raise them if a real consignment is
 * refused that a courier would have taken.
 */
export const MAX_EDGE_MM = 1_500;
export const MAX_WEIGHT_KG = 30;

/** Millimetres to centimetres, never rounding a real dimension down to zero. */
export function mmToCm(mm: number): number {
	return Math.max(0.1, Math.round(mm) / 10);
}

export type Parcel = {
	weight: number;
	length: number;
	width: number;
	height: number;
};

/**
 * The job as one parcel.
 *
 * EasyParcel books a consignment, and a consignment has one box. The weight is
 * the whole job's; the box is the largest item's, because that is what has to
 * fit through the courier's gauge.
 *
 * ponytail: a job of several bulky lines is quoted as its biggest box at the
 * full weight, which under-states volumetric charge. It holds for what this
 * partner is actually for — a couple of doors, a box of hinges. If invoices
 * start disagreeing, the fix is one shipment per line item, which the
 * `shipment[]` array already supports and `carrierOrderId` does not.
 */
export function parcelOf(job: DeliveryJob): Parcel {
	if (job.items.length === 0) {
		throw new EasyParcelNotDeliverable("This job has no items to price");
	}
	if (job.totalWeightKg === null) {
		throw new EasyParcelNotDeliverable(
			"EasyParcel prices by weight and nothing on this job is weighed — add a weight to each line",
		);
	}
	if (job.totalWeightKg > MAX_WEIGHT_KG) {
		throw new EasyParcelNotDeliverable(
			`${job.totalWeightKg} kg is past what a courier will take — this is a lorry job`,
		);
	}

	// The biggest box on the job, by its own volume.
	const largest = job.items.reduce((a, b) =>
		a.widthMm * a.heightMm * a.depthMm >= b.widthMm * b.heightMm * b.depthMm
			? a
			: b,
	);
	const edges = [largest.widthMm, largest.heightMm, largest.depthMm].sort(
		(a, b) => b - a,
	);
	if (edges[0] > MAX_EDGE_MM) {
		throw new EasyParcelNotDeliverable(
			`${edges[0]} mm on its longest edge is past what a courier will take — this is a lorry job`,
		);
	}

	return {
		weight: job.totalWeightKg,
		length: mmToCm(edges[0]),
		width: mmToCm(edges[1]),
		height: mmToCm(edges[2]),
	};
}

type Endpoint = { postcode: string; subdivision_code: string; country: string };

function endpoint(
	postcode: string | null,
	state: string | null,
	which: string,
): Endpoint {
	if (postcode === null || state === null) {
		trace("easyparcel.refused", { why: "no place", end: which });
		throw new EasyParcelNotDeliverable(
			`The ${which} address has no postcode we could read — edit it and save again`,
		);
	}
	return { postcode, subdivision_code: state, country: COUNTRY };
}

/** The workshop's own place when the job leaves from the workshop. */
function senderPlace(job: DeliveryJob) {
	return (
		pickupPlace(job.pickupAddress, {
			postcode: job.pickupPostcode,
			city: job.pickupCity,
			state: job.pickupState,
		}) ?? { postcode: null, city: null, state: null }
	);
}

export function quotationBody(job: DeliveryJob) {
	const parcel = parcelOf(job);
	const sender = senderPlace(job);
	return {
		shipment: [
			{
				sender: endpoint(sender.postcode, sender.state, "pickup"),
				receiver: endpoint(job.sitePostcode, job.siteState, "site"),
				weight: parcel.weight,
				length: parcel.length,
				width: parcel.width,
				height: parcel.height,
				// Declared value. Zero would waive every courier's liability, and we
				// do not know what the cabinets are worth from the layout — one
				// ringgit says "declared, not insured" without inventing a figure.
				parcel_value: 1,
			},
		],
	};
}

const quotationSchema = z.object({
	status_code: z.number().optional(),
	data: z.array(
		z.object({
			status: z.string(),
			quotations: z
				.array(
					z.object({
						courier: z.object({
							service_id: z.string(),
							service_name: z.string().nullish(),
							courier_id: z.string().nullish(),
							courier_name: z.string().nullish(),
							delivery_duration: z.string().nullish(),
							is_pickup: z.boolean().nullish(),
							is_dropoff: z.boolean().nullish(),
						}),
						pricing: z.object({
							currency: z.string().nullish(),
							total_amount: z.string().nullish(),
						}),
					}),
				)
				.default([]),
			errors: z.array(z.string()).default([]),
		}),
	),
});

export type Quotation = z.infer<
	typeof quotationSchema
>["data"][number]["quotations"][number];

/** `"9.80"` -> `9.8`; anything unreadable -> null rather than NaN. */
function num(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * The rate to put on the comparison row.
 *
 * Cheapest wins, and a pickup service breaks a tie — a drop-off rate is only
 * cheaper because somebody has to drive the box to a counter, which is a cost
 * this screen cannot show.
 *
 * ponytail: one rate per partner, because `CarrierQuote` is one row. Showing
 * the whole marketplace would be the better screen and is a bigger change than
 * this adapter — the quote route, the row component and the booking payload all
 * assume one price per carrier.
 *
 * ponytail: `book/route.ts` re-quotes before booking and uses the fresh
 * `quoteRef`, which Lalamove requires — its quotationId expires in five
 * minutes. Here it means a rate change between comparing and booking can swap
 * the courier under the admin without tripping the route's 10% price guard.
 * Deterministic on unchanged rates, and the confirmation names what was
 * actually booked, so it is left alone. Upgrade path is threading the admin's
 * chosen ref through `bookInputSchema` — which has to be conditional per
 * carrier, because Lalamove must not honour a stale one.
 */
export function cheapest(quotations: Quotation[]): Quotation | null {
	const priced = quotations
		.map((q) => ({ q, price: num(q.pricing.total_amount) }))
		.filter((row): row is { q: Quotation; price: number } => row.price !== null);
	if (priced.length === 0) return null;

	priced.sort((a, b) => {
		if (a.price !== b.price) return a.price - b.price;
		return Number(b.q.courier.is_pickup ?? false) -
			Number(a.q.courier.is_pickup ?? false);
	});
	return priced[0].q;
}

/** Every EasyParcel call. Bearer token, JSON in, JSON out. */
async function call<T>(
	path: string,
	body: unknown,
	idempotent = false,
): Promise<T> {
	const token = await accessTokenFor("easyparcel");
	return carrierFetch<T>(`${BASE}${path}`, {
		carrierId: "easyparcel",
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body,
		idempotent,
	});
}

/**
 * A reply, or a message naming what arrived instead. Same reasoning as
 * `readReply` in `lalamove.ts`: a ZodError's path list is useless on a
 * comparison row, and the payload is the only thing that explains it.
 */
function readReply<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const seen = JSON.stringify(payload) ?? String(payload);
	trace("easyparcel.unreadable", { what, payload: seen });
	throw new Error(
		`EasyParcel's ${what} reply was not the shape we expect: ${seen.slice(0, 200)}`,
	);
}

export const easyparcelAdapter: CarrierAdapter = {
	id: "easyparcel",

	// The app's credentials being present is what this can answer synchronously.
	// Whether an account is actually linked is a DB read, and a quote that finds
	// no connection throws `CarrierNotConfigured`, which the routes already
	// report — see `hasConnection` for the admin page's own check.
	isConfigured: () => easyparcelAppConfigured(),

	async quote(job): Promise<CarrierQuote> {
		trace("easyparcel.quote", {
			deliveryId: job.id,
			site: { postcode: job.sitePostcode, state: job.siteState },
			weightKg: job.totalWeightKg,
		});

		const parsed = readReply(
			quotationSchema,
			await call("/shipment/quotations", quotationBody(job), true),
			"quotation",
		);

		const first = parsed.data[0];
		if (!first || first.status !== "success") {
			throw new EasyParcelNotDeliverable(
				first?.errors.join("; ") || "EasyParcel returned no rate for this job",
			);
		}

		const best = cheapest(first.quotations);
		if (!best) {
			throw new EasyParcelNotDeliverable(
				"No courier on EasyParcel serves this route at this size",
			);
		}

		return {
			carrierId: "easyparcel",
			priceRm: num(best.pricing.total_amount),
			// `delivery_duration` is prose ("1-3 working days"), not minutes, and
			// converting it would put a made-up number on the screen.
			etaMinutes: null,
			quoteRef: best.courier.service_id,
			notes: `${best.courier.courier_name ?? "Courier"} — ${best.courier.service_name ?? best.courier.service_id}${
				best.courier.delivery_duration
					? `, ${best.courier.delivery_duration}`
					: ""
			}`,
		};
	},

	async book(): Promise<never> {
		throw new Error("not implemented until Task 5");
	},

	async track(): Promise<never> {
		throw new Error("not implemented until Task 5");
	},
};
```

Note: only `pickupPlace` is used in this task. `WORKSHOP_ADDRESS`, `WORKSHOP_CITY`, `WORKSHOP_PHONE`, `WORKSHOP_POSTCODE` and `WORKSHOP_STATE` are consumed by `submitBody` in Task 5 — drop whichever Biome flags as unused here and re-add them there.

- [ ] **Step 4: Write the wire test for `quote`**

The payload builders above are pure and already covered. This is the part that proves the *call* is right: the URL, the Bearer token, the serialised body, and what we do with EasyParcel's own documented reply.

`quote()` reaches for a token, so the DB module is faked the same way `tokens.test.ts` does it — a live token, no refresh. Append to `src/lib/logistics/__tests__/easyparcel.test.ts`, **merging the `vitest` import into the one already at the top of that file** rather than adding a second (Biome flags duplicate module imports):

```ts
import { afterEach, beforeEach, vi } from "vitest";
import { easyparcelAdapter } from "../adapters/easyparcel";
import { CarrierNotConfigured } from "../types";
import { quotationRefusal, quotationReply } from "./fixtures/easyparcel";

/** A connected account with a token that has hours left, so nothing refreshes. */
vi.mock("@/lib/catalogue/db", () => {
	const live = {
		carrierId: "easyparcel",
		accessToken: "at_live",
		refreshToken: "rt_live",
		accessTokenExpiresAt: new Date(Date.now() + 5 * 3_600_000),
		refreshTokenExpiresAt: new Date(Date.now() + 8000 * 3_600_000),
	};
	const tx = {
		$executeRaw: async () => 1,
		carrierToken: { findUnique: async () => live, update: async () => live },
	};
	return {
		prisma: {
			$transaction: async (fn: (t: unknown) => unknown) => fn(tx),
			carrierToken: { findUnique: async () => live, upsert: async () => live },
		},
	};
});

/** Queue one JSON response per call, in order. Same helper as lalamove.test.ts. */
function stubResponses(...bodies: unknown[]) {
	const fetchMock = vi.fn(async (..._args: unknown[]) => {
		const next = bodies.shift() ?? {};
		return new Response(JSON.stringify(next), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.stubEnv("EASYPARCEL_CLIENT_ID", "cid");
	vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "csecret");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("easyparcelAdapter.isConfigured", () => {
	it("is false without the app credentials, so the row says why", () => {
		vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "");
		expect(easyparcelAdapter.isConfigured()).toBe(false);
	});
});

describe("easyparcelAdapter.quote", () => {
	it("posts the quotation to the 2026-06 endpoint with a Bearer token", async () => {
		const fetchMock = stubResponses(quotationReply);

		await easyparcelAdapter.quote(job());

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe(
			"https://api.easyparcel.com/open_api/2026-06/shipment/quotations",
		);
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer at_live");
	});

	it("sends the body the builder produced, byte for byte", async () => {
		const fetchMock = stubResponses(quotationReply);

		await easyparcelAdapter.quote(job());

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.body).toBe(JSON.stringify(quotationBody(job())));
	});

	it("reads their documented reply into the cheapest rate", async () => {
		stubResponses(quotationReply);

		const quote = await easyparcelAdapter.quote(job());

		expect(quote.carrierId).toBe("easyparcel");
		// City-Link at 8.20 undercuts Aramex at 10.84 in their own sample.
		expect(quote.priceRm).toBe(8.2);
		expect(quote.quoteRef).toBe("EP-CS09C");
		expect(quote.notes).toContain("City-Link");
		expect(quote.etaMinutes).toBeNull();
	});

	it("treats a 200 carrying an error as a refusal — this is not an HTTP failure", async () => {
		stubResponses(quotationRefusal);

		await expect(easyparcelAdapter.quote(job())).rejects.toThrow(
			/No courier service available/,
		);
	});

	it("refuses when nobody has connected an account, without calling out", async () => {
		vi.stubEnv("EASYPARCEL_CLIENT_ID", "");
		const fetchMock = stubResponses(quotationReply);

		await expect(easyparcelAdapter.quote(job())).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never calls out at all for a job it can refuse from the row alone", async () => {
		const fetchMock = stubResponses(quotationReply);

		await expect(
			easyparcelAdapter.quote(job({ totalWeightKg: null })),
		).rejects.toBeInstanceOf(EasyParcelNotDeliverable);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcel.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logistics/adapters/easyparcel.ts src/lib/logistics/__tests__/easyparcel.test.ts
git commit -m "feat(logistics): quote a parcel job against EasyParcel"
```

---

## Task 5: Book, track and cancel

`POST /shipment/submit_orders` spends the EasyParcel wallet and returns a `shipment_number` (`ES-2602-VC4KV`), an `awb_number`, a `tracking_url` and an `awb_url` — the consignment note to print.

`shipment_number` becomes `carrierOrderId`, because it is what `shipment/details` and `shipment/cancel` are keyed on. The AWB is only needed by `tracking_status`, which `details` makes redundant, so it costs no column.

**Files:**
- Modify: `src/lib/logistics/adapters/easyparcel.ts`
- Modify: `src/lib/logistics/status.ts`
- Modify: `src/lib/logistics/types.ts` (`CarrierBooking`)
- Modify: `src/app/api/admin/deliveries/[id]/book/route.ts`
- Test: `src/lib/logistics/__tests__/easyparcel.test.ts` (extend), `src/lib/logistics/__tests__/status.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 4, plus `toE164` from `../phone`.
- Produces: `submitBody`, `collectionDate`, `easyparcelAdapter.book/track/cancel`; `CarrierBooking.labelUrl?: string | null`.

- [ ] **Step 1: Write the failing status test**

Append to `src/lib/logistics/__tests__/status.test.ts`:

```ts
describe("easyparcel status codes", () => {
	it("reads the numeric shipment status code", () => {
		expect(mapCarrierStatus("easyparcel", "2")).toBe("BOOKED");
		expect(mapCarrierStatus("easyparcel", "3")).toBe("PICKED_UP");
		expect(mapCarrierStatus("easyparcel", "4")).toBe("IN_TRANSIT");
		expect(mapCarrierStatus("easyparcel", "5")).toBe("DELIVERED");
		expect(mapCarrierStatus("easyparcel", "0")).toBe("CANCELLED");
		expect(mapCarrierStatus("easyparcel", "6")).toBe("FAILED");
	});

	it("leaves a job alone for a code that is not a transition", () => {
		// 8 is "On Hold" — a real state, and not a step along the route.
		expect(mapCarrierStatus("easyparcel", "8")).toBeNull();
		expect(mapCarrierStatus("easyparcel", "99")).toBeNull();
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts`
Expected: FAIL — every `mapCarrierStatus("easyparcel", …)` returns `null`.

- [ ] **Step 3: Fill the status table**

In `src/lib/logistics/status.ts`, replace `easyparcel: {}`:

```ts
	/**
	 * EasyParcel's shipment status *codes*, as strings.
	 *
	 * Keyed on the number rather than the text because the text is the courier's,
	 * not EasyParcel's: the same code arrives as "Parcel been collected at ABC"
	 * from one and "Collected" from another, and their own documented sample
	 * contains "Deliverd To Suntech". The code is the stable half.
	 *
	 * 7 ("Schedule In Arrangement") and 2 ("To Be Collected") are both the state
	 * between booking and pickup, so both map to BOOKED. 8 ("On Hold") and 11
	 * are deliberately absent: On Hold is not a step along the route, and an
	 * unmapped status leaves the row alone rather than inventing a transition.
	 */
	easyparcel: {
		"0": "CANCELLED",
		"2": "BOOKED",
		"3": "PICKED_UP",
		"4": "IN_TRANSIT",
		"5": "DELIVERED",
		"6": "FAILED",
		"7": "BOOKED",
	},
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen `CarrierBooking`**

In `src/lib/logistics/types.ts`:

```ts
export type CarrierBooking = {
	carrierOrderId: string;
	trackingUrl: string | null;
	/**
	 * The consignment note, when the partner issues one. A parcel courier will
	 * not collect a box without its AWB taped to it, so for `easyparcel` this is
	 * the difference between a booking and a shipment. Null for the vehicle
	 * partners, which have nothing to print.
	 */
	labelUrl?: string | null;
};
```

- [ ] **Step 6: Write the failing booking-payload test**

Append to `src/lib/logistics/__tests__/easyparcel.test.ts`:

```ts
import { collectionDate, submitBody } from "../adapters/easyparcel";

describe("collectionDate", () => {
	it("uses the scheduled date, in Kuala Lumpur", () => {
		// 2026-09-07T17:00Z is already the 8th in Malaysia.
		expect(collectionDate(new Date("2026-09-07T17:00:00Z"))).toBe("2026-09-08");
	});

	it("falls back to today when nothing is scheduled", () => {
		expect(collectionDate(null)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("submitBody", () => {
	const body = () => submitBody(job(), "EP-CS096");

	it("carries the chosen service and one shipment", () => {
		expect(body().shipment).toHaveLength(1);
		expect(body().shipment[0].service_id).toBe("EP-CS096");
	});

	it("sends the workshop as sender and the customer as receiver", () => {
		const s = body().shipment[0];
		expect(s.sender.name).toBe("EzCabinet");
		expect(s.receiver.name).toBe("Siti");
		expect(s.receiver.phone_number_country_code).toBe("MY");
		// E.164 without the +60: EasyParcel takes the country code separately.
		expect(s.receiver.phone_number).toBe("123456789");
	});

	it("puts the gate code where a driver reads it, not in the address line", () => {
		expect(body().shipment[0].receiver.address_2).toBe("Gate code 1234");
	});

	it("references the job number the staff say out loud", () => {
		expect(body().shipment[0].reference).toContain("41");
	});

	it("refuses a phone number no courier can call", () => {
		expect(() =>
			submitBody(job({ customerPhone: "not a phone" }), "EP-CS096"),
		).toThrow(EasyParcelNotDeliverable);
	});

	it("describes the items rather than sending an empty parcel", () => {
		expect(body().shipment[0].item[0].content).toContain("Spare door");
		expect(body().shipment[0].item[0].quantity).toBe(2);
	});
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcel.test.ts`
Expected: FAIL — `submitBody` and `collectionDate` are not exported.

- [ ] **Step 8: Write book, track and cancel**

Add to `src/lib/logistics/adapters/easyparcel.ts` — and replace the two `not implemented` stubs.

```ts
import { toE164 } from "../phone";
import { mapCarrierStatus } from "../status";
import type { CarrierBooking, TrackingUpdate } from "../types";

/**
 * `collection_date` is required and is a date, not a timestamp — so it has to
 * be the date in Malaysia, not the date at UTC. `en-CA` is the locale that
 * formats as YYYY-MM-DD, which is what their API wants.
 */
export function collectionDate(scheduledAt: Date | null): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Kuala_Lumpur",
	}).format(scheduledAt ?? new Date());
}

/**
 * EasyParcel takes the country code and the national number separately, so
 * `toE164`'s `+60123456789` is split rather than sent whole.
 */
function phoneParts(raw: string, whose: string) {
	const e164 = toE164(raw);
	if (e164 === null) {
		throw new EasyParcelNotDeliverable(
			`The ${whose} phone number (${raw}) is not a number a courier can call`,
		);
	}
	return {
		phone_number_country_code: COUNTRY,
		phone_number: e164.replace(/^\+60/, ""),
	};
}

export function submitBody(job: DeliveryJob, serviceId: string) {
	const parcel = parcelOf(job);
	const sender = senderPlace(job);
	const senderEnd = endpoint(sender.postcode, sender.state, "pickup");
	const receiverEnd = endpoint(job.sitePostcode, job.siteState, "site");

	return {
		shipment: [
			{
				// Ours, echoed back on the shipment and on every webhook — the
				// fastest way to tie an EasyParcel shipment to a job number staff
				// say aloud.
				reference: `Delivery ${job.number}`,
				service_id: serviceId,
				collection_date: collectionDate(job.scheduledAt),
				weight: parcel.weight,
				length: parcel.length,
				width: parcel.width,
				height: parcel.height,
				item: job.items.map((line) => ({
					content: line.label,
					quantity: line.qty,
					weight: line.weightKg ?? parcel.weight / job.items.length,
					length: mmToCm(line.widthMm),
					width: mmToCm(line.depthMm),
					height: mmToCm(line.heightMm),
					currency_code: "MYR",
					value: 1,
				})),
				sender: {
					name: "EzCabinet",
					company: "EzCabinet Sdn Bhd",
					// The workshop's own number, emphatically not the customer's:
					// this is who a courier rings from the loading bay.
					...phoneParts(WORKSHOP_PHONE, "workshop's"),
					address_1:
						job.pickupAddress.trim() === WORKSHOP_ADDRESS
							? WORKSHOP_ADDRESS
							: job.pickupAddress,
					postcode: senderEnd.postcode,
					city: sender.city ?? WORKSHOP_CITY,
					subdivision_code: senderEnd.subdivision_code,
					country_code: COUNTRY,
				},
				receiver: {
					name: job.customerName,
					...phoneParts(job.customerPhone, "customer's"),
					address_1: job.siteAddress,
					// Gate codes and unit numbers are kept out of the address line
					// precisely so they can go here, where the driver reads them.
					...(job.addressNotes ? { address_2: job.addressNotes } : {}),
					postcode: receiverEnd.postcode,
					city: job.siteCity ?? "",
					subdivision_code: receiverEnd.subdivision_code,
					country_code: COUNTRY,
				},
				// Every add-on costs money per shipment. None are on by default —
				// turning one on is a price change and belongs in a catalogue-style
				// decision, not a silent default.
				feature: {},
			},
		],
	};
}

const submitSchema = z.object({
	data: z.array(
		z.object({
			status: z.string(),
			shipment_number: z.string().nullish(),
			awb_number: z.string().nullish(),
			awb_url: z.string().nullish(),
			tracking_url: z.string().nullish(),
			errors: z.array(z.string()).default([]),
		}),
	),
});

const detailsSchema = z.object({
	data: z.array(
		z.object({
			shipment_number: z.string(),
			shipment_details: z.looseObject({
				shipment_status_code: z.number().nullish(),
				shipment_status: z.string().nullish(),
				awb_number: z.string().nullish(),
				tracking_url: z.string().nullish(),
			}),
		}),
	),
});
```

And the three methods, replacing the stubs:

```ts
	async book(job, quote): Promise<CarrierBooking> {
		const serviceId = quote.quoteRef ?? "";
		if (serviceId === "") {
			throw new EasyParcelNotDeliverable(
				"This quote is missing its EasyParcel service — compare partners again",
			);
		}

		trace("easyparcel.book", {
			deliveryId: job.id,
			serviceId,
			priceRm: quote.priceRm,
		});

		// Not idempotent, and `carrierFetch` will not retry it: submitting twice
		// deducts the wallet twice and prints two consignment notes.
		const parsed = readReply(
			submitSchema,
			await call("/shipment/submit_orders", submitBody(job, serviceId)),
			"submit",
		);

		const first = parsed.data[0];
		if (!first || first.status !== "success" || !first.shipment_number) {
			throw new Error(
				first?.errors.join("; ") || "EasyParcel refused the shipment",
			);
		}

		return {
			// The shipment number, not the AWB: it is what `details` and `cancel`
			// are keyed on, and the AWB does not exist yet on some couriers.
			carrierOrderId: first.shipment_number,
			trackingUrl: first.tracking_url ?? null,
			labelUrl: first.awb_url ?? null,
		};
	},

	async track(carrierOrderId): Promise<TrackingUpdate> {
		const parsed = readReply(
			detailsSchema,
			await call("/shipment/details", { shipment_number: carrierOrderId }, true),
			"details",
		);

		const row = parsed.data[0];
		if (!row) return { status: null, message: "EasyParcel knows no such shipment" };

		const code = row.shipment_details.shipment_status_code;
		const text = row.shipment_details.shipment_status ?? "no status";

		return {
			// The code, not the text — see the note on the table in `status.ts`.
			status: code === null || code === undefined
				? null
				: mapCarrierStatus("easyparcel", String(code)),
			message: `EasyParcel reports ${text}`,
			raw: row,
		};
	},

	async cancel(carrierOrderId): Promise<void> {
		// EasyParcel refuses once a courier has collected. The caller turns that
		// into a message rather than swallowing it — a shipment that could not be
		// cancelled is still on its way.
		await call("/shipment/cancel", {
			cancel_list: [
				{ shipment_number: carrierOrderId, remark: "Cancelled by EzCabinet" },
			],
		});
	},
```

- [ ] **Step 9: Write the wire tests for `book`, `track` and `cancel`**

These are the three calls that spend money, decide a job's status and undo a booking. Each one asserts the request that goes out and the parse of EasyParcel's own documented reply. Append to `src/lib/logistics/__tests__/easyparcel.test.ts`:

```ts
import {
	cancelReply,
	detailsReply,
	submitReply,
	submitRefusal,
} from "./fixtures/easyparcel";

describe("easyparcelAdapter.book", () => {
	const chosen = { carrierId: "easyparcel", priceRm: 8.2, etaMinutes: null, quoteRef: "EP-CS09C" };

	it("submits to the orders endpoint with the service the admin chose", async () => {
		const fetchMock = stubResponses(submitReply);

		await easyparcelAdapter.book(job(), chosen);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe(
			"https://api.easyparcel.com/open_api/2026-06/shipment/submit_orders",
		);
		const sent = JSON.parse(init.body as string);
		expect(sent.shipment[0].service_id).toBe("EP-CS09C");
		expect(sent.shipment[0].collection_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("returns the shipment number, the tracking page and the label", async () => {
		stubResponses(submitReply);

		const booking = await easyparcelAdapter.book(job(), chosen);

		// The shipment number, not the AWB — it is what details and cancel take.
		expect(booking.carrierOrderId).toBe("ES-2602-VC4KV");
		expect(booking.trackingUrl).toContain("easytrack");
		expect(booking.labelUrl).toContain("format=A4");
	});

	it("surfaces an empty wallet as an error rather than a booking", async () => {
		stubResponses(submitRefusal);

		await expect(easyparcelAdapter.book(job(), chosen)).rejects.toThrow(
			/Insufficient credit balance/,
		);
	});

	it("is never retried — a resubmit deducts the wallet twice", async () => {
		const fetchMock = vi.fn(
			async () => new Response("boom", { status: 500 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(easyparcelAdapter.book(job(), chosen)).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a quote carrying no service id", async () => {
		const fetchMock = stubResponses(submitReply);

		await expect(
			easyparcelAdapter.book(job(), { ...chosen, quoteRef: undefined }),
		).rejects.toBeInstanceOf(EasyParcelNotDeliverable);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("easyparcelAdapter.track", () => {
	it("asks details by shipment number and maps the status code", async () => {
		const fetchMock = stubResponses(detailsReply);

		const update = await easyparcelAdapter.track("ES-2602-VC4KV");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe(
			"https://api.easyparcel.com/open_api/2026-06/shipment/details",
		);
		expect(JSON.parse(init.body as string)).toEqual({
			shipment_number: "ES-2602-VC4KV",
		});
		// Code 3 is Collected.
		expect(update.status).toBe("PICKED_UP");
		expect(update.message).toContain("Collected");
		expect(update.raw).toBeTruthy();
	});

	it("reports no driver, because a parcel network has none", async () => {
		stubResponses(detailsReply);

		const update = await easyparcelAdapter.track("ES-2602-VC4KV");

		expect(update.driverName).toBeUndefined();
		expect(update.latitude).toBeUndefined();
	});

	it("leaves the row alone for a status code we do not map", async () => {
		stubResponses({
			data: [
				{
					shipment_number: "ES-2602-VC4KV",
					shipment_details: { shipment_status_code: 8, shipment_status: "On Hold" },
				},
			],
		});

		const update = await easyparcelAdapter.track("ES-2602-VC4KV");

		expect(update.status).toBeNull();
		expect(update.message).toContain("On Hold");
	});

	it("says so rather than throwing when EasyParcel knows no such shipment", async () => {
		stubResponses({ data: [] });

		const update = await easyparcelAdapter.track("ES-0000-XXXXX");

		expect(update.status).toBeNull();
	});
});

describe("easyparcelAdapter.cancel", () => {
	it("sends a cancel list with the required remark", async () => {
		const fetchMock = stubResponses(cancelReply);

		await easyparcelAdapter.cancel?.("ES-2602-VC4KV");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe(
			"https://api.easyparcel.com/open_api/2026-06/shipment/cancel",
		);
		const sent = JSON.parse(init.body as string);
		expect(sent.cancel_list[0].shipment_number).toBe("ES-2602-VC4KV");
		// `remark` is required by their API, not optional as it reads.
		expect(sent.cancel_list[0].remark).toBeTruthy();
	});
});
```

- [ ] **Step 10: Run the adapter tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcel.test.ts`
Expected: PASS, 37 tests.

- [ ] **Step 11: Persist the label on booking**

In `src/app/api/admin/deliveries/[id]/book/route.ts`, in the `prisma.delivery.update` data block, beside `trackingUrl: booking.trackingUrl`:

```ts
				labelUrl: booking.labelUrl ?? null,
```

- [ ] **Step 12: Verify and commit**

Run: `pnpm tsc --noEmit && pnpm test && pnpm biome check --write .`

```bash
git add src/lib/logistics src/app/api/admin/deliveries
git commit -m "feat(logistics): book, track and cancel an EasyParcel shipment"
```

---

## Task 6: The webhook

EasyParcel posts to a URL registered in their Developer Hub and **signs nothing** — no HMAC, no shared secret in a header, nothing. The only identity available is a secret we put in the URL ourselves, which is exactly the upgrade path `lalamove.ts` already names in its own `verifyWebhook` comment: *"a secret path segment, which needs `verifyWebhook` widened to see the request URL."*

So this task widens it. `verifyWebhook(rawBody, headers, url)`; Lalamove ignores the third argument, EasyParcel compares `?token=` against `EASYPARCEL_WEBHOOK_TOKEN` in constant time.

**Files:**
- Modify: `src/lib/logistics/types.ts`
- Modify: `src/app/api/webhooks/[carrier]/route.ts`
- Modify: `src/lib/logistics/adapters/lalamove.ts` (signature only)
- Modify: `src/lib/logistics/adapters/easyparcel.ts`
- Test: `src/lib/logistics/__tests__/easyparcel.test.ts` (extend)

**Interfaces:**
- Consumes: `CarrierWebhookEvent` from `../types`, `mapCarrierStatus`.
- Produces: `verifyWebhook(rawBody: string, headers: Headers, url: URL): CarrierWebhookEvent | null` on the adapter interface.

- [ ] **Step 1: Write the failing webhook test**

Append to `src/lib/logistics/__tests__/easyparcel.test.ts`:

```ts
import { webhooks } from "./fixtures/easyparcel";

describe("easyparcelAdapter.verifyWebhook", () => {
	const hook = (path: string, body: unknown) =>
		easyparcelAdapter.verifyWebhook?.(
			JSON.stringify(body),
			new Headers(),
			new URL(`https://example.com${path}`),
		) ?? null;

	beforeEach(() => {
		vi.stubEnv("EASYPARCEL_WEBHOOK_TOKEN", "s3cret");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// From `./fixtures/easyparcel`, so the webhook payloads live beside the
	// request/response ones and a shape change is still one edit.
	const statusUpdate = webhooks.statusUpdate;

	it("reads a status update into a tracking update", () => {
		const event = hook("/api/webhooks/easyparcel?token=s3cret", statusUpdate);
		expect(event).toEqual({
			kind: "order",
			carrierOrderId: "ES-2504-G7FDF",
			update: expect.objectContaining({ status: "CANCELLED" }),
		});
	});

	it("refuses a payload with the wrong token", () => {
		expect(hook("/api/webhooks/easyparcel?token=wrong", statusUpdate)).toBeNull();
	});

	it("refuses a payload with no token at all", () => {
		expect(hook("/api/webhooks/easyparcel", statusUpdate)).toBeNull();
	});

	it("refuses everything when no token is configured", () => {
		vi.stubEnv("EASYPARCEL_WEBHOOK_TOKEN", "");
		expect(hook("/api/webhooks/easyparcel?token=", statusUpdate)).toBeNull();
	});

	it("reads a tracking update, whose status lives under another key", () => {
		// Their own sample, typo and all — code 5 is Delivered whatever the
		// courier's text says, which is exactly why the table is keyed on the code.
		const event = hook("/api/webhooks/easyparcel?token=s3cret", webhooks.trackingUpdate);
		expect(event).toEqual({
			kind: "order",
			carrierOrderId: "ES-2504-G7FDF",
			update: expect.objectContaining({ status: "DELIVERED" }),
		});
	});

	it("accepts an event carrying no shipment rather than answering 400", () => {
		// `shipment.awb.update` and `shipment.created` are real topics that carry
		// no status. A carrier that gets an error back resends for hours.
		const event = hook("/api/webhooks/easyparcel?token=s3cret", webhooks.awbUpdate);
		expect(event).toEqual({
			kind: "order",
			carrierOrderId: "ES-2504-G7FDF",
			update: expect.objectContaining({ status: null }),
		});
	});

	it("ignores a topic with no shipment number", () => {
		const event = hook("/api/webhooks/easyparcel?token=s3cret", webhooks.ondemandUpdate);
		expect(event).toEqual({ kind: "ignored", eventType: "ondemand.status.update" });
	});

	it("refuses a body that is not JSON", () => {
		expect(
			easyparcelAdapter.verifyWebhook?.(
				"not json",
				new Headers(),
				new URL("https://example.com/api/webhooks/easyparcel?token=s3cret"),
			),
		).toBeNull();
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcel.test.ts`
Expected: FAIL — `verifyWebhook` is undefined on the adapter, and the interface takes two arguments.

- [ ] **Step 3: Widen the interface**

In `src/lib/logistics/types.ts`:

```ts
	/**
	 * Returns null for anything that fails verification — the caller turns that
	 * into a 400 and writes nothing. Absent when the partner has no callbacks
	 * and is tracked by poll only.
	 *
	 * `url` is the request's own URL, and it is not decoration: EasyParcel signs
	 * nothing at all, so a secret in the registered callback URL is the entire
	 * identity check available for that partner. Lalamove ignores it.
	 */
	verifyWebhook?(
		rawBody: string,
		headers: Headers,
		url: URL,
	): CarrierWebhookEvent | null;
```

In `src/app/api/webhooks/[carrier]/route.ts`, replace the verify call:

```ts
	let event: CarrierWebhookEvent | null;
	try {
		event = adapter.verifyWebhook(rawBody, request.headers, new URL(request.url));
	} catch {
		event = null;
	}
```

`lalamove.ts` needs no change — `verifyWebhook(rawBody)` already satisfies a wider signature. Confirm with `pnpm tsc --noEmit`.

- [ ] **Step 4: Write EasyParcel's `verifyWebhook`**

Add to `src/lib/logistics/adapters/easyparcel.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import type { CarrierWebhookEvent } from "../types";

const WEBHOOK_TOKEN = () => process.env.EASYPARCEL_WEBHOOK_TOKEN ?? "";

/** Constant-time, and length-safe — `timingSafeEqual` throws on a length mismatch. */
function secretsMatch(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * EasyParcel's webhook payloads, loose on purpose.
 *
 * Five topics, and only two of them carry a status. The rest — an AWB being
 * issued, a shipment being created, an OnDemand order we did not book — still
 * have to parse, because a schema tight enough to validate one of them answers
 * 400 to the others and EasyParcel resends those for hours. Same lesson as
 * `cf31ac1` on the Lalamove side.
 */
const webhookSchema = z.looseObject({
	topic: z.string().nullish(),
	shipment_number: z.string().nullish(),
	awb_number: z.string().nullish(),
	// `shipment.status.update` carries this pair…
	shipment_status_code: z.number().nullish(),
	shipment_status: z.string().nullish(),
	// …and `shipment.tracking.update` carries this one.
	latest_shipment_status_code: z.number().nullish(),
	latest_tracking_status: z.string().nullish(),
});
```

And on the adapter object:

```ts
	/**
	 * EasyParcel signs nothing — no HMAC, no shared header, no timestamp. The
	 * only identity available is a secret we choose ourselves and register as
	 * part of the callback URL in their Developer Hub:
	 *
	 *     https://…/api/webhooks/easyparcel?token=<EASYPARCEL_WEBHOOK_TOKEN>
	 *
	 * Compared in constant time, and an absent or empty token refuses everything
	 * — a deployment that forgot to set it must reject callbacks rather than
	 * accept anyone's.
	 *
	 * ponytail: a URL secret is only as private as their dashboard and our
	 * access logs. It is bounded by the route acting on a `carrierOrderId` we
	 * already own, and by `isForwardTransition` refusing to reopen a finished
	 * job. Upgrade path is polling for confirmation before writing, which costs
	 * a call per callback.
	 */
	verifyWebhook(rawBody, _headers, url): CarrierWebhookEvent | null {
		const expected = WEBHOOK_TOKEN();
		if (expected === "") return null;
		if (!secretsMatch(url.searchParams.get("token") ?? "", expected)) {
			return null;
		}

		let parsed: z.infer<typeof webhookSchema>;
		try {
			parsed = webhookSchema.parse(JSON.parse(rawBody));
		} catch {
			return null;
		}

		const topic = parsed.topic ?? null;

		// The one place an undocumented payload can be read from: every event
		// EasyParcel sends passes through here, whether we act on it or not.
		trace("easyparcel.webhook", { topic, body: parsed });

		const shipmentNumber = parsed.shipment_number ?? "";
		if (shipmentNumber === "") {
			// An OnDemand order, or a topic added after this was written. We do not
			// book OnDemand — see the note at the top of this file.
			return { kind: "ignored", eventType: topic };
		}

		const code =
			parsed.shipment_status_code ?? parsed.latest_shipment_status_code ?? null;
		const text =
			parsed.shipment_status ?? parsed.latest_tracking_status ?? "no status";

		return {
			kind: "order",
			carrierOrderId: shipmentNumber,
			update: {
				status: code === null ? null : mapCarrierStatus("easyparcel", String(code)),
				message: `EasyParcel ${topic ?? "webhook"}: ${text}`,
				raw: parsed,
			},
		};
	},
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcel.test.ts src/lib/logistics/__tests__/lalamove.test.ts`
Expected: PASS. The Lalamove webhook tests pass unchanged — if one fails on arity, it is calling `verifyWebhook` with two arguments through a typed reference; pass a `new URL(...)` third argument.

- [ ] **Step 6: Verify and commit**

Run: `pnpm tsc --noEmit && pnpm test && pnpm biome check --write .`

```bash
git add src/lib/logistics src/app/api/webhooks
git commit -m "feat(logistics): accept EasyParcel callbacks, verified by a URL secret"
```

---

## Task 7: The admin page, and the documentation

Two things the admin cannot do yet: connect the EasyParcel account, and print the consignment note the courier will not collect without.

**Files:**
- Modify: `src/app/admin/logistics/LogisticsManager.tsx`
- Modify: `src/app/api/admin/deliveries/route.ts` (the GET, to report the connection)
- Modify: `.env.local` (and `.env.example` if the repo has one)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `hasConnection`, `easyparcelAppConfigured` from `src/lib/logistics/tokens.ts`.
- Produces: `GET /api/admin/deliveries` gains `easyparcel: { appConfigured: boolean; connected: boolean }`.

- [ ] **Step 1: Report the connection state**

In the `GET` of `src/app/api/admin/deliveries/route.ts`:

```ts
import { easyparcelAppConfigured, hasConnection } from "@/lib/logistics/tokens";

// …inside GET, beside the existing geocodingConfigured line:
		easyparcel: {
			appConfigured: easyparcelAppConfigured(),
			connected: easyparcelAppConfigured()
				? await hasConnection("easyparcel")
				: false,
		},
```

- [ ] **Step 2: Add the connect banner**

In `src/app/admin/logistics/LogisticsManager.tsx`, beside the existing "geocoding is not configured" notice — match its markup and tone exactly rather than inventing a new component. Three states:

- `appConfigured === false` → "EasyParcel is not set up on this deployment." No link. An admin cannot fix a missing environment variable from this page, which is the same reasoning `enabledCarriers()` already applies.
- `appConfigured && !connected` → "EasyParcel is not connected — parcel jobs cannot be quoted." with a link to `/api/admin/logistics/easyparcel/connect` reading "Connect EasyParcel account".
- `connected` → nothing. A working integration does not need a banner.

Read `?easyparcel=connected` / `?easyparcel=failed` off the URL (the callback redirects with it) and show a one-line confirmation or "Connecting the EasyParcel account failed — try again."

- [ ] **Step 3: Add the label link**

In the booked-delivery detail panel, beside the existing `delivery.trackingUrl` block:

```tsx
{delivery.labelUrl && (
	<a
		href={delivery.labelUrl}
		target="_blank"
		rel="noopener noreferrer"
		className={/* match the tracking-link classes already in this file */}
	>
		Print AWB label
	</a>
)}
```

Add `labelUrl` to whatever `Delivery` type the file declares for the API payload.

- [ ] **Step 4: Document the environment variables**

Add to `.env.local` (and `.env.example` if present):

```bash
# EasyParcel — OAuth app credentials from the Developer Hub
# (https://developer.easyparcel.com). Sandbox and live use the same app; which
# account it reaches is decided by the account an admin links at connect time.
EASYPARCEL_CLIENT_ID=
EASYPARCEL_CLIENT_SECRET=
# A secret you choose. Register the webhook endpoint in the Developer Hub as
# https://<host>/api/webhooks/easyparcel?token=<this value> — EasyParcel signs
# nothing, so this is the whole identity check on a callback.
EASYPARCEL_WEBHOOK_TOKEN=
# Where EasyParcel redirects back to. Must match the redirect URI registered on
# the app, byte for byte.
APP_URL=http://localhost:3000
```

- [ ] **Step 5: Update `CLAUDE.md`**

Three edits:

- In the `lib/logistics/` tree in **Directory layout**, add `tokens.ts ← a partner's OAuth tokens: one row, refreshed under a lock` and change `adapters/` to `one file per partner; manual, lalamove and easyparcel are live`.
- In **Known issues**, add: *"EasyParcel's webhooks are unsigned. Nothing in their payload identifies the sender, so the callback URL carries a secret query token and that is the entire check — see `verifyWebhook` in `adapters/easyparcel.ts`."*
- In **Open questions**, extend the workshop-address entry: `WORKSHOP_POSTCODE`, `WORKSHOP_CITY` and `WORKSHOP_STATE` are placeholders derived from `WORKSHOP_PIN`, and EasyParcel prices the origin zone off them — a wrong postcode there is a wrong price on every parcel quote. Add: *"Does EzCabinet have an EasyParcel account, and who tops up the wallet? `submit_orders` deducts at booking time and a shipment cannot be booked against an empty wallet."*

- [ ] **Step 6: Verify and commit**

Run: `pnpm tsc --noEmit && pnpm test && pnpm biome check --write .`

```bash
git add src/app CLAUDE.md .env.local
git commit -m "feat(logistics): connect and print an EasyParcel shipment from the admin page"
```

---

---

## Task 8: The smoke script and CI

The tests up to here prove the adapter behaves correctly *against our belief about EasyParcel's API*. Two things are still missing: something that checks that belief against the real API, and something that makes any of it gate a merge.

**Files:**
- Create: `scripts/easyparcel-ping.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (two scripts)

**Interfaces:**
- Consumes: nothing in `src` — the script is standalone on purpose, exactly like `scripts/lalamove-ping.mjs`.
- Produces: `pnpm easyparcel:ping`, `pnpm typecheck`.

- [ ] **Step 1: Add the missing `typecheck` script**

The plan has been running `pnpm tsc --noEmit` by hand and CI needs it named. In `package.json`, beside `"lint"` and `"test"`:

```json
		"typecheck": "tsc --noEmit",
		"easyparcel:ping": "node --env-file=.env.local scripts/easyparcel-ping.mjs",
```

- [ ] **Step 2: Write the ping script**

Standalone, no imports from `src` — the point is to answer "is it EasyParcel or is it us", and a script that shares our code cannot. Read `scripts/lalamove-ping.mjs` first and mirror its structure and tone.

```js
#!/usr/bin/env node
/**
 * Talk to EasyParcel without the app in the way.
 *
 * The stubbed-fetch tests prove the adapter matches the fixtures in
 * `__tests__/fixtures/easyparcel.ts`, and those fixtures are EasyParcel's
 * documented samples — which is our *belief* about their API, not their API. A
 * renamed field passes every test in CI and fails the first real booking. This
 * is what notices.
 *
 *   node --env-file=.env.local scripts/easyparcel-ping.mjs
 *   pnpm easyparcel:ping
 *
 * It reads only: the wallet (proves the token works and says whether a booking
 * could even be paid for) and a quotation for a small parcel between two real
 * Klang Valley postcodes. It never submits an order — that spends credit.
 */

const CLIENT_ID = process.env.EASYPARCEL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.EASYPARCEL_CLIENT_SECRET ?? "";
const REFRESH_TOKEN = process.argv[2] ?? process.env.EASYPARCEL_REFRESH_TOKEN ?? "";

const VERSION = "2026-06";
const BASE = `https://api.easyparcel.com/open_api/${VERSION}`;

if (CLIENT_ID === "" || CLIENT_SECRET === "") {
	console.error(
		"No app credentials. Run with `node --env-file=.env.local scripts/easyparcel-ping.mjs`,\n" +
			"or set EASYPARCEL_CLIENT_ID and EASYPARCEL_CLIENT_SECRET in the environment.",
	);
	process.exit(1);
}
if (REFRESH_TOKEN === "") {
	console.error(
		"No refresh token. Connect an account at /admin/logistics first, then copy the\n" +
			"CarrierToken.refreshToken column here:\n" +
			"  pnpm easyparcel:ping <refresh_token>",
	);
	process.exit(1);
}

/**
 * A refresh, not a full authorization-code dance — that needs a browser, and
 * this script has none. It also means the token this prints is the one the app
 * would have used, which is the comparison worth making.
 */
async function accessToken() {
	const response = await fetch("https://api.easyparcel.com/oauth/token", {
		method: "POST",
		headers: {
			authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: REFRESH_TOKEN,
		}).toString(),
	});
	const text = await response.text();
	console.log(`\n── POST /oauth/token → ${response.status}\n${text}\n`);
	if (!response.ok) process.exit(1);
	const body = JSON.parse(text);
	// The refresh token rotates. Print the new one, because the old one in the
	// DB is now dead and anyone re-running this needs the replacement.
	console.log(`New refresh token (the old one is now spent):\n  ${body.refresh_token}\n`);
	return body.access_token;
}

async function call(token, method, path, payload) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json",
		},
		...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
	});
	const text = await response.text();
	console.log(`── ${method} ${path} → ${response.status}\n${text}\n`);
	return text;
}

const token = await accessToken();

// Says whether a booking could be paid for at all, and proves the token works.
await call(token, "GET", "/wallet");

// A small parcel, workshop to Kota Damansara. Read-only: no credit is spent.
await call(token, "POST", "/shipment/quotations", {
	shipment: [
		{
			sender: { postcode: "43800", subdivision_code: "MY-10", country: "MY" },
			receiver: { postcode: "47810", subdivision_code: "MY-10", country: "MY" },
			weight: 7,
			length: 72,
			width: 40,
			height: 2,
			parcel_value: 1,
		},
	],
});

console.log(
	"Compare the shapes above against src/lib/logistics/__tests__/fixtures/easyparcel.ts.\n" +
		"A field that has moved or been renamed is a fixture to correct and a schema to widen.",
);
```

- [ ] **Step 3: Run it against the sandbox**

Connect an account first (Task 3's verification step), then copy `CarrierToken.refreshToken` out of `pnpm prisma studio`:

Run: `pnpm easyparcel:ping <refresh_token>`
Expected: a wallet balance, and a `quotations[]` array with at least one courier. Every response shape should match the corresponding fixture — a difference is a real finding, and the fixture is what gets corrected.

Note the script prints a **new** refresh token: the one in the DB is now spent, and the app will refresh to its own on the next call. Do not paste the printed one back into the row.

- [ ] **Step 4: Write the CI workflow**

The repo has no `.github/` at all, so this is the whole gate. Node and pnpm versions come from `package.json` — read `packageManager` and `engines` before pinning anything here.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# A second push to the same branch cancels the first — nothing here is worth
# paying for twice.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # The generated Prisma client is not committed, and both typecheck and
      # the logistics tests import types from it.
      - run: pnpm prisma generate

      - run: pnpm lint

      - run: pnpm typecheck

      - run: pnpm test
```

No database service and no secrets. Every test in this plan runs on stubbed `fetch` and a faked db module, which is the property that keeps this workflow to four commands — and the reason `tokens.ts` was split from `oauth.ts` in the first place.

- [ ] **Step 5: Note where the live check belongs**

Add to `CLAUDE.md`, under the logistics notes:

> `pnpm easyparcel:ping` is the only thing that checks EasyParcel's real API shape; CI runs against recorded fixtures and cannot see a renamed field. Run it before a release that touches `lib/logistics`, or wire it to a scheduled workflow with the credentials as repository secrets. It is deliberately not in PR CI: it needs secrets in the runner, it fails on EasyParcel's downtime rather than on our bugs, and a partner outage must not block an unrelated merge.

- [ ] **Step 6: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — the same three commands CI will run.

```bash
git add package.json scripts/easyparcel-ping.mjs .github CLAUDE.md
git commit -m "ci: run lint, typecheck and tests, and add an EasyParcel smoke script"
```


## Verification

Unit tests cover the pure halves; these are the checks that prove the integration is real.

**Before any of it:** register an app at https://developer.easyparcel.com, set `EASYPARCEL_CLIENT_ID` and `EASYPARCEL_CLIENT_SECRET`, add `http://localhost:3000/api/admin/logistics/easyparcel/callback` as a redirect URI, and set up a **sandbox** connection with test credit topped up (Settings → Connection Management → Add New Connection → Sandbox, then Top Up).

1. **Whole suite green — the three commands CI runs.**
   `pnpm lint && pnpm typecheck && pnpm test`

   Every EasyParcel test in it runs on stubbed `fetch` and recorded fixtures, so this passes with no credentials and no database. That is the property that makes it a merge gate.

2. **Connect the account.** `pnpm dev`, sign in to `/admin`, open `/admin/logistics`. The banner says EasyParcel is not connected. Click through; EasyParcel's login appears; choose the **demo** account; allow access. You land back on `/admin/logistics?easyparcel=connected` and the banner is gone. Confirm one row exists:
   `pnpm prisma studio` → `CarrierToken`, `carrierId = easyparcel`, `accessTokenExpiresAt` about ten hours out.

3. **Quote a real parcel job.** Create a delivery whose site address is a real Klang Valley address that geocodes precisely, with one item small enough to be a parcel and a weight on it — e.g. `Spare door 400mm`, qty 2, 400 × 720 × 20 mm, 3.5 kg. Check in Prisma Studio that `sitePostcode`, `siteCity` and `siteState` are populated. Then "Compare partners": the EasyParcel row shows a price in RM and a courier name in its note.

   `LOGISTICS_DEBUG=1 pnpm dev` prints the request and reply for each step if it does not.

4. **Quote a job it should refuse.** Add a `BC 800mm` carcass (800 × 720 × 560, 45 kg) to a job and compare again. The EasyParcel row reads *"…is past what a courier will take — this is a lorry job"*, and the Lalamove row still prices. Remove every `weightKg` and compare: the row reads *"EasyParcel prices by weight and nothing on this job is weighed"*.

5. **Book it.** With the parcel job, book EasyParcel. The job goes `BOOKED`, `carrierOrderId` is an `ES-YYMM-XXXXX`, and "Print AWB label" opens a consignment note PDF. Check the EasyParcel sandbox dashboard shows the shipment and the wallet is down by the quoted amount.

6. **Track it.** `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/track-deliveries` returns `polled: 1`, and the job's timeline gains a POLL event carrying EasyParcel's status text. **The sandbox never advances a shipment**, so the status will not move — that a poll completes and writes an event is what this step proves.

7. **Feed it a webhook.** Sandbox statuses do not move, so post a recorded payload by hand:

   ```bash
   curl -i -X POST "http://localhost:3000/api/webhooks/easyparcel?token=$EASYPARCEL_WEBHOOK_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"topic":"shipment.status.update","shipment_number":"<the ES- number>","awb_number":"123","shipment_status":"Collected","shipment_status_code":3}'
   ```

   Expect `200 {"received":true}` and the job at `PICKED_UP` with a `CARRIER_WEBHOOK` event. Then repeat with `?token=wrong` — expect `400 {"error":"invalid_signature"}` and **no** new event. Then post `{"topic":"shipment.awb.update","shipment_number":"<same>","awb_number":"999"}` — expect `200`, and the job still at `PICKED_UP` (an AWB update carries no status, and `isForwardTransition` would refuse a backwards one anyway).

8. **Cancel it.** From the admin page, cancel the booked job. EasyParcel's sandbox dashboard shows it cancelled and the credit refunded.

9. **Token refresh.** In Prisma Studio, set the `CarrierToken` row's `accessTokenExpiresAt` to a past date. Compare partners again: the quote still succeeds, `LOGISTICS_DEBUG=1` prints `easyparcel.refresh`, and both token columns in the row have changed.

10. **The real API still looks like our fixtures.** `pnpm easyparcel:ping <refresh_token>`. Compare each printed response against `src/lib/logistics/__tests__/fixtures/easyparcel.ts`. This is the only step in the list that can catch EasyParcel changing a field name — everything above it, CI included, is measured against our own recording of their docs. Re-run it after step 9, since that leaves the row holding a token this script would spend.
