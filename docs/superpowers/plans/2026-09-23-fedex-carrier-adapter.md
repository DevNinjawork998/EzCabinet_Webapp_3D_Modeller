# FedEx Carrier Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add FedEx as a domestic Malaysian parcel partner that quotes, books (shipment + collection), tracks and cancels through the existing `CarrierAdapter` contract.

**Architecture:** One new adapter file, `src/lib/logistics/adapters/fedex.ts`, shaped like `adapters/gdex.ts`: pure body builders that refuse a job before any network call, a thin `call()` over the shared `carrierFetch`, and zod readers for every reply. The label-capture path that is GDEX-only today moves to a shared `label.ts` so both carriers use it. The pickup details a cancel needs ride inside the booking event's existing `raw` JSON, so there is no migration.

**Tech Stack:** Next.js route handlers, TypeScript, zod, Vitest, `@vercel/blob` (private), Prisma.

**Spec:** `docs/superpowers/specs/2026-09-22-fedex-carrier-adapter-design.md`

## Global Constraints

- Domestic Malaysia only: `countryCode: "MY"` on every address. No customs fields.
- Environment: `FEDEX_API_KEY`, `FEDEX_API_PASSWORD`, `FEDEX_ACCOUNT_NUMBER`, `FEDEX_API_URL`. Unset `FEDEX_API_URL` means `https://apis-sandbox.fedex.com`.
- `isConfigured()` is true only when key, password **and** account number are set.
- Preferred service `FEDEX_PRIORITY`; `packagingType: "YOUR_PACKAGING"`; max **68 kg** per package; max **30** `requestedPackageLineItems`; postcodes must match `^\d{5}$`.
- A quote whose currency is not `MYR` is refused, never shown as RM.
- The Ship create call is **never retried** (`idempotent: false`). Only a 401 re-sends it, after refreshing the token, because a 401 means the operation never ran.
- A booking is all-or-nothing: if the pickup cannot be booked, the shipment is cancelled and the booking throws.
- The label blob is `access: "private"` at `logistics/<carrierId>/<trackingNumber>.pdf`; GDEX's existing paths must not change.
- Our bearer token is only ever sent to a `*.fedex.com` host.
- No Prisma migration.
- Test command: `pnpm vitest run <file>`; full gates: `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- Commit messages end with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX
  ```

### What the sandbox can and cannot tell you

FedEx's sandbox answers **only its own canned inputs**. Any request that differs from a documented example (a city, a second package, `CONTACT_FEDEX_TO_SCHEDULE`) returns `SERVICE.PACKAGECOMBINATION.INVALID`, and the canned Malaysian rates come back in **USD**. Tracking returns random canned results (mock `918408715227` answered as a Spanish-language `DE`). So:

- Unit tests use fixtures built from the **structure** of real sandbox replies and the OpenAPI schemas; they cannot prove FedEx accepts our bodies.
- `scripts/fedex-ping.mjs` (Task 6) is the only check against FedEx's real behaviour, and it is only meaningful against production.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/lib/logistics/status.ts` | + `fedex` status table |
| `src/lib/logistics/label.ts` (new) | label blob path + which carriers capture a label, isomorphic |
| `src/lib/logistics/adapters/gdex.ts` | uses `label.ts` instead of its own `labelPathname` |
| `src/app/api/admin/deliveries/[id]/label/route.ts` | serves any carrier in `LABEL_FALLBACK` |
| `src/app/admin/logistics/DeliveryDetail.tsx` | missing-label warning for any capturing carrier |
| `src/lib/logistics/types.ts` | `CarrierBooking.pickupRef`, `CarrierBooking.note` |
| `src/app/api/admin/deliveries/[id]/book/route.ts` | appends `booking.note` to the booking event message |
| `src/lib/logistics/adapters/fedex.ts` (new) | the adapter |
| `src/lib/logistics/__tests__/fedex.test.ts` (new) | adapter tests |
| `src/lib/logistics/__tests__/fixtures/fedex.ts` (new) | reply fixtures |
| `src/lib/logistics/carriers.ts` | FedEx entry, `WORKSHOP_CLOSE_TIME` |
| `src/lib/logistics/registry.ts` | register `fedexAdapter` |
| `scripts/fedex-ping.mjs` (new), `package.json` | live shape check |
| `CLAUDE.md` | directory note, known issue, open question |

---

### Task 1: FedEx status table

**Files:**
- Modify: `src/lib/logistics/status.ts` (the `CARRIER_STATUS_MAPS` object, after the `gdex` table)
- Test: `src/lib/logistics/__tests__/status.test.ts`

