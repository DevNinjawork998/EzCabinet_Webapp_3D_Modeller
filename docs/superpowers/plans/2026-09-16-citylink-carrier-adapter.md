# City-Link Carrier Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the City-Link stub with a working adapter that books a parcel, stores its consignment note and tracks it by poll.

**Architecture:** One file, `src/lib/logistics/adapters/citylink.ts`, implementing the existing `CarrierAdapter` contract the way `adapters/gdex.ts` does: pure payload builders that refuse a job they cannot send, a `call()` that adds City-Link's header credentials and checks their `returncode` envelope, and the adapter object. City-Link has no rate, cancel or webhook operation, so `quote` validates and returns a null price, `cancel` is absent, and tracking rides the existing cron poll.

**Tech Stack:** Next.js route handlers, zod, `@vercel/blob` (private), vitest, biome.

**Spec:** The review agreed in conversation on 2026-09-16, against *City-Link Express Web Service (RESTful) Developers Reference Guide, Testing V1.21, revised 7 May 2026*. The PDF is City-Link's confidential property and is **not** in the repo — ask the project owner for it. Everything this plan needs from it is quoted below.

## Global Constraints

- Defaults taken where the review left questions open: **null price** on the comparison row, **a fresh token per operation** (no DB cache), **build against the test server now**, live credentials later.
- Base URL is the test server only: `https://devsvr2019a.citylinkexpress.com:21145/CitylinkService.svc/rest`. Going live is a deliberate code edit, not an env flag — same rule as `BASE` in `adapters/gdex.ts`.
- Env vars: `CITYLINK_COMPANY_CODE`, `CITYLINK_ACCOUNT_NUMBER`, `CITYLINK_METER_NUMBER`. All three present = configured.
- Booking (`requestShipment`) is never retried: `idempotent: false`. Token and tracking calls are `idempotent: true`.
- The consignment note is customer data: Blob `access: "private"`, served only through `/api/admin/deliveries/[id]/label`.
- Field limits from the doc: address lines 50 chars, city 20, state 20, postcode 10, tel 25, contact/name 50, remarks 50, customer reference (`XR`) 20, content description 500, pieces ≤ 999, `TransactionIdentifier` ≤ 40.
- Success is `returncode === "00"`, inside an HTTP 200. Anything else is a refusal whose `returnmessage` is shown verbatim.
- Do not commit `City Link API.pdf` (currently untracked in the repo root).
- UI copy is sentence case. Tests run with `pnpm test`, types with `pnpm typecheck`, lint with `pnpm lint`.

## What the API offers (from the PDF)

All operations are `POST {BASE}/{operation}` with JSON. Credentials travel in **request headers**:

| Header | Value |
| --- | --- |
| `CompanyCode` | `CITYLINK_COMPANY_CODE` (City-Link issues `CT`) |
| `AccountNumber` | `CITYLINK_ACCOUNT_NUMBER` |
| `MeterNumber` | `CITYLINK_METER_NUMBER` |
| `TransactionIdentifier` | unique per call, ≤ 40 chars — `crypto.randomUUID()` |
| `Token` | from `requestToken`; not sent on `requestToken` itself |

- `requestToken` → `{ txnId, returncode, returnmessage, token, requestDate, expiryDate }`. Valid 7 days.
- `requestShipment` → `{ returncode, returnmessage, txnId, hawbNo, label }`; `label` is the consignment note PDF as base64 (empty when not requested).
- `trackShipment` body `{ hawbtype: "True", hawbvalue: "<hawb>" }` → `{ returncode, returnmessage, trackHeader: [...], trackDetails: [{ detDate: "29/09/2017", detTime: "120459", CP_Code: "PK", status, location, Recipient, DisposeCode }] }`.

