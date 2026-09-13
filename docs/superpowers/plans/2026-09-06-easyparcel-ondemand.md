# EasyParcel OnDemand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add EasyParcel's OnDemand product as a second, vehicle-class logistics partner, so a lorry-sized job can be quoted and booked through the EasyParcel account we already hold — and so the vehicle weight and dimension limits the app currently invents come from the vendor instead.

**Architecture:** A new carrier id `easyparcel_ondemand` with `kind: "vehicle"`, backed by a new adapter file that shares the existing EasyParcel OAuth token row and HTTP transport. The parcel adapter is untouched except for the extraction of that shared transport. OnDemand is coordinate-based (waypoints), so it consumes the same `siteLat`/`siteLng`/`WORKSHOP_PIN` fields Lalamove already uses, and returns a per-vehicle rate card carrying each vehicle's real `weight_limit` and `dimension` — which the adapter uses to pick the smallest vehicle that fits the job.

**Tech Stack:** TypeScript, Zod, Vitest, Prisma/Postgres, Next.js App Router. No new dependencies.

**Spec:** No separate spec document. This plan is written against the EasyParcel OpenAPI reference at <https://easyparcel.github.io/OpenAPI/>, sections *OnDemand Shipping* (Quotation, Order Submission, Order Details, Cancellation) and *Webhooks → Ondemand Status Codes*, read on 2026-09-06. Every payload shape and status code quoted below is copied from that page. The existing parcel-side integration it extends is `docs/superpowers/plans/2026-09-06-easyparcel-integration.md`.

## Global Constraints

- **One EasyParcel account, one token row.** `accessTokenFor(carrierId)` keys `CarrierToken` by carrier id. The OnDemand adapter MUST call `accessTokenFor("easyparcel")`, never `accessTokenFor("easyparcel_ondemand")` — there is one OAuth connection and one wallet behind both products. Same for `hasConnection("easyparcel")`.
- **`lib/logistics` stays framework-free and `server-only` where it holds credentials.** `carriers.ts` is imported by client components: nothing secret, no adapter import.
- **Zod parses every reply.** No casts. Follow `readReply` in `adapters/easyparcel.ts`.
- **Booking is never idempotent.** `carrierFetch`'s `idempotent` flag stays `false` for any submit or cancel call — a retried booking spends the wallet twice.
- **EasyParcel signals errors as HTTP 200.** Every endpoint returns `status_code: 200` with a per-item `status: "error"`. Check the body, never just the HTTP status.
- **Prices in RM.** Sentence case in UI copy.
- **Commit catalogue changes separately from code changes.** No catalogue changes in this plan.
- API version constant: the parcel endpoints use `2026-06`. The OnDemand endpoints are documented under `2025-09` and the cancel example is unversioned. Task 2 pins OnDemand to its own constant so the two can move independently.

## Prerequisite — confirm before Task 4

Two of the open questions in `CLAUDE.md` become blocking here, and neither is answerable from code:

1. **Does EzCabinet's EasyParcel account have OnDemand enabled, and is the wallet funded?** OnDemand submit deducts at booking time exactly as `submit_orders` does. Tasks 1–3 are safe to build without an answer; Task 4 onward cannot be verified against the live API without one.
2. **`WORKSHOP_PIN` is real but `WORKSHOP_PHONE` is a placeholder.** OnDemand's `waypoint[].shipment_info.phone_number` is required and is the number the driver rings from the loading bay. Booking with a placeholder produces a real driver calling a wrong number.

Tasks 1–3 and 7's `measure.ts` half are pure and testable against fixtures today. Do not run Task 4–6 against production credentials until (1) is answered.

## Scope

**In scope:** the OnDemand product end to end (quote, book, track, cancel, webhook), and correcting `VEHICLE_LIMITS` in `measure.ts` against the vendor's own figures.

**Out of scope — a separate plan.** The parcel-side endpoints we still ignore are an independent subsystem and should get their own plan: Insurance Quotation (we currently send `parcel_value: 1`, which waives every courier's liability on real cabinet parts), Wallet Balance (booking fails silently on an empty wallet), Courier List, Courier Drop-off Points (drop-off is materially cheaper than pickup), and Coupon.

## File Structure

| File | Responsibility |
| --- | --- |
| Create `src/lib/logistics/adapters/easyparcelClient.ts` | The shared EasyParcel transport: `BASE`, `ondemandBase`, `call`, `readReply`, `num`, `EasyParcelNotDeliverable`. Both adapters import it. `server-only`. |
| Create `src/lib/logistics/adapters/easyparcelOndemand.ts` | The OnDemand adapter: payload builders, vehicle selection, `quote`/`book`/`track`/`cancel`/`verifyWebhook`. `server-only`. |
| Create `src/lib/logistics/__tests__/easyparcelOndemand.test.ts` | Unit tests for the above, against recorded fixtures. |
| Create `src/lib/logistics/__tests__/fixtures/easyparcelOndemand.ts` | Recorded OnDemand replies, copied from the vendor docs. |
| Modify `src/lib/logistics/adapters/easyparcel.ts` | Import the shared transport instead of defining it. No behaviour change. |
| Modify `src/lib/logistics/carriers.ts` | Add the `easyparcel_ondemand` entry. |
| Modify `src/lib/logistics/status.ts` | Add the OnDemand status-code table. |
| Modify `src/lib/logistics/registry.ts` | Register the adapter. |
| Modify `src/lib/logistics/measure.ts` | Correct `VEHICLE_LIMITS` against the vendor's published vehicle ladder. |
| Modify `src/app/api/webhooks/[carrier]/route.ts` | Route `easyparcel_ondemand` callbacks. |

---

### Task 1: Extract the shared EasyParcel transport

Two adapters cannot both own `call()`. Pull the transport out first, with no behaviour change, so Task 4 has something to import.

**Files:**
- Create: `src/lib/logistics/adapters/easyparcelClient.ts`
- Modify: `src/lib/logistics/adapters/easyparcel.ts` (remove the extracted definitions, import them instead)
- Test: `src/lib/logistics/__tests__/easyparcel.test.ts` (existing suite is the regression test)

**Interfaces:**
- Consumes: `accessTokenFor` from `../tokens`, `carrierFetch` from `../http`, `trace` from `../trace`.
- Produces:
  - `PARCEL_BASE: string`
  - `ONDEMAND_BASE: string`
  - `call<T>(base: string, path: string, body: unknown, idempotent?: boolean): Promise<T>`
  - `readReply<T>(schema: z.ZodType<T>, payload: unknown, what: string): T`
  - `num(value: string | number | null | undefined): number | null`
  - `class EasyParcelNotDeliverable extends Error`

- [ ] **Step 1: Create the shared client**

```ts
// src/lib/logistics/adapters/easyparcelClient.ts
import "server-only";
import type { z } from "zod";
import { carrierFetch } from "../http";
import { accessTokenFor } from "../tokens";
import { trace } from "../trace";

/**
 * The transport both EasyParcel products share.
 *
 * One account, one OAuth token row, two product families on two API versions:
 * `shipment/*` (parcel, `2026-06`) and `ondemand/*` (vehicle, `2025-09`). The
 * version is per-product and part of the path, so `call` takes the base rather
 * than closing over one — a version bump on one product must not move the
 * other.
 *
 * `accessTokenFor("easyparcel")` is deliberate and load-bearing: the token row
 * is keyed by carrier id, and OnDemand books against the *same* account and the
 * same wallet. Asking for a token under `easyparcel_ondemand` would look for a
 * connection nobody ever made.
 */
const VERSION = "2026-06";
const ONDEMAND_VERSION = "2025-09";

export const PARCEL_BASE = `https://api.easyparcel.com/open_api/${VERSION}`;
export const ONDEMAND_BASE = `https://api.easyparcel.com/open_api/${ONDEMAND_VERSION}`;

/**
 * A job EasyParcel cannot be asked about — unweighed, unplaced, or past what
 * any vehicle on the platform will carry.
 *
 * The cause is the job, not the environment, so the message goes straight onto
 * the comparison row where the admin can act on it.
 */
export class EasyParcelNotDeliverable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EasyParcelNotDeliverable";
  }
}

/** Every EasyParcel call. Bearer token, JSON in, JSON out. */
export async function call<T>(
  base: string,
  path: string,
  body: unknown,
  idempotent = false,
): Promise<T> {
  const token = await accessTokenFor("easyparcel");
  return carrierFetch<T>(`${base}${path}`, {
    carrierId: "easyparcel",
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
    idempotent,
  });
}

/**
 * Parse a reply or throw with the payload attached.
 *
 * EasyParcel answers HTTP 200 for refusals as well as successes, so a schema
 * mismatch is the only signal that the contract moved — and without the body in
 * the message there is nothing to debug from.
 */