**Interfaces:**
- Produces: `mapCarrierStatus("fedex", code)` → `DeliveryStatusName | null`, used by Task 5.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/logistics/__tests__/status.test.ts`:

```ts
describe("fedex status table", () => {
	it.each([
		["OC", "BOOKED"],
		["PD", "BOOKED"],
		["DS", "BOOKED"],
		["PU", "PICKED_UP"],
		["DO", "PICKED_UP"],
		["IP", "PICKED_UP"],
		["IT", "IN_TRANSIT"],
		["AR", "IN_TRANSIT"],
		["AF", "IN_TRANSIT"],
		["DP", "IN_TRANSIT"],
		["TR", "IN_TRANSIT"],
		["OD", "IN_TRANSIT"],
		["DL", "DELIVERED"],
		["RS", "FAILED"],
		["CA", "CANCELLED"],
	])("maps %s to %s", (code, status) => {
		expect(mapCarrierStatus("fedex", code)).toBe(status);
	});

	it.each(["DE", "DD", "SE", "HP"])(
		"leaves the exception %s unmapped, so the row stays where it is",
		(code) => {
			expect(mapCarrierStatus("fedex", code)).toBeNull();
		},
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts`
Expected: FAIL — `maps OC to BOOKED` receives `null`.

- [ ] **Step 3: Add the table**

In `src/lib/logistics/status.ts`, inside `CARRIER_STATUS_MAPS`, directly after the closing `},` of the `gdex` table:

```ts
	/**
	 * FedEx event codes (`latestStatusDetail.derivedCode`), from the API
	 * reference guide's "Tracking Event Codes" tables.
	 *
	 * Keyed on the two-letter code, not the description: the description is
	 * localised — the sandbox answered `DL` as "Entregado" — and the code is
	 * the stable half, the same reasoning as EasyParcel's numeric table.
	 *
	 * `DE`, `DD` and `SE` are exceptions, not steps along the route, and stay
	 * unmapped: an exception can resolve into a delivery, and reading it as
	 * `FAILED` would stop the poll on a parcel that is still moving. `RS`
	 * ("returning package to shipper") is the one that means somebody has to
	 * phone the customer.
	 */
	fedex: {
		oc: "BOOKED",
		pd: "BOOKED",
		ds: "BOOKED",
		pu: "PICKED_UP",
		do: "PICKED_UP",
		ip: "PICKED_UP",
		it: "IN_TRANSIT",
		ar: "IN_TRANSIT",
		af: "IN_TRANSIT",
		dp: "IN_TRANSIT",
		tr: "IN_TRANSIT",
		od: "IN_TRANSIT",
		dl: "DELIVERED",
		rs: "FAILED",
		ca: "CANCELLED",
	},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/logistics/__tests__/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/status.ts src/lib/logistics/__tests__/status.test.ts
git commit -m "feat(logistics): translate FedEx tracking codes into ours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX"
```

---

### Task 2: Label capture for any carrier

**Files:**
- Create: `src/lib/logistics/label.ts`
- Create: `src/lib/logistics/__tests__/label.test.ts`
- Modify: `src/lib/logistics/adapters/gdex.ts` (delete `labelPathname`, import it from `../label`, update the one call site in `storeLabel`)
- Modify: `src/lib/logistics/__tests__/gdex.test.ts` (drop `labelPathname` from the gdex import and delete its `describe("labelPathname")` block, which moves to `label.test.ts`)
- Modify: `src/app/api/admin/deliveries/[id]/label/route.ts`
- Modify: `src/app/admin/logistics/DeliveryDetail.tsx` (~line 1287)

**Interfaces:**
- Produces: `labelPathname(carrierId: string, trackingNumber: string): string` and `LABEL_FALLBACK: Record<string, string>` from `src/lib/logistics/label.ts`. Task 4 calls `labelPathname("fedex", n)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/logistics/__tests__/label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LABEL_FALLBACK, labelPathname } from "../label";

describe("labelPathname", () => {
	it("keeps GDEX's existing path, so no stored label moves", () => {
		expect(labelPathname("gdex", "MY1700012345")).toBe(
			"logistics/gdex/MY1700012345.pdf",
		);
	});

	it("files each carrier under its own folder", () => {
		expect(labelPathname("fedex", "794953535000")).toBe(
			"logistics/fedex/794953535000.pdf",
		);
	});
});

describe("LABEL_FALLBACK", () => {
	it("names the carriers whose label we capture, and only those", () => {
		expect(Object.keys(LABEL_FALLBACK).sort()).toEqual(["fedex", "gdex"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/label.test.ts`
Expected: FAIL — cannot resolve `../label`.

- [ ] **Step 3: Create `label.ts`**

Create `src/lib/logistics/label.ts`:

```ts
/**
 * Where a captured shipping label lives, and which carriers have one.
 *
 * Isomorphic on purpose: the admin page reads `LABEL_FALLBACK` to word its
 * warning, and the label route reads it to decide what it will serve. Nothing
 * secret belongs here.
 */

/**
 * Carriers whose label we fetch at booking time and serve from
 * `/api/admin/deliveries/[id]/label`, mapped to where an admin prints it when
 * that capture failed. EasyParcel is absent on purpose: it hands back its own
 * AWB link, which goes straight into `labelUrl`.
 */
export const LABEL_FALLBACK: Record<string, string> = {
	gdex: "Print it from the GDEX portal — GDEX only serves the PDF while the shipment is pending.",
	fedex: "Print it from FedEx Ship Manager.",
};

/**
 * The private blob path of a carrier's label.
 *
 * Derived from the tracking number already on the row as `carrierOrderId`, so
 * no column stores it. Private because the label carries the customer's name,
 * phone and home address, and a tracking number is guessable enough that a
 * public object would be a disclosure waiting to happen.
 */
export function labelPathname(
	carrierId: string,
	trackingNumber: string,
): string {
	return `logistics/${carrierId}/${trackingNumber}.pdf`;
}
```

- [ ] **Step 4: Point GDEX at it**

In `src/lib/logistics/adapters/gdex.ts`:

1. Delete the whole `labelPathname` function and its docblock (the block starting `* The consignment number is already on the delivery row as \`carrierOrderId\`` and ending `return \`logistics/gdex/${consignmentNumber}.pdf\`;` `}`).
2. Add to the imports: `import { labelPathname } from "../label";`
3. In `storeLabel`, change `await put(labelPathname(consignmentNumber), …` to `await put(labelPathname("gdex", consignmentNumber), …`.

In `src/lib/logistics/__tests__/gdex.test.ts`:

1. Remove `labelPathname,` from the `from "../adapters/gdex"` import list.
2. Delete the `describe("labelPathname", () => { … });` block (it is covered by `label.test.ts`).
3. If any other test in the file calls `labelPathname(`, change it to `labelPathname("gdex", …)` and add `import { labelPathname } from "../label";`.

- [ ] **Step 5: Generalise the label route**

In `src/app/api/admin/deliveries/[id]/label/route.ts`:

Replace `import { labelPathname } from "@/lib/logistics/adapters/gdex";` with:

```ts
import { LABEL_FALLBACK, labelPathname } from "@/lib/logistics/label";
```

Replace the guard

```ts
		if (
			!delivery ||
			delivery.carrierId !== "gdex" ||
			delivery.carrierOrderId === null
		) {
```

with

```ts
		if (
			!delivery ||
			delivery.carrierId === null ||
			!(delivery.carrierId in LABEL_FALLBACK) ||
			delivery.carrierOrderId === null
		) {
```

and the blob lookup `get(labelPathname(delivery.carrierOrderId), {` with `get(labelPathname(delivery.carrierId, delivery.carrierOrderId), {`.

In the route's docblock, change the paragraph beginning "GDEX only serves the PDF while a shipment is pending" to:

```ts
 * Reads the copy taken at booking time, for every carrier in
 * `LABEL_FALLBACK`. GDEX only serves its PDF while a shipment is pending, and
 * FedEx's label link is not ours to rely on later. A 404 here means that
 * capture failed — the label is still printable from the carrier's own portal.
```

- [ ] **Step 6: Generalise the missing-label warning**

In `src/app/admin/logistics/DeliveryDetail.tsx`, add `import { LABEL_FALLBACK } from "@/lib/logistics/label";` beside the other `@/lib/logistics` imports, then replace

```tsx
									{delivery.carrierId === "gdex" &&
										delivery.labelUrl === null && (
											<p className={`${WARN} text-[12px] leading-[18px]`}>
												The consignment note was not captured when this job was
												booked, so it cannot be shown here. Print it from the
												GDEX portal — GDEX only serves the PDF while the
												shipment is pending.
											</p>
										)}
```

with

```tsx
									{delivery.carrierId !== null &&
										delivery.carrierId in LABEL_FALLBACK &&
										delivery.labelUrl === null && (
											<p className={`${WARN} text-[12px] leading-[18px]`}>
												The consignment note was not captured when this job was
												booked, so it cannot be shown here.{" "}
												{LABEL_FALLBACK[delivery.carrierId]}
											</p>
										)}
```

(If the `delivery` type there has `carrierId: string | null` under another name, keep the null check; `in` on `null` throws.)

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run src/lib/logistics/__tests__/label.test.ts src/lib/logistics/__tests__/gdex.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/logistics/label.ts src/lib/logistics/__tests__/label.test.ts src/lib/logistics/adapters/gdex.ts src/lib/logistics/__tests__/gdex.test.ts "src/app/api/admin/deliveries/[id]/label/route.ts" src/app/admin/logistics/DeliveryDetail.tsx
git commit -m "refactor(logistics): serve captured labels for any carrier, not only GDEX

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX"
```

---

### Task 3: FedEx adapter — configuration, token, refusals, quote

**Files:**
- Create: `src/lib/logistics/adapters/fedex.ts`
- Create: `src/lib/logistics/__tests__/fixtures/fedex.ts`
- Create: `src/lib/logistics/__tests__/fedex.test.ts`

**Interfaces:**
- Consumes: `carrierFetch`, `CarrierHttpError` (`../http`); `pickupPlace`, `WORKSHOP_ADDRESS` (`../carriers`); `kualaLumpur(at: Date): { date: string; time: string }` (`./gdex`); `CarrierNotConfigured`, `CarrierQuote`, `DeliveryJob` (`../types`); `trace` (`../trace`).
- Produces (used by Tasks 4–6): `FedexNotDeliverable`, `SANDBOX`, `SERVICE`, `COUNTRY`, `MAX_PACKAGE_KG`, `MAX_LINE_ITEMS`, `fedexConfigured(): boolean`, `forgetFedexToken(): void`, `packagesOf(job): FedexPackage[]`, `sitePlaceOf(job): Place`, `pickupPlaceOf(job): Place`, `pickupDate(job): string`, `rateBody(job, account)`, `chooseRate(payload): FedexRate`, `fedexQuote(job): Promise<CarrierQuote>`, and module-internal `ACCOUNT()`, `accessToken()`, `call(method, path, body, idempotent?)`, `readReply(schema, payload, what)`, `addressOf(place)`.

- [ ] **Step 1: Create the fixtures**

Create `src/lib/logistics/__tests__/fixtures/fedex.ts`:

```ts
/**
 * FedEx replies, trimmed to the fields the adapter reads.
 *
 * The *structure* is FedEx's own: the rate and track shapes were captured
 * from the sandbox on 2026-09-23, the ship, pickup and cancel shapes come
 * from the OpenAPI files the developer portal serves. The *values* are ours —
 * the sandbox answers only canned inputs, in USD, so its numbers prove
 * nothing about a Malaysian lane.
 */

export const tokenReply = {
	access_token: "tok_test",
	token_type: "bearer",
	expires_in: 3599,
	scope: "CXS-TP",
};

const rated = (serviceType: string, amount: number, currency = "MYR") => ({
	serviceType,
	serviceName: serviceType.replaceAll("_", " "),
	packagingType: "YOUR_PACKAGING",
	ratedShipmentDetails: [
		{
			rateType: "ACCOUNT",
			ratedWeightMethod: "ACTUAL",
			totalBaseCharge: amount,
			totalNetCharge: amount,
			totalNetFedExCharge: amount,
			currency,
		},
	],
});

export const rateReply = {
	transactionId: "5d885ab5-9506-4949-8299-ef5e7e4f9c41",
	output: {
		rateReplyDetails: [
			rated("FEDEX_PRIORITY_EXPRESS_FREIGHT", 410.5),
			rated("FEDEX_PRIORITY", 38.4),
		],
	},
};

export const rateReplyWithoutPriority = {
	output: {
		rateReplyDetails: [
			rated("FEDEX_INTERNATIONAL_PRIORITY", 251.98),
			rated("INTERNATIONAL_ECONOMY", 247.13),
		],
	},
};

export const rateReplyInUsd = {
	output: { rateReplyDetails: [rated("FEDEX_PRIORITY", 9.1, "USD")] },
};

export const rateReplyEmpty = { output: { rateReplyDetails: [] } };

export const shipReply = {
	transactionId: "t-ship",
	output: {
		transactionShipments: [
			{
				serviceType: "FEDEX_PRIORITY",
				masterTrackingNumber: "794953535000",
				shipmentDocuments: [
					{
						contentType: "MERGED_LABELS_ONLY",
						url: "https://wwwtest.fedex.com/document/v1/cache/merged.pdf",
					},
				],
				pieceResponses: [
					{
						trackingNumber: "794953535000",
						packageDocuments: [
							{
								contentType: "LABEL",
								url: "https://wwwtest.fedex.com/document/v1/cache/piece1.pdf",
							},
						],
					},
				],
			},
		],
	},
};

export const pickupReply = {
	transactionId: "t-pickup",
	output: { pickupConfirmationCode: "3001", location: "KULA" },
};

export const cancelShipmentReply = {
	transactionId: "t-cancel",
	output: { cancelledShipment: true, cancelledHistory: true },
};

export const cancelPickupReply = {
	transactionId: "t-cancel-pickup",
	output: {
		pickupConfirmationCode: "3001",
		cancelConfirmationMessage: "Requested pickup has been cancelled Successfully.",
	},
};

const tracked = (
	trackingNumber: string,
	latest: { code: string; derivedCode: string; description: string } | null,
	error?: { code: string; message: string },
) => ({
	trackingNumber,
	trackResults: [
		{
			trackingNumberInfo: { trackingNumber },
			latestStatusDetail: latest,
			...(error ? { error } : {}),
		},
	],
});

export const trackReply = (
	trackingNumber: string,
	code: string,
	description = code,
) => ({
	transactionId: "t-track",
	output: {
		completeTrackResults: [
			tracked(trackingNumber, { code, derivedCode: code, description }),
		],
	},
});

export const trackReplyNotFound = (trackingNumber: string) => ({
	transactionId: "t-track",
	output: {
		completeTrackResults: [
			tracked(trackingNumber, null, {
				code: "TRACKING.TRACKINGNUMBER.NOTFOUND",
				message: "Tracking number cannot be found.",
			}),
		],
	},
});

export const unauthorised = {
	transactionId: "t-401",
	errors: [{ code: "NOT.AUTHORIZED.ERROR", message: "Access token expired." }],
};
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/logistics/__tests__/fedex.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]) => ({ pathname: "p" })),
);
vi.mock("@vercel/blob", () => ({ put }));

const findMany = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));
vi.mock("@/lib/catalogue/db", () => ({
	prisma: { deliveryEvent: { findMany } },
}));

import {
	chooseRate,
	FedexNotDeliverable,
	fedexConfigured,
	fedexQuote,
	forgetFedexToken,
	MAX_LINE_ITEMS,
	packagesOf,
	pickupDate,
	pickupPlaceOf,
	rateBody,
	SANDBOX,
	sitePlaceOf,
} from "../adapters/fedex";
import { WORKSHOP_ADDRESS } from "../carriers";
import {
	CarrierNotConfigured,
	type DeliveryItem,
	type DeliveryJob,
} from "../types";
import {
	rateReply,
	rateReplyEmpty,
	rateReplyInUsd,
	rateReplyWithoutPriority,
	tokenReply,
	unauthorised,
} from "./fixtures/fedex";

/**
 * Pinned so `job()`'s date stays in the future: the GDEX suite went red on a
 * calendar page turning, and this one should not.
 */
beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date("2026-09-22T02:00:00.000Z"));
	vi.stubEnv("FEDEX_API_KEY", "key_test");
	vi.stubEnv("FEDEX_API_PASSWORD", "secret_test");
	vi.stubEnv("FEDEX_ACCOUNT_NUMBER", "740561073");
	vi.stubEnv("FEDEX_API_URL", "");
	forgetFedexToken();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	put.mockClear();
	findMany.mockReset();
	findMany.mockResolvedValue([]);
});

const handles: DeliveryItem = {
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
	pickupPostcode: null,
	pickupCity: null,
	pickupState: null,
	addressNotes: "Guard house, ask for block C",
	pickupAddress: WORKSHOP_ADDRESS,
	siteLat: null,
	siteLng: null,
	pickupLat: null,
	pickupLng: null,
	items: [handles],
	totalWeightKg: 3,
	totalVolumeM3: 0.005,
	scheduledAt: new Date("2026-09-24T01:00:00.000Z"),
	...over,
});