**Unverified, and the reason Task 5 exists:** the doc lists `requestShipment` body fields in groups (`Shipper`, `Consignee`, `Dimensions`, `Label`, `MultiPiece`, `ShipmentContent`, `Reference`, `ServiceInfo`) but prints no sample request. This plan sends each group as a nested object of that name, and `GenerateLabel` as `1`. The ping script checks both against the test server once credentials exist.

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/lib/logistics/status.ts` | Modify | City-Link `CP_Code` → our statuses |
| `src/lib/logistics/__tests__/status.test.ts` | Modify | Table tests |
| `src/lib/logistics/adapters/citylink.ts` | Rewrite | Builders, `call`, adapter |
| `src/lib/logistics/__tests__/citylink.test.ts` | Create | Builder + adapter tests |
| `src/lib/logistics/adapters/stub.ts` | Delete | Its only user was citylink |
| `src/app/api/admin/deliveries/[id]/label/route.ts` | Modify | Serve GDEX **and** City-Link notes |
| `scripts/citylink-ping.mjs` | Create | Checks the real API shape |
| `package.json` | Modify | `citylink:ping` script |
| `CLAUDE.md`, `.gitignore` | Modify | Docs, keep the PDF out of git |

---

### Task 1: City-Link status table

**Files:**

- Modify: `src/lib/logistics/status.ts` (the `citylink: {},` line and the docblock above `CARRIER_STATUS_MAPS`)
- Test: `src/lib/logistics/__tests__/status.test.ts`

**Interfaces:**

- Consumes: `mapCarrierStatus(carrierId, raw)`, which normalises keys to lowercase.
- Produces: `mapCarrierStatus("citylink", cpCode)` is used by Task 3's `track`.

City-Link's event codes and the mapping, from the doc's "CP_Code (Status code) Mapping" table:

| CP_Code | City-Link's description | Ours |
| --- | --- | --- |
| SR | Received request shipment data | BOOKED |
| DP | Drop-off at authorised drop-in centre | PICKED_UP |
| SC | Shipment pickup by City-Link | PICKED_UP |
| PK | Arrived City-Link facility (pickup from shipper) | PICKED_UP |
| GS, GA, GD, GC | Airport gateway events | IN_TRANSIT |
| OB | Departed origin facility | IN_TRANSIT |
| HD | Departed sorting facility | IN_TRANSIT |
| RV | At local facility | IN_TRANSIT |
| CR | Arrived destination import hub | IN_TRANSIT |
| OD | With delivery courier | IN_TRANSIT |
| DL | Delivered | DELIVERED |
| SP | Delivery status — meaning is in `DisposeCode` | *unmapped* |

- [ ] **Step 1: Write the failing tests**

In `status.test.ts`, delete the whole `it("returns null for a carrier with no table yet", …)` block (citylink was the last empty table, and "a carrier that does not exist" already covers null). Then append:

```ts
describe("citylink statuses", () => {
 it("maps City-Link's event codes, whatever the case", () => {
  expect(mapCarrierStatus("citylink", "SR")).toBe("BOOKED");
  expect(mapCarrierStatus("citylink", "sc")).toBe("PICKED_UP");
  expect(mapCarrierStatus("citylink", "PK")).toBe("PICKED_UP");
  expect(mapCarrierStatus("citylink", "DP")).toBe("PICKED_UP");
  expect(mapCarrierStatus("citylink", "OD")).toBe("IN_TRANSIT");
  expect(mapCarrierStatus("citylink", "DL")).toBe("DELIVERED");
 });

 it("leaves SP unmapped — its meaning is in the dispose code, not the event", () => {
  expect(mapCarrierStatus("citylink", "SP")).toBeNull();
 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts`
Expected: FAIL — `expected null to be 'BOOKED'`.

- [ ] **Step 3: Implement**

In `status.ts`, replace `citylink: {},` with:

```ts
 /**
  * City-Link's `CP_Code` tracking events — two letters, keyed on the code
  * rather than the description because the doc itself lists an old and a new
  * wording for most of them.
  *
  * `SP` is deliberately absent. It means "delivery status, see DisposeCode",
  * and the dispose code ranges from "Receiver Not In" (try again tomorrow) to
  * "Returned To Shipper" — one event, several of our states. Unmapped leaves
  * the row alone, which is safe; the raw event is on the DeliveryEvent.
  *
  * Like GDEX, a parcel network never reports a driver, so a City-Link job
  * never reaches DRIVER_ASSIGNED.
  */
 citylink: {
  sr: "BOOKED",
  dp: "PICKED_UP",
  sc: "PICKED_UP",
  pk: "PICKED_UP",
  gs: "IN_TRANSIT",
  ga: "IN_TRANSIT",
  gd: "IN_TRANSIT",
  gc: "IN_TRANSIT",
  ob: "IN_TRANSIT",
  hd: "IN_TRANSIT",
  rv: "IN_TRANSIT",
  cr: "IN_TRANSIT",
  od: "IN_TRANSIT",
  dl: "DELIVERED",
 },
```

In the docblock above `CARRIER_STATUS_MAPS`, delete the paragraph beginning "`manual`, `lalamove` and `easyparcel` are filled in" and its `ponytail:` line — every table is now filled.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/status.ts src/lib/logistics/__tests__/status.test.ts
git commit -m "feat(logistics): map City-Link tracking events to delivery statuses"
```

---

### Task 2: Shipment payload builders

**Files:**

- Rewrite: `src/lib/logistics/adapters/citylink.ts` (builders only in this task; the adapter object in Task 3)
- Create: `src/lib/logistics/__tests__/citylink.test.ts`

**Interfaces:**

- Consumes: `pickupPlace(address, place)` and `WORKSHOP_ADDRESS`, `WORKSHOP_PHONE` from `../carriers`; `MALAYSIAN_STATES` from `../malaysia`; `toE164` from `../phone`; `DeliveryJob` from `../types`.
- Produces (all exported from `adapters/citylink.ts`):
  - `class CitylinkNotDeliverable extends Error`
  - `weightOf(job: DeliveryJob): number`
  - `piecesOf(job: DeliveryJob): number`
  - `dimensionsCm(job: DeliveryJob): { Length: number; Width: number; Height: number; Units: "CM" }`
  - `addressLines(address: string, fallback: string): string[]` (2 or 3 lines)
  - `stateName(code: string | null): string | null`
  - `pickupDate(job: DeliveryJob): string` (`YYYYMMDD`)
  - `shipmentBody(job: DeliveryJob): ShipmentBody`

This task leaves `citylinkAdapter` still exported as the stub so `registry.ts` keeps compiling; Task 3 replaces it.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/logistics/__tests__/citylink.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.hoisted(() =>
 vi.fn(async (..._args: unknown[]) => ({ pathname: "p" })),
);
vi.mock("@vercel/blob", () => ({ put }));

import {
 addressLines,
 CitylinkNotDeliverable,
 dimensionsCm,
 pickupDate,
 piecesOf,
 shipmentBody,
 stateName,
 weightOf,
} from "../adapters/citylink";
import { WORKSHOP_ADDRESS } from "../carriers";
import type { DeliveryItem, DeliveryJob } from "../types";

/**
 * Frozen for the same reason gdex.test.ts freezes it: `pickupDate` compares
 * against today in Malaysia, and a fixture date that is "tomorrow" today is
 * "last week" next week.
 */
beforeEach(() => {
 vi.useFakeTimers({ shouldAdvanceTime: true });
 vi.setSystemTime(new Date("2026-09-06T02:00:00.000Z"));
});

afterEach(() => {
 vi.useRealTimers();
});

const carton: DeliveryItem = {
 label: "Handle set",
 qty: 2,
 widthMm: 300,
 heightMm: 100,
 depthMm: 80,
 weightKg: 1.5,
};

const job = (over: Partial<DeliveryJob> = {}): DeliveryJob => ({
 id: "dlv_1",
 number: 7,
 customerName: "Chan Kin Kong",
 customerPhone: "012-345 6789",
 siteAddress: "No. 45, Persiaran Mahsuri 1/3, 11950 Bayan Baru, Pulau Pinang",
 sitePostcode: "11950",
 siteCity: "Bayan Baru",
 siteState: "MY-07",
 // The workshop, so `pickupPlace` supplies 43800 / Dengkil / MY-10.
 pickupAddress: WORKSHOP_ADDRESS,
 pickupPostcode: null,
 pickupCity: null,
 pickupState: null,
 addressNotes: "Guard house, ask for block C",
 siteLat: null,
 siteLng: null,
 pickupLat: null,
 pickupLng: null,
 items: [carton],
 totalWeightKg: 3,
 totalVolumeM3: 0.005,
 scheduledAt: new Date("2026-09-10T08:00:00.000Z"),
 ...over,
});

describe("weightOf", () => {
 it("returns the job's weight", () => {
  expect(weightOf(job())).toBe(3);
 });

 it("refuses a job with no weight rather than inventing one", () => {
  expect(() => weightOf(job({ totalWeightKg: null }))).toThrow(
   CitylinkNotDeliverable,
  );
 });
});

describe("piecesOf", () => {
 it("counts quantities, not rows", () => {
  expect(piecesOf(job())).toBe(2);
 });

 it("refuses an empty job and one over City-Link's 999", () => {
  expect(() => piecesOf(job({ items: [] }))).toThrow(/no items/);
  expect(() =>
   piecesOf(job({ items: [{ ...carton, qty: 999 }, carton] })),
  ).toThrow(/999/);
 });
});

describe("dimensionsCm", () => {
 it("converts to whole centimetres, rounding up", () => {
  expect(dimensionsCm(job())).toEqual({
   Length: 30,
   Width: 8,
   Height: 10,
   Units: "CM",
  });
 });

 it("takes the largest extent on each axis across items", () => {
  const door: DeliveryItem = {
   label: "Spare door",
   qty: 1,
   widthMm: 1200,
   heightMm: 600,
   depthMm: 18,
   weightKg: 9,
  };
  expect(dimensionsCm(job({ items: [carton, door] }))).toEqual({
   Length: 120,
   Width: 8,
   Height: 60,
   Units: "CM",
  });
 });
});

describe("addressLines", () => {
 it("wraps at word boundaries within 50 characters", () => {
  expect(addressLines(job().siteAddress, "unused")).toEqual([
   "No. 45, Persiaran Mahsuri 1/3, 11950 Bayan Baru,",
   "Pulau Pinang",
  ]);
 });

 it("fills the required second line when the address fits on one", () => {
  expect(addressLines("Lot 5, Jalan 1", "43800 Dengkil")).toEqual([
   "Lot 5, Jalan 1",
   "43800 Dengkil",
  ]);
 });

 it("refuses an address longer than City-Link's three lines", () => {
  expect(() => addressLines("x ".repeat(100), "f")).toThrow(
   CitylinkNotDeliverable,
  );
 });
});

describe("stateName", () => {
 it("turns our ISO code back into the name City-Link expects", () => {
  expect(stateName("MY-07")).toBe("Pulau Pinang");
  expect(stateName("MY-14")).toBe("Kuala Lumpur");
 });

 it("returns null for nothing or an unknown code", () => {
  expect(stateName(null)).toBeNull();
  expect(stateName("MY-99")).toBeNull();
 });
});

describe("pickupDate", () => {
 it("formats the scheduled day in Malaysia as YYYYMMDD", () => {
  expect(pickupDate(job())).toBe("20260910");
 });

 it("uses the Malaysian calendar day, not the UTC one", () => {
  // 2026-09-09 17:00 UTC is 01:00 on the 10th in Kuala Lumpur.
  expect(
   pickupDate(job({ scheduledAt: new Date("2026-09-09T17:00:00.000Z") })),
  ).toBe("20260910");
 });

 it("refuses no date, and today — City-Link wants a day after today", () => {
  expect(() => pickupDate(job({ scheduledAt: null }))).toThrow(
   /no scheduled date/,
  );
  expect(() =>
   pickupDate(job({ scheduledAt: new Date("2026-09-06T08:00:00.000Z") })),
  ).toThrow(/after today/);
 });
});

describe("shipmentBody", () => {
 it("builds a parcel shipment from the workshop to the site", () => {
  const body = shipmentBody(job());

  expect(body).toMatchObject({
   ServiceType: "EXP",
   PackageType: "SPX",
   Weight: 3,
   WeightUnits: "KG",
   CurrencyCode: "MYR",
   DeclaredValue: "0.00",
   Shipper: {
    Tel: "60312345678",
    PostCode: "43800",
    City: "Dengkil",
    State: "Selangor",
    CountryCode: "MY",
   },
   Consignee: {
    ContactPerson: "Chan Kin Kong",
    Name: "Chan Kin Kong",
    Tel: "60123456789",
    AddressType: "M",
    AddressLine1: "No. 45, Persiaran Mahsuri 1/3, 11950 Bayan Baru,",
    AddressLine2: "Pulau Pinang",
    City: "Bayan Baru",
    State: "Pulau Pinang",
    PostCode: "11950",
    CountryCode: "MY",
   },
   Dimensions: { Length: 30, Width: 8, Height: 10, Units: "CM" },
   Remarks: "Guard house, ask for block C",
   Label: { GenerateLabel: 1, Type: "A4" },
   MultiPiece: { NumberPieces: 2 },
   ShipmentContent: { Description: "Handle set" },
   Reference: { XR: "ICB-7" },
   ServiceInfo: { business_type: "1", schedule_pickup_date: "20260910" },
  });
  expect(body.Consignee).not.toHaveProperty("AddressLine3");
 });

 it("refuses a site with no postcode, city or readable state", () => {
  expect(() => shipmentBody(job({ sitePostcode: null }))).toThrow(
   /postcode, town and state/,
  );
  expect(() => shipmentBody(job({ siteState: "MY-99" }))).toThrow(
   /postcode, town and state/,
  );
 });

 it("refuses an edited pickup that never geocoded", () => {
  expect(() =>
   shipmentBody(job({ pickupAddress: "Somewhere else, Shah Alam" })),
  ).toThrow(/pickup address/);
 });

 it("refuses a phone number City-Link cannot dial", () => {
  expect(() => shipmentBody(job({ customerPhone: "+65 9123 4567" }))).toThrow(
   /customer's phone/,
  );
 });

 it("clips fields to City-Link's lengths", () => {
  const body = shipmentBody(
   job({
    customerName: "A".repeat(80),
    siteCity: "Bandar Baru Seri Petaling Jaya",
    addressNotes: "N".repeat(80),
   }),
  );
  expect(body.Consignee.Name).toHaveLength(50);
  expect(body.Consignee.City).toHaveLength(20);
  expect(body.Remarks).toHaveLength(50);
 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/citylink.test.ts`
Expected: FAIL — `addressLines` (and the rest) is not exported.

- [ ] **Step 3: Implement the builders**

Replace the whole of `src/lib/logistics/adapters/citylink.ts` with:

```ts
import "server-only";
import { pickupPlace, WORKSHOP_PHONE } from "../carriers";
import { MALAYSIAN_STATES } from "../malaysia";
import { toE164 } from "../phone";
import { trace } from "../trace";
import { CarrierNotConfigured, type DeliveryJob } from "../types";
import { stubAdapter } from "./stub";

/**
 * City-Link Express — a parcel partner.
 *
 * Three things separate it from GDEX and every choice here follows from them:
 * it has **no rate operation** (a quote validates the job and carries no
 * price), **no cancel operation** (a booking is undone by phoning City-Link),
 * and **no webhook** (tracking is the cron poll only). What it does have is a
 * booking reply that carries the consignment note itself, as base64, so there
 * is no second fetch to lose.
 *
 * Source: City-Link Express Web Service Developers Reference Guide, Testing
 * V1.21 (7 May 2026). Confidential to City-Link, so not in the repo.
 */

/**
 * A job City-Link cannot be asked to carry. Separate from
 * `CarrierNotConfigured` for the reason `GdexNotDeliverable` is: the fix is on
 * the job, and `quotes/route.ts` puts this message on the comparison row.
 */
export class CitylinkNotDeliverable extends Error {
 constructor(message: string) {
  super(message);
  this.name = "CitylinkNotDeliverable";
 }
}

/** Who the consignment note says it is from. */
const SENDER_NAME = "EzCabinet Sdn Bhd";

/** City-Link's field limits, from the guide's return-code table. */
const LINE = 50;
const CITY = 20;
const REMARKS = 50;
const CONTENT = 500;
export const MAX_PIECES = 999;

export function weightOf(job: DeliveryJob): number {
 const kg = job.totalWeightKg;
 if (kg === null || kg <= 0) {
  trace("citylink.refused", { why: "no weight", deliveryId: job.id });
  throw new CitylinkNotDeliverable(
   "This job has no weight — City-Link needs the gross weight, so give each item a weight and compare again",
  );
 }
 return kg;
}

export function piecesOf(job: DeliveryJob): number {
 const pieces = job.items.reduce((sum, item) => sum + item.qty, 0);
 if (pieces === 0) {
  throw new CitylinkNotDeliverable("This job has no items to send");
 }
 if (pieces > MAX_PIECES) {
  throw new CitylinkNotDeliverable(
   `This job is ${pieces} pieces — City-Link takes at most ${MAX_PIECES} on one shipment, so split it`,
  );
 }
 return pieces;
}

/**
 * One box size for the whole shipment, because City-Link takes one.
 *
 * `SPX` (parcel) makes dimensions mandatory. The largest extent on each axis
 * across the items is the smallest box every piece fits in — an over-statement
 * for a mixed job, never an under-statement, which is the side that gets
 * surcharged.
 *
 * ponytail: one bounding box for all pieces. Send a shipment per item size if
 * City-Link's volumetric invoicing makes the over-statement cost money.
 */
export function dimensionsCm(job: DeliveryJob) {
 const cm = (pick: (i: DeliveryJob["items"][number]) => number) =>
  Math.ceil(Math.max(...job.items.map(pick)) / 10);
 return {
  Length: cm((i) => i.widthMm),
  Width: cm((i) => i.depthMm),
  Height: cm((i) => i.heightMm),
  Units: "CM" as const,
 };
}

/**
 * An address as City-Link's lines: at most three, 50 characters each, and at
 * least two, because `AddressLine2` is mandatory.
 *
 * Wrapped at spaces rather than split at commas — a Malaysian address puts
 * commas wherever the typist likes, and a comma split can still leave a 60
 * character segment. `fallback` fills the second line of a short address.
 */
export function addressLines(address: string, fallback: string): string[] {
 const lines: string[] = [];
 for (const word of address.trim().split(/\s+/)) {
  const last = lines.at(-1);
  if (last !== undefined && `${last} ${word}`.length <= LINE) {
   lines[lines.length - 1] = `${last} ${word}`;
  } else {
   lines.push(word.slice(0, LINE));
  }
 }
 if (lines.length > 3) {
  throw new CitylinkNotDeliverable(
   `The address "${address.slice(0, 60)}…" is longer than City-Link's three lines of ${LINE} characters — shorten it`,
  );
 }
 if (lines.length < 2) lines.push(fallback.slice(0, LINE));
 return lines;
}

/** Our stored ISO code (`MY-07`) back to a name City-Link reads. */
export function stateName(code: string | null): string | null {
 return MALAYSIAN_STATES.find((s) => s.code === code)?.name ?? null;
}

/** A moment as `YYYYMMDD` on a Malaysian calendar. `en-CA` formats ISO dates. */
function klDay(at: Date): string {
 return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" })
  .format(at)
  .replaceAll("-", "");
}

/**
 * The collection day. City-Link refuses today and the past (return code 98,
 * "Pickup date must greater than current date"), so both are refused here,
 * where the message can name the fix.
 */
export function pickupDate(job: DeliveryJob): string {
 if (job.scheduledAt === null) {
  throw new CitylinkNotDeliverable(
   "This job has no scheduled date — City-Link needs a pickup day, so set Scheduled and compare again",
  );
 }
 const day = klDay(job.scheduledAt);
 if (day <= klDay(new Date())) {
  throw new CitylinkNotDeliverable(
   `This job is scheduled for ${day} — City-Link collects on a day after today, so pick a later date`,
  );
 }
 return day;
}

/**
 * A number as City-Link's `Tel`: digits with the country code, no `+`. Same
 * shape and same Malaysia-only rule as `phoneOrThrow` in `gdex.ts`.
 */
function telOf(raw: string, whose: string): string {
 const e164 = toE164(raw);
 if (e164 === null || !e164.startsWith("+60")) {
  throw new CitylinkNotDeliverable(
   `The ${whose} phone number (${raw}) is not a number City-Link can call`,
  );
 }
 return e164.slice(1);
}

export type ShipmentBody = ReturnType<typeof shipmentBody>;

/**
 * The `requestShipment` payload.
 *
 * Nesting is our reading of the guide, which lists fields under group headings
 * but prints no sample request — `pnpm citylink:ping` is what confirms it.
 *
 * `DeclaredValue` is zero for the reason GDEX's `ShipmentValue` is: a value we
 * were never given would misstate the contents. `business_type: "1"` asks for a
 * pickup; without it City-Link expects the parcel dropped at a counter.
 */
export function shipmentBody(job: DeliveryJob) {
 const site = {
  postcode: job.sitePostcode,
  city: job.siteCity,
  state: stateName(job.siteState),
 };
 if (!site.postcode || !site.city || !site.state) {
  trace("citylink.refused", { why: "site place", deliveryId: job.id });
  throw new CitylinkNotDeliverable(
   "City-Link needs the site's postcode, town and state and we could not read them — edit the address and save again",
  );
 }

 const from = pickupPlace(job.pickupAddress, {
  postcode: job.pickupPostcode,
  city: job.pickupCity,
  state: job.pickupState,
 });
 const fromState = stateName(from?.state ?? null);
 if (!from?.postcode || !from.city || !fromState) {
  throw new CitylinkNotDeliverable(
   "City-Link needs the pickup address's postcode, town and state and we could not read them — edit the pickup address and save again",
  );
 }

 const [s1, s2, s3] = addressLines(
  job.pickupAddress,
  `${from.postcode} ${from.city}`,
 );
 const [c1, c2, c3] = addressLines(
  job.siteAddress,
  `${site.postcode} ${site.city}`,
 );
 const customer = job.customerName.slice(0, LINE);

 return {
  ServiceType: "EXP",
  PackageType: "SPX",
  Weight: weightOf(job),
  WeightUnits: "KG",
  CurrencyCode: "MYR",
  DeclaredValue: "0.00",
  Shipper: {
   ContactPerson: SENDER_NAME,
   Name: SENDER_NAME,
   Tel: telOf(WORKSHOP_PHONE, "workshop's"),
   AddressLine1: s1,
   AddressLine2: s2,
   ...(s3 ? { AddressLine3: s3 } : {}),
   City: from.city.slice(0, CITY),
   State: fromState,
   PostCode: from.postcode,
   CountryCode: "MY",
  },
  Consignee: {
   ContactPerson: customer,
   Name: customer,
   Tel: telOf(job.customerPhone, "customer's"),
   AddressType: "M",
   AddressLine1: c1,
   AddressLine2: c2,
   ...(c3 ? { AddressLine3: c3 } : {}),
   City: site.city.slice(0, CITY),
   State: site.state,
   PostCode: site.postcode,
   CountryCode: "MY",
  },
  Dimensions: dimensionsCm(job),
  ...(job.addressNotes
   ? { Remarks: job.addressNotes.slice(0, REMARKS) }
   : {}),
  Label: { GenerateLabel: 1, Type: "A4" },
  MultiPiece: { NumberPieces: piecesOf(job) },
  ShipmentContent: {
   Description: job.items
    .map((i) => i.label)
    .join(", ")
    .slice(0, CONTENT),
  },
  // Ours, printed on the note — ties City-Link's portal to a job number.
  Reference: { XR: `ICB-${job.number}` },
  ServiceInfo: {
   business_type: "1",
   schedule_pickup_date: pickupDate(job),
  },
 };
}

// Replaced in Task 3.
export const citylinkAdapter = stubAdapter("citylink", () => {
 throw new CarrierNotConfigured("citylink");
});
```

Note: `Remarks` is optional, so `body.Remarks` must still type-check in the "clips fields" test. The spread yields `Remarks?: string`, which `toHaveLength` accepts.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/logistics/__tests__/citylink.test.ts`
Expected: PASS, all describe blocks.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean. If biome reformats, run `pnpm biome check --write src/lib/logistics` and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logistics/adapters/citylink.ts src/lib/logistics/__tests__/citylink.test.ts
git commit -m "feat(logistics): build City-Link shipment payloads from a delivery job"
```

---

### Task 3: The City-Link adapter

**Files:**

- Modify: `src/lib/logistics/adapters/citylink.ts` (append `call`, schemas, label store, adapter; drop the stub import)
- Delete: `src/lib/logistics/adapters/stub.ts`
- Modify: `src/app/api/admin/deliveries/[id]/label/route.ts`
- Test: `src/lib/logistics/__tests__/citylink.test.ts`

**Interfaces:**

- Consumes: Task 2's `shipmentBody`, `weightOf`, `piecesOf`, `CitylinkNotDeliverable`; Task 1's `mapCarrierStatus("citylink", …)`; `carrierFetch<T>(url, { carrierId, method, headers, body, idempotent })` from `../http`; `put` from `@vercel/blob`.
- Produces:
  - `citylinkAdapter: CarrierAdapter` with `isConfigured`, `quote`, `book`, `track` (no `cancel`, no `verifyWebhook`)
  - `labelPathname(hawb: string): string` → `logistics/citylink/${hawb}.pdf`
  - `latestEvent(details: TrackEvent[]): TrackEvent | null`

- [ ] **Step 1: Write the failing tests**

Add to the import list at the top of `citylink.test.ts`: `citylinkAdapter`, `labelPathname`, `latestEvent`. Then append:

```ts
/** One queued JSON Response per call, in order. Same helper as gdex.test.ts. */
function stubResponses(...bodies: unknown[]) {
 const fetchMock = vi.fn();
 for (const body of bodies) {
  fetchMock.mockResolvedValueOnce(
   new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
   }),
  );
 }
 vi.stubGlobal("fetch", fetchMock);
 return fetchMock;
}

/** The guide's own sample replies, V1.21 pages 5, 8 and 10. */
const tokenReply = {
 txnId: "test",
 returncode: "00",
 returnmessage: "",
 token: "87ed0cf4-c51d-4dd8-8571-1f22daf9f492",
 requestDate: "29/09/2017",
 expiryDate: "06/10/2017",
};

const shipmentReply = {
 returncode: "00",
 returnmessage: "",
 txnId: "js123",
 hawbNo: "06039900998373",
 label: Buffer.from("%PDF-1.7").toString("base64"),
};

const trackReply = {
 txnId: "5588",
 returncode: "00",
 returnmessage: "",
 trackHeader: [{ hawb: "06039900998373", xr1: "ICB-7" }],
 trackDetails: [
  {
   detDate: "30/09/2017",
   detTime: "090000",
   CP_Code: "OD",
   status: "With City-Link delivery courier",
   location: "KUL",
   Recipient: "",
   DisposeCode: "",
  },
  {
   detDate: "29/09/2017",
   detTime: "120459",
   CP_Code: "PK",
   status: "Shipment Collected",
   location: "DATARAN CITY-LINK EXPRESS, MALAYSIA",
   Recipient: "",
   DisposeCode: "",
  },
 ],
};

const quote = { carrierId: "citylink", priceRm: null, etaMinutes: null };

describe("citylinkAdapter", () => {
 beforeEach(() => {
  vi.stubEnv("CITYLINK_COMPANY_CODE", "CT");
  vi.stubEnv("CITYLINK_ACCOUNT_NUMBER", "acc_test");
  vi.stubEnv("CITYLINK_METER_NUMBER", "meter_test");
  put.mockClear();
 });

 afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
 });

 it("is configured only with all three credentials", () => {
  expect(citylinkAdapter.isConfigured()).toBe(true);
  vi.stubEnv("CITYLINK_METER_NUMBER", "");
  expect(citylinkAdapter.isConfigured()).toBe(false);
 });

 describe("quote", () => {
  it("offers no price and calls nothing — City-Link has no rate API", async () => {
   const fetchMock = stubResponses();
   const result = await citylinkAdapter.quote(job());
   expect(result.priceRm).toBeNull();
   expect(result.carrierId).toBe("citylink");
   expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a job City-Link could not book, before the admin picks it", async () => {
   await expect(
    citylinkAdapter.quote(job({ totalWeightKg: null })),
   ).rejects.toThrow(CitylinkNotDeliverable);
  });
 });

 describe("book", () => {
  it("gets a token, sends it with the credentials, and returns the HAWB", async () => {
   const fetchMock = stubResponses(tokenReply, shipmentReply);

   const booking = await citylinkAdapter.book(job(), quote);

   expect(booking.carrierOrderId).toBe("06039900998373");
   expect(fetchMock.mock.calls[0][0]).toMatch(/\/requestToken$/);
   expect(fetchMock.mock.calls[1][0]).toMatch(/\/requestShipment$/);
   const headers = fetchMock.mock.calls[1][1].headers;
   expect(headers).toMatchObject({
    CompanyCode: "CT",
    AccountNumber: "acc_test",
    MeterNumber: "meter_test",
    Token: tokenReply.token,
   });
   expect(headers.TransactionIdentifier.length).toBeLessThanOrEqual(40);
  });

  it("stores the note privately and links to our own route", async () => {
   stubResponses(tokenReply, shipmentReply);

   const booking = await citylinkAdapter.book(job(), quote);

   expect(put).toHaveBeenCalledWith(
    "logistics/citylink/06039900998373.pdf",
    expect.any(Buffer),
    expect.objectContaining({ access: "private" }),
   );
   expect(booking.labelUrl).toBe("/api/admin/deliveries/dlv_1/label");
  });

  it("still books when there is no label to store", async () => {
   stubResponses(tokenReply, { ...shipmentReply, label: "" });
   const booking = await citylinkAdapter.book(job(), quote);
   expect(put).not.toHaveBeenCalled();
   expect(booking.labelUrl).toBeNull();
  });

  it("surfaces City-Link's own refusal, from inside a 200", async () => {
   stubResponses(tokenReply, {
    returncode: "92",
    returnmessage: "Error getting destination station for post code / package type",
    txnId: null,
    hawbNo: null,
    label: "",
   });
   await expect(citylinkAdapter.book(job(), quote)).rejects.toThrow(
    /destination station/,
   );
  });

  it("never retries the booking call", async () => {
   const fetchMock = stubResponses(tokenReply);
   fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));

   await expect(citylinkAdapter.book(job(), quote)).rejects.toThrow();
   expect(fetchMock).toHaveBeenCalledTimes(2);
  });
 });

 describe("track", () => {
  it("reports the latest event, whatever order City-Link lists them in", async () => {
   stubResponses(tokenReply, trackReply);

   const update = await citylinkAdapter.track("06039900998373");

   expect(update.status).toBe("IN_TRANSIT");
   expect(update.message).toMatch(/With City-Link delivery courier/);
  });

  it("asks by HAWB", async () => {
   const fetchMock = stubResponses(tokenReply, trackReply);
   await citylinkAdapter.track("06039900998373");
   expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    hawbtype: "True",
    hawbvalue: "06039900998373",
   });
  });

  it("leaves the row alone when there are no events yet", async () => {
   stubResponses(tokenReply, { ...trackReply, trackDetails: [] });
   const update = await citylinkAdapter.track("06039900998373");
   expect(update.status).toBeNull();
  });
 });
});