export function readReply<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const seen = JSON.stringify(payload) ?? String(payload);
  trace("easyparcel.unreadable", { what, payload: seen });
  throw new Error(
    `EasyParcel's ${what} reply was not the shape we expect: ${seen.slice(0, 200)}`,
  );
}

/** Their money and their coordinates arrive as strings. Null rather than NaN. */
export function num(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 2: Point the parcel adapter at it**

In `src/lib/logistics/adapters/easyparcel.ts`, delete the local `VERSION`, `BASE`, `EasyParcelNotDeliverable`, `call`, `readReply` and `num` definitions, and add the import:

```ts
import {
  call as epCall,
  EasyParcelNotDeliverable,
  num,
  PARCEL_BASE,
  readReply,
} from "./easyparcelClient";

/** The parcel product's calls, bound to its own API version. */
function call<T>(path: string, body: unknown, idempotent = false): Promise<T> {
  return epCall<T>(PARCEL_BASE, path, body, idempotent);
}
```

Re-export the error class so existing importers do not break:

```ts
export { EasyParcelNotDeliverable } from "./easyparcelClient";
```

- [ ] **Step 3: Run the existing suite to prove nothing moved**

Run: `pnpm vitest run src/lib/logistics`
Expected: PASS, same count as before the change (279 at time of writing).

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm tsc --noEmit && pnpm biome check src/lib/logistics`
Expected: no errors; one pre-existing optional-chain warning in `easyparcel.ts` `book()` is expected and unrelated.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/adapters/easyparcelClient.ts src/lib/logistics/adapters/easyparcel.ts
git commit -m "refactor(logistics): share the EasyParcel transport between products"
```

---

### Task 2: The OnDemand vocabulary and status table

**Files:**
- Modify: `src/lib/logistics/carriers.ts`
- Modify: `src/lib/logistics/status.ts`
- Test: `src/lib/logistics/__tests__/status.test.ts`, `src/lib/logistics/__tests__/carriers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: carrier id `"easyparcel_ondemand"` with `kind: "vehicle"`; `CARRIER_STATUS_MAPS.easyparcel_ondemand` keyed on OnDemand's numeric status codes as strings.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/logistics/__tests__/status.test.ts — add inside the existing describe
it("maps EasyParcel OnDemand's codes, which are its own, not the parcel ones", () => {
  // Code 3 is "In Transit" on OnDemand and "Picked Up" on the parcel side.
  // Two products, two tables — one shared table would silently mis-state one.
  expect(mapCarrierStatus("easyparcel_ondemand", "3")).toBe("IN_TRANSIT");
  expect(mapCarrierStatus("easyparcel", "3")).toBe("PICKED_UP");
  expect(mapCarrierStatus("easyparcel_ondemand", "2")).toBe("DRIVER_ASSIGNED");
  expect(mapCarrierStatus("easyparcel_ondemand", "6")).toBe("DELIVERED");
});

it("treats every OnDemand cancellation as CANCELLED, whoever cancelled it", () => {
  // 0 customer, 4 admin, 5 driver. Who cancelled is a story for the event log;
  // the row's state is the same in all three cases.
  expect(mapCarrierStatus("easyparcel_ondemand", "0")).toBe("CANCELLED");
  expect(mapCarrierStatus("easyparcel_ondemand", "4")).toBe("CANCELLED");
  expect(mapCarrierStatus("easyparcel_ondemand", "5")).toBe("CANCELLED");
});

it("fails a job no driver would take", () => {
  expect(mapCarrierStatus("easyparcel_ondemand", "7")).toBe("FAILED");
});
```

```ts
// src/lib/logistics/__tests__/carriers.test.ts — add
it("lists EasyParcel OnDemand as a vehicle partner, not a parcel one", () => {
  expect(KIND.easyparcel_ondemand).toBe("vehicle");
  expect(KIND.easyparcel).toBe("parcel");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts src/lib/logistics/__tests__/carriers.test.ts`
Expected: FAIL — `mapCarrierStatus` returns `null` for an unknown carrier, and `KIND.easyparcel_ondemand` is `undefined`.

- [ ] **Step 3: Add the carrier**

In `src/lib/logistics/carriers.ts`, inside `CARRIERS`, after the `easyparcel` entry:

```ts
  {
    id: "easyparcel_ondemand",
    label: "EasyParcel OnDemand",
    kind: "vehicle",
  },
```

- [ ] **Step 4: Add the status table**

In `src/lib/logistics/status.ts`, inside `CARRIER_STATUS_MAPS`, after the `easyparcel` entry:

```ts
  /**
   * EasyParcel OnDemand's own status codes — a different scale from the parcel
   * side's, which is why this is a second table rather than a shared one. Their
   * 3 is "In Transit"; the parcel product's 3 is "Parcel been collected".
   *
   * 1 ("Pending") is the state between booking and a driver accepting, so it
   * maps to BOOKED. Three separate codes mean cancelled — by customer, by
   * admin, by driver — and all three land on CANCELLED: who cancelled belongs
   * in the event message, not in the row's state. 7 ("Unable to Find Driver")
   * is the one genuine failure.
   */
  easyparcel_ondemand: {
    "0": "CANCELLED",
    "1": "BOOKED",
    "2": "DRIVER_ASSIGNED",
    "3": "IN_TRANSIT",
    "4": "CANCELLED",
    "5": "CANCELLED",
    "6": "DELIVERED",
    "7": "FAILED",
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logistics/carriers.ts src/lib/logistics/status.ts src/lib/logistics/__tests__/status.test.ts src/lib/logistics/__tests__/carriers.test.ts
git commit -m "feat(logistics): name EasyParcel OnDemand as a vehicle partner"
```

---

### Task 3: Read the vendor's vehicle ladder and pick the smallest that fits

This is the heart of the plan and the only pure-logic task. OnDemand's quotation returns one row per vehicle, each carrying its real limits as prose (`"weight_limit": "800kg"`, `"dimension": "270cmx130cmx120cm"`). Parsing those and choosing the cheapest vehicle the job actually fits is what replaces the guessing in `measure.ts`.

**Files:**
- Create: `src/lib/logistics/__tests__/fixtures/easyparcelOndemand.ts`
- Create: `src/lib/logistics/adapters/easyparcelOndemand.ts` (partial — the pure functions only)
- Test: `src/lib/logistics/__tests__/easyparcelOndemand.test.ts`

**Interfaces:**
- Consumes: `EasyParcelNotDeliverable`, `num` from `./easyparcelClient`; `longestEdgeMm` from `../measure`; `DeliveryJob` from `../types`.
- Produces:
  - `parseWeightLimitKg(raw: string | null | undefined): number | null`
  - `parseDimensionMm(raw: string | null | undefined): number[] | null` — descending, three entries
  - `type OndemandOption = { serviceId: string; quotationId: string | null; courierName: string; transportType: string; weightLimitKg: number | null; dimensionMm: number[] | null; priceRm: number | null }`
  - `optionsOf(rows: unknown): OndemandOption[]` — their rate card in our words
  - `fits(job: DeliveryJob, option: OndemandOption): boolean`
  - `cheapestFitting(job: DeliveryJob, options: OndemandOption[]): OndemandOption | null`
  - `quotationSchema` — the Zod schema Task 4's `quote` parses with

- [ ] **Step 1: Record the fixture**

```ts
// src/lib/logistics/__tests__/fixtures/easyparcelOndemand.ts

/**
 * A real OnDemand quotation reply, trimmed to the fields we read.
 *
 * Copied from EasyParcel's own published sample so the vehicle ladder is
 * theirs, not ours: Bike 10kg through Lorry 14-ft 2500kg. This fixture is the
 * only place in the test suite that knows what a real vehicle carries, and it
 * is deliberately verbatim — a "tidied" fixture would stop catching a renamed
 * field, which is the one thing recorded fixtures are for.
 */
export const ONDEMAND_QUOTATION_OK = {
  status_code: 200,
  message: "",
  data: [
    {
      status: "success",
      quotations: [
        {
          metadata: { quotationId: "3418817446755394383" },
          courier: { service_id: "EP-CS0F", courier_name: "Lalamove" },
          transport: {
            transportation_type: "Bike",
            durations: "5mins",
            parcel_type_support: "Parcel",
            weight_limit: "10kg",
            dimension: "30cmx30cmx30cm",
          },
          pricing: { total_amount: 5.88, currency: "MYR" },
        },
        {
          metadata: { quotationId: "3418817446335963964" },
          courier: { service_id: "EP-CS0I", courier_name: "Lalamove" },
          transport: {
            transportation_type: "Car",
            durations: "5mins",
            parcel_type_support: "Parcel",
            weight_limit: "40kg",
            dimension: "50cmx50cmx50cm",
          },
          pricing: { total_amount: 7.06, currency: "MYR" },
        },
        {
          metadata: { quotationId: "3418817660128027070" },
          courier: { service_id: "EP-CS09", courier_name: "Lalamove" },
          transport: {
            transportation_type: "4X4",
            durations: "5mins",
            parcel_type_support:
              "Ideal for small fridge, washing machine, bike, 1-seater sofa",
            weight_limit: "250kg",
            dimension: "120cmx90cmx90cm",
          },
          pricing: { total_amount: 27.06, currency: "MYR" },
        },
        {
          metadata: { quotationId: "3418817660128027086" },
          courier: { service_id: "EP-CS0Y", courier_name: "Lalamove" },
          transport: {
            transportation_type: "Van",
            durations: "5mins",
            parcel_type_support:
              "Ideal for small fridge, washing machine, bike, 1-seater sofa",
            weight_limit: "500kg",
            dimension: "170cmx100cmx120cm",
          },
          pricing: { total_amount: 45.88, currency: "MYR" },
        },
        {
          metadata: { quotationId: "3418817446335963900" },
          courier: { service_id: "EP-CS05", courier_name: "Lalamove" },
          transport: {
            transportation_type: "Large Van",
            durations: "5mins",
            parcel_type_support:
              "Ideal for washing machine, sofa, treadmill , large parcels",
            weight_limit: "800kg",
            dimension: "270cmx130cmx120cm",
          },
          pricing: { total_amount: 57.65, currency: "MYR" },
        },
        {
          metadata: { quotationId: "3418817941557441277" },
          courier: { service_id: "EP-CS0G", courier_name: "Lalamove" },
          transport: {
            transportation_type: "Lorry 10-ft",
            durations: "5mins",
            parcel_type_support:
              "Ideal for queen size bed, fridge, 3-seater sofa, wardrobe",
            weight_limit: "1000kg",
            dimension: "290cmx150cmx150cm",
          },
          pricing: { total_amount: 78.82, currency: "MYR" },
        },
        {
          metadata: { quotationId: "3418817672006300006" },
          courier: { service_id: "EP-CS0M", courier_name: "Lalamove" },
          transport: {
            transportation_type: "Lorry 14-ft",
            durations: "5mins",
            parcel_type_support:
              "Ideal for king size bed, large fridge, 3-seater sofa, wardro",
            weight_limit: "2500kg",
            dimension: "420cmx200cmx200cm",
          },
          pricing: { total_amount: 125.29, currency: "MYR" },
        },
      ],
    },
  ],
};

/** Their documented shape for a refused request. */
export const ONDEMAND_QUOTATION_BAD_INPUT = {
  status_code: 400,
  message: "Invalid input Error",
  data: ["The waypoint 0 type field is required "],
};

/** A successful submit. `booking_id` is what cancel and details are keyed on. */
export const ONDEMAND_SUBMIT_OK = {
  status_code: 200,
  message: "Success",
  data: {
    booking_id: "EOD-150",
    ondemand_service_id: "EP-CS0I",
    order_number: "3418823367426527326",
    tracking_url:
      "https://share.lalamove.com/?MY100260129095828875410020097479892&lang=en_MY",
    courier: { service_id: 3, courier_name: "Lalamove" },
    pricing_breakdown: {
      currency_code: "MYR",
      total_order_amount: "7.06",
      total_paid_amount: "7.06",
    },
  },
};

/** Order details, mid-delivery, with a driver attached. */
export const ONDEMAND_DETAILS_IN_TRANSIT = {
  status_code: 200,
  message: "success",
  data: [
    {
      booking_id: "EOD-98765",
      order_number: "355123433231311221",
      status: 3,
      status_text: "In Transit",
      driver: {
        name: "John Doe",
        phone: "60123456789",
        vehicle: { license_plate: "ABC 1234", model: "Honda EX5", type: "MOTORCYCLE" },
        coordinates: { latitude: 5.3341, longitude: 100.2841 },
      },
      courier: { courier_name: "Lalamove", service_id: "EP-CS0F" },
      transport: { tracking_url: "https://test3.com", transportation_type: "Bike" },
    },
  ],
};

/** Details before a driver is matched — every driver field absent. */
export const ONDEMAND_DETAILS_PENDING = {
  status_code: 200,
  message: "success",
  data: [
    {
      booking_id: "EOD-98766",
      order_number: "355123433231311222",
      status: 1,
      status_text: "Pending",
      courier: { courier_name: "Lalamove", service_id: "EP-CS0F" },
      transport: { tracking_url: null, transportation_type: "Van" },
    },
  ],
};
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/logistics/__tests__/easyparcelOndemand.test.ts
import { describe, expect, it } from "vitest";
import {
  cheapestFitting,
  fits,
  type OndemandOption,
  optionsOf,
  parseDimensionMm,
  parseWeightLimitKg,
} from "../adapters/easyparcelOndemand";
import type { DeliveryItem, DeliveryJob } from "../types";
import { ONDEMAND_QUOTATION_OK } from "./fixtures/easyparcelOndemand";

const CARCASS: DeliveryItem = {
  label: "BC 800mm",
  qty: 1,
  widthMm: 800,
  heightMm: 720,
  depthMm: 560,
  weightKg: 45,
};

function job(over: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    id: "d1",
    number: 4,
    customerName: "Tan",
    customerPhone: "0123456789",
    siteAddress: "1 Jalan Test",
    addressNotes: null,
    pickupAddress: "EzCabinet Sdn Bhd",
    siteLat: 3.0678442,
    siteLng: 101.6247002,
    pickupLat: 2.9848868,
    pickupLng: 101.861807,
    sitePostcode: "47810",
    siteCity: "Petaling Jaya",
    siteState: "MY-10",
    pickupPostcode: "43500",
    pickupCity: "Semenyih",
    pickupState: "MY-10",
    items: [CARCASS],
    totalWeightKg: 45,
    totalVolumeM3: 0.323,
    scheduledAt: null,
    ...over,
  } as DeliveryJob;
}

describe("parseWeightLimitKg", () => {
  it("reads their prose figure", () => {
    expect(parseWeightLimitKg("800kg")).toBe(800);
    expect(parseWeightLimitKg("10 kg")).toBe(10);
    expect(parseWeightLimitKg("2500KG")).toBe(2500);
  });

  it("is null rather than zero when they say something new", () => {
    // Null means "unknown", and `fits` treats unknown as "do not rule it out".
    // Zero would silently exclude every vehicle the moment they reword a label.
    expect(parseWeightLimitKg("unlimited")).toBeNull();
    expect(parseWeightLimitKg(null)).toBeNull();
    expect(parseWeightLimitKg("")).toBeNull();
  });
});

describe("parseDimensionMm", () => {
  it("reads three centimetre edges into descending millimetres", () => {
    expect(parseDimensionMm("270cmx130cmx120cm")).toEqual([2700, 1300, 1200]);
    expect(parseDimensionMm("30cmx30cmx30cm")).toEqual([300, 300, 300]);
  });

  it("is null on anything that is not three edges", () => {
    expect(parseDimensionMm("120cmx90cm")).toBeNull();
    expect(parseDimensionMm("varies")).toBeNull();
    expect(parseDimensionMm(null)).toBeNull();
  });
});

describe("fits", () => {
  const van: OndemandOption = {
    serviceId: "EP-CS0Y",
    quotationId: "q",
    courierName: "Lalamove",
    transportType: "Van",
    weightLimitKg: 500,
    dimensionMm: [1700, 1200, 1000],
    priceRm: 45.88,
  };

  it("takes a job inside both the weight and the deck", () => {
    expect(fits(job(), van)).toBe(true);
  });

  it("refuses a job over the vehicle's weight", () => {
    expect(fits(job({ totalWeightKg: 501 }), van)).toBe(false);
  });

  it("refuses a job whose longest edge is longer than the deck's longest edge", () => {
    const strip: DeliveryItem = {
      label: "Trim strip",
      qty: 1,
      widthMm: 2400,
      heightMm: 60,
      depthMm: 18,
      weightKg: 2,
    };
    expect(fits(job({ items: [strip], totalWeightKg: 2 }), van)).toBe(false);
  });

  it("does not rule out a vehicle whose limits we could not read", () => {
    // An unreadable limit is our parser's problem, not evidence the vehicle is
    // too small. Excluding it would hide a bookable option; including it means
    // EasyParcel refuses at booking, which is the safer of the two failures.
    const unknown = { ...van, weightLimitKg: null, dimensionMm: null };
    expect(fits(job({ totalWeightKg: 9000 }), unknown)).toBe(true);
  });

  it("does not test weight when the job carries none", () => {
    expect(fits(job({ totalWeightKg: null }), van)).toBe(true);
  });
});

describe("cheapestFitting", () => {
  const options = optionsOf(ONDEMAND_QUOTATION_OK.data[0].quotations);

  it("picks the cheapest vehicle that actually fits, not the cheapest overall", () => {
    // A 45 kg carcass with an 800mm edge fits the 4X4 (250kg, 1200mm) but not
    // the Car (40kg) or the Bike. The Bike is cheapest and must not win.
    const best = cheapestFitting(job(), options);
    expect(best?.transportType).toBe("4X4");
    expect(best?.priceRm).toBe(27.06);
  });

  it("climbs the ladder for a 500 kg job", () => {
    // The job that started all this. Van is rated at exactly 500kg, so it fits
    // — the boundary is inclusive, because a vehicle rated 500kg carries 500kg.
    const best = cheapestFitting(job({ totalWeightKg: 500 }), options);
    expect(best?.transportType).toBe("Van");
    expect(best?.priceRm).toBe(45.88);
  });

  it("returns null when the job outgrows the largest vehicle", () => {
    expect(cheapestFitting(job({ totalWeightKg: 4000 }), options)).toBeNull();
  });

  it("ignores an option with no price — an unpriced row is not an offer", () => {
    const unpriced: OndemandOption[] = [
      { ...options[0], priceRm: null, weightLimitKg: 9000, dimensionMm: null },
    ];
    expect(cheapestFitting(job(), unpriced)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: FAIL — `Cannot find module '../adapters/easyparcelOndemand'`.

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/logistics/adapters/easyparcelOndemand.ts
import "server-only";
import { z } from "zod";
import { longestEdgeMm } from "../measure";
import type { DeliveryJob } from "../types";
import { EasyParcelNotDeliverable, num } from "./easyparcelClient";

/**
 * EasyParcel OnDemand — the same account as the parcel product, a different
 * vehicle.
 *
 * OnDemand is a marketplace of *vehicles*: one quotation comes back with a row
 * per class, from a 10 kg bike to a 2,500 kg 14-ft lorry, each carrying its own
 * `weight_limit` and `dimension`. That rate card is the thing this file exists
 * for. It is the only vendor-authoritative statement of what a vehicle carries
 * that this app can get — `courier/list` returns names and logos and nothing
 * else, and the parcel `shipment/quotation` endpoint documents no limits at all
 * — so the vehicle is chosen here, against their numbers, rather than against
 * the deck sizes `measure.ts` guesses at for the admin form.
 *
 * Coordinates, not postcodes: OnDemand takes waypoints, exactly like Lalamove,
 * which is not a coincidence — Lalamove is one of the couriers behind it.
 */

const quotationSchema = z.object({
  status_code: z.number().nullish(),
  data: z.array(
    z.object({
      status: z.string().nullish(),
      errors: z.array(z.string()).nullish(),
      quotations: z
        .array(
          z.looseObject({
            metadata: z
              .looseObject({ quotationId: z.string().nullish() })
              .nullish(),
            courier: z.looseObject({
              service_id: z.string(),
              courier_name: z.string().nullish(),
            }),
            transport: z
              .looseObject({
                transportation_type: z.string().nullish(),
                weight_limit: z.string().nullish(),
                dimension: z.string().nullish(),
              })
              .nullish(),
            pricing: z
              .looseObject({
                total_amount: z.union([z.string(), z.number()]).nullish(),
              })
              .nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

export type OndemandOption = {
  serviceId: string;
  quotationId: string | null;
  courierName: string;
  transportType: string;
  /** Null when their label was not a figure we could read — see `fits`. */
  weightLimitKg: number | null;
  /** Descending millimetres, or null on the same terms as the weight. */
  dimensionMm: number[] | null;
  priceRm: number | null;
};

/** `"800kg"` => `800`. Null when it is not a plain figure in kilogrammes. */
export function parseWeightLimitKg(
  raw: string | null | undefined,
): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*kg\s*$/i.exec(raw);
  return m ? Number(m[1]) : null;
}

/** `"270cmx130cmx120cm"` => `[2700, 1300, 1200]`, longest first. */
export function parseDimensionMm(
  raw: string | null | undefined,
): number[] | null {
  if (!raw) return null;
  const parts = raw.split(/x/i).map((p) => /^\s*(\d+(?:\.\d+)?)\s*cm\s*$/i.exec(p));
  if (parts.length !== 3 || parts.some((p) => p === null)) return null;
  return parts
    .map((p) => Math.round(Number((p as RegExpExecArray)[1]) * 10))
    .sort((a, b) => b - a);
}

/** Their rate card in our words. */
export function optionsOf(rows: unknown): OndemandOption[] {
  const parsed = z
    .array(z.looseObject({}))
    .safeParse(rows ?? []);
  if (!parsed.success) return [];
  return (rows as Record<string, never>[]).map((row) => {
    const r = row as unknown as {
      metadata?: { quotationId?: string | null } | null;
      courier: { service_id: string; courier_name?: string | null };
      transport?: {
        transportation_type?: string | null;
        weight_limit?: string | null;
        dimension?: string | null;
      } | null;
      pricing?: { total_amount?: string | number | null } | null;
    };
    return {
      serviceId: r.courier.service_id,
      quotationId: r.metadata?.quotationId ?? null,
      courierName: r.courier.courier_name ?? "Courier",
      transportType: r.transport?.transportation_type ?? "Vehicle",
      weightLimitKg: parseWeightLimitKg(r.transport?.weight_limit),
      dimensionMm: parseDimensionMm(r.transport?.dimension),
      priceRm: num(r.pricing?.total_amount),
    };
  });
}

/**
 * Whether the job is inside this vehicle's rating.
 *
 * A null limit is "unknown", never "zero". If EasyParcel rewords a label our
 * parser does not read, excluding the vehicle would hide a bookable option and
 * report it as "no vehicle serves this"; including it means the worst case is
 * EasyParcel refusing at booking time with their own reason. Between a silent
 * false refusal and a loud real one, the loud one is correct.
 *
 * Only the longest edge is tested against the longest deck edge. A full packing
 * solve is not what this is for — the deck is metres and a carcass is under a
 * metre, so the edge is the constraint that actually bites.
 */
export function fits(job: DeliveryJob, option: OndemandOption): boolean {
  if (
    option.weightLimitKg !== null &&
    job.totalWeightKg !== null &&
    job.totalWeightKg > option.weightLimitKg
  ) {
    return false;
  }
  if (option.dimensionMm !== null) {
    const edge = longestEdgeMm(job.items);
    if (edge > option.dimensionMm[0]) return false;
  }
  return true;
}

/**
 * The cheapest vehicle that will take the job.
 *
 * Cheapest *fitting*, emphatically not cheapest: their list is priced ascending
 * by vehicle size, so picking on price alone books a bike for a wardrobe.
 */
export function cheapestFitting(
  job: DeliveryJob,
  options: OndemandOption[],
): OndemandOption | null {
  const usable = options
    .filter((o) => o.priceRm !== null && fits(job, o))
    .sort((a, b) => (a.priceRm ?? 0) - (b.priceRm ?? 0));
  return usable[0] ?? null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logistics/adapters/easyparcelOndemand.ts src/lib/logistics/__tests__/easyparcelOndemand.test.ts src/lib/logistics/__tests__/fixtures/easyparcelOndemand.ts
git commit -m "feat(logistics): read EasyParcel OnDemand's vehicle ladder and pick what fits"
```

---

### Task 4: Quote an OnDemand job

**Files:**
- Modify: `src/lib/logistics/adapters/easyparcelOndemand.ts`
- Test: `src/lib/logistics/__tests__/easyparcelOndemand.test.ts`

**Interfaces:**
- Consumes: `cheapestFitting`, `optionsOf`, `quotationSchema` (Task 3); `call`, `ONDEMAND_BASE`, `readReply` (Task 1); `WORKSHOP_ADDRESS`, `WORKSHOP_PHONE` from `../carriers`; `easyparcelAppConfigured` from `../oauth`. The job's own `pickupLat`/`pickupLng` are used directly — `pickupPlace` is a postcode helper and has no part in a coordinate API.
- Produces:
  - `ondemandQuotationBody(job: DeliveryJob): { schedule_pickup_date: string; schedule_pickup_time: string; timezone: string; waypoint: Waypoint[] }`
  - `easyparcelOndemandAdapter.quote(job): Promise<CarrierQuote>` with `quoteRef` packed as `` `${serviceId}|${quotationId}` ``

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/lib/logistics/__tests__/easyparcelOndemand.test.ts
import { afterEach, vi } from "vitest";
import {
  easyparcelOndemandAdapter,
  ondemandQuotationBody,
  packOndemandRef,
  unpackOndemandRef,
} from "../adapters/easyparcelOndemand";

vi.mock("../tokens", () => ({
  accessTokenFor: vi.fn(async () => "test-token"),
  hasConnection: vi.fn(async () => true),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(payload: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ondemandQuotationBody", () => {
  it("sends two waypoints as coordinates, pickup first", () => {
    const body = ondemandQuotationBody(job());
    expect(body.waypoint).toHaveLength(2);
    expect(body.waypoint[0].type).toBe("pickup");
    expect(body.waypoint[0].coordinates).toEqual({
      latitude: 2.9848868,
      longitude: 101.861807,
    });
    expect(body.waypoint[1].type).toBe("dropoff");
    expect(body.waypoint[1].coordinates).toEqual({
      latitude: 3.0678442,
      longitude: 101.6247002,
    });
  });

  it("refuses a job with no pin rather than sending a stop without one", () => {
    // Same rule as Lalamove: OnDemand prices between coordinates, and a stop
    // with no coordinate is not a stop.
    expect(() =>
      ondemandQuotationBody(job({ siteLat: null, siteLng: null })),
    ).toThrow(/no map location/);
  });

  it("dates the pickup in Malaysia, not at UTC", () => {
    const body = ondemandQuotationBody(job());
    expect(body.timezone).toBe("Asia/Kuala_Lumpur");
    expect(body.schedule_pickup_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("packOndemandRef", () => {
  it("round-trips the service and the quotation it was priced under", () => {
    expect(unpackOndemandRef(packOndemandRef("EP-CS0Y", "q1"))).toEqual({
      serviceId: "EP-CS0Y",
      quotationId: "q1",
    });
  });

  it("survives a quotation id their reply left null", () => {
    // PandaGo's rows come back with `quotationId: null` in their own sample.
    expect(unpackOndemandRef(packOndemandRef("EP-CS0R", null))).toEqual({
      serviceId: "EP-CS0R",
      quotationId: null,
    });
  });

  it("is null on a ref from some other partner", () => {
    expect(unpackOndemandRef("")).toBeNull();
    expect(unpackOndemandRef(undefined)).toBeNull();
  });
});

describe("easyparcelOndemandAdapter.quote", () => {
  it("quotes the cheapest vehicle that fits and names it on the row", async () => {
    stub(ONDEMAND_QUOTATION_OK);
    const quote = await easyparcelOndemandAdapter.quote(job());
    expect(quote.carrierId).toBe("easyparcel_ondemand");
    expect(quote.priceRm).toBe(27.06);
    expect(quote.notes).toContain("4X4");
    expect(quote.notes).toContain("Lalamove");
    expect(quote.quoteRef).toBe("EP-CS09|3418817660128027070");
  });

  it("carries their own refusal to the admin rather than paraphrasing it", async () => {
    stub({
      status_code: 200,
      data: [{ status: "error", errors: ["No driver available in this area"] }],
    });
    await expect(easyparcelOndemandAdapter.quote(job())).rejects.toThrow(
      /No driver available in this area/,
    );
  });

  it("says so plainly when the job outgrows every vehicle", async () => {
    stub(ONDEMAND_QUOTATION_OK);
    await expect(
      easyparcelOndemandAdapter.quote(job({ totalWeightKg: 4000 })),
    ).rejects.toThrow(/no vehicle on EasyParcel/i);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: FAIL — `ondemandQuotationBody`, `packOndemandRef`, `unpackOndemandRef` and `easyparcelOndemandAdapter` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/logistics/adapters/easyparcelOndemand.ts`:

```ts
import { WORKSHOP_ADDRESS, WORKSHOP_PHONE } from "../carriers";
import { toE164 } from "../phone";
import { mapCarrierStatus } from "../status";
import { trace } from "../trace";
import type {
  CarrierAdapter,
  CarrierBooking,
  CarrierQuote,
  TrackingUpdate,
} from "../types";
import { easyparcelAppConfigured } from "../oauth";
import { call, ONDEMAND_BASE, readReply } from "./easyparcelClient";

const TIMEZONE = "Asia/Kuala_Lumpur";

type Waypoint = {
  point: number;
  type: "pickup" | "dropoff";
  coordinates: { latitude: number; longitude: number };
  address?: string;
};

/** OnDemand prices between pins, and refuses a stop without one. */
function waypoint(
  point: number,
  type: "pickup" | "dropoff",
  lat: number | null,
  lng: number | null,
  address: string,
  which: string,
): Waypoint {
  if (lat === null || lng === null) {
    trace("easyparcel.ondemand.refused", { why: "no pin", stop: which, address });
    throw new EasyParcelNotDeliverable(
      `The ${which} address has no map location — edit it, or paste a pin`,
    );
  }
  return { point, type, coordinates: { latitude: lat, longitude: lng }, address };
}

/**
 * `schedule_pickup_date` is a date in Malaysia, not at UTC — the same trap the
 * parcel adapter's `collectionDate` documents. `en-CA` formats as YYYY-MM-DD.
 */
function pickupWhen(scheduledAt: Date | null) {
  const at = scheduledAt ?? new Date();
  return {
    schedule_pickup_date: new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
    }).format(at),
    schedule_pickup_time: new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(at),
    timezone: TIMEZONE,
  };
}

export function ondemandQuotationBody(job: DeliveryJob) {
  return {
    ...pickupWhen(job.scheduledAt),
    waypoint: [
      waypoint(0, "pickup", job.pickupLat, job.pickupLng, job.pickupAddress, "pickup"),
      waypoint(1, "dropoff", job.siteLat, job.siteLng, job.siteAddress, "site"),
    ],
  };
}

/**
 * `book()` needs two strings from `quote()` and `CarrierQuote` gives it one.
 *
 * Joined rather than JSON so the value stays readable in the booking event's
 * `raw` — the same reasoning as `packQuoteRef` on the Lalamove side. The
 * quotation id can legitimately be absent: PandaGo's rows carry `null` in
 * EasyParcel's own sample, and `metadata` is still required on submit.
 */
export function packOndemandRef(
  serviceId: string,
  quotationId: string | null,
): string {
  return `${serviceId}|${quotationId ?? ""}`;
}

export function unpackOndemandRef(ref: string | undefined) {
  const parts = (ref ?? "").split("|");
  if (parts.length !== 2 || parts[0] === "") return null;
  return { serviceId: parts[0], quotationId: parts[1] === "" ? null : parts[1] };
}

export const easyparcelOndemandAdapter: CarrierAdapter = {
  id: "easyparcel_ondemand",

  isConfigured: () => easyparcelAppConfigured(),

  async quote(job): Promise<CarrierQuote> {
    trace("easyparcel.ondemand.quote", {
      deliveryId: job.id,
      weightKg: job.totalWeightKg,
    });

    const parsed = readReply(
      quotationSchema,
      await call(ONDEMAND_BASE, "/ondemand/quotation", ondemandQuotationBody(job), true),
      "ondemand quotation",
    );

    const first = parsed.data[0];
    if (first?.status !== "success") {
      throw new EasyParcelNotDeliverable(
        first?.errors?.join("; ") || "EasyParcel returned no vehicle for this job",
      );
    }

    const best = cheapestFitting(job, optionsOf(first.quotations ?? []));
    if (!best) {
      throw new EasyParcelNotDeliverable(
        "No vehicle on EasyParcel carries this job — split it across trips",
      );
    }

    return {
      carrierId: "easyparcel_ondemand",
      priceRm: best.priceRm,
      // Their `durations` is prose ("5mins") and describes time-to-driver, not
      // time-to-door. Converting it would put a delivery ETA on the screen that
      // nobody promised.
      etaMinutes: null,
      quoteRef: packOndemandRef(best.serviceId, best.quotationId),
      notes: `${best.courierName} ${best.transportType}${
        best.weightLimitKg === null ? "" : `, up to ${best.weightLimitKg} kg`
      }`,
    };
  },

  async book(): Promise<CarrierBooking> {
    throw new Error("not implemented until Task 5");
  },

  async track(): Promise<TrackingUpdate> {
    throw new Error("not implemented until Task 6");
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/adapters/easyparcelOndemand.ts src/lib/logistics/__tests__/easyparcelOndemand.test.ts
git commit -m "feat(logistics): quote a vehicle job against EasyParcel OnDemand"
```

---

### Task 5: Book an OnDemand job

**Files:**
- Modify: `src/lib/logistics/adapters/easyparcelOndemand.ts`
- Test: `src/lib/logistics/__tests__/easyparcelOndemand.test.ts`

**Interfaces:**
- Consumes: `unpackOndemandRef` (Task 4); `toE164` from `../phone`.
- Produces: `ondemandSubmitBody(job, serviceId, quotationId)`; `easyparcelOndemandAdapter.book` returning `carrierOrderId` = `booking_id`.

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/lib/logistics/__tests__/easyparcelOndemand.test.ts
import { ONDEMAND_SUBMIT_OK } from "./fixtures/easyparcelOndemand";
import { ondemandSubmitBody } from "../adapters/easyparcelOndemand";

describe("ondemandSubmitBody", () => {
  it("puts every line item on the pickup waypoint, in centimetres", () => {
    const body = ondemandSubmitBody(job(), "EP-CS09", "q1");
    expect(body.waypoint[0].item).toEqual([
      {
        quantity: "1",
        description: "BC 800mm",
        dimensions: { length: "80", width: "56", height: "72", weight: "45" },
      },
    ]);
  });

  it("rings the workshop from the loading bay, not the customer", () => {
    const body = ondemandSubmitBody(job(), "EP-CS09", "q1");
    expect(body.waypoint[0].shipment_info.name).toBe("EzCabinet");
    expect(body.waypoint[1].shipment_info.name).toBe("Tan");
    expect(body.waypoint[1].shipment_info.phone_number).toBe("123456789");
    expect(body.waypoint[1].shipment_info.phone_number_country_code).toBe("MY");
  });

  it("refuses a number a Malaysian driver cannot call", () => {
    expect(() =>
      ondemandSubmitBody(job({ customerPhone: "+6591234567" }), "EP-CS09", "q1"),
    ).toThrow(/not a number a courier can call/);
  });

  it("echoes the quotation it was priced under", () => {
    expect(ondemandSubmitBody(job(), "EP-CS09", "q1").metadata).toEqual({
      quotationId: "q1",
    });
  });
});

describe("easyparcelOndemandAdapter.book", () => {
  it("returns the booking id, which is what cancel and details are keyed on", async () => {
    stub(ONDEMAND_SUBMIT_OK);
    const booking = await easyparcelOndemandAdapter.book(job(), {
      carrierId: "easyparcel_ondemand",
      priceRm: 27.06,
      etaMinutes: null,
      quoteRef: "EP-CS09|q1",
    });
    expect(booking.carrierOrderId).toBe("EOD-150");
    expect(booking.trackingUrl).toContain("share.lalamove.com");
  });

  it("never retries a booking — a second lorry is not a retry", async () => {
    const fetchMock = stub(ONDEMAND_SUBMIT_OK);
    await easyparcelOndemandAdapter.book(job(), {
      carrierId: "easyparcel_ondemand",
      priceRm: 27.06,
      etaMinutes: null,
      quoteRef: "EP-CS09|q1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a quote from some other partner rather than guessing a service", async () => {
    await expect(
      easyparcelOndemandAdapter.book(job(), {
        carrierId: "easyparcel_ondemand",
        priceRm: 1,
        etaMinutes: null,
      }),
    ).rejects.toThrow(/missing its EasyParcel vehicle/);
  });

  it("does not report a spent wallet as a refusal", async () => {
    // Their reply says success but carries no booking id. The wallet is already
    // spent and a driver may be moving; calling that a failure invites a retry
    // that spends it twice. Same guard as the parcel adapter's submit.
    stub({ status_code: 200, message: "Success", data: { order_number: "x" } });
    await expect(
      easyparcelOndemandAdapter.book(job(), {
        carrierId: "easyparcel_ondemand",
        priceRm: 27.06,
        etaMinutes: null,
        quoteRef: "EP-CS09|q1",
      }),
    ).rejects.toThrow(/check the EasyParcel portal before booking again/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: FAIL — `ondemandSubmitBody` is not exported and `book` throws "not implemented until Task 5".

- [ ] **Step 3: Write the implementation**

Replace the `book` stub in `src/lib/logistics/adapters/easyparcelOndemand.ts`:

```ts
const submitSchema = z.object({
  status_code: z.number().nullish(),
  message: z.string().nullish(),
  data: z
    .looseObject({
      booking_id: z.string().nullish(),
      order_number: z.string().nullish(),
      tracking_url: z.string().nullish(),
    })
    .nullish(),
});

/**
 * EasyParcel takes the country code and the national number separately, so
 * `toE164`'s `+60123456789` is split rather than sent whole.
 */
function phoneParts(raw: string, whose: string) {
  const e164 = toE164(raw);
  // `toE164` defaults to a Malaysian country code but does not refuse a number
  // typed with a different one. This app only ever labels a number MY, so a
  // Singapore number must be refused rather than mislabelled.
  if (e164 === null || !e164.startsWith("+60")) {
    throw new EasyParcelNotDeliverable(
      `The ${whose} phone number (${raw}) is not a number a courier can call`,
    );
  }
  return {
    phone_number_country_code: "MY",
    phone_number: e164.replace(/^\+60/, ""),
  };
}

/**
 * Every line item rides on the pickup waypoint.
 *
 * OnDemand's `item` array hangs off a waypoint rather than the order, and the
 * whole consignment is collected at one stop and dropped at one stop, so the
 * real manifest belongs on the pickup. The dropoff carries the same list — their
 * sample puts items on both, and a driver reading the dropoff should see what
 * they are handing over.
 */
function itemsOf(job: DeliveryJob) {
  return job.items.map((line) => ({
    quantity: String(line.qty),
    description: line.label,
    dimensions: {
      length: String(Math.round(line.widthMm / 10)),
      width: String(Math.round(line.depthMm / 10)),
      height: String(Math.round(line.heightMm / 10)),
      weight: String(line.weightKg ?? 0),
    },
  }));
}

export function ondemandSubmitBody(
  job: DeliveryJob,
  serviceId: string,
  quotationId: string | null,
) {
  const pickup = waypoint(
    0,
    "pickup",
    job.pickupLat,
    job.pickupLng,
    job.pickupAddress,
    "pickup",
  );
  const dropoff = waypoint(
    1,
    "dropoff",
    job.siteLat,
    job.siteLng,
    job.siteAddress,
    "site",
  );
  const item = itemsOf(job);

  return {
    origin_country: "MY",
    ondemand_service_id: serviceId,
    ...pickupWhen(job.scheduledAt),
    // Required even when their reply left the id null — an empty object is a
    // valid `metadata`, an absent key is not.
    metadata: quotationId === null ? {} : { quotationId },
    waypoint: [
      {
        ...pickup,
        remark: `Delivery ${job.number}`,
        item,
        shipment_info: {
          name: "EzCabinet",
          // The workshop's own number, emphatically not the customer's: this is
          // who a driver rings from the loading bay.
          ...phoneParts(WORKSHOP_PHONE, "workshop's"),
          address:
            job.pickupAddress.trim() === WORKSHOP_ADDRESS
              ? WORKSHOP_ADDRESS
              : job.pickupAddress,
        },
      },
      {
        ...dropoff,
        ...(job.addressNotes ? { remark: job.addressNotes } : {}),
        item,
        shipment_info: {
          name: job.customerName,
          ...phoneParts(job.customerPhone, "customer's"),
          address: job.siteAddress,
        },
      },
    ],
  };
}
```

and the adapter method:

```ts
  async book(job, quote): Promise<CarrierBooking> {
    const ref = unpackOndemandRef(quote.quoteRef);
    if (!ref) {
      throw new EasyParcelNotDeliverable(
        "This quote is missing its EasyParcel vehicle — compare partners again",
      );
    }

    trace("easyparcel.ondemand.book", {
      deliveryId: job.id,
      serviceId: ref.serviceId,
      priceRm: quote.priceRm,
    });

    // Not idempotent, and `carrierFetch` will not retry it: a retried booking
    // deducts the wallet twice and sends a second driver.
    const parsed = readReply(
      submitSchema,
      await call(
        ONDEMAND_BASE,
        "/ondemand/submit_order",
        ondemandSubmitBody(job, ref.serviceId, ref.quotationId),
      ),
      "ondemand submit",
    );

    const bookingId = parsed.data?.booking_id ?? "";
    if (bookingId === "") {
      // The wallet has already been spent and a driver may already be moving.
      // Reporting this as a refusal would invite a retry that spends it twice,
      // and `carrierOrderId` never reached the DB so the already-booked guard
      // in `book/route.ts` cannot catch that retry either.
      throw new Error(
        "EasyParcel accepted the order but returned no booking id — check the EasyParcel portal before booking again",
      );
    }

    return {
      carrierOrderId: bookingId,
      trackingUrl: parsed.data?.tracking_url ?? null,
      labelUrl: null,
    };
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/adapters/easyparcelOndemand.ts src/lib/logistics/__tests__/easyparcelOndemand.test.ts
git commit -m "feat(logistics): book a vehicle job through EasyParcel OnDemand"
```

---

### Task 6: Track and cancel an OnDemand job

OnDemand's order details carry the driver's name, phone, plate and coordinates — the same fields Lalamove fills. This is the task that gives EasyParcel live driver tracking, which until now only Lalamove had.

**Files:**
- Modify: `src/lib/logistics/adapters/easyparcelOndemand.ts`
- Test: `src/lib/logistics/__tests__/easyparcelOndemand.test.ts`

**Interfaces:**
- Consumes: `mapCarrierStatus` from `../status` (Task 2's table).
- Produces: `easyparcelOndemandAdapter.track(bookingId)`, `easyparcelOndemandAdapter.cancel(bookingId)`.

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/lib/logistics/__tests__/easyparcelOndemand.test.ts
import {
  ONDEMAND_DETAILS_IN_TRANSIT,
  ONDEMAND_DETAILS_PENDING,
} from "./fixtures/easyparcelOndemand";

describe("easyparcelOndemandAdapter.track", () => {
  it("reports the driver and where they are", async () => {
    stub(ONDEMAND_DETAILS_IN_TRANSIT);
    const update = await easyparcelOndemandAdapter.track("EOD-98765");
    expect(update.status).toBe("IN_TRANSIT");
    expect(update.driverName).toBe("John Doe");
    expect(update.driverPhone).toBe("60123456789");
    expect(update.vehiclePlate).toBe("ABC 1234");
    expect(update.latitude).toBe(5.3341);
    expect(update.longitude).toBe(100.2841);
  });

  it("reports a status with no driver attached before one is matched", async () => {
    // Undefined, not null: `applyTrackingUpdate` writes a field only when it is
    // present, so an absent driver must leave the row's driver alone rather
    // than blanking one a webhook already delivered.
    stub(ONDEMAND_DETAILS_PENDING);
    const update = await easyparcelOndemandAdapter.track("EOD-98766");
    expect(update.status).toBe("BOOKED");
    expect(update.driverName).toBeUndefined();
    expect(update.latitude).toBeUndefined();
  });

  it("leaves the row alone when EasyParcel knows no such booking", async () => {
    stub({ status_code: 200, message: "success", data: [] });
    const update = await easyparcelOndemandAdapter.track("EOD-nope");
    expect(update.status).toBeNull();
  });
});

describe("easyparcelOndemandAdapter.cancel", () => {
  it("resolves on their success shape", async () => {
    stub({
      status_code: 200,
      message: "success",
      data: [{ message: "Shipment cancelled successfully", booking_id: "EOD-150" }],
    });
    await expect(
      easyparcelOndemandAdapter.cancel?.("EOD-150"),
    ).resolves.toBeUndefined();
  });

  it("throws when they refuse, so the row is not marked cancelled", async () => {
    // `advance/route.ts` relies entirely on this throwing: with no throw it
    // falls straight through to marking the job CANCELLED while a driver is
    // still on the way.
    stub({ status_code: 400, message: "Order cannot be cancelled", data: [] }, 400);
    await expect(
      easyparcelOndemandAdapter.cancel?.("EOD-150"),
    ).rejects.toThrow(/cannot be cancelled/i);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: FAIL — `track` throws "not implemented until Task 6" and `cancel` is undefined.

- [ ] **Step 3: Write the implementation**

Add the schema and replace the `track` stub:

```ts
const detailsSchema = z.object({
  status_code: z.number().nullish(),
  data: z.array(
    z.looseObject({
      booking_id: z.string().nullish(),
      status: z.number().nullish(),
      status_text: z.string().nullish(),
      driver: z
        .looseObject({
          name: z.string().nullish(),
          phone: z.string().nullish(),
          vehicle: z
            .looseObject({ license_plate: z.string().nullish() })
            .nullish(),
          coordinates: z
            .looseObject({
              latitude: z.union([z.string(), z.number()]).nullish(),
              longitude: z.union([z.string(), z.number()]).nullish(),
            })
            .nullish(),
        })
        .nullish(),
    }),
  ),
});

const cancelSchema = z.object({
  status_code: z.number().nullish(),
  message: z.string().nullish(),
  data: z
    .array(z.looseObject({ booking_id: z.string().nullish() }))
    .nullish(),
});
```

```ts
  async track(carrierOrderId): Promise<TrackingUpdate> {
    const parsed = readReply(
      detailsSchema,
      await call(
        ONDEMAND_BASE,
        "/ondemand/order_details",
        { booking_id: carrierOrderId },
        true,
      ),
      "ondemand details",
    );

    const row = parsed.data[0];
    if (!row) {
      return { status: null, message: "EasyParcel knows no such booking" };
    }

    const code = row.status;
    const text = row.status_text ?? "no status";
    const update: TrackingUpdate = {
      // The code, not the text — see the note on the table in `status.ts`.
      status:
        code === null || code === undefined
          ? null
          : mapCarrierStatus("easyparcel_ondemand", String(code)),
      message: `EasyParcel OnDemand reports ${text}`,
      raw: row,
    };

    const driver = row.driver;
    if (!driver) return update;

    // Every driver field is left `undefined` rather than null when absent:
    // `applyTrackingUpdate` writes only the keys that are present, so a poll
    // arriving between driver assignments must not blank a name a webhook
    // already delivered.
    return {
      ...update,
      driverName: driver.name ?? undefined,
      driverPhone: driver.phone ?? undefined,
      vehiclePlate: driver.vehicle?.license_plate ?? undefined,
      latitude: num(driver.coordinates?.latitude) ?? undefined,
      longitude: num(driver.coordinates?.longitude) ?? undefined,
    };
  },

  async cancel(carrierOrderId): Promise<void> {
    // EasyParcel refuses once a driver has collected. `carrierFetch` throws on
    // their non-2xx, and this parses the 200-shaped refusal — both have to
    // reach the caller, because `advance/route.ts` treats a resolved cancel as
    // permission to mark the row CANCELLED.
    const parsed = readReply(
      cancelSchema,
      await call(ONDEMAND_BASE, "/ondemand/cancel", { booking_id: carrierOrderId }),
      "ondemand cancel",
    );
    if (!parsed.data || parsed.data.length === 0) {
      throw new Error(parsed.message || "EasyParcel refused the cancellation");
    }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/easyparcelOndemand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/adapters/easyparcelOndemand.ts src/lib/logistics/__tests__/easyparcelOndemand.test.ts
git commit -m "feat(logistics): track and cancel an EasyParcel OnDemand booking"
```

---

### Task 7: Wire it up — webhook, registry, and the corrected vehicle table

**Files:**
- Modify: `src/lib/logistics/adapters/easyparcelOndemand.ts` (add `verifyWebhook`)
- Modify: `src/lib/logistics/registry.ts`
- Modify: `src/lib/logistics/measure.ts`
- Test: `src/lib/logistics/__tests__/easyparcelOndemand.test.ts`, `src/lib/logistics/__tests__/measure.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `easyparcelOndemandAdapter.verifyWebhook`; `ADAPTERS.easyparcel_ondemand`; corrected `VEHICLE_LIMITS`.

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/lib/logistics/__tests__/easyparcelOndemand.test.ts
describe("easyparcelOndemandAdapter.verifyWebhook", () => {
  const url = (token: string) =>
    new URL(`https://x.test/api/webhooks/easyparcel_ondemand?token=${token}`);

  it("keys an OnDemand callback on booking_id, not shipment_number", async () => {
    process.env.EASYPARCEL_WEBHOOK_TOKEN = "s3cret";
    const event = easyparcelOndemandAdapter.verifyWebhook?.(
      JSON.stringify({
        topic: "ondemand.status.update",
        booking_id: "EOD-150",
        status_code: 3,
        status: "In Transit",
      }),
      new Headers(),
      url("s3cret"),
    );
    expect(event).toEqual({
      kind: "order",
      carrierOrderId: "EOD-150",
      update: expect.objectContaining({ status: "IN_TRANSIT" }),
    });
  });

  it("refuses a callback with the wrong token", () => {
    process.env.EASYPARCEL_WEBHOOK_TOKEN = "s3cret";
    expect(
      easyparcelOndemandAdapter.verifyWebhook?.(
        JSON.stringify({ topic: "ondemand.status.update", booking_id: "EOD-1" }),
        new Headers(),
        url("wrong"),
      ),
    ).toBeNull();
  });

  it("acknowledges a parcel-side callback rather than 400-ing it", () => {
    // Both products post to the same registered endpoint family. A verified
    // event we have no use for is a 200 that says so — a 400 reads as a broken
    // endpoint and EasyParcel retries it for hours.
    process.env.EASYPARCEL_WEBHOOK_TOKEN = "s3cret";
    expect(
      easyparcelOndemandAdapter.verifyWebhook?.(
        JSON.stringify({ topic: "shipment.status.update", shipment_number: "EP-1" }),
        new Headers(),
        url("s3cret"),
      ),
    ).toEqual({ kind: "ignored", eventType: "shipment.status.update" });
  });
});
```

```ts
// add to src/lib/logistics/__tests__/measure.test.ts
it("sizes a van at what a real van carries", () => {
  // EasyParcel's OnDemand rate card rates Lalamove's Van at 500kg and its Large
  // Van at 800kg. The table used to say 600 — a figure between the two, which
  // pre-selected a van for a job no van takes.
  const van = VEHICLE_LIMITS.find((v) => v.id === "van");
  expect(van?.maxWeightKg).toBe(500);
});

it("offers the large van the vendor actually sells", () => {
  const largeVan = VEHICLE_LIMITS.find((v) => v.id === "van_large");
  expect(largeVan?.maxWeightKg).toBe(800);
  expect(largeVan?.maxEdgeMm).toBe(2700);
});

it("keeps the ladder ordered smallest first, so the first fit is the smallest", () => {
  const weights = VEHICLE_LIMITS.map((v) => v.maxWeightKg);
  expect([...weights].sort((a, b) => a - b)).toEqual(weights);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/logistics`
Expected: FAIL — `verifyWebhook` is undefined on the OnDemand adapter; `van.maxWeightKg` is 600; there is no `van_large`.

- [ ] **Step 3: Add the webhook verifier**

Append to the adapter object in `src/lib/logistics/adapters/easyparcelOndemand.ts`:

```ts
  /**
   * EasyParcel signs nothing — same as the parcel product, same URL secret, and
   * the same `EASYPARCEL_WEBHOOK_TOKEN`, because it is one account and one
   * registration in their Developer Hub.
   *
   * The one difference that matters: an OnDemand callback is keyed on
   * `booking_id`, and a parcel callback on `shipment_number`. Reading the wrong
   * key would either miss every update or write an OnDemand status onto a
   * parcel row.
   */
  verifyWebhook(rawBody, _headers, url): CarrierWebhookEvent | null {
    const expected = process.env.EASYPARCEL_WEBHOOK_TOKEN ?? "";
    if (expected === "") return null;
    if (!secretsMatch(url.searchParams.get("token") ?? "", expected)) return null;

    let parsed: z.infer<typeof ondemandWebhookSchema>;
    try {
      parsed = ondemandWebhookSchema.parse(JSON.parse(rawBody));
    } catch {
      return null;
    }

    const topic = parsed.topic ?? null;
    trace("easyparcel.ondemand.webhook", { topic, body: parsed });

    const bookingId = parsed.booking_id ?? "";
    if (bookingId === "") {
      // A parcel-side callback, or a topic added after this was written.
      return { kind: "ignored", eventType: topic };
    }

    const code = parsed.status_code ?? parsed.ondemand_status_code ?? null;
    const text = parsed.status ?? parsed.status_text ?? "no status";

    return {
      kind: "order",
      carrierOrderId: bookingId,
      update: {
        status:
          code === null
            ? null
            : mapCarrierStatus("easyparcel_ondemand", String(code)),
        message: `EasyParcel OnDemand ${topic ?? "webhook"}: ${text}`,
        raw: parsed,
      },
    };
  },
```

with the schema and helper above it:

```ts
import { timingSafeEqual } from "node:crypto";
import type { CarrierWebhookEvent } from "../types";

/** Constant-time, and length-safe — `timingSafeEqual` throws on a length mismatch. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Loose on purpose — an unknown topic must parse, not 400. */
const ondemandWebhookSchema = z.looseObject({
  topic: z.string().nullish(),
  booking_id: z.string().nullish(),
  order_number: z.string().nullish(),
  status_code: z.number().nullish(),
  ondemand_status_code: z.number().nullish(),
  status: z.string().nullish(),
  status_text: z.string().nullish(),
});
```

- [ ] **Step 4: Register the adapter**

In `src/lib/logistics/registry.ts`:

```ts
import { easyparcelOndemandAdapter } from "./adapters/easyparcelOndemand";
```

and inside `ADAPTERS`:

```ts
  easyparcel_ondemand: easyparcelOndemandAdapter,
```

- [ ] **Step 5: Correct the vehicle table against the vendor's ladder**

In `src/lib/logistics/measure.ts`, replace the `VEHICLE_LIMITS` array and extend `VehicleClass`:

```ts
export type VehicleClass =
  | "car"
  | "van"
  | "van_large"
  | "lorry_1t"
  | "lorry_3t";

/**
 * Load deck limits, smallest first. The first class every item and every total
 * fits inside is the suggestion.
 *
 * These are no longer estimates. EasyParcel's OnDemand quotation publishes the
 * real rate card — Bike 10kg, Car 40kg, 4X4 250kg, Van 500kg, Large Van 800kg,
 * Lorry 10-ft 1000kg, Lorry 14-ft 2500kg, each with its deck dimensions — and
 * these rows are read off it. The van was the one that mattered: it said 600kg,
 * a figure between the real Van (500) and the real Large Van (800), so it
 * pre-selected a vehicle no carrier sells for jobs between the two.
 *
 * The bike is deliberately absent. Nothing this business ships fits on one, and
 * an option that is never correct is one more row for an admin to read past.
 *
 * This is still advisory — it pre-selects a class in the booking form and the
 * carrier's own quote is the authority. `easyparcelOndemand.cheapestFitting`
 * chooses against the live rate card rather than against this table.
 */
export const VEHICLE_LIMITS: {
  id: VehicleClass;
  label: string;
  maxVolumeM3: number;
  maxWeightKg: number;
  maxEdgeMm: number;
}[] = [
  {
    id: "car",
    label: "Car",
    maxVolumeM3: 0.125,
    maxWeightKg: 40,
    maxEdgeMm: 500,
  },
  {
    id: "van",
    label: "Van",
    maxVolumeM3: 2.04,
    maxWeightKg: 500,
    maxEdgeMm: 1700,
  },
  {
    id: "van_large",
    label: "Large van",
    maxVolumeM3: 4.21,
    maxWeightKg: 800,
    maxEdgeMm: 2700,
  },
  {
    id: "lorry_1t",
    label: "1-tonne lorry",
    maxVolumeM3: 6.53,
    maxWeightKg: 1000,
    maxEdgeMm: 2900,
  },
  {
    id: "lorry_3t",
    label: "3-tonne lorry",
    maxVolumeM3: 16.8,
    maxWeightKg: 2500,
    maxEdgeMm: 4200,
  },
];
```

Then update the Lalamove service-type map in `src/lib/logistics/adapters/lalamove.ts`, which is keyed on `VehicleClass` and will no longer typecheck:

```ts
export const SERVICE_TYPE: Record<VehicleClass, string> = {
  car: "CAR",
  van: "VAN",
  van_large: "VAN",
  lorry_1t: "TRUCK330",
  lorry_3t: "TRUCK550",
};
```

- [ ] **Step 6: Run the whole suite**

Run: `pnpm vitest run && pnpm tsc --noEmit && pnpm biome check src`
Expected: all tests PASS, no type errors, no new lint findings.

- [ ] **Step 7: Verify against the live API**

Run: `pnpm easyparcel:ping`
Expected: the ping script's existing checks still pass. This is the only thing in the repo that sees a renamed field — CI runs against fixtures and cannot. If the OnDemand endpoints are not enabled on the account, this is where that surfaces.

- [ ] **Step 8: Commit**

```bash
git add src/lib/logistics/adapters/easyparcelOndemand.ts src/lib/logistics/adapters/lalamove.ts src/lib/logistics/registry.ts src/lib/logistics/measure.ts src/lib/logistics/__tests__/
git commit -m "feat(logistics): route OnDemand callbacks and size vehicles off the vendor's rate card"
```

---

## Notes for the reviewer

- **This improves carrier parity rather than straining it.** The recorded principle is that a feature only one partner supports stays out of the admin UI. Live driver position was Lalamove-only; after Task 6 both vehicle partners report it, so the driver panel stops being a Lalamove special case. Nothing in this plan adds a UI affordance only one partner can serve.
- **Two partners now reach Lalamove.** `lalamove` books it directly against our own API key; `easyparcel_ondemand` books it through EasyParcel's wallet. That is a real comparison — the prices differ and so does who holds the account — not a duplicate row, and the comparison screen already renders one row per carrier.
- **`MAX_EDGE_MM` on the parcel adapter stays.** It is a gauge, not a price: a 2.4m panel does not fit through a courier's counter at any weight, and the quotation endpoint will happily return a rate for one. The weight cap was removed on 2026-09-06 because the vendor publishes no weight limit; that reasoning does not extend to dimensions.