/** One queued Response per fetch, in order. */
function stubFetch(...replies: Array<{ status?: number; body: unknown }>) {
	const fetchMock = vi.fn();
	for (const { status = 200, body } of replies) {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const ok = (body: unknown) => ({ body });
const sent = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
	JSON.parse(fetchMock.mock.calls[call][1].body as string);

describe("fedexConfigured", () => {
	it("needs the key, the password and the account number", () => {
		expect(fedexConfigured()).toBe(true);
		vi.stubEnv("FEDEX_ACCOUNT_NUMBER", "");
		expect(fedexConfigured()).toBe(false);
	});
});

describe("packagesOf", () => {
	it("sends one line item per row, qty as the package count, in kg and cm", () => {
		expect(packagesOf(job())).toEqual([
			{
				groupPackageCount: 2,
				weight: { units: "KG", value: 1.5 },
				dimensions: { length: 8, width: 30, height: 10, units: "CM" },
			},
		]);
	});

	it("rounds millimetres up to whole centimetres, never down", () => {
		const [pkg] = packagesOf(
			job({ items: [{ ...handles, widthMm: 301, heightMm: 99, depthMm: 5 }] }),
		);
		expect(pkg.dimensions).toEqual({
			length: 1,
			width: 31,
			height: 10,
			units: "CM",
		});
	});

	it("refuses a job with nothing in it", () => {
		expect(() => packagesOf(job({ items: [] }))).toThrow(FedexNotDeliverable);
	});

	it("refuses an unweighed row rather than guessing", () => {
		expect(() =>
			packagesOf(job({ items: [{ ...handles, weightKg: null }] })),
		).toThrow(/Handle set has no weight/);
	});

	it("refuses a box over 68 kg", () => {
		expect(() =>
			packagesOf(job({ items: [{ ...handles, weightKg: 70 }] })),
		).toThrow(/at most 68 kg/);
	});

	it("refuses more rows than FedEx takes on one shipment", () => {
		const items = Array.from({ length: MAX_LINE_ITEMS + 1 }, () => handles);
		expect(() => packagesOf(job({ items }))).toThrow(/at most 30/);
	});
});

describe("places", () => {
	it("reads the site postcode and town off the job", () => {
		expect(sitePlaceOf(job())).toEqual({ postcode: "11950", city: "Bayan Baru" });
	});

	it("refuses a site without a five-digit postcode", () => {
		expect(() => sitePlaceOf(job({ sitePostcode: null }))).toThrow(
			FedexNotDeliverable,
		);
		expect(() => sitePlaceOf(job({ sitePostcode: "1195" }))).toThrow(
			/five-digit postcode \(1195\)/,
		);
	});

	it("falls back to the workshop's postcode for a workshop pickup", () => {
		expect(pickupPlaceOf(job())).toEqual({ postcode: "43800", city: "Dengkil" });
	});

	it("refuses an edited pickup that was never geocoded", () => {
		expect(() =>
			pickupPlaceOf(job({ pickupAddress: "Lot 5, Jalan Kilang, Shah Alam" })),
		).toThrow(/pickup address has no five-digit postcode/);
	});
});

describe("pickupDate", () => {
	it("is the scheduled day in Malaysian time", () => {
		// 2026-09-23T17:00Z is 01:00 on the 24th in Kuala Lumpur.
		expect(
			pickupDate(job({ scheduledAt: new Date("2026-09-23T17:00:00.000Z") })),
		).toBe("2026-09-24");
	});

	it("refuses a job with no scheduled date", () => {
		expect(() => pickupDate(job({ scheduledAt: null }))).toThrow(
			/no scheduled date/,
		);
	});

	it("refuses a day that has gone", () => {
		expect(() =>
			pickupDate(job({ scheduledAt: new Date("2026-09-20T01:00:00.000Z") })),
		).toThrow(/which is past/);
	});
});

describe("rateBody", () => {
	it("asks for account rates in ringgit, collected from the workshop", () => {
		expect(rateBody(job(), "740561073")).toEqual({
			accountNumber: { value: "740561073" },
			requestedShipment: {
				shipper: {
					address: { postalCode: "43800", city: "Dengkil", countryCode: "MY" },
				},
				recipient: {
					address: {
						postalCode: "11950",
						city: "Bayan Baru",
						countryCode: "MY",
					},
				},
				pickupType: "CONTACT_FEDEX_TO_SCHEDULE",
				packagingType: "YOUR_PACKAGING",
				rateRequestType: ["ACCOUNT"],
				preferredCurrency: "MYR",
				requestedPackageLineItems: packagesOf(job()),
			},
		});
	});

	it("refuses an unschedulable job before anything is priced", () => {
		expect(() => rateBody(job({ scheduledAt: null }), "740561073")).toThrow(
			FedexNotDeliverable,
		);
	});
});

describe("chooseRate", () => {
	it("prefers FedEx Priority, the domestic parcel service", () => {
		expect(chooseRate(rateReply)).toEqual({
			serviceType: "FEDEX_PRIORITY",
			serviceName: "FEDEX PRIORITY",
			priceRm: 38.4,
		});
	});

	it("falls back to the cheapest service when Priority is not offered", () => {
		expect(chooseRate(rateReplyWithoutPriority).serviceType).toBe(
			"INTERNATIONAL_ECONOMY",
		);
	});

	it("refuses a price in any currency but ringgit", () => {
		expect(() => chooseRate(rateReplyInUsd)).toThrow(/USD, not ringgit/);
	});

	it("refuses a reply that priced nothing", () => {
		expect(() => chooseRate(rateReplyEmpty)).toThrow(/priced nothing/);
	});

	it("names the shape it could not read", () => {
		expect(() => chooseRate({ nope: true })).toThrow(
			/FedEx's rate reply was not the shape we expect/,
		);
	});
});

describe("fedexQuote", () => {
	it("gets a token, then prices at the sandbox by default", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		const quote = await fedexQuote(job());

		expect(fetchMock.mock.calls[0][0]).toBe(`${SANDBOX}/oauth/token`);
		expect(fetchMock.mock.calls[0][1].body).toContain(
			"grant_type=client_credentials",
		);
		expect(fetchMock.mock.calls[1][0]).toBe(`${SANDBOX}/rate/v1/rates/quotes`);
		expect(fetchMock.mock.calls[1][1].headers.authorization).toBe(
			"Bearer tok_test",
		);
		expect(sent(fetchMock, 1).requestedShipment.preferredCurrency).toBe("MYR");
		expect(quote).toEqual({
			carrierId: "fedex",
			priceRm: 38.4,
			etaMinutes: null,
			quoteRef: "FEDEX_PRIORITY",
			notes: "Parcel, 3 kg — FEDEX PRIORITY",
		});
	});

	it("uses FEDEX_API_URL when it is set, without a trailing slash", async () => {
		vi.stubEnv("FEDEX_API_URL", "https://apis.fedex.com/");
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		await fedexQuote(job());

		expect(fetchMock.mock.calls[1][0]).toBe(
			"https://apis.fedex.com/rate/v1/rates/quotes",
		);
	});

	it("reuses a live token instead of asking for a new one", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply), ok(rateReply));

		await fedexQuote(job());
		await fedexQuote(job());

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("asks for a fresh token once when FedEx says the old one is dead", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			{ status: 401, body: unauthorised },
			ok({ ...tokenReply, access_token: "tok_fresh" }),
			ok(rateReply),
		);

		const quote = await fedexQuote(job());

		expect(quote.priceRm).toBe(38.4);
		expect(fetchMock.mock.calls[3][1].headers.authorization).toBe(
			"Bearer tok_fresh",
		);
	});

	it("refuses to call at all without an account number", async () => {
		vi.stubEnv("FEDEX_ACCOUNT_NUMBER", "");
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		await expect(fedexQuote(job())).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses an unweighed job before it dials", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		await expect(
			fedexQuote(job({ items: [{ ...handles, weightKg: null }] })),
		).rejects.toBeInstanceOf(FedexNotDeliverable);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/fedex.test.ts`
Expected: FAIL — cannot resolve `../adapters/fedex`.

- [ ] **Step 4: Create the adapter's first half**

Create `src/lib/logistics/adapters/fedex.ts`:

```ts
import "server-only";
import { z } from "zod";
import { pickupPlace } from "../carriers";
import { CarrierHttpError, carrierFetch } from "../http";
import { trace } from "../trace";
import {
	CarrierNotConfigured,
	type CarrierQuote,
	type DeliveryJob,
} from "../types";
import { kualaLumpur } from "./gdex";

/**
 * FedEx — a domestic Malaysian parcel partner, beside GDEX and EasyParcel.
 *
 * Shaped like `gdex.ts` on purpose: it prices by postcode and kilogram, it
 * books the collection as part of the booking, the label is captured to
 * private Blob at booking time, and tracking is the cron poll only. Three
 * things are FedEx's own:
 *
 * - **OAuth client credentials.** A token lasts an hour and there is no user
 *   consent and no refresh token, so it lives in module memory, not a
 *   `CarrierToken` row. A cold start costs one token call.
 * - **Two calls per booking.** The Ship API creates the shipment and the
 *   Pickup API books the collection, and a shipment with no collection must
 *   never be reported as booked — see `fedexBook`.
 * - **The sandbox only answers canned inputs.** Anything that differs from a
 *   documented example comes back `SERVICE.PACKAGECOMBINATION.INVALID`, and
 *   its Malaysian prices are USD. Tests prove our reading of the reply
 *   shapes, not that FedEx accepts our bodies; `scripts/fedex-ping.mjs`
 *   against production is what checks that.
 */

/**
 * A job FedEx cannot be asked about. Separate from `CarrierNotConfigured` for
 * the same reason `GdexNotDeliverable` is: the cause is the job, and the
 * message goes straight onto the comparison row where the admin can act.
 */
export class FedexNotDeliverable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FedexNotDeliverable";
	}
}

/** Unset means the sandbox: a missing variable must never book a billed shipment. */
export const SANDBOX = "https://apis-sandbox.fedex.com";

/** Read per call, not at import, so a test can stub them. */
const BASE = () =>
	(process.env.FEDEX_API_URL ?? "").trim().replace(/\/+$/, "") || SANDBOX;
const KEY = () => process.env.FEDEX_API_KEY ?? "";
const SECRET = () => process.env.FEDEX_API_PASSWORD ?? "";
export const ACCOUNT = () => process.env.FEDEX_ACCOUNT_NUMBER ?? "";

/** All three, because Rate and Ship both refuse a request without the account. */
export function fedexConfigured(): boolean {
	return KEY() !== "" && SECRET() !== "" && ACCOUNT() !== "";
}