describe("latestEvent", () => {
 it("orders by the date City-Link writes day-first", () => {
  expect(
   latestEvent([
    { detDate: "01/10/2017", detTime: "080000" },
    { detDate: "30/09/2017", detTime: "235959" },
   ])?.detDate,
  ).toBe("01/10/2017");
 });

 it("is null for no events", () => {
  expect(latestEvent([])).toBeNull();
 });
});

describe("labelPathname", () => {
 it("keeps City-Link notes apart from GDEX's", () => {
  expect(labelPathname("06039900998373")).toBe(
   "logistics/citylink/06039900998373.pdf",
  );
 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/citylink.test.ts`
Expected: FAIL — `citylinkAdapter.isConfigured()` is false, and `latestEvent`/`labelPathname` are not exported.

- [ ] **Step 3: Implement the adapter**

In `adapters/citylink.ts`:

1. Replace the import block with:

```ts
import "server-only";
import { put } from "@vercel/blob";
import { z } from "zod";
import { pickupPlace, WORKSHOP_PHONE } from "../carriers";
import { carrierFetch } from "../http";
import { MALAYSIAN_STATES } from "../malaysia";
import { toE164 } from "../phone";
import { mapCarrierStatus } from "../status";
import { trace } from "../trace";
import {
 type CarrierAdapter,
 type CarrierBooking,
 CarrierNotConfigured,
 type CarrierQuote,
 type DeliveryJob,
 type TrackingUpdate,
} from "../types";
```

1. Delete the `// Replaced in Task 3.` stub export at the bottom and append:

```ts
/** Read per call, not at import, so a test can stub them. */
const COMPANY_CODE = () => process.env.CITYLINK_COMPANY_CODE ?? "";
const ACCOUNT_NUMBER = () => process.env.CITYLINK_ACCOUNT_NUMBER ?? "";
const METER_NUMBER = () => process.env.CITYLINK_METER_NUMBER ?? "";

/**
 * The test server, and only the test server — the guide documents no live
 * host. Going live is an edit here once City-Link issues live credentials and
 * a URL, not an environment variable somebody flips.
 */
const BASE =
 "https://devsvr2019a.citylinkexpress.com:21145/CitylinkService.svc/rest";

/** Every reply carries this; `"00"` is the only success. */
const envelope = z.object({
 returncode: z.string(),
 returnmessage: z.string().nullish(),
});

const tokenSchema = envelope.extend({ token: z.string().nullish() });

const shipmentSchema = envelope.extend({
 hawbNo: z.string().nullish(),
 label: z.string().nullish(),
});

const trackEventSchema = z.object({
 detDate: z.string(),
 detTime: z.string().nullish(),
 CP_Code: z.string().nullish(),
 status: z.string().nullish(),
 location: z.string().nullish(),
});

export type TrackEvent = z.infer<typeof trackEventSchema>;

const trackSchema = envelope.extend({
 trackDetails: z.array(trackEventSchema).nullish(),
});

/**
 * One City-Link operation. Credentials go in headers; a refusal arrives as
 * HTTP 200 with a non-`"00"` return code, so the envelope is checked here and
 * every caller can trust what it gets back.
 */
async function call<T extends z.infer<typeof envelope>>(
 operation: string,
 schema: z.ZodType<T>,
 options: { token?: string; body?: unknown; idempotent: boolean },
): Promise<T> {
 if (!citylinkAdapter.isConfigured()) {
  throw new CarrierNotConfigured("citylink");
 }
 const payload = await carrierFetch<unknown>(`${BASE}/${operation}`, {
  carrierId: "citylink",
  method: "POST",
  headers: {
   CompanyCode: COMPANY_CODE(),
   AccountNumber: ACCOUNT_NUMBER(),
   MeterNumber: METER_NUMBER(),
   TransactionIdentifier: crypto.randomUUID(),
   ...(options.token ? { Token: options.token } : {}),
  },
  ...(options.body === undefined ? {} : { body: options.body }),
  idempotent: options.idempotent,
 });

 const parsed = schema.safeParse(payload);
 if (!parsed.success) {
  const seen = JSON.stringify(payload) ?? String(payload);
  trace("citylink.unreadable", { operation, payload: seen });
  throw new Error(
   `City-Link's ${operation} reply was not the shape we expect: ${seen.slice(0, 200)}`,
  );
 }
 if (parsed.data.returncode !== "00") {
  trace("citylink.refused", { operation, code: parsed.data.returncode });
  throw new CitylinkNotDeliverable(
   `City-Link refused (${parsed.data.returncode}): ${parsed.data.returnmessage || "no reason given"}`,
  );
 }
 return parsed.data;
}

/**
 * A token for this operation.
 *
 * ponytail: a fresh token per operation, one extra round trip each. Tokens
 * last seven days; store one in `CarrierToken` if the extra call ever shows up
 * in the comparison's latency.
 */
async function requestToken(): Promise<string> {
 const reply = await call("requestToken", tokenSchema, { idempotent: true });
 if (!reply.token) throw new Error("City-Link issued an empty token");
 return reply.token;
}

/**
 * Newest first by City-Link's own clock. `detDate` is `DD/MM/YYYY`, so it is
 * rearranged before comparing — as written, the 30th sorts after the 1st of
 * the next month.
 */
export function latestEvent(details: TrackEvent[]): TrackEvent | null {
 const key = (e: TrackEvent) =>
  `${e.detDate.split("/").reverse().join("")}${(e.detTime ?? "").padStart(6, "0")}`;
 return [...details].sort((a, b) => key(b).localeCompare(key(a)))[0] ?? null;
}

/**
 * Where a City-Link note lives. Private, derived from `carrierOrderId`, served
 * only by `/api/admin/deliveries/[id]/label` — the reasoning is on GDEX's
 * `labelPathname`, which this mirrors.
 */
export function labelPathname(hawb: string): string {
 return `logistics/citylink/${hawb}.pdf`;
}

/**
 * Keep the note that came back with the booking. Failure is swallowed for the
 * reason it is in `gdex.ts`: the shipment already exists, and throwing here
 * would report a booking that happened as one that did not.
 */
async function storeLabel(hawb: string, base64: string): Promise<boolean> {
 if (base64 === "") return false;
 try {
  await put(labelPathname(hawb), Buffer.from(base64, "base64"), {
   access: "private",
   addRandomSuffix: false,
   contentType: "application/pdf",
   allowOverwrite: true,
  });
  return true;
 } catch (error) {
  trace("citylink.label", { hawb, error: String(error) });
  return false;
 }
}

export const citylinkAdapter: CarrierAdapter = {
 id: "citylink",

 isConfigured: () =>
  COMPANY_CODE() !== "" && ACCOUNT_NUMBER() !== "" && METER_NUMBER() !== "",

 async quote(job): Promise<CarrierQuote> {
  // Built and thrown away: the only way to find out now, rather than at
  // booking, that City-Link would refuse this job.
  shipmentBody(job);
  return {
   carrierId: "citylink",
   // No rate operation exists. Null is "not priced through an API", the
   // same answer `manual` gives, and the comparison still offers booking.
   priceRm: null,
   etaMinutes: null,
   notes: `Parcel, ${weightOf(job)} kg, ${piecesOf(job)} pcs — priced on City-Link's invoice`,
  };
 },

 async book(job): Promise<CarrierBooking> {
  trace("citylink.book", { deliveryId: job.id });
  const body = shipmentBody(job);
  const token = await requestToken();

  // Not idempotent: a retried shipment request is a second parcel.
  const reply = await call("requestShipment", shipmentSchema, {
   token,
   body,
   idempotent: false,
  });
  if (!reply.hawbNo) {
   throw new Error("City-Link accepted the shipment but returned no HAWB");
  }

  const stored = await storeLabel(reply.hawbNo, reply.label ?? "");
  return {
   carrierOrderId: reply.hawbNo,
   labelUrl: stored ? `/api/admin/deliveries/${job.id}/label` : null,
   // The guide documents no public tracking page.
   trackingUrl: null,
  };
 },

 async track(carrierOrderId): Promise<TrackingUpdate> {
  const token = await requestToken();
  const reply = await call("trackShipment", trackSchema, {
   token,
   body: { hawbtype: "True", hawbvalue: carrierOrderId },
   idempotent: true,
  });

  const event = latestEvent(reply.trackDetails ?? []);
  if (event === null) {
   return {
    status: null,
    message: "City-Link has no tracking events for this shipment yet",
    raw: reply,
   };
  }
  return {
   // An unmapped code (`SP`, or one City-Link adds) gives null and the
   // row stays where it is — see `mapCarrierStatus`.
   status: event.CP_Code ? mapCarrierStatus("citylink", event.CP_Code) : null,
   message: `City-Link reports ${event.status || event.CP_Code || "an event"}${event.location ? ` at ${event.location}` : ""}`,
   raw: reply,
  };
 },
};
```

`call` references `citylinkAdapter` before its declaration in source order. That is fine, because `call` only runs after the module has loaded.

1. Delete `src/lib/logistics/adapters/stub.ts`. Check nothing else imports it:

Run: `grep -rn "adapters/stub" src`
Expected: no output.

- [ ] **Step 4: Serve City-Link notes from the label route**

In `src/app/api/admin/deliveries/[id]/label/route.ts`, replace the gdex import with:

```ts
import { labelPathname as citylinkLabel } from "@/lib/logistics/adapters/citylink";
import { labelPathname as gdexLabel } from "@/lib/logistics/adapters/gdex";

/** The carriers that hand us a note at booking, and where each one keeps it. */
const LABELS: Record<string, (carrierOrderId: string) => string> = {
 gdex: gdexLabel,
 citylink: citylinkLabel,
};
```

Replace the guard and the `get` call with:

```ts
 const pathnameOf = delivery?.carrierId ? LABELS[delivery.carrierId] : undefined;
 if (!delivery || !pathnameOf || delivery.carrierOrderId === null) {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
 }

 const result = await get(pathnameOf(delivery.carrierOrderId), {
  access: "private",
  useCache: false,
 });
```

In the route's docblock, change "GDEX only serves the PDF while a shipment is pending, so this reads the copy taken at booking time." to "GDEX only serves the PDF while a shipment is pending, and City-Link only returns it in the booking reply, so this reads the copy taken at booking time."

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/lib/logistics`
Expected: PASS across the folder, including `gdex.test.ts` and `status.test.ts`.

- [ ] **Step 6: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logistics/adapters/citylink.ts src/lib/logistics/__tests__/citylink.test.ts src/app/api/admin/deliveries/\[id\]/label/route.ts
git rm src/lib/logistics/adapters/stub.ts
git commit -m "feat(logistics): book and track City-Link parcels"
```

---

### Task 4: Docs, and keep the confidential PDF out of git

**Files:**

- Modify: `CLAUDE.md`
- Modify: `.gitignore`

**Interfaces:** none, documentation only.

- [ ] **Step 1: Ignore the PDF**

Append to `.gitignore`:

```gitignore

# City-Link's API guide is their confidential document. Never commit it.
/City Link API.pdf
```

Run: `git status --short | grep -c "City Link"`
Expected: `0`.

- [ ] **Step 2: Update CLAUDE.md**

In the directory layout, change

```text
    adapters/            ← one file per partner; manual, lalamove and easyparcel are live
```

to

```text
    adapters/            ← one file per partner; manual, lalamove, gdex, easyparcel and citylink
```

Under **Known issues**, append a new numbered item:

```markdown
5. **City-Link has no rate, cancel or webhook operation.** Its comparison row carries no price, a booking is undone by phoning City-Link, and tracking is the cron poll only. `requestShipment`'s body nesting is our reading of a guide that prints no sample request — `pnpm citylink:ping` is what checks it.
```

Under **Open questions**, append:

```markdown
- **City-Link: live host, credentials, and a rate API.** The guide (Testing V1.21) documents only `devsvr2019a.citylinkexpress.com:21145`, and its credentials page is blank. Ask City-Link for the live URL, the account and meter numbers, and whether a rate operation exists — without one, admins compare City-Link blind on price.
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs(logistics): record City-Link's gaps and keep its guide out of git"
```

---

### Task 5: `citylink:ping` — check the real API shape

**Files:**

- Create: `scripts/citylink-ping.mjs`
- Modify: `package.json` (`scripts`)

**Interfaces:**

- Consumes: env `CITYLINK_COMPANY_CODE`, `CITYLINK_ACCOUNT_NUMBER`, `CITYLINK_METER_NUMBER`; optional `CITYLINK_PING_BOOK=1`; optional argv HAWB.
- Produces: a console report. Nothing imports it.

CI tests against the guide's sample replies, which is our *belief* about City-Link. This script checks City-Link itself, the same role `scripts/gdex-ping.mjs` plays. It is not run in CI, because it needs credentials.

- [ ] **Step 1: Write the script**

Create `scripts/citylink-ping.mjs`:

```js
#!/usr/bin/env node
/**
 * Talk to City-Link's test server without the app in the way.
 *
 *   pnpm citylink:ping                     token only
 *   pnpm citylink:ping 06039900998373      token + track that HAWB
 *   CITYLINK_PING_BOOK=1 pnpm citylink:ping   token + one test shipment
 *
 * The booking mode exists because the guide prints no sample request body:
 * `shipmentBody` in adapters/citylink.ts nests each field group as an object
 * and sends GenerateLabel as 1, and only City-Link can say whether that is
 * right. A return code of 21, 42, 65 or 80 ("… information required") means
 * the nesting is wrong. Test server only — never point this at live.
 */

const BASE =
 "https://devsvr2019a.citylinkexpress.com:21145/CitylinkService.svc/rest";

const creds = {
 CompanyCode: process.env.CITYLINK_COMPANY_CODE ?? "",
 AccountNumber: process.env.CITYLINK_ACCOUNT_NUMBER ?? "",
 MeterNumber: process.env.CITYLINK_METER_NUMBER ?? "",
};

if (Object.values(creds).some((v) => v === "")) {
 console.error(
  "Set CITYLINK_COMPANY_CODE, CITYLINK_ACCOUNT_NUMBER and CITYLINK_METER_NUMBER in .env.local",
 );
 process.exit(1);
}

async function post(operation, { token, body } = {}) {
 const response = await fetch(`${BASE}/${operation}`, {
  method: "POST",
  headers: {
   "content-type": "application/json",
   ...creds,
   TransactionIdentifier: crypto.randomUUID(),
   ...(token ? { Token: token } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
  signal: AbortSignal.timeout(15_000),
 });
 const text = await response.text();
 console.log(`\n${operation} → HTTP ${response.status}`);
 console.log(text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
 try {
  return JSON.parse(text);
 } catch {
  return null;
 }
}

const token = (await post("requestToken"))?.token;
if (!token) {
 console.error("\nNo token — check the three credentials with City-Link.");
 process.exit(1);
}

const hawb = process.argv[2];
if (hawb) {
 await post("trackShipment", {
  token,
  body: { hawbtype: "True", hawbvalue: hawb },
 });
}

if (process.env.CITYLINK_PING_BOOK === "1") {
 const tomorrow = new Date(Date.now() + 86_400_000);
 const day = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
 })
  .format(tomorrow)
  .replaceAll("-", "");
 const reply = await post("requestShipment", {
  token,
  body: {
   ServiceType: "EXP",
   PackageType: "SPX",
   Weight: 1,
   WeightUnits: "KG",
   CurrencyCode: "MYR",
   DeclaredValue: "0.00",
   Shipper: {
    ContactPerson: "EzCabinet Sdn Bhd",
    Name: "EzCabinet Sdn Bhd",
    Tel: "60312345678",
    AddressLine1: "Test pickup — please ignore",
    AddressLine2: "43800 Dengkil",
    City: "Dengkil",
    State: "Selangor",
    PostCode: "43800",
    CountryCode: "MY",
   },
   Consignee: {
    ContactPerson: "Test Receiver",
    Name: "Test Receiver",
    Tel: "60123456789",
    AddressType: "M",
    AddressLine1: "Test delivery — please ignore",
    AddressLine2: "50450 Kuala Lumpur",
    City: "Kuala Lumpur",
    State: "Kuala Lumpur",
    PostCode: "50450",
    CountryCode: "MY",
   },
   Dimensions: { Length: 30, Width: 20, Height: 10, Units: "CM" },
   Label: { GenerateLabel: 1, Type: "A4" },
   MultiPiece: { NumberPieces: 1 },
   ShipmentContent: { Description: "Sandbox verification" },
   Reference: { XR: "ICB-PING" },
   ServiceInfo: { business_type: "1", schedule_pickup_date: day },
  },
 });
 if (reply?.returncode === "00") {
  console.log(
   `\nBooked ${reply.hawbNo}; label ${reply.label ? `${reply.label.length} base64 chars` : "absent"}. Re-run with that HAWB to see tracking.`,
  );
 }
}
```

- [ ] **Step 2: Add the script entry**

In `package.json` `scripts`, after `"gdex:ping"`, add:

```json
  "citylink:ping": "node --env-file=.env.local scripts/citylink-ping.mjs",
```

- [ ] **Step 3: Verify it fails cleanly without credentials**

Run: `CITYLINK_COMPANY_CODE= node scripts/citylink-ping.mjs; echo "exit $?"`
Expected: `Set CITYLINK_COMPANY_CODE, …` then `exit 1`. No network call is made.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/citylink-ping.mjs package.json
git commit -m "chore(logistics): add citylink:ping to check City-Link's real API shape"
```

- [ ] **Step 6 (once credentials arrive, not part of this plan's completion): verify against City-Link**

Run: `CITYLINK_PING_BOOK=1 pnpm citylink:ping`
Expected: `requestShipment → HTTP 200` with `"returncode":"00"`. If the return code is 21/42/65/80 or 81/82, fix the nesting or `GenerateLabel` in **both** `shipmentBody` and this script, and correct the adapter tests to match.