export const COUNTRY = "MY";

/**
 * The domestic parcel service. The API reference lists it as "Only Malaysia
 * and Thailand"; the rest of the APAC list is international.
 */
export const SERVICE = "FEDEX_PRIORITY";

/** `YOUR_PACKAGING` on an Express service. */
export const MAX_PACKAGE_KG = 68;

/** `requestedPackageLineItems`: "Maximum occurrences is 30." */
export const MAX_LINE_ITEMS = 30;

const POSTCODE = /^\d{5}$/;

export type Place = { postcode: string; city: string };

export type FedexPackage = {
	groupPackageCount: number;
	weight: { units: "KG"; value: number };
	dimensions: { length: number; width: number; height: number; units: "CM" };
};

export type FedexRate = {
	serviceType: string;
	serviceName: string;
	priceRm: number;
};

/** Same reasoning as GDEX's `readReply`: a ZodError path list explains nothing. */
export function readReply<T>(
	schema: z.ZodType<T>,
	payload: unknown,
	what: string,
): T {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const seen = JSON.stringify(payload) ?? String(payload);
	trace("fedex.unreadable", { what, payload: seen });
	throw new Error(
		`FedEx's ${what} reply was not the shape we expect: ${seen.slice(0, 200)}`,
	);
}

const tokenSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number(),
});

let cached: { token: string; expiresAt: number } | null = null;

/** Tests only: a token cached in one case must not leak into the next. */
export function forgetFedexToken(): void {
	cached = null;
}

/**
 * A bearer token, from memory while it has more than a minute left.
 *
 * `sensitive`: the request body carries the client secret and the reply a
 * live token, and `trace`'s redaction works by key name, not by body.
 */
export async function accessToken(): Promise<string> {
	if (cached && cached.expiresAt > Date.now()) return cached.token;
	const reply = readReply(
		tokenSchema,
		await carrierFetch<unknown>(`${BASE()}/oauth/token`, {
			carrierId: "fedex",
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "client_credentials",
				client_id: KEY(),
				client_secret: SECRET(),
			}).toString(),
			idempotent: true,
			sensitive: true,
		}),
		"token",
	);
	cached = {
		token: reply.access_token,
		expiresAt: Date.now() + (reply.expires_in - 60) * 1000,
	};
	return cached.token;
}

/**
 * Every FedEx operation.
 *
 * A 401 is the one failure that re-sends, even for a booking: it means the
 * token was refused before the operation ran, so the second request is the
 * first one FedEx acts on. Everything else goes through `carrierFetch`'s own
 * rule — retry only what is `idempotent`.
 */
export async function call(
	method: "POST" | "PUT",
	path: string,
	body: unknown,
	idempotent = false,
): Promise<unknown> {
	if (!fedexConfigured()) throw new CarrierNotConfigured("fedex");
	const send = async () =>
		carrierFetch<unknown>(`${BASE()}${path}`, {
			carrierId: "fedex",
			method,
			headers: {
				authorization: `Bearer ${await accessToken()}`,
				"x-locale": "en_US",
			},
			body,
			idempotent,
		});
	try {
		return await send();
	} catch (error) {
		if (error instanceof CarrierHttpError && error.status === 401) {
			cached = null;
			return send();
		}
		throw error;
	}
}

/** Millimetres to whole centimetres, rounded up: a box is never smaller than it is. */
const cm = (mm: number) => Math.ceil(mm / 10);

/**
 * One line item per row, its quantity as the package count. `weightKg` is per
 * unit (see `measure.ts`), which is what FedEx's per-package weight means.
 */
export function packagesOf(job: DeliveryJob): FedexPackage[] {
	if (job.items.length === 0) {
		throw new FedexNotDeliverable("This job has no items to send");
	}
	if (job.items.length > MAX_LINE_ITEMS) {
		trace("fedex.refused", { why: "rows", rows: job.items.length });
		throw new FedexNotDeliverable(
			`This job has ${job.items.length} item rows — FedEx takes at most ${MAX_LINE_ITEMS} on one shipment, so split it`,
		);
	}
	return job.items.map((item) => {
		if (item.weightKg === null || item.weightKg <= 0) {
			throw new FedexNotDeliverable(
				`${item.label} has no weight — FedEx prices by the kilogram, so weigh it and compare again`,
			);
		}
		if (item.weightKg > MAX_PACKAGE_KG) {
			throw new FedexNotDeliverable(
				`${item.label} is ${item.weightKg} kg — FedEx takes at most ${MAX_PACKAGE_KG} kg a box, so send it by lorry`,
			);
		}
		return {
			groupPackageCount: item.qty,
			weight: { units: "KG", value: item.weightKg },
			dimensions: {
				length: cm(item.depthMm),
				width: cm(item.widthMm),
				height: cm(item.heightMm),
				units: "CM",
			},
		};
	});
}

export function sitePlaceOf(job: DeliveryJob): Place {
	const postcode = job.sitePostcode ?? "";
	if (!POSTCODE.test(postcode)) {
		throw new FedexNotDeliverable(
			`The site address has no five-digit postcode${postcode ? ` (${postcode})` : ""} — FedEx prices by postcode, so fix the address and save again`,
		);
	}
	return { postcode, city: job.siteCity ?? "" };
}

/**
 * The pickup's postcode and town, falling back to the workshop's own when the
 * job leaves from the workshop — `pickupPlace` in `carriers.ts` decides that,
 * the same rule EasyParcel prices by.
 */
export function pickupPlaceOf(job: DeliveryJob): Place {
	const place = pickupPlace(job.pickupAddress, {
		postcode: job.pickupPostcode,
		city: job.pickupCity,
		state: job.pickupState,
	});
	const postcode = place?.postcode ?? "";
	if (!POSTCODE.test(postcode)) {
		throw new FedexNotDeliverable(
			`The pickup address has no five-digit postcode${postcode ? ` (${postcode})` : ""} — fix the pickup address and save again`,
		);
	}
	return { postcode, city: place?.city ?? "" };
}

/**
 * The collection day, as `YYYY-MM-DD` in Malaysian time.
 *
 * Checked at quote time as well as booking, for GDEX's reason: a price for a
 * day nobody can collect on is a price the admin cannot act on.
 *
 * ponytail: past-or-not only. FedEx's own window (weekends, holidays, how far
 * ahead) is answered by the Pickup API at booking; call
 * `/pickup/v1/pickups/availabilities` here if those refusals start costing time.
 */
export function pickupDate(job: DeliveryJob): string {
	if (job.scheduledAt === null) {
		throw new FedexNotDeliverable(
			"This job has no scheduled date — FedEx needs a day to collect, so set Scheduled and compare again",
		);
	}
	const day = kualaLumpur(job.scheduledAt).date;
	const today = kualaLumpur(new Date()).date;
	if (day < today) {
		throw new FedexNotDeliverable(
			`This job is scheduled for ${day}, which is past — FedEx cannot collect on a day that has gone, so pick a new date`,
		);
	}
	return day;
}

/** An address as FedEx's rate and ship bodies take it; an unknown town is left out. */
export function addressOf(place: Place) {
	return {
		postalCode: place.postcode,
		...(place.city ? { city: place.city } : {}),
		countryCode: COUNTRY,
	};
}

/**
 * The rate request. `CONTACT_FEDEX_TO_SCHEDULE` because the booking books a
 * collection, and the price should be the one for that, not for a drop-off.
 */
export function rateBody(job: DeliveryJob, account: string) {
	// Called for its refusal: no price for a job nobody can collect.
	pickupDate(job);
	return {
		accountNumber: { value: account },
		requestedShipment: {
			shipper: { address: addressOf(pickupPlaceOf(job)) },
			recipient: { address: addressOf(sitePlaceOf(job)) },
			pickupType: "CONTACT_FEDEX_TO_SCHEDULE",
			packagingType: "YOUR_PACKAGING",
			rateRequestType: ["ACCOUNT"],
			preferredCurrency: "MYR",
			requestedPackageLineItems: packagesOf(job),
		},
	};
}

const rateSchema = z.object({
	output: z.object({
		rateReplyDetails: z.array(
			z.object({
				serviceType: z.string(),
				serviceName: z.string().nullish(),
				ratedShipmentDetails: z
					.array(
						z.object({
							rateType: z.string().nullish(),
							totalNetCharge: z.number(),
							currency: z.string().nullish(),
						}),
					)
					.min(1),
			}),
		),
	}),
});

/**
 * The one price to show: FedEx Priority, else the cheapest service offered.
 *
 * The currency is checked, not assumed. `preferredCurrency` is a request, and
 * the sandbox's Malaysian prices came back in USD — a USD figure on a row
 * labelled RM is a price wrong by four times.
 */
export function chooseRate(payload: unknown): FedexRate {
	const rows = readReply(rateSchema, payload, "rate").output.rateReplyDetails;
	const priced = rows.map((row) => ({
		row,
		detail:
			row.ratedShipmentDetails.find((d) => d.rateType === "ACCOUNT") ??
			row.ratedShipmentDetails[0],
	}));
	if (priced.length === 0) {
		throw new FedexNotDeliverable("FedEx priced nothing for this job");
	}
	const chosen =
		priced.find((p) => p.row.serviceType === SERVICE) ??
		[...priced].sort(
			(a, b) => a.detail.totalNetCharge - b.detail.totalNetCharge,
		)[0];

	const currency = chosen.detail.currency ?? "";
	if (currency !== "MYR") {
		trace("fedex.refused", { why: "currency", currency });
		throw new FedexNotDeliverable(
			`FedEx priced this job in ${currency || "an unstated currency"}, not ringgit — it cannot be shown as RM, so check the account's currency with FedEx`,
		);
	}
	return {
		serviceType: chosen.row.serviceType,
		serviceName: chosen.row.serviceName ?? chosen.row.serviceType,
		priceRm: chosen.detail.totalNetCharge,
	};
}

/**
 * `etaMinutes` stays null: it is a vehicle-partner field, and a parcel
 * transit is days, not minutes.
 */
export async function fedexQuote(job: DeliveryJob): Promise<CarrierQuote> {
	// Built before `call`, so an unweighed job is refused without dialling.
	const body = rateBody(job, ACCOUNT());
	trace("fedex.quote", { deliveryId: job.id, rows: job.items.length });
	const rate = chooseRate(
		await call("POST", "/rate/v1/rates/quotes", body, true),
	);
	const kg =
		Math.round(
			job.items.reduce((sum, i) => sum + i.qty * (i.weightKg ?? 0), 0) * 10,
		) / 10;
	return {
		carrierId: "fedex",
		priceRm: rate.priceRm,
		etaMinutes: null,
		quoteRef: rate.serviceType,
		notes: `Parcel, ${kg} kg — ${rate.serviceName}`,
	};
}
```

Note on `rateBody` when the account is unset: `ACCOUNT()` is `""`, the body is still built so refusals win, and `call` then throws `CarrierNotConfigured` before any fetch. The test "refuses to call at all without an account number" pins that order.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/fedex.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logistics/adapters/fedex.ts src/lib/logistics/__tests__/fedex.test.ts src/lib/logistics/__tests__/fixtures/fedex.ts
git commit -m "feat(logistics): price parcels with FedEx

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX"
```

---

### Task 4: FedEx booking — shipment, collection, label

**Files:**
- Modify: `src/lib/logistics/types.ts` (`CarrierBooking`)
- Modify: `src/app/api/admin/deliveries/[id]/book/route.ts` (the booking event `message`)
- Modify: `src/lib/logistics/adapters/fedex.ts` (append)
- Modify: `src/lib/logistics/carriers.ts` (add `WORKSHOP_CLOSE_TIME` only; the carrier entry is Task 6)
- Test: `src/lib/logistics/__tests__/fedex.test.ts` (append)

**Interfaces:**
- Consumes (Task 3): `call`, `accessToken`, `readReply`, `ACCOUNT`, `addressOf`, `packagesOf`, `pickupPlaceOf`, `sitePlaceOf`, `pickupDate`, `FedexNotDeliverable`, `SERVICE`. (Task 2): `labelPathname`.
- Produces (used by Task 5): `PickupRef = { code: string; date: string; location: string | null }`, `pickupRefSchema`, `cancelShipment(trackingNumber: string): Promise<void>`, `trackingUrlFor(n: string): string`, `fedexBook(job, quote): Promise<CarrierBooking>`. `CarrierBooking` gains `pickupRef?: string | null` and `note?: string | null`.

- [ ] **Step 1: Extend the booking contract**

In `src/lib/logistics/types.ts`, inside `export type CarrierBooking = { … }`, after the `labelUrl?: string | null;` field:

```ts
	/**
	 * Whatever the partner needs later to undo the collection it booked
	 * alongside the shipment. Opaque to everything but its own adapter, and
	 * persisted only inside the booking event's `raw` — FedEx cancels a pickup
	 * by confirmation code, date and depot, none of which is the tracking
	 * number `cancel` is handed.
	 */
	pickupRef?: string | null;
	/** One line for the booking event, e.g. the carrier's pickup confirmation. */
	note?: string | null;
```

In `src/app/api/admin/deliveries/[id]/book/route.ts`, change the event message

```ts
							message: `Booked with ${carrierId}${
								quote.priceRm === null ? "" : ` for RM ${quote.priceRm}`
							}`,
```

to

```ts
							message: `Booked with ${carrierId}${
								quote.priceRm === null ? "" : ` for RM ${quote.priceRm}`
							}${booking.note ? ` — ${booking.note}` : ""}`,
```

In `src/lib/logistics/carriers.ts`, directly after the `WORKSHOP_PHONE` export:

```ts
/**
 * When the workshop stops handing parcels over, as FedEx's pickup request
 * wants it (`customerCloseTime`, `HH:MM:SS`, Malaysian local time).
 *
 * ponytail: a placeholder until the client confirms their hours — the same
 * open question as `WORKSHOP_ADDRESS` and `WORKSHOP_PHONE`. Too early and
 * FedEx refuses a late-afternoon collection; too late and a courier arrives
 * to a locked gate.
 */
export const WORKSHOP_CLOSE_TIME = "18:00:00";
```

- [ ] **Step 2: Write the failing tests**

In `src/lib/logistics/__tests__/fedex.test.ts`, extend the `../adapters/fedex` import with `fedexBook, pickupBody, shipBody, streetLines, trackingUrlFor,` and the fixtures import with `cancelShipmentReply, pickupReply, shipReply,`. Then append:

```ts
describe("streetLines", () => {
	it("wraps an address into lines of at most 35 characters", () => {
		const lines = streetLines(
			"No. 45, Persiaran Mahsuri 1/3, 11950 Bayan Baru, Pulau Pinang",
		);
		expect(lines).toEqual([
			"No. 45, Persiaran Mahsuri 1/3,",
			"11950 Bayan Baru, Pulau Pinang",
		]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(35);
	});

	it("keeps three lines at most, which is all FedEx reads", () => {
		const long =
			"Lot 1234, Jalan Perindustrian Bukit Minyak 7, Kawasan Perindustrian Bukit Minyak, Mukim 13, 14100 Simpang Ampat, Seberang Perai Tengah, Pulau Pinang";
		expect(streetLines(long)).toHaveLength(3);
	});
});

describe("shipBody", () => {
	it("books the priced service, paid by us, labels merged into one PDF", () => {
		const body = shipBody(job(), "740561073", "FEDEX_PRIORITY");

		expect(body.accountNumber).toEqual({ value: "740561073" });
		expect(body.labelResponseOptions).toBe("URL_ONLY");
		expect(body.mergeLabelDocOption).toBe("LABELS_ONLY");
		const shipment = body.requestedShipment;
		expect(shipment.serviceType).toBe("FEDEX_PRIORITY");
		expect(shipment.pickupType).toBe("CONTACT_FEDEX_TO_SCHEDULE");
		expect(shipment.packagingType).toBe("YOUR_PACKAGING");
		expect(shipment.shippingChargesPayment).toEqual({ paymentType: "SENDER" });
		expect(shipment.labelSpecification).toEqual({
			imageType: "PDF",
			labelStockType: "PAPER_4X6",
		});
		expect(shipment.shipDatestamp).toBe("2026-09-24");
		expect(shipment.totalWeight).toBe(3);
		expect(shipment.recipients[0]).toEqual({
			contact: { personName: "Chan Kin Kong", phoneNumber: "60123456789" },
			address: {
				streetLines: [
					"No. 45, Persiaran Mahsuri 1/3,",
					"11950 Bayan Baru, Pulau Pinang",
				],
				postalCode: "11950",
				city: "Bayan Baru",
				countryCode: "MY",
			},
		});
		expect(shipment.shipper.contact.companyName).toBe("EzCabinet Sdn Bhd");
	});

	it("refuses a customer number FedEx cannot ring", () => {
		expect(() =>
			shipBody(job({ customerPhone: "+65 6123 4567" }), "740561073", "FEDEX_PRIORITY"),
		).toThrow(/not a Malaysian number FedEx can call/);
	});
});

describe("pickupBody", () => {
	it("asks FedEx Express to collect from the workshop at the scheduled time", () => {
		expect(pickupBody(job(), "740561073")).toEqual({
			associatedAccountNumber: { value: "740561073" },
			originDetail: {
				pickupLocation: {
					contact: {
						companyName: "EzCabinet Sdn Bhd",
						phoneNumber: "60312345678",
					},
					address: {
						streetLines: ["EzCabinet Sdn Bhd, Klang Valley,", "Selangor"],
						postalCode: "43800",
						city: "Dengkil",
						countryCode: "MY",
					},
				},
				readyDateTimestamp: "2026-09-24T01:00:00.000Z",
				customerCloseTime: "18:00:00",
			},
			carrierCode: "FDXE",
		});
	});
});

describe("fedexBook", () => {
	const quote = {
		carrierId: "fedex",
		priceRm: 38.4,
		etaMinutes: null,
		quoteRef: "FEDEX_PRIORITY",
	};
	const pdf = () => ({ status: 200, body: "%PDF-1.4" });

	it("creates the shipment, books the collection and keeps the label", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(shipReply),
			ok(pickupReply),
			pdf(),
		);

		const booking = await fedexBook(job(), quote);

		expect(fetchMock.mock.calls[1][0]).toBe(`${SANDBOX}/ship/v1/shipments`);
		expect(fetchMock.mock.calls[2][0]).toBe(`${SANDBOX}/pickup/v1/pickups`);
		expect(fetchMock.mock.calls[3][0]).toBe(
			"https://wwwtest.fedex.com/document/v1/cache/merged.pdf",
		);
		expect(put.mock.calls[0][0]).toBe("logistics/fedex/794953535000.pdf");
		expect(put.mock.calls[0][2]).toMatchObject({ access: "private" });
		expect(booking).toEqual({
			carrierOrderId: "794953535000",
			trackingUrl: trackingUrlFor("794953535000"),
			labelUrl: "/api/admin/deliveries/dlv_1/label",
			pickupRef: JSON.stringify({
				code: "3001",
				date: "2026-09-24",
				location: "KULA",
			}),
			note: "FedEx collection 3001 on 2026-09-24",
		});
	});

	it("never sends the shipment twice, even on FedEx's own 500", async () => {
		const fetchMock = stubFetch(ok(tokenReply), {
			status: 500,
			body: { errors: [{ code: "INTERNAL.SERVER.ERROR" }] },
		});

		await expect(fedexBook(job(), quote)).rejects.toThrow(/500/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("cancels the shipment when the collection cannot be booked", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(shipReply),
			{
				status: 400,
				body: {
					errors: [
						{ code: "PICKUP.DATE.INVALID", message: "Pickup date is not available" },
					],
				},
			},
			ok(cancelShipmentReply),
		);

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/so the shipment was cancelled: .*Pickup date is not available/,
		);
		expect(fetchMock.mock.calls[3][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
		expect(sent(fetchMock, 3)).toEqual({
			accountNumber: { value: "740561073" },
			trackingNumber: "794953535000",
		});
	});

	it("names the tracking number when neither the pickup nor the undo worked", async () => {
		stubFetch(
			ok(tokenReply),
			ok(shipReply),
			{ status: 400, body: { errors: [{ code: "PICKUP.X", message: "no" }] } },
			{ status: 400, body: { errors: [{ code: "SHIPMENT.X", message: "no" }] } },
		);

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/shipment 794953535000 could not be cancelled .* void it in FedEx Ship Manager/,
		);
	});

	it("still books when the label cannot be fetched", async () => {
		stubFetch(ok(tokenReply), ok(shipReply), ok(pickupReply), {
			status: 404,
			body: {},
		});

		const booking = await fedexBook(job(), quote);

		expect(booking.carrierOrderId).toBe("794953535000");
		expect(booking.labelUrl).toBeNull();
		expect(put).not.toHaveBeenCalled();
	});

	it("never sends our token to a label link off FedEx's domain", async () => {
		const foreign = structuredClone(shipReply);
		foreign.output.transactionShipments[0].shipmentDocuments[0].url =
			"https://example.com/label.pdf";
		const fetchMock = stubFetch(ok(tokenReply), ok(foreign), ok(pickupReply));

		const booking = await fedexBook(job(), quote);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(booking.labelUrl).toBeNull();
	});

	it("refuses an unbookable job before creating anything", async () => {
		const fetchMock = stubFetch(ok(tokenReply));

		await expect(
			fedexBook(job({ scheduledAt: null }), quote),
		).rejects.toBeInstanceOf(FedexNotDeliverable);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
```

(The `pickupBody` expectation of `["EzCabinet Sdn Bhd, Klang Valley,", "Selangor"]` follows from wrapping `WORKSHOP_ADDRESS` at 35 characters by words: "EzCabinet Sdn Bhd, Klang Valley," is 32 characters and adding " Selangor" would make 41.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/fedex.test.ts`
Expected: FAIL — `fedexBook` / `shipBody` / `pickupBody` / `streetLines` / `trackingUrlFor` are not exported.

- [ ] **Step 4: Implement booking**

In `src/lib/logistics/adapters/fedex.ts`:

Add to the imports:

```ts
import { put } from "@vercel/blob";
import { WORKSHOP_CLOSE_TIME, WORKSHOP_PHONE } from "../carriers";
import { labelPathname } from "../label";
import { toE164 } from "../phone";
```

(merge `WORKSHOP_CLOSE_TIME, WORKSHOP_PHONE` into the existing `../carriers` import, and add `type CarrierBooking,` to the `../types` import.)

Append:

```ts
/** The shipper and pickup contact FedEx prints on the label. */
const SHIPPER_NAME = "EzCabinet Sdn Bhd";

/** FedEx reads at most three street lines of 35 characters each. */
const LINE_CHARS = 35;
const MAX_LINES = 3;

/**
 * An address line wrapped at word boundaries into FedEx's street lines.
 *
 * ponytail: anything past the third line is dropped, which is what FedEx does
 * with a fourth line anyway. The postcode and town travel in their own fields,
 * so the courier still has the area; a very long street line is where to look
 * first if one arrives at the wrong door.
 */
export function streetLines(address: string): string[] {
	const lines: string[] = [];
	for (const word of address.replace(/\s+/g, " ").trim().split(" ")) {
		const last = lines.at(-1);
		if (last !== undefined && `${last} ${word}`.length <= LINE_CHARS) {
			lines[lines.length - 1] = `${last} ${word}`;
		} else {
			lines.push(word.slice(0, LINE_CHARS));
		}
	}
	return lines.slice(0, MAX_LINES);
}

/**
 * A number FedEx will dial, as `60123456789` — E.164 without the `+`, inside
 * FedEx's 15-digit limit. Malaysian only, for GDEX's reason: a `+65` number on
 * a domestic parcel is a courier who cannot phone the gate.
 *
 * Unverified against FedEx's Malaysian validation; `fedex-ping` against
 * production is where a refused format would show.
 */
function phoneOrThrow(raw: string, whose: string): string {
	const e164 = toE164(raw);
	if (e164 === null || !e164.startsWith("+60")) {
		throw new FedexNotDeliverable(
			`The ${whose} phone number (${raw}) is not a Malaysian number FedEx can call`,
		);
	}
	return e164.slice(1);
}

const totalKg = (packages: FedexPackage[]) =>
	Math.round(
		packages.reduce((sum, p) => sum + p.groupPackageCount * p.weight.value, 0) *
			10,
	) / 10;

/**
 * The shipment. `URL_ONLY` + `LABELS_ONLY` because that is the only way FedEx
 * returns every package's label merged into one PDF — one file to print, and
 * one blob to keep.
 */
export function shipBody(job: DeliveryJob, account: string, serviceType: string) {
	const packages = packagesOf(job);
	return {
		accountNumber: { value: account },
		labelResponseOptions: "URL_ONLY",
		mergeLabelDocOption: "LABELS_ONLY",
		requestedShipment: {
			shipper: {
				contact: {
					companyName: SHIPPER_NAME,
					phoneNumber: phoneOrThrow(WORKSHOP_PHONE, "workshop's"),
				},
				address: {
					streetLines: streetLines(job.pickupAddress),
					...addressOf(pickupPlaceOf(job)),
				},
			},
			recipients: [
				{
					contact: {
						personName: job.customerName.slice(0, 70),
						phoneNumber: phoneOrThrow(job.customerPhone, "customer's"),
					},
					address: {
						streetLines: streetLines(job.siteAddress),
						...addressOf(sitePlaceOf(job)),
					},
				},
			],
			shipDatestamp: pickupDate(job),
			serviceType,
			packagingType: "YOUR_PACKAGING",
			pickupType: "CONTACT_FEDEX_TO_SCHEDULE",
			shippingChargesPayment: { paymentType: "SENDER" },
			labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6" },
			totalWeight: totalKg(packages),
			requestedPackageLineItems: packages,
		},
	};
}

/**
 * The collection. `readyDateTimestamp` is the scheduled instant as ISO — the
 * format FedEx's own example uses — and `customerCloseTime` the workshop's
 * wall-clock closing time. `FDXE` because `FEDEX_PRIORITY` is an Express
 * service.
 */
export function pickupBody(job: DeliveryJob, account: string) {
	pickupDate(job);
	return {
		associatedAccountNumber: { value: account },
		originDetail: {
			pickupLocation: {
				contact: {
					companyName: SHIPPER_NAME,
					phoneNumber: phoneOrThrow(WORKSHOP_PHONE, "workshop's"),
				},
				address: {
					streetLines: streetLines(job.pickupAddress),
					...addressOf(pickupPlaceOf(job)),
				},
			},
			readyDateTimestamp: (job.scheduledAt as Date).toISOString(),
			customerCloseTime: WORKSHOP_CLOSE_TIME,
		},
		carrierCode: "FDXE",
	};
}

const shipSchema = z.object({
	output: z.object({
		transactionShipments: z
			.array(
				z.object({
					masterTrackingNumber: z.string().nullish(),
					shipmentDocuments: z
						.array(
							z.object({
								contentType: z.string().nullish(),
								url: z.string().nullish(),
							}),
						)
						.nullish(),
					pieceResponses: z
						.array(
							z.object({
								trackingNumber: z.string().nullish(),
								packageDocuments: z
									.array(z.object({ url: z.string().nullish() }))
									.nullish(),
							}),
						)
						.nullish(),
				}),
			)
			.min(1),
	}),
});

const pickupSchema = z.object({
	output: z.object({
		pickupConfirmationCode: z.string().min(1),
		location: z.string().nullish(),
	}),
});

const cancelShipmentSchema = z.object({
	output: z.object({ cancelledShipment: z.boolean() }),
});

export type PickupRef = { code: string; date: string; location: string | null };

export const pickupRefSchema = z.object({
	code: z.string(),
	date: z.string(),
	location: z.string().nullable(),
});

/** FedEx's public tracking page; unlike GDEX, a link we can give the customer. */
export const trackingUrlFor = (trackingNumber: string) =>
	`https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;

/** Idempotent: cancelling a cancelled shipment is a no-op FedEx answers either way. */
export async function cancelShipment(trackingNumber: string): Promise<void> {
	const reply = readReply(
		cancelShipmentSchema,
		await call(
			"PUT",
			"/ship/v1/shipments/cancel",
			{ accountNumber: { value: ACCOUNT() }, trackingNumber },
			true,
		),
		"cancel",
	);
	if (!reply.output.cancelledShipment) {
		throw new Error(`FedEx did not cancel shipment ${trackingNumber}`);
	}
}

/**
 * Fetch the merged label and keep a private copy.
 *
 * Only from a `*.fedex.com` host, because the request carries our bearer
 * token and the URL comes out of a reply. Failure is swallowed for GDEX's
 * reason: the shipment and the collection already exist, so throwing here
 * would report as failed a booking that succeeded.
 */
async function storeLabel(
	trackingNumber: string,
	source: string | null,
): Promise<boolean> {
	if (source === null) return false;
	try {
		const host = new URL(source).hostname;
		if (host !== "fedex.com" && !host.endsWith(".fedex.com")) {
			trace("fedex.label", { trackingNumber, refused: host });
			return false;
		}
		const response = await fetch(source, {
			headers: { authorization: `Bearer ${await accessToken()}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			trace("fedex.label", { trackingNumber, status: response.status });
			return false;
		}
		await put(labelPathname("fedex", trackingNumber), await response.blob(), {
			access: "private",
			addRandomSuffix: false,
			contentType: "application/pdf",
			allowOverwrite: true,
		});
		return true;
	} catch (error) {
		trace("fedex.label", { trackingNumber, error: String(error) });
		return false;
	}
}

/**
 * Shipment, then collection — all or nothing.
 *
 * The shipment call is never retried: a second create is a second shipment
 * and a second charge. If the collection cannot be booked, the shipment is
 * cancelled and the booking throws with FedEx's reason, so the row stays
 * unbooked and the admin sees why. A shipment with no collection is never
 * reported as booked; if even the cancel fails, the error names the tracking
 * number so someone can void it by hand.
 */
export async function fedexBook(
	job: DeliveryJob,
	quote: CarrierQuote,
): Promise<CarrierBooking> {
	const account = ACCOUNT();
	// Both bodies before any call, so every refusal lands before FedEx is dialled.
	const shipment = shipBody(job, account, quote.quoteRef ?? SERVICE);
	const collection = pickupBody(job, account);
	const date = pickupDate(job);
	trace("fedex.book", { deliveryId: job.id });

	const [created] = readReply(
		shipSchema,
		await call("POST", "/ship/v1/shipments", shipment),
		"shipment",
	).output.transactionShipments;
	const trackingNumber =
		created.masterTrackingNumber ?? created.pieceResponses?.[0]?.trackingNumber;
	if (!trackingNumber) {
		throw new Error(
			"FedEx created a shipment but returned no tracking number — check FedEx Ship Manager before booking again",
		);
	}

	let ref: PickupRef;
	try {
		const reply = readReply(
			pickupSchema,
			await call("POST", "/pickup/v1/pickups", collection),
			"pickup",
		);
		ref = {
			code: reply.output.pickupConfirmationCode,
			date,
			location: reply.output.location ?? null,
		};
	} catch (error) {
		const why = (error as Error).message;
		try {
			await cancelShipment(trackingNumber);
		} catch (undo) {
			trace("fedex.orphan", { trackingNumber, error: String(undo) });
			throw new Error(
				`FedEx would not book the collection (${why}), and shipment ${trackingNumber} could not be cancelled (${(undo as Error).message}) — void it in FedEx Ship Manager`,
			);
		}
		throw new Error(
			`FedEx would not book the collection, so the shipment was cancelled: ${why}`,
		);
	}

	const labelSource =
		created.shipmentDocuments?.find((d) => d.contentType === "MERGED_LABELS_ONLY")
			?.url ??
		created.pieceResponses?.[0]?.packageDocuments?.[0]?.url ??
		null;
	const stored = await storeLabel(trackingNumber, labelSource);

	return {
		carrierOrderId: trackingNumber,
		trackingUrl: trackingUrlFor(trackingNumber),
		labelUrl: stored ? `/api/admin/deliveries/${job.id}/label` : null,
		pickupRef: JSON.stringify(ref),
		note: `FedEx collection ${ref.code} on ${ref.date}`,
	};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/fedex.test.ts`
Expected: PASS. If the `pickupBody` street-lines expectation differs, print `streetLines(WORKSHOP_ADDRESS)` and correct the **test** to the wrapped value — the wrapping rule, not the constant, is what is under test.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logistics/types.ts "src/app/api/admin/deliveries/[id]/book/route.ts" src/lib/logistics/carriers.ts src/lib/logistics/adapters/fedex.ts src/lib/logistics/__tests__/fedex.test.ts
git commit -m "feat(logistics): book FedEx shipments with their collection, all or nothing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX"
```

---

### Task 5: FedEx tracking and cancel

**Files:**
- Modify: `src/lib/logistics/adapters/fedex.ts` (append)
- Test: `src/lib/logistics/__tests__/fedex.test.ts` (append)

**Interfaces:**
- Consumes (Tasks 1, 3, 4): `mapCarrierStatus("fedex", code)`, `call`, `readReply`, `ACCOUNT`, `PickupRef`, `pickupRefSchema`, `cancelShipment`, `fedexConfigured`, `fedexQuote`, `fedexBook`.
- Produces (used by Task 6): `fedexAdapter: CarrierAdapter` with `id: "fedex"`; also `readTracking(payload, trackingNumber): TrackingUpdate`, `readPickupRef(raw: unknown): PickupRef | null`, `fedexTrack`, `fedexCancel`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/logistics/__tests__/fedex.test.ts`, extend the `../adapters/fedex` import with `fedexAdapter, fedexCancel, fedexTrack, readPickupRef, readTracking,` and the fixtures import with `cancelPickupReply, trackReply, trackReplyNotFound,`. Then append:

```ts
describe("readTracking", () => {
	it("maps FedEx's code, not its localised description", () => {
		expect(
			readTracking(trackReply("794953535000", "DL", "Entregado"), "794953535000"),
		).toMatchObject({ status: "DELIVERED", message: "FedEx reports Entregado" });
	});

	it("leaves an exception unmapped, so the row stays where it is", () => {
		expect(
			readTracking(trackReply("794953535000", "DE"), "794953535000").status,
		).toBeNull();
	});

	it("reports a number FedEx does not know as no status, not as booked", () => {
		expect(
			readTracking(trackReplyNotFound("794953535000"), "794953535000"),
		).toMatchObject({
			status: null,
			message:
				"FedEx has no tracking for 794953535000 (TRACKING.TRACKINGNUMBER.NOTFOUND)",
		});
	});
});

describe("fedexTrack", () => {
	it("asks for one number, without the scan history", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(trackReply("794953535000", "OD")),
		);

		const update = await fedexTrack("794953535000");

		expect(fetchMock.mock.calls[1][0]).toBe(
			`${SANDBOX}/track/v1/trackingnumbers`,
		);
		expect(sent(fetchMock, 1)).toEqual({
			includeDetailedScans: false,
			trackingInfo: [{ trackingNumberInfo: { trackingNumber: "794953535000" } }],
		});
		expect(update.status).toBe("IN_TRANSIT");
	});
});

describe("readPickupRef", () => {
	const ref = { code: "3001", date: "2026-09-24", location: "KULA" };

	it("reads the collection back out of the booking event", () => {
		expect(readPickupRef({ booking: { pickupRef: JSON.stringify(ref) } })).toEqual(
			ref,
		);
	});

	it("is null for any other event's raw payload", () => {
		expect(readPickupRef(null)).toBeNull();
		expect(readPickupRef({ booking: {} })).toBeNull();
		expect(readPickupRef({ booking: { pickupRef: "not json" } })).toBeNull();
	});
});

describe("fedexCancel", () => {
	const booked = {
		raw: {
			booking: {
				pickupRef: JSON.stringify({
					code: "3001",
					date: "2026-09-24",
					location: "KULA",
				}),
			},
		},
	};

	it("cancels the collection, then the shipment", async () => {
		findMany.mockResolvedValue([booked] as never);
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(cancelPickupReply),
			ok(cancelShipmentReply),
		);

		await fedexCancel("794953535000");

		expect(findMany.mock.calls[0][0]).toMatchObject({
			where: { status: "BOOKED", delivery: { carrierOrderId: "794953535000" } },
		});
		expect(fetchMock.mock.calls[1][0]).toBe(`${SANDBOX}/pickup/v1/pickups/cancel`);
		expect(sent(fetchMock, 1)).toEqual({
			associatedAccountNumber: { value: "740561073" },
			pickupConfirmationCode: "3001",
			scheduledDate: "2026-09-24",
			carrierCode: "FDXE",
			location: "KULA",
		});
		expect(fetchMock.mock.calls[2][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
	});

	it("still cancels the shipment when the collection cannot be cancelled", async () => {
		findMany.mockResolvedValue([booked] as never);
		const fetchMock = stubFetch(
			ok(tokenReply),
			{ status: 400, body: { errors: [{ code: "PICKUP.ALREADY.DONE" }] } },
			ok(cancelShipmentReply),
		);

		await fedexCancel("794953535000");

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("passes FedEx's refusal up when the parcel is already moving", async () => {
		stubFetch(ok(tokenReply), {
			status: 400,
			body: {
				errors: [
					{ code: "SHIPMENT.CANCEL.NOTALLOWED", message: "Shipment already scanned" },
				],
			},
		});

		await expect(fedexCancel("794953535000")).rejects.toThrow(
			/Shipment already scanned/,
		);
	});

	it("cancels just the shipment when no collection was recorded", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(cancelShipmentReply));

		await fedexCancel("794953535000");

		expect(fetchMock.mock.calls[1][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
	});
});

describe("fedexAdapter", () => {
	it("is the parcel adapter the registry hands out", () => {
		expect(fedexAdapter.id).toBe("fedex");
		expect(fedexAdapter.isConfigured()).toBe(true);
		expect(fedexAdapter.quote).toBe(fedexQuote);
		expect(fedexAdapter.book).toBe(fedexBook);
		expect(fedexAdapter.track).toBe(fedexTrack);
		expect(fedexAdapter.cancel).toBe(fedexCancel);
		expect(fedexAdapter.verifyWebhook).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/logistics/__tests__/fedex.test.ts`
Expected: FAIL — `readTracking`, `fedexTrack`, `readPickupRef`, `fedexCancel`, `fedexAdapter` not exported.

- [ ] **Step 3: Implement tracking and cancel**

In `src/lib/logistics/adapters/fedex.ts`, add to the imports:

```ts
import { prisma } from "@/lib/catalogue/db";
import { mapCarrierStatus } from "../status";
```

and add `type CarrierAdapter,` and `type TrackingUpdate,` to the `../types` import. Append:

```ts
const trackSchema = z.object({
	output: z.object({
		completeTrackResults: z.array(
			z.object({
				trackingNumber: z.string(),
				trackResults: z.array(
					z.object({
						latestStatusDetail: z
							.object({
								code: z.string().nullish(),
								derivedCode: z.string().nullish(),
								description: z.string().nullish(),
							})
							.nullish(),
						error: z
							.object({ code: z.string(), message: z.string().nullish() })
							.nullish(),
					}),
				),
			}),
		),
	}),
});

/**
 * One reading of where a shipment is.
 *
 * An unknown number arrives as HTTP 200 with an `error` inside the result, and
 * is reported as no status rather than whatever an empty row would map to —
 * the same trap GDEX's `IsValid` is there for.
 */
export function readTracking(
	payload: unknown,
	trackingNumber: string,
): TrackingUpdate {
	const results = readReply(trackSchema, payload, "tracking").output
		.completeTrackResults;
	const result = (
		results.find((r) => r.trackingNumber === trackingNumber) ?? results[0]
	)?.trackResults[0];

	if (!result || result.error) {
		const code = result?.error ? ` (${result.error.code})` : "";
		trace("fedex.unknown_shipment", { trackingNumber });
		return {
			status: null,
			message: `FedEx has no tracking for ${trackingNumber}${code}`,
			raw: payload,
		};
	}

	const latest = result.latestStatusDetail;
	const code = latest?.derivedCode || latest?.code || "";
	const described = latest?.description || code || "no status";
	return {
		status: code === "" ? null : mapCarrierStatus("fedex", code),
		message: `FedEx reports ${described}`,
		raw: payload,
	};
}

export async function fedexTrack(
	trackingNumber: string,
): Promise<TrackingUpdate> {
	const payload = await call(
		"POST",
		"/track/v1/trackingnumbers",
		{
			includeDetailedScans: false,
			trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
		},
		true,
	);
	return readTracking(payload, trackingNumber);
}

const bookedRawSchema = z.object({
	booking: z.object({ pickupRef: z.string() }),
});

/** The collection `fedexBook` recorded, out of a booking event's `raw`; null for anything else. */
export function readPickupRef(raw: unknown): PickupRef | null {
	const booked = bookedRawSchema.safeParse(raw);
	if (!booked.success) return null;
	try {
		const ref = pickupRefSchema.safeParse(
			JSON.parse(booked.data.booking.pickupRef),
		);
		return ref.success ? ref.data : null;
	} catch {
		return null;
	}
}

/**
 * The newest booking event for this shipment that recorded a collection.
 *
 * Read from the event log rather than a column: `book/route.ts` already
 * writes `raw: { booking, quote }`, so this needs no migration. Promote it to
 * a column if a second partner ever needs the same thing.
 */
async function pickupRefFor(trackingNumber: string): Promise<PickupRef | null> {
	const events = await prisma.deliveryEvent.findMany({
		where: { status: "BOOKED", delivery: { carrierOrderId: trackingNumber } },
		orderBy: { at: "desc" },
		select: { raw: true },
		take: 5,
	});
	for (const event of events) {
		const ref = readPickupRef(event.raw);
		if (ref) return ref;
	}
	return null;
}

/**
 * Collection first, then the shipment.
 *
 * A collection that cannot be cancelled — already done, or the day has passed
 * — does not stop the shipment cancel: whether the parcel is still ours to
 * recall is FedEx's answer to *that* call. Its refusal (the parcel has been
 * scanned) is thrown as FedEx worded it, and `advance/route.ts` already turns
 * it into `carrier_refused_cancel`.
 *
 * ponytail: a collection-cancel failure is traced, not surfaced. If couriers
 * start turning up for cancelled jobs, record it as a delivery event instead.
 */
export async function fedexCancel(trackingNumber: string): Promise<void> {
	const ref = await pickupRefFor(trackingNumber);
	if (ref === null) {
		trace("fedex.no_pickup_ref", { trackingNumber });
	} else {
		try {
			await call(
				"PUT",
				"/pickup/v1/pickups/cancel",
				{
					associatedAccountNumber: { value: ACCOUNT() },
					pickupConfirmationCode: ref.code,
					scheduledDate: ref.date,
					carrierCode: "FDXE",
					...(ref.location ? { location: ref.location } : {}),
				},
				true,
			);
		} catch (error) {
			trace("fedex.pickup_cancel", { trackingNumber, error: String(error) });
		}
	}
	await cancelShipment(trackingNumber);
}

/**
 * No `verifyWebhook`: FedEx's push tracking sits behind a separate programme,
 * so FedEx is tracked by the cron poll, like GDEX.
 */
export const fedexAdapter: CarrierAdapter = {
	id: "fedex",
	isConfigured: fedexConfigured,
	quote: fedexQuote,
	book: fedexBook,
	track: fedexTrack,
	cancel: fedexCancel,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logistics/__tests__/fedex.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logistics/adapters/fedex.ts src/lib/logistics/__tests__/fedex.test.ts
git commit -m "feat(logistics): track and cancel FedEx shipments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX"
```

---

### Task 6: Register FedEx, ping script, docs

**Files:**
- Modify: `src/lib/logistics/carriers.ts` (`CARRIERS`)
- Modify: `src/lib/logistics/registry.ts`
- Create: `scripts/fedex-ping.mjs`
- Modify: `package.json` (`scripts`)
- Modify: `CLAUDE.md`
- Test: `src/lib/logistics/__tests__/registry.test.ts` (create if absent)

**Interfaces:**
- Consumes: `fedexAdapter` (Task 5).
- Produces: `"fedex"` in `CARRIER_IDS`; `findAdapter("fedex")` returns `fedexAdapter`.

- [ ] **Step 1: Write the failing test**

Check `ls src/lib/logistics/__tests__/registry.test.ts`. If it exists, append the `it` below inside it; otherwise create it:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({ put: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/catalogue/db", () => ({ prisma: {} }));

import { fedexAdapter } from "../adapters/fedex";
import { CARRIER_IDS, KIND, LABEL } from "../carriers";
import { findAdapter } from "../registry";

describe("fedex registration", () => {
	it("is a parcel partner the registry can reach", () => {
		expect(CARRIER_IDS).toContain("fedex");
		expect(LABEL.fedex).toBe("FedEx");
		expect(KIND.fedex).toBe("parcel");
		expect(findAdapter("fedex")).toBe(fedexAdapter);
	});
});
```

(If the existing registry test already mocks modules the registry imports — `tokens.ts` touches Prisma — keep its mocks and only add the `it`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/registry.test.ts`
Expected: FAIL — `CARRIER_IDS` does not contain `"fedex"`.

- [ ] **Step 3: Register the carrier**

In `src/lib/logistics/carriers.ts`, add to `CARRIERS` after the EasyParcel row:

```ts
	{ id: "fedex", label: "FedEx", kind: "parcel" },
```

In `src/lib/logistics/registry.ts`, add `import { fedexAdapter } from "./adapters/fedex";` in alphabetical order among the adapter imports, and `fedex: fedexAdapter,` to `ADAPTERS` after `easyparcel`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/logistics/__tests__/registry.test.ts src/lib/logistics/__tests__/status.test.ts`
Expected: PASS. (`status.test.ts` may assert every carrier id has a table; Task 1 already added one.)

- [ ] **Step 5: Add the ping script**

Create `scripts/fedex-ping.mjs`:

```js
#!/usr/bin/env node
/**
 * Talk to FedEx without the app in the way.
 *
 *   node --env-file=.env.local scripts/fedex-ping.mjs
 *   pnpm fedex:ping
 *
 * CI runs `adapters/fedex.ts` against fixtures built from FedEx's documented
 * shapes — our belief about FedEx, not FedEx. This is what notices a renamed
 * field or a refused body. It only reads: a token, one rate for a small parcel
 * between two real Malaysian postcodes, and one tracking lookup. It never
 * creates a shipment.
 *
 * **Only meaningful against production.** The sandbox answers only its own
 * canned inputs: this rate request comes back SERVICE.PACKAGECOMBINATION.INVALID
 * there, and even the canned Malaysian rates are USD. What to look for live:
 *
 * - the token call succeeds (sandbox credentials are refused by production,
 *   and the other way round — switch FEDEX_API_URL and the key pair together);
 * - FEDEX_PRIORITY is offered for the lane, priced in MYR;
 * - the tracking reply parses (any real tracking number of ours will do:
 *   FEDEX_PING_TRACKING=794953535000 pnpm fedex:ping).
 */

const BASE = (process.env.FEDEX_API_URL || "https://apis-sandbox.fedex.com")
	.trim()
	.replace(/\/+$/, "");
const KEY = process.env.FEDEX_API_KEY ?? "";
const SECRET = process.env.FEDEX_API_PASSWORD ?? "";
const ACCOUNT = process.env.FEDEX_ACCOUNT_NUMBER ?? "";
const TRACKING = process.env.FEDEX_PING_TRACKING || "123456789012";

const fail = (message) => {
	console.error(`✗ ${message}`);
	process.exit(1);
};

if (!KEY || !SECRET) fail("FEDEX_API_KEY and FEDEX_API_PASSWORD must be set");
if (!ACCOUNT) fail("FEDEX_ACCOUNT_NUMBER must be set");
console.log(`→ ${BASE}${BASE.includes("sandbox") ? " (sandbox: rate will not be meaningful)" : ""}`);

const tokenResponse = await fetch(`${BASE}/oauth/token`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		grant_type: "client_credentials",
		client_id: KEY,
		client_secret: SECRET,
	}),
});
const token = await tokenResponse.json();
if (!tokenResponse.ok) fail(`token: ${JSON.stringify(token.errors ?? token)}`);
console.log(`✓ token, expires in ${token.expires_in}s`);

const call = async (path, body) => {
	const response = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token.access_token}`,
			"content-type": "application/json",
			"x-locale": "en_US",
		},
		body: JSON.stringify(body),
	});
	return { ok: response.ok, status: response.status, body: await response.json() };
};

const rate = await call("/rate/v1/rates/quotes", {
	accountNumber: { value: ACCOUNT },
	requestedShipment: {
		shipper: { address: { postalCode: "43800", city: "Dengkil", countryCode: "MY" } },
		recipient: { address: { postalCode: "50450", city: "Kuala Lumpur", countryCode: "MY" } },
		pickupType: "CONTACT_FEDEX_TO_SCHEDULE",
		packagingType: "YOUR_PACKAGING",
		rateRequestType: ["ACCOUNT"],
		preferredCurrency: "MYR",
		requestedPackageLineItems: [
			{
				groupPackageCount: 2,
				weight: { units: "KG", value: 1.5 },
				dimensions: { length: 30, width: 10, height: 8, units: "CM" },
			},
		],
	},
});
if (!rate.ok || rate.body.errors) {
	console.log(`✗ rate ${rate.status}: ${JSON.stringify(rate.body.errors ?? rate.body)}`);
} else {
	for (const row of rate.body.output.rateReplyDetails) {
		const detail = row.ratedShipmentDetails[0];
		console.log(
			`✓ rate ${row.serviceType}: ${detail.totalNetCharge} ${detail.currency}${row.serviceType === "FEDEX_PRIORITY" ? "  ← the one we book" : ""}`,
		);
	}
}

const track = await call("/track/v1/trackingnumbers", {
	includeDetailedScans: false,
	trackingInfo: [{ trackingNumberInfo: { trackingNumber: TRACKING } }],
});
const result = track.body.output?.completeTrackResults?.[0]?.trackResults?.[0];
if (!track.ok || !result) {
	console.log(`✗ track ${track.status}: ${JSON.stringify(track.body.errors ?? track.body)}`);
} else if (result.error) {
	console.log(`✓ track ${TRACKING}: FedEx does not know it (${result.error.code})`);
} else {
	console.log(
		`✓ track ${TRACKING}: ${result.latestStatusDetail?.derivedCode} — ${result.latestStatusDetail?.description}`,
	);
}
```

In `package.json` `scripts`, after `"easyparcel:ping"`:

```json
		"fedex:ping": "node --env-file=.env.local scripts/fedex-ping.mjs",
```

Run: `pnpm fedex:ping`
Expected (sandbox, and only once `FEDEX_ACCOUNT_NUMBER` is in `.env.local`): `✓ token`, then `✗ rate 400: …SERVICE.PACKAGECOMBINATION.INVALID…` — that is the sandbox's canned-input limit, not a bug — then a `✓ track` line. Without `FEDEX_ACCOUNT_NUMBER` it exits with `✗ FEDEX_ACCOUNT_NUMBER must be set`, which is also correct.

- [ ] **Step 6: Document it in CLAUDE.md**

In `CLAUDE.md`:

1. Directory layout: change `adapters/            ← one file per partner; manual, lalamove and easyparcel are live` to `adapters/            ← one file per partner; manual, lalamove, easyparcel, gdex and fedex are built`, and add `    label.ts             ← captured shipping labels: blob path, and which carriers have one` under `lib/logistics/`.
2. Known issues: append

```md
13. **FedEx's sandbox cannot check our requests.** It answers only its own canned inputs — any request that differs from a documented example returns `SERVICE.PACKAGECOMBINATION.INVALID`, and its canned Malaysian rates are USD — so `adapters/fedex.ts` is tested against fixtures built from FedEx's documented shapes, not against FedEx. `pnpm fedex:ping` against **production** is the first real check: run it once production credentials exist, before the first FedEx booking. Production also needs label certification with FedEx, which can take weeks.
```

3. Open questions, under the "workshop's real street address and phone" bullet, append a sentence: `FedEx takes the shipper and pickup address from the same constants (GDEX avoided this with its account profile; FedEx cannot), plus WORKSHOP_CLOSE_TIME, also a placeholder.` And add a bullet:

```md
- **Does EzCabinet's FedEx account sell `FEDEX_PRIORITY` domestically, and in MYR?** The adapter prefers it and falls back to the cheapest service offered; a non-MYR price is refused rather than shown as RM. Only production credentials or their FedEx rep can answer. `FEDEX_PRIORITY_EXPRESS_FREIGHT` (freight, over 68 kg) could carry whole cabinets — out of scope, worth asking.
```

- [ ] **Step 7: Full gates**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/logistics/carriers.ts src/lib/logistics/registry.ts src/lib/logistics/__tests__/registry.test.ts scripts/fedex-ping.mjs package.json CLAUDE.md
git commit -m "feat(logistics): offer FedEx as a parcel partner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX"
```

---

## Deviations from the spec

- **No delivery date in the quote notes.** The spec said the FedEx date goes into `notes` "when FedEx returns one". The canned sandbox reply carries no `commit` date, so the field it lives in is unverified; `notes` is `Parcel, N kg — <service name>` until `fedex-ping` shows a real reply with one.
- **`CarrierBooking.note`** is new. The spec said the booking event's message carries the pickup confirmation code; the route builds that message generically, so the adapter needs a field to hand it over.
