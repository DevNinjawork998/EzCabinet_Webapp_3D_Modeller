# GDEX carrier adapter — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this task-by-task. Steps use `- [ ]` checkboxes.
>
> **Final home:** copy this file to `docs/superpowers/plans/2026-09-06-gdex-carrier-adapter.md` in the first commit.

**Goal:** Make GDEX a real logistics partner — quote, book, track, cancel — so it appears in the admin's Compare partners table alongside Lalamove and Own lorry.

**Architecture:** `src/lib/logistics/adapters/gdex.ts` is today a stub that throws `CarrierNotConfigured`. Replacing that one file with a real `CarrierAdapter` is *almost* the whole job: `carriers.ts` already lists GDEX, `registry.ts` already maps it, the quote fan-out, book, track, cron sweep and webhook routes are all carrier-agnostic, and `Delivery.carrierId` is a plain string by design so **no Prisma migration is needed**. Two support pieces are new — a postcode reader, because GDEX prices by postcode and nothing in this app has ever needed one — and one small honesty fix so a GDEX rejection actually reaches the admin's screen.

**Tech stack:** TypeScript, Zod v4, Vitest, Next.js App Router, Prisma. No new dependencies.

**Spec:** the myGDEX Open API developer portal (`https://myopenplatform.gdexpress.com`, API `mygdex-open-api-testing`), read 2026-09-06. The operations this plan uses are transcribed verbatim in [Appendix A](#appendix-a--the-gdex-operations-this-plan-uses) so no executor needs a portal login.

---

## Status

Unblocked 2026-09-06. The EasyParcel integration it waited on landed in `69e2a0d`;
`CarrierBooking.labelUrl`, `pickupPlace()`, `WORKSHOP_POSTCODE` and the place
columns on `DeliveryJob` all exist. Task 1 is done — `scripts/gdex-ping.mjs`
was written and run on 2026-09-06.

**The auth section of this document is superseded.** `Ocp-Apim-Subscription-Key`
is ignored by GDEX's gateway; the header is `subscription-key`. See the current
plan's "corrected auth contract".

**Conventions this plan follows**, set by the EasyParcel work: payload fixtures copied verbatim from the vendor's own documented samples into `src/lib/logistics/__tests__/fixtures/<carrier>.ts`; stubbed-`fetch` tests asserting *both* the bytes sent and the reply parsed; a `<carrier>-ping.mjs` smoke script run by a human, never in PR CI.

---

## Context

EzCabinet needs a parcel partner. Cabinets travel by lorry (Lalamove), but hardware, samples and spare doors do not — `carriers.ts` already says exactly this in its `CarrierKind` docblock, and GDEX has sat in the carrier list as a `parcel` stub since the logistics module was built, waiting for documentation that has now arrived along with sandbox credentials.

Three things about GDEX are structurally different from Lalamove, and every design decision below falls out of them:

| | Lalamove | GDEX |
| --- | --- | --- |
| Prices against | pickup/dropoff **coordinates** | **postcode pair + weight in kg** |
| Status arrives by | webhook **and** poll | **poll only** — the API has no callback operation |
| Booking is paid by | invoice | **e-Wallet debit at booking time** |

The postcode row is the one that costs work. `Delivery` stores free-text addresses and a geocoded pin; the word "postcode" does not appear anywhere in `src/`. The weight row costs the second-most: `DeliveryItem.weightKg` is nullable and the catalogue carries no weights, so the honest answer for an unweighed job is a refusal that names the fix, not an invented kilogram.

**Decisions taken with the user, 2026-09-06:**

1. **Credentials: one held, one missing.** `GDEX_PRIMARY_API_KEY` is the APIM subscription key and works. The `User-Token` is *not* `GDEX_PUBLIC_KEY`, which the API rejects — it is an Integration Token from the myGDEX web application, and the client has yet to supply it. Every task below reads `GDEX_USER_TOKEN`, so GDEX stays an honest "no credentials" row until it is set.
2. **Weight is entered by the admin.** The item row already has a Weight kg input (`LogisticsManager.tsx:451-467`); its supporting copy currently tells the admin weight is optional. GDEX refuses to quote without it and says so on its own comparison row.
3. **Request a pickup.** `CreateConsignment` sends the optional `Pickup` block so a GDEX driver collects from the workshop — the same shape as a Lalamove job. Nobody drives to a branch.
4. **No e-Wallet UI.** GDEX is the only partner with a balance endpoint; surfacing it would make one carrier's panel look unlike the other four. `Insufficient Credit` reaches the admin as an ordinary booking rejection instead — which is what Task 7 exists to guarantee. (This also avoids re-adding the `CarrierWallet` table that was created and reverted on 2026-09-05, migrations `20260905171501` / `20260905172637`.)

---

## Global constraints

Every task's requirements implicitly include these.

- **Zod is the source of truth for types.** Define the schema, infer the TS type. Validate every payload that arrives from outside the process.
- **`lib/logistics/adapters/*` is `server-only`.** These modules hold booking credentials and must never be reachable from a client bundle. `carriers.ts` is the isomorphic half; nothing secret goes there.
- **No Prisma migration.** `Delivery.carrierId` is deliberately a `String?` validated against `CARRIER_IDS`, not an enum — `schema.prisma:245-247` says so explicitly. If a task seems to need a column, stop and re-read this line.
- **Every `lib/logistics` function gets a test before it gets a caller** (project convention, CLAUDE.md).
- **Sentence case in UI copy. Prices in RM.**
- **Booking is never retried.** `carrierFetch`'s `idempotent` flag defaults to false; `CreateConsignment` debits an e-Wallet, so it must stay false. Quotes and status reads pass `idempotent: true`.
- Verification commands: `pnpm test` (vitest), `pnpm lint` (biome), `pnpm exec tsc --noEmit`. There is no `typecheck` script.
- Commit after every task. Do not squash tasks together.

---

## File structure

| File | Status | Responsibility |
| --- | --- | --- |
| `scripts/gdex-ping.mjs` | **create** | Talk to GDEX with the app out of the way. Proves which env var is the `User-Token`, which host answers, and what the sandbox's real status words are. Read-only operations only. |
| `src/lib/logistics/adapters/gdex.ts` | **replace** | The adapter. Pure payload builders + the four `CarrierAdapter` methods. Currently an 18-line stub. |
| `src/lib/logistics/__tests__/fixtures/gdex.ts` | **create** | Every GDEX payload this integration parses, copied verbatim from Appendix A. One place, so a shape change is one edit. Convention borrowed from the EasyParcel plan. |
| `src/lib/logistics/__tests__/gdex.test.ts` | **create** | Builders bare, then the network methods with a faked fetch. Mirrors `lalamove.test.ts`. |
| `src/lib/logistics/status.ts` | modify | Fill `CARRIER_STATUS_MAPS.gdex`, today `{}`. |
| `src/lib/logistics/__tests__/status.test.ts` | modify | Cover the new table. |
| `src/app/api/admin/deliveries/[id]/book/route.ts` | modify | Return a `carrier_refused` code so the carrier's own sentence reaches the screen. |
| `src/app/admin/logistics/errors.ts` | modify | One more entry in `messageFor`. |
| `src/app/admin/logistics/__tests__/errors.test.ts` | modify | Cover it. |
| `src/app/admin/logistics/LogisticsManager.tsx` | modify | Weight copy, and show the carrier's message on a failed booking. |
| `src/lib/logistics/types.ts` | modify | `CarrierBooking.labelUrl` — **only if the EasyParcel work has not already added it.** |
| `src/app/api/admin/deliveries/[id]/book/route.ts` | modify | Persist `labelUrl`; return `carrier_refused` with the carrier's message. |
| `README.md` | modify | The env-var table. |
| `package.json` | modify | One script: `gdex:ping`. |

---

## Task 1: Prove the credentials — DONE 2026-09-06

`scripts/gdex-ping.mjs` exists and `pnpm gdex:ping` runs it. Read-only: token
validity, e-wallet balance, one rate quote between two Klang Valley postcodes.
It never calls `CreateConsignment`.

**Do not paste a script over it.** The listing that stood here was written
before the API answered and got the auth wrong. What the real run established:

| Question | Answer |
| --- | --- |
| Base URL | `https://myopenapi.gdexpress.com/test/api/MyGDex` — live is the same host without `/test`, and the account has no active live subscription |
| Subscription header | **`subscription-key`**. `Ocp-Apim-Subscription-Key` is ignored: the gateway answers "missing subscription key" while a valid key is being sent |
| Subscription key | `GDEX_PRIMARY_API_KEY`, valid for the `myGDEX (Testing)` product |
| `GDEX_SECONDARY_API_SECRET` | APIM's rotation spare for the primary key. Not a signing secret. Nothing reads it |
| User token | **Not yet held.** `GDEX_PUBLIC_KEY` returns `{"statusCode":401,"message":"Invalid User Token"}`. The real one is an Integration Token from the myGDEX *web application*, User Profile → Integration Token. Later tasks read `GDEX_USER_TOKEN` |
| Status words | Unknown until the token lands. Task 6's table is built from the documented copy and must be rebuilt from a real reply |

- [x] Script written, run, and its findings recorded above.

## Task 2: ~~Read a postcode out of an address~~ — deleted

**Do not implement this.** The original plan wrote a `postcodeOf(address)`
regex because nothing in the app carried a postcode. Commit `a0f153e` landed
while this plan was being written and solved it better: the Google geocode that
already runs at job-save time now keeps `postal_code`, `locality` and
`administrative_area_level_1`, `Delivery` stores all six place columns, and
`toJob` puts them on `DeliveryJob`.

A parsed component from the geocoder beats five digits scraped out of free text
— it cannot mistake a lot number for a postcode, and it is the same value the
pin was derived from.

**So, everywhere the later tasks want a postcode:**

| Want | Read |
| --- | --- |
| the destination postcode | `job.sitePostcode` — null when the geocode did not return one |
| the workshop's postcode | the GDEX account profile's `PostalCode` from `GetUserDetails`, **not** `job.pickupPostcode` — see below |

A null `sitePostcode` is a refusal, not a fallback: throw
`GdexNotDeliverable("The site address did not geocode to a postcode — GDEX
prices postcode to postcode, so correct the address and compare again")`. The
`DeliveryJob` field's own docblock says a parcel partner refuses rather than
guesses; this is that.

**Why the sender postcode comes from the profile and not the job.** GDEX's
`CreateConsignment` demands a `LocationId` — an integer naming a specific
locality within a postcode — and there is no way to derive one from arbitrary
text except `GetPostcodeLocations`, which returns many locations per postcode
with nothing to choose between them. `GetUserDetails` returns the account's own
postcode *and* its `LocationId` together, already agreeing with each other. See
the open question about an edited `pickupAddress` at the end of this plan.

Nothing to write, nothing to commit. Go to Task 3.
## Task 3: The GDEX payload builders, pure

Same split as `lalamove.test.ts`: everything that turns a `DeliveryJob` into a request body is a plain exported function, tested with no mocking at all, before a single call is made. This is where every refusal lives, because a refusal is cheaper than a round trip and its message is what the admin reads on the comparison row.

**Files:**
- Modify (replace wholesale): `src/lib/logistics/adapters/gdex.ts`
- Test: `src/lib/logistics/__tests__/gdex.test.ts`

**Interfaces:**
- Consumes: `suggestVehicle` from `../measure`; `toE164` from `../phone`; `DeliveryJob`, `CarrierQuote` from `../types`. The postcode comes off `job.sitePostcode` — see Task 2.
- Produces, for Task 4:
  - `class GdexNotDeliverable extends Error`
  - `TRANSPORTATION: Record<VehicleClass, string>`
  - `weightOf(job: DeliveryJob): number`
  - `piecesOf(job: DeliveryJob): number`
  - `rateBody(job: DeliveryJob, fromPostcode: string): RateRequest[]`
  - `pickupInfo(job: DeliveryJob): { Transportation: string; ParcelReadyTime: string; PickupDate: string; PickupRemark?: string; IsTrolleyRequired: boolean }`
  - `consignmentBody(job: DeliveryJob, sender: GdexUserDetails): GenerateConsignmentRequest`
  - `type GdexUserDetails = { Name: string; Email: string; MobileNumber: string; Address1: string; Address2: string | null; PostalCode: string; City: string | null; LocationId: number; Location: string; State: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
	GdexNotDeliverable,
	consignmentBody,
	pickupInfo,
	piecesOf,
	rateBody,
	transportationFor,
	weightOf,
} from "../adapters/gdex";
import type { DeliveryItem, DeliveryJob } from "../types";

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
	siteState: "Pulau Pinang",
	pickupPostcode: null,
	pickupCity: null,
	pickupState: null,
	addressNotes: "Guard house, ask for block C",
	pickupAddress: "EzCabinet Sdn Bhd, Klang Valley, Selangor",
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

const sender = {
	Name: "EzCabinet Sdn Bhd",
	Email: "sales@ezcabinet.com.my",
	MobileNumber: "+60355112233",
	Address1: "No. 19, Jalan Tandang",
	Address2: null,
	PostalCode: "46050",
	City: "Petaling Jaya",
	LocationId: 33500,
	Location: "Jalan Tandang Seksyen 51",
	State: "Selangor",
};

describe("weightOf", () => {
	it("is the job's total weight", () => {
		expect(weightOf(job())).toBe(3);
	});

	it("refuses an unweighed job rather than guessing", () => {
		expect(() => weightOf(job({ totalWeightKg: null }))).toThrow(GdexNotDeliverable);
		expect(() => weightOf(job({ totalWeightKg: null }))).toThrow(/weight/i);
	});

	it("refuses a zero weight, which is not a parcel", () => {
		expect(() => weightOf(job({ totalWeightKg: 0 }))).toThrow(GdexNotDeliverable);
	});
});

describe("piecesOf", () => {
	it("sums the quantities", () => {
		expect(piecesOf(job({ items: [carton, { ...carton, qty: 3 }] }))).toBe(5);
	});

	it("refuses more than fifteen pieces, which GDEX caps", () => {
		expect(() => piecesOf(job({ items: [{ ...carton, qty: 16 }] }))).toThrow(/15 pieces/);
	});

	it("refuses a job with no items", () => {
		expect(() => piecesOf(job({ items: [] }))).toThrow(GdexNotDeliverable);
	});
});

describe("transportationFor", () => {
	it("maps our vehicle classes to GDEX's three", () => {
		expect(transportationFor(job())).toBe("Motorbike");
	});

	it("asks for an offsize truck when the job needs a lorry", () => {
		const big = { ...carton, qty: 1, widthMm: 2400, heightMm: 900, depthMm: 600, weightKg: 90 };
		expect(transportationFor(job({ items: [big], totalWeightKg: 90 }))).toBe("OffsizeTruck");
	});

	it("refuses a job that fits in no vehicle at all", () => {
		const huge = { ...carton, qty: 40, widthMm: 2400, heightMm: 2400, depthMm: 600, weightKg: 200 };
		expect(() => transportationFor(job({ items: [huge], totalWeightKg: 8000 }))).toThrow(GdexNotDeliverable);
	});
});

describe("rateBody", () => {
	it("prices one line, postcode to postcode, in kilograms", () => {
		expect(rateBody(job(), "46050")).toEqual([
			{
				ReferenceNumber: 7,
				FromPostCode: "46050",
				ToPostCode: "11950",
				ParcelType: "Parcel",
				Weight: 3,
				Country: "MYS",
			},
		]);
	});

	it("refuses a job whose address never geocoded to a postcode", () => {
		expect(() => rateBody(job({ sitePostcode: null }), "46050")).toThrow(/postcode/i);
	});
});

describe("pickupInfo", () => {
	it("asks for a pickup on the scheduled day", () => {
		expect(pickupInfo(job())).toEqual({
			Transportation: "Motorbike",
			ParcelReadyTime: "16:00:00",
			PickupDate: "2026-09-10T16:00:00.000Z",
			PickupRemark: "Guard house, ask for block C",
			IsTrolleyRequired: false,
		});
	});

	it("refuses a job with no scheduled date, because a pickup needs a day", () => {
		expect(() => pickupInfo(job({ scheduledAt: null }))).toThrow(/scheduled/i);
	});

	it("omits the remark when there are no address notes", () => {
		expect(pickupInfo(job({ addressNotes: null })).PickupRemark).toBeUndefined();
	});
});

describe("consignmentBody", () => {
	it("puts the account profile in the sender block and the customer in the consignment", () => {
		const body = consignmentBody(job(), sender);

		expect(body.Name).toBe("EzCabinet Sdn Bhd");
		expect(body.Postcode).toBe("46050");
		expect(body.LocationId).toBe(33500);
		expect(body.Consignments).toHaveLength(1);

		const [consignment] = body.Consignments;
		expect(consignment.OrderId).toBe("ICB-7");
		expect(consignment.Mobile).toBe("60123456789");
		expect(consignment.Postcode).toBe("11950");
		expect(consignment.Country).toBe("MYS");
		expect(consignment.Weight).toBe(3);
		expect(consignment.Pieces).toBe(2);
		expect(consignment.IsInsurance).toBe(false);
	});

	it("carries the pickup arrangement", () => {
		expect(consignmentBody(job(), sender).Pickup?.Transportation).toBe("Motorbike");
	});

	it("refuses a customer phone GDEX cannot call", () => {
		expect(() => consignmentBody(job({ customerPhone: "n/a" }), sender)).toThrow(GdexNotDeliverable);
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm test src/lib/logistics/__tests__/gdex.test.ts
```

Expected: FAIL — every named export is missing from the stub module.

- [ ] **Step 3: Write the builders**

Replace the whole of `src/lib/logistics/adapters/gdex.ts` with the module below. Task 4 appends the adapter object to the same file; the `CarrierAdapter` export disappears for one commit, which is why Task 3 and Task 4 are one branch and not two.

```ts
import "server-only";
import { suggestVehicle, type VehicleClass } from "../measure";
import { toE164 } from "../phone";
import { trace } from "../trace";
import type { DeliveryJob } from "../types";

/**
 * GDEX — the parcel partner.
 *
 * Three things separate it from Lalamove and every design choice here follows
 * from them: it prices by **postcode and kilogram** rather than by coordinate,
 * it has **no webhook** (the API documents no callback operation, so tracking
 * is the cron poll only), and booking **debits an e-Wallet** — which makes
 * `CreateConsignment` the one call in this file that must never be retried.
 *
 * The account's own profile is the sender. `GetUserDetails` returns Name,
 * Mobile, Email, Address1, PostalCode, City, State, Location and — the field
 * that matters — `LocationId`, which `CreateConsignment` requires and which
 * cannot be derived from an address without a second lookup. WORKSHOP_ADDRESS
 * is a placeholder too vague to geocode (see the open question in CLAUDE.md);
 * the GDEX profile is a real registered address, so GDEX sidesteps that
 * problem entirely rather than inheriting it.
 */

/**
 * A job GDEX cannot be asked about — no weight, no postcode, too many pieces,
 * no pickup day.
 *
 * Separate from `CarrierNotConfigured` for the same reason
 * `LalamoveNotDeliverable` is: the cause is the job, not the environment, and
 * `quotes/route.ts` puts this message straight onto the GDEX comparison row
 * where the admin can act on it.
 */
export class GdexNotDeliverable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GdexNotDeliverable";
	}
}

/** Malaysia. GDEX takes ISO-3166 alpha-3, not the alpha-2 everything else uses. */
export const COUNTRY = "MYS";

/** Documents are paper. Anything EzCabinet ships is not. */
export const PARCEL_TYPE = "Parcel";

/** GDEX caps a consignment at fifteen pieces. */
export const MAX_PIECES = 15;

/**
 * Our four vehicle classes in GDEX's three.
 *
 * GDEX collects with a motorbike, a van or an offsize truck. A car-sized job
 * goes on the bike — this is a parcel network, and the class only decides
 * which vehicle turns up at the loading bay.
 */
export const TRANSPORTATION: Record<VehicleClass, string> = {
	car: "Motorbike",
	van: "Van",
	lorry_1t: "OffsizeTruck",
	lorry_3t: "OffsizeTruck",
};

/**
 * The weight GDEX prices against.
 *
 * Refuses rather than defaults. The catalogue carries no weights, so most jobs
 * arrive with none — and a fabricated kilogram would be quoted against and then
 * invoiced differently, which is the exact failure `deliveryItemSchema`'s
 * nullable `weightKg` was written to avoid. The message names the fix, because
 * the fix is a field the admin can fill in on this screen.
 */
export function weightOf(job: DeliveryJob): number {
	const kg = job.totalWeightKg;
	if (kg === null || kg <= 0) {
		trace("gdex.refused", { why: "no weight", deliveryId: job.id });
		throw new GdexNotDeliverable(
			"This job has no weight — GDEX prices by the kilogram, so give each item a weight and compare again",
		);
	}
	return kg;
}

export function piecesOf(job: DeliveryJob): number {
	const pieces = job.items.reduce((sum, item) => sum + item.qty, 0);
	if (pieces === 0) {
		throw new GdexNotDeliverable("This job has no items to send");
	}
	if (pieces > MAX_PIECES) {
		trace("gdex.refused", { why: "pieces", pieces, deliveryId: job.id });
		throw new GdexNotDeliverable(
			`This job is ${pieces} pieces — GDEX takes at most ${MAX_PIECES} on one consignment, so split it`,
		);
	}
	return pieces;
}

export function transportationFor(job: DeliveryJob): string {
	const suggestion = suggestVehicle(job.items);
	if (suggestion.id === null) {
		trace("gdex.refused", { why: "vehicle", reason: suggestion.reason });
		throw new GdexNotDeliverable(
			`This job is ${suggestion.reason} — GDEX collects with one vehicle`,
		);
	}
	return TRANSPORTATION[suggestion.id];
}

/**
 * The destination postcode, off the job.
 *
 * Kept by the geocode at save time (`a0f153e`) rather than parsed out of the
 * address here — a component the geocoder identified cannot be confused with a
 * lot number, and it is the same reply the pin came from. Null means the
 * address did not geocode to one, which is a refusal: GDEX prices postcode to
 * postcode and there is nothing to guess with.
 */
function sitePostcodeOf(job: DeliveryJob): string {
	if (job.sitePostcode === null || job.sitePostcode === "") {
		trace("gdex.refused", { why: "no postcode", address: job.siteAddress });
		throw new GdexNotDeliverable(
			"The site address did not geocode to a postcode — GDEX prices postcode to postcode, so correct the address and compare again",
		);
	}
	return job.sitePostcode;
}

export type RateRequest = {
	ReferenceNumber: number;
	FromPostCode: string;
	ToPostCode: string;
	ParcelType: string;
	Weight: number;
	Country: string;
};

/**
 * The rate payload — an array, because GDEX prices a batch and we send one.
 *
 * `ReferenceNumber` is the delivery number staff say out loud, which makes the
 * reply's row identifiable in the event log without a lookup table.
 */
export function rateBody(job: DeliveryJob, fromPostcode: string): RateRequest[] {
	return [
		{
			ReferenceNumber: job.number,
			FromPostCode: fromPostcode,
			ToPostCode: sitePostcodeOf(job),
			ParcelType: PARCEL_TYPE,
			Weight: weightOf(job),
			Country: COUNTRY,
		},
	];
}

/** GDEX will not collect more than five days out, and not in the past. */
export const MAX_PICKUP_DAYS = 5;

export type PickupInfo = {
	Transportation: string;
	ParcelReadyTime: string;
	PickupDate: string;
	PickupRemark?: string;
	IsTrolleyRequired: boolean;
};

/**
 * The pickup arrangement, from the job's scheduled time.
 *
 * A GDEX pickup needs a day, and the job's `scheduledAt` is the only day this
 * app knows about — so a job with none is refused rather than collected on a
 * guessed date. `addressNotes` becomes `PickupRemark` for the same reason it
 * becomes Lalamove's `remarks`: gate codes are what the driver at the boom
 * gate actually needs.
 */
export function pickupInfo(job: DeliveryJob): PickupInfo {
	const at = job.scheduledAt;
	if (at === null) {
		throw new GdexNotDeliverable(
			"This job has no scheduled date — GDEX needs a day to send a driver, so set Scheduled and compare again",
		);
	}
	// GDEX takes the time twice: once as the ISO instant and once as the
	// wall-clock time the parcel is ready. Same moment, two formats.
	const time = at.toISOString().slice(11, 19);
	return {
		Transportation: transportationFor(job),
		ParcelReadyTime: time,
		PickupDate: at.toISOString(),
		...(job.addressNotes ? { PickupRemark: job.addressNotes } : {}),
		// Nothing in this app knows whether a trolley is wanted, and a wrong
		// `true` sends a trolley to a job that is two door handles.
		IsTrolleyRequired: false,
	};
}

export type GdexUserDetails = {
	Name: string;
	Email: string;
	MobileNumber: string;
	Address1: string;
	Address2: string | null;
	PostalCode: string;
	City: string | null;
	LocationId: number;
	Location: string;
	State: string | null;
};

function phoneOrThrow(raw: string, whose: string): string {
	const e164 = toE164(raw);
	if (e164 === null) {
		throw new GdexNotDeliverable(
			`The ${whose} phone number (${raw}) is not a number GDEX can call`,
		);
	}
	return e164;
}

/**
 * The consignment payload.
 *
 * One consignment per job. GDEX allows ten and fifteen pieces within one, and
 * a cabinet job that needs more than that is a lorry job, not a parcel job.
 *
 * `ShipmentValue` is zero because `IsInsurance` is false: the field is what
 * enhanced liability is priced on, and declaring a value we have not been given
 * would either buy cover nobody asked for or misstate the contents.
 */
export function consignmentBody(job: DeliveryJob, sender: GdexUserDetails) {
	return {
		Name: sender.Name,
		Mobile: phoneOrThrow(sender.MobileNumber, "workshop's"),
		Email: sender.Email,
		Address1: sender.Address1,
		...(sender.Address2 ? { Address2: sender.Address2 } : {}),
		Postcode: sender.PostalCode,
		LocationId: sender.LocationId,
		Location: sender.Location,
		...(sender.City ? { City: sender.City } : {}),
		...(sender.State ? { State: sender.State } : {}),
		Pickup: pickupInfo(job),
		Consignments: [
			{
				// Ours, printed on the consignment note — the fastest way to tie a
				// note in GDEX's portal to a job number staff say aloud.
				OrderId: `ICB-${job.number}`,
				ShipmentContent: job.items.map((i) => i.label).join(", ").slice(0, 200),
				ParcelType: PARCEL_TYPE,
				ShipmentValue: 0,
				Pieces: piecesOf(job),
				Weight: weightOf(job),
				Name: job.customerName,
				Mobile: phoneOrThrow(job.customerPhone, "customer's"),
				Address1: job.siteAddress,
				Postcode: sitePostcodeOf(job),
				Country: COUNTRY,
				IsInsurance: false,
				IsTrackingSms: false,
				...(job.addressNotes ? { Note1: job.addressNotes } : {}),
			},
		],
	};
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test src/lib/logistics/__tests__/gdex.test.ts
```

Expected: PASS. `pnpm exec tsc --noEmit` will still fail on `registry.ts`, which imports a `gdexAdapter` this commit removed — that is expected and Task 4 fixes it. Do not paper over it by leaving the stub in place.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/adapters/gdex.ts src/lib/logistics/__tests__/gdex.test.ts
git commit -m "feat(logistics): build the gdex request payloads

Pure and tested bare, the way the Lalamove builders are. Every refusal lives
here because its message is what the admin reads on the comparison row."
```

---

## Task 4: The adapter — quote, book, track, cancel

**Files:**
- Modify: `src/lib/logistics/adapters/gdex.ts` (append)
- Modify: `src/lib/logistics/__tests__/gdex.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 3 produced; `carrierFetch` from `../http`; `mapCarrierStatus` from `../status` (Task 6 fills its table — until then it returns null, which `applyTrackingUpdate` correctly treats as "leave the row alone").
- Produces: `export const gdexAdapter: CarrierAdapter` — the name `registry.ts:4` already imports.

**Do not implement `verifyWebhook`.** GDEX documents no callback operation. Leaving the method off is the correct signal: `webhooks/[carrier]/route.ts:43-47` answers `200 {received:true}` for an adapter without one, and the cron sweep at `*/10 * * * *` is the only tracking channel.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/logistics/__tests__/gdex.test.ts`:

```ts
import { afterEach, beforeEach, vi } from "vitest";
import { gdexAdapter } from "../adapters/gdex";
import { CarrierNotConfigured } from "../types";

const userDetailsResponse = {
	statusCode: 200,
	data: sender,
	message: null,
};

const rateResponse = {
	statusCode: 200,
	data: [{ ReferenceNumber: 7, Rate: 12.4, HasError: false, Error: null }],
	message: null,
};

const consignmentResponse = {
	statusCode: 200,
	data: {
		InvoiceNumber: "120CPA0001234",
		ConsignmentNumbers: ["MY1700012345"],
		Consignments: [{ OrderId: "ICB-7", ConsignmentNumber: "MY1700012345", Rate: 12.4 }],
		GrandTotal: 12.4,
		EWalletBalance: 980.6,
	},
	message: null,
};

/** One queued JSON Response per call, in order. Same helper as lalamove.test.ts. */
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

describe("gdexAdapter", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is not configured without a user token", () => {
		vi.stubEnv("GDEX_USER_TOKEN", "");
		expect(gdexAdapter.isConfigured()).toBe(false);
	});

	it("has no webhook, because GDEX has no callback operation", () => {
		expect(gdexAdapter.verifyWebhook).toBeUndefined();
	});

	describe("quote", () => {
		it("reads the sender postcode from the account, then prices against it", async () => {
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);

			const quote = await gdexAdapter.quote(job());

			expect(quote).toMatchObject({ carrierId: "gdex", priceRm: 12.4, etaMinutes: null });
			expect(fetchMock.mock.calls[0][0]).toContain("/GetUserDetails");
			expect(fetchMock.mock.calls[1][0]).toContain("/GetShippingRate");
			expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual([
				{
					ReferenceNumber: 7,
					FromPostCode: "46050",
					ToPostCode: "11950",
					ParcelType: "Parcel",
					Weight: 3,
					Country: "MYS",
				},
			]);
		});

		it("sends the user token as a header", async () => {
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);
			await gdexAdapter.quote(job());
			expect(fetchMock.mock.calls[0][1].headers["User-Token"]).toBe("utok_test_abc");
		});

		it("turns a per-row HasError into a refusal, not a price of zero", async () => {
			stubResponses(userDetailsResponse, {
				statusCode: 200,
				data: [{ ReferenceNumber: 7, Rate: 0, HasError: true, Error: "Postal code 11950 not found" }],
				message: null,
			});

			await expect(gdexAdapter.quote(job())).rejects.toThrow(/Postal code 11950 not found/);
		});

		it("refuses to call at all without credentials", async () => {
			vi.stubEnv("GDEX_USER_TOKEN", "");
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);

			await expect(gdexAdapter.quote(job())).rejects.toBeInstanceOf(CarrierNotConfigured);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("refuses an unweighed job before it dials", async () => {
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);

			await expect(gdexAdapter.quote(job({ totalWeightKg: null }))).rejects.toBeInstanceOf(
				GdexNotDeliverable,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("book", () => {
		it("returns the consignment number as the carrier order id", async () => {
			const fetchMock = stubResponses(userDetailsResponse, consignmentResponse);

			const booking = await gdexAdapter.book(job(), {
				carrierId: "gdex",
				priceRm: 12.4,
				etaMinutes: null,
			});

			expect(booking.carrierOrderId).toBe("MY1700012345");
			expect(fetchMock.mock.calls[1][0]).toContain("/CreateConsignment");
		});

		it("surfaces an insufficient balance as the carrier's own sentence", async () => {
			const fetchMock = vi.fn();
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify(userDetailsResponse), { status: 200 }),
			);
			fetchMock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ statusCode: 400, data: null, message: "Insufficient Credit" }),
					{ status: 400 },
				),
			);
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				gdexAdapter.book(job(), { carrierId: "gdex", priceRm: 12.4, etaMinutes: null }),
			).rejects.toThrow(/Insufficient Credit/);
		});

		it("never retries the booking call", async () => {
			const fetchMock = vi.fn();
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify(userDetailsResponse), { status: 200 }),
			);
			fetchMock.mockResolvedValueOnce(new Response("upstream is down", { status: 503 }));
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				gdexAdapter.book(job(), { carrierId: "gdex", priceRm: 12.4, etaMinutes: null }),
			).rejects.toThrow();
			// GetUserDetails plus one CreateConsignment. A second consignment is a
			// second parcel and a second e-Wallet debit.
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});

	describe("track", () => {
		it("reads the last shipment status for the consignment", async () => {
			const fetchMock = stubResponses({
				statusCode: 200,
				data: [{ ConsignmentNote: "MY1700012345", ConsignmentNoteStatus: "Pending" }],
				message: null,
			});

			const update = await gdexAdapter.track("MY1700012345");

			expect(update.message).toContain("Pending");
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(["MY1700012345"]);
		});

		it("leaves the status null when GDEX returns a word we have not mapped", async () => {
			stubResponses({
				statusCode: 200,
				data: [{ ConsignmentNote: "MY1700012345", ConsignmentNoteStatus: "Bagged" }],
				message: null,
			});

			expect((await gdexAdapter.track("MY1700012345")).status).toBeNull();
		});
	});

	describe("cancel", () => {
		it("puts the consignment number on the query string", async () => {
			const fetchMock = stubResponses({ statusCode: 200, data: null, message: null });
			await gdexAdapter.cancel?.("MY1700012345");
			expect(fetchMock.mock.calls[0][0]).toContain("ConsignmentNumber=MY1700012345");
			expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
		});
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm test src/lib/logistics/__tests__/gdex.test.ts
```

Expected: FAIL — `gdexAdapter` is not exported.

- [ ] **Step 3: Append the adapter**

Append to `src/lib/logistics/adapters/gdex.ts`. Header names come from Task 1's recorded answer — if the ping proved a different env var carries the `User-Token`, change `USER_TOKEN` here and nowhere else.

```ts
import { z } from "zod";
import { carrierFetch } from "../http";
import { mapCarrierStatus } from "../status";
import {
	type CarrierAdapter,
	type CarrierBooking,
	CarrierNotConfigured,
	type CarrierQuote,
	type TrackingUpdate,
} from "../types";

/**
 * The myGDEX user token, generated in the portal's User Profile page. Read per
 * call rather than at import so a test can stub it.
 */
const USER_TOKEN = () => process.env.GDEX_USER_TOKEN ?? "";

/**
 * The Azure APIM subscription key. Sent when present and omitted when not:
 * `myopenapi.gdexpress.com` is the origin, and it is the gateway in front of it
 * that wants a subscription key — see the answer recorded in
 * `scripts/gdex-ping.mjs`.
 */
const SUBSCRIPTION_KEY = () => process.env.GDEX_PRIMARY_API_KEY ?? "";

/**
 * Sandbox unless told otherwise.
 *
 * Lalamove's key prefixes its own environment, so its adapter reads the host
 * off the key. GDEX's tokens carry no such marker, which leaves an explicit
 * flag — defaulted to the test host, because the wrong default here creates
 * real consignments and debits a real e-Wallet.
 */
function baseUrl(): string {
	return process.env.GDEX_LIVE === "1"
		? "https://myopenapi.gdexpress.com/api/MyGDex"
		: "https://myopenapi.gdexpress.com/test/api/MyGDex";
}

async function call<T>(
	method: "GET" | "POST" | "PUT",
	path: string,
	body?: unknown,
	idempotent = false,
): Promise<T> {
	const token = USER_TOKEN();
	if (token === "") throw new CarrierNotConfigured("gdex");

	const subscriptionKey = SUBSCRIPTION_KEY();
	return carrierFetch<T>(`${baseUrl()}${path}`, {
		carrierId: "gdex",
		method,
		headers: {
			"User-Token": token,
			"subscription-key": subscriptionKey,
		},
		...(body === undefined ? {} : { body }),
		idempotent,
	});
}

/**
 * Every GDEX reply is `{ statusCode, data, message }` and the HTTP status
 * agrees with `statusCode` — `carrierFetch` has already thrown on a non-2xx by
 * the time these parse, so only the envelope's shape is in question here.
 */
const envelope = <T extends z.ZodType>(data: T) =>
	z.object({ statusCode: z.number(), data, message: z.string().nullish() });

const userDetailsSchema = envelope(
	z.object({
		Name: z.string(),
		Email: z.string(),
		MobileNumber: z.string(),
		Address1: z.string(),
		Address2: z.string().nullish(),
		PostalCode: z.string(),
		City: z.string().nullish(),
		LocationId: z.number(),
		Location: z.string(),
		State: z.string().nullish(),
	}),
);

const rateSchema = envelope(
	z.array(
		z.object({
			ReferenceNumber: z.number(),
			Rate: z.number(),
			HasError: z.boolean(),
			Error: z.string().nullish(),
		}),
	),
);

const consignmentSchema = envelope(
	z.object({
		InvoiceNumber: z.string().nullish(),
		ConsignmentNumbers: z.array(z.string()).min(1),
		GrandTotal: z.number().nullish(),
	}),
);

const statusSchema = envelope(
	z.array(
		z.object({
			ConsignmentNote: z.string(),
			ConsignmentNoteStatus: z.string().nullish(),
		}),
	),
);

/** Same reasoning as Lalamove's `readReply`: a ZodError path list explains nothing. */
function readReply<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const seen = JSON.stringify(payload) ?? String(payload);
	trace("gdex.unreadable", { what, payload: seen });
	throw new Error(`GDEX's ${what} reply was not the shape we expect: ${seen.slice(0, 200)}`);
}

/**
 * The sender block, from the GDEX account's own profile.
 *
 * Fetched on every quote and every booking rather than cached: it is one small
 * GET, it changes when someone edits the account, and a stale `LocationId` is a
 * parcel collected from an address the workshop moved out of.
 */
async function senderDetails(): Promise<GdexUserDetails> {
	const reply = readReply(
		userDetailsSchema,
		await call("GET", "/GetUserDetails", undefined, true),
		"user details",
	);
	return {
		...reply.data,
		Address2: reply.data.Address2 ?? null,
		City: reply.data.City ?? null,
		State: reply.data.State ?? null,
	};
}

export const gdexAdapter: CarrierAdapter = {
	id: "gdex",

	isConfigured: () => USER_TOKEN() !== "",

	async quote(job): Promise<CarrierQuote> {
		// Before anything is dialled: an unweighed or postcode-less job is
		// refused here, and the message goes on the comparison row.
		const weight = weightOf(job);
		trace("gdex.quote", { deliveryId: job.id, weight, items: job.items.length });

		const sender = await senderDetails();
		const reply = readReply(
			rateSchema,
			await call("POST", "/GetShippingRate", rateBody(job, sender.PostalCode), true),
			"rate",
		);

		const [row] = reply.data;
		if (row === undefined) {
			throw new GdexNotDeliverable("GDEX priced nothing for this job");
		}
		// A per-row error arrives inside a 200 — a rate of 0 with HasError true.
		// Reading only `Rate` would put "RM 0" on the comparison row and let an
		// admin book a parcel GDEX has already said it cannot carry.
		if (row.HasError) {
			throw new GdexNotDeliverable(row.Error ?? "GDEX would not price this job");
		}

		return {
			carrierId: "gdex",
			priceRm: row.Rate,
			// GDEX quotes a rate, not a time. Transit days depend on the lane and
			// are not in this reply; inventing minutes would put a promise on the
			// screen nobody made.
			etaMinutes: null,
			notes: `Parcel, ${weight} kg`,
		};
	},

	async book(job): Promise<CarrierBooking> {
		trace("gdex.book", { deliveryId: job.id });
		const sender = await senderDetails();

		// Not idempotent, and `carrierFetch` will not retry it: a retried
		// consignment is a second parcel and a second e-Wallet debit.
		const reply = readReply(
			consignmentSchema,
			await call("POST", "/CreateConsignment", consignmentBody(job, sender)),
			"consignment",
		);

		return {
			carrierOrderId: reply.data.ConsignmentNumbers[0],
			// GDEX returns no share link. Its public tracking page takes a
			// consignment number, but the URL is not in the API documentation, so
			// null is the honest answer rather than a guessed link an admin would
			// send to a customer.
			// ponytail: fill this in once the tracking URL is confirmed with GDEX.
			trackingUrl: null,
		};
	},

	async track(carrierOrderId): Promise<TrackingUpdate> {
		const reply = readReply(
			statusSchema,
			await call("POST", "/GetLastShipmentStatus", [carrierOrderId], true),
			"shipment status",
		);

		const row = reply.data.find((r) => r.ConsignmentNote === carrierOrderId) ?? reply.data[0];
		const status = row?.ConsignmentNoteStatus ?? "";

		return {
			// An unmapped word gives null, and `applyTrackingUpdate` leaves the row
			// where it is — see the docblock on `mapCarrierStatus`.
			status: status === "" ? null : mapCarrierStatus("gdex", status),
			message: `GDEX reports ${status || "no status"}`,
			raw: reply.data,
		};
	},

	async cancel(carrierOrderId): Promise<void> {
		// GDEX refuses once the consignment has been scanned, or after 14 days,
		// with a 400 whose message says which. `advance/route.ts` turns that into
		// `carrier_refused_cancel` and shows the message — a job that could not be
		// cancelled still has a parcel moving.
		await call(
			"PUT",
			`/CancelConsignment?ConsignmentNumber=${encodeURIComponent(carrierOrderId)}`,
		);
	},
};
```

- [ ] **Step 4: Run the whole suite**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
```

Expected: all green. `registry.ts` resolves again because `gdexAdapter` is back.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics/adapters/gdex.ts src/lib/logistics/__tests__/gdex.test.ts
git commit -m "feat(logistics): implement the gdex adapter

Quote, book, track, cancel. No verifyWebhook: GDEX documents no callback
operation, so the cron sweep is the only tracking channel and the webhook
route's 200-for-an-adapter-without-one is the correct answer."
```

---

## Task 5: The consignment label

A parcel that leaves the workshop without its consignment note taped to it does
not get collected. `Delivery.labelUrl` exists for exactly this (`a0f153e`), and
GDEX will hand over the note as a PDF — but only while the shipment is still
pending, so it has to be fetched at booking time and stored, not linked to.

**Depends on the EasyParcel session having landed `CarrierBooking.labelUrl` and
the `book/route.ts` write that persists it.** If they are not there when you
start, add them here: `labelUrl: string | null` on `CarrierBooking` in
`types.ts`, and `labelUrl: booking.labelUrl` in the `prisma.delivery.update` in
`book/route.ts`. Do not invent a second field name.

**Files:**
- Modify: `src/lib/logistics/adapters/gdex.ts` (the `book` method)
- Modify: `src/lib/logistics/__tests__/gdex.test.ts`
- Possibly modify: `src/lib/logistics/types.ts`, `src/app/api/admin/deliveries/[id]/book/route.ts` — only if the EasyParcel work has not already

**Two things make this awkward, and both are load-bearing:**

1. **The reply is a PDF, not JSON.** `carrierFetch` reads every 2xx body and
   `JSON.parse`s it, throwing `CarrierHttpError` when that fails — correct for
   every other call in this file and wrong for this one. The label fetch uses a
   bare `fetch` with the same headers and its own timeout. Do not loosen
   `carrierFetch` to accommodate it: one binary endpoint is not a reason to make
   every other carrier's error handling vaguer.
2. **A failed label must not fail the booking.** The consignment is already
   created and the e-Wallet already debited by the time this runs. A throw here
   would surface as a booking error for a booking that succeeded, and the
   `carrierOrderId` would be lost — the parcel would exist with nothing in our
   database pointing at it. Catch, trace, return `labelUrl: null`, and let the
   admin print from the myGDEX portal.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/logistics/__tests__/gdex.test.ts`, inside `describe("book")`:

```ts
it("stores the consignment note and returns its url", async () => {
	const fetchMock = vi.fn();
	fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(userDetailsResponse), { status: 200 }));
	fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(consignmentResponse), { status: 200 }));
	fetchMock.mockResolvedValueOnce(
		new Response(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const put = vi.fn().mockResolvedValue({ url: "https://blob.example/gdex/MY1700012345.pdf" });
	vi.doMock("@vercel/blob", () => ({ put }));

	const booking = await gdexAdapter.book(job(), { carrierId: "gdex", priceRm: 12.4, etaMinutes: null });

	expect(fetchMock.mock.calls[2][0]).toContain("/GetConsignmentsImage?ConsignmentNumber=MY1700012345");
	expect(booking.labelUrl).toBe("https://blob.example/gdex/MY1700012345.pdf");
});

it("still returns the booking when the label cannot be fetched", async () => {
	const fetchMock = vi.fn();
	fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(userDetailsResponse), { status: 200 }));
	fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(consignmentResponse), { status: 200 }));
	fetchMock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({ statusCode: 400, data: null, message: "Invalid Consignment Number" }),
			{ status: 400 },
		),
	);
	vi.stubGlobal("fetch", fetchMock);

	// The consignment exists and the wallet has already been debited. Losing the
	// carrierOrderId over a missing PDF would leave a parcel nothing points at.
	const booking = await gdexAdapter.book(job(), { carrierId: "gdex", priceRm: 12.4, etaMinutes: null });

	expect(booking.carrierOrderId).toBe("MY1700012345");
	expect(booking.labelUrl).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm test src/lib/logistics/__tests__/gdex.test.ts
```

Expected: FAIL — `labelUrl` is undefined, and only two fetches happen.

- [ ] **Step 3: Fetch and store the label**

Add to `src/lib/logistics/adapters/gdex.ts`:

```ts
import { put } from "@vercel/blob";

/**
 * The consignment note, as a PDF, stored so it can be printed later.
 *
 * GDEX only serves this while the shipment is pending — once it is cancelled,
 * delivered or returned the call 400s — so it is fetched at booking time rather
 * than linked to and fetched on demand.
 *
 * A bare `fetch` rather than `carrierFetch`, which JSON-parses every 2xx and
 * would reject a PDF as a broken contract. One binary endpoint is not a reason
 * to make every other carrier's error handling vaguer.
 *
 * Never throws. The consignment is already created and paid for by the time
 * this runs; a throw would report a failed booking for a booking that worked
 * and lose the consignment number with it.
 */
async function storeLabel(consignmentNumber: string): Promise<string | null> {
	try {
		const response = await fetch(
			`${baseUrl()}/GetConsignmentsImage?ConsignmentNumber=${encodeURIComponent(consignmentNumber)}`,
			{
				headers: { "User-Token": USER_TOKEN() },
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!response.ok) {
			trace("gdex.label.refused", {
				consignmentNumber,
				status: response.status,
				body: await response.text().catch(() => ""),
			});
			return null;
		}

		const blob = await put(`logistics/gdex/${consignmentNumber}.pdf`, await response.blob(), {
			access: "public",
			contentType: "application/pdf",
		});
		return blob.url;
	} catch (error) {
		trace("gdex.label.failed", { consignmentNumber, error });
		return null;
	}
}
```

And in `book`, replace the returned object:

```ts
		const carrierOrderId = reply.data.ConsignmentNumbers[0];
		return {
			carrierOrderId,
			// GDEX returns no share link. Its public tracking page takes a
			// consignment number, but the URL is not in the API documentation, so
			// null is the honest answer rather than a guessed link an admin would
			// send to a customer.
			// ponytail: fill this in once the tracking URL is confirmed with GDEX.
			trackingUrl: null,
			labelUrl: await storeLabel(carrierOrderId),
		};
```

- [ ] **Step 4: Check the label is public, and decide whether it should be**

The note carries the customer's name, phone and full address. It is stored
`access: "public"` because a warehouse phone has to open it from a link with no
admin cookie — the same trade-off `/api/cabinet-mesh/[id]` makes. The pathname
is the consignment number, which is guessable. **Raise this with the user
before merging**; the alternative is a private blob behind an
`/api/admin/deliveries/[id]/label` route, which is one more route and one more
auth check. Record whichever is chosen in a comment.

- [ ] **Step 5: Run everything**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/logistics/adapters/gdex.ts src/lib/logistics/__tests__/gdex.test.ts
git commit -m "feat(logistics): keep the GDEX consignment note

Fetched at booking time because GDEX only serves it while the shipment is
pending, and never allowed to fail the booking: the wallet is already debited
by then, and a lost consignment number is a parcel nothing points at."
```

---

## Task 6: Teach `status.ts` GDEX's vocabulary

`CARRIER_STATUS_MAPS.gdex` is `{}` today and its docblock says why: a guessed table maps statuses nobody sends and silently misses the ones they do. Fill it from what the sandbox actually returned in Task 1, plus the states named in the API documentation's own error copy (`Pending` in the status example, "already cancelled" and "already shipped" in the cancel rules).

**Files:**
- Modify: `src/lib/logistics/status.ts` (the `gdex: {}` entry)
- Modify: `src/lib/logistics/__tests__/status.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `mapCarrierStatus("gdex", …)` starts returning statuses; Task 4's `track` already calls it.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/logistics/__tests__/status.test.ts`:

```ts
describe("gdex statuses", () => {
	it("maps a freshly created consignment to booked", () => {
		expect(mapCarrierStatus("gdex", "Pending")).toBe("BOOKED");
	});

	it("normalises spacing and case the way every other carrier's table is", () => {
		expect(mapCarrierStatus("gdex", "IN TRANSIT")).toBe("IN_TRANSIT");
		expect(mapCarrierStatus("gdex", "in-transit")).toBe("IN_TRANSIT");
	});

	it("maps collection and delivery", () => {
		expect(mapCarrierStatus("gdex", "Picked Up")).toBe("PICKED_UP");
		expect(mapCarrierStatus("gdex", "Delivered")).toBe("DELIVERED");
	});

	it("maps the two ways a parcel ends badly", () => {
		expect(mapCarrierStatus("gdex", "Cancelled")).toBe("CANCELLED");
		expect(mapCarrierStatus("gdex", "Returned")).toBe("FAILED");
	});

	it("returns null for a word we have not seen, rather than inventing a move", () => {
		expect(mapCarrierStatus("gdex", "Bagged")).toBeNull();
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm test src/lib/logistics/__tests__/status.test.ts
```

Expected: FAIL — every `mapCarrierStatus("gdex", …)` returns null against the empty table.

- [ ] **Step 3: Fill the table**

Replace `gdex: {},` in `src/lib/logistics/status.ts` with:

```ts
	/**
	 * GDEX's consignment-note statuses.
	 *
	 * `Pending` is a note that exists and has not been collected — our `BOOKED`,
	 * not our `DRAFT`, because the money has already left the e-Wallet.
	 *
	 * There is no driver-assigned state: a parcel network does not tell us which
	 * courier has the job, so a GDEX delivery never reaches `DRIVER_ASSIGNED`,
	 * and the journey tracker showing that stop as skipped is the truth rather
	 * than a hole in this table.
	 *
	 * `Returned` is a `FAILED`: the parcel came back and somebody has to phone
	 * the customer. It is not a `CANCELLED`, which is a decision we made.
	 *
	 * Extend this from `scripts/gdex-ping.mjs` output rather than from guesses —
	 * an unmapped word returns null and leaves the row alone, which is safe.
	 */
	gdex: {
		pending: "BOOKED",
		picked_up: "PICKED_UP",
		collected: "PICKED_UP",
		in_transit: "IN_TRANSIT",
		out_for_delivery: "IN_TRANSIT",
		delivered: "DELIVERED",
		cancelled: "CANCELLED",
		canceled: "CANCELLED",
		returned: "FAILED",
	},
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test src/lib/logistics/__tests__/status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit — on its own, and say where the words came from**

```bash
git add src/lib/logistics/status.ts src/lib/logistics/__tests__/status.test.ts
git commit -m "feat(logistics): map GDEX's consignment statuses

Taken from the sandbox's own replies via gdex-ping, not guessed. No
driver-assigned state: a parcel network does not name the courier."
```

---

## Task 7: Let a carrier's rejection reach the screen

Found while tracing the booking path, and GDEX makes it matter: `book/route.ts` catches everything that is not `CarrierNotConfigured` and answers `502 { error: "booking failed: <message>" }`. That `error` is a sentence, not a code, so `messageFor` in `errors.ts` misses it and the admin sees the generic fallback. The carrier's actual words survive only in the `DeliveryEvent` timeline.

For Lalamove that cost a `LalamoveNotDeliverable` explanation. For GDEX it costs **"Insufficient Credit"** — the single most likely booking failure, entirely fixable by the person reading the screen, and today invisible to them. `advance/route.ts` already does this correctly with `carrier_refused_cancel`; this is the same shape on the booking path.

**Files:**
- Modify: `src/app/api/admin/deliveries/[id]/book/route.ts:95-118` (the catch block)
- Modify: `src/app/admin/logistics/errors.ts`
- Modify: `src/app/admin/logistics/LogisticsManager.tsx` (the booking error branch)
- Test: `src/app/admin/logistics/__tests__/errors.test.ts`

**Interfaces:**
- Produces: a `502 { error: "carrier_refused", message: string }` body. The `DeliveryEvent` write in that catch block stays exactly as it is.

- [ ] **Step 1: Write the failing test**

Append to `src/app/admin/logistics/__tests__/errors.test.ts`:

```ts
it("passes a refused booking through with the carrier's own words", () => {
	expect(messageFor("carrier_refused", "Booking failed")).toBe(
		"The partner refused this booking.",
	);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm test src/app/admin/logistics/__tests__/errors.test.ts
```

Expected: FAIL — returns the fallback `"Booking failed"`.

- [ ] **Step 3: Add the code to `errors.ts`**

In the map inside `messageFor`, alongside `carrier_not_configured`:

```ts
	carrier_refused: "The partner refused this booking.",
```

- [ ] **Step 4: Return the code from the route**

In `src/app/api/admin/deliveries/[id]/book/route.ts`, in the catch block, replace the final `502` response. The `DeliveryEvent` write above it is unchanged.

```ts
		// A code rather than a sentence, so `messageFor` can translate it — and
		// the carrier's own words alongside, because "Insufficient Credit" is
		// something the admin can act on and the generic fallback is not.
		return NextResponse.json(
			{ error: "carrier_refused", message },
			{ status: 502 },
		);
```

- [ ] **Step 5: Show the message in the UI**

In `LogisticsManager.tsx`, in the booking error branch, mirror what the cancel path already does with `carrier_refused_cancel`: when the body's `error` is `carrier_refused`, render `messageFor(...)` followed by the body's `message`. Do not replace the generic sentence — append the carrier's, so an unreadable carrier reply still leaves something on screen.

- [ ] **Step 6: Run everything**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/admin/deliveries/\[id\]/book/route.ts src/app/admin/logistics/errors.ts src/app/admin/logistics/__tests__/errors.test.ts src/app/admin/logistics/LogisticsManager.tsx
git commit -m "fix(logistics): show why a carrier refused a booking

The route answered a sentence where errors.ts expects a code, so every
booking failure read as the generic fallback and the carrier's own reason
lived only in the event timeline. GDEX's 'Insufficient Credit' is exactly the
kind the admin can fix."
```

---

## Task 8: Tell the admin that weight is what a parcel partner prices on

The Weight kg input already exists (`LogisticsManager.tsx:451-467`). The sentence under the item list says weight is optional and a guessed figure would be quoted against — true when Lalamove was the only partner, and now the reason GDEX cannot quote. Change the copy, not the schema: `weightKg` stays nullable because a lorry job genuinely does not need one.

**Files:**
- Modify: `src/app/admin/logistics/LogisticsManager.tsx:493-499`
- Modify: `README.md` (the env-var table, lines ~62-71)

- [ ] **Step 1: Change the summary copy**

Replace the paragraph at `LogisticsManager.tsx:493-499` with copy that says which partners need it. Keep sentence case; keep the existing `totalVolumeM3` / weight / `suggestion.label` line intact:

```tsx
			<p className="text-[12px] text-neutral-500">
				{totalVolumeM3(items)} m³
				{weight === null ? ", weight not given" : `, ${weight} kg`} —{" "}
				<span className="text-neutral-900">{suggestion.label}</span>. The
				vehicle partners price by distance and do not need a weight. The parcel
				partners price by the kilogram and cannot quote without one.
			</p>
```

- [ ] **Step 2: Correct the env-var table in `README.md`**

The table documents `GDEX_API_KEY`, which is not what `.env.local` holds and not what the adapter reads. Replace that row with the real names, and add the environment flag:

| Variable | For |
| --- | --- |
| `GDEX_PRIMARY_API_KEY` | GDEX — the Azure APIM subscription key from the developer portal, sent as the `subscription-key` header. Not `Ocp-Apim-Subscription-Key`; GDEX renamed it. `GDEX_SECONDARY_API_SECRET` is APIM's rotation spare for this key, not a signing secret, and nothing reads it. |
| `GDEX_USER_TOKEN` | GDEX — the myGDEX account's Integration Token, sent as `User-Token`. From the myGDEX **web application** (User Profile → Integration Token), not the developer portal. |
| `GDEX_LIVE` | `1` to book against GDEX production. Anything else, including unset, uses the sandbox host. |

While there, correct the two stale claims the same table sits under: only Lalamove was implemented (now Lalamove and GDEX), and unconfigured carriers do still appear in the comparison as an explanatory row.

- [ ] **Step 3: Run the checks**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
```

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/logistics/LogisticsManager.tsx README.md
git commit -m "docs(logistics): say which partners price on weight

And correct the GDEX env-var names, which documented a key the adapter never
reads and .env.local never held."
```

---

## Verification

Run in order. Steps 1–3 need no GDEX account; step 4 spends sandbox e-Wallet credit and should be done with the user watching.

1. **The suite.** `pnpm test` — expect the existing 969 plus roughly 40 new. `pnpm exec tsc --noEmit`, `pnpm lint`.
2. **The ping.** `pnpm gdex:ping` — `GetUserTokenValidity` answers 200, `GetUserDetails` returns the workshop's registered address and a numeric `LocationId`, `GetShippingRate` returns a rate for the hardcoded postcode pair.
3. **The comparison screen.** `pnpm db:up && pnpm dev`, then `/admin/logistics`:
   - Create a delivery with a site address that **has** a postcode and items with **no** weight. Compare partners → the GDEX row shows, in red, *"This job has no weight — GDEX prices by the kilogram…"*, and cannot be selected.
   - Edit the job, give each item a weight, set Scheduled to two days out. Compare again → GDEX shows a price in RM and *"Parcel, N kg"*.
   - Edit the site address to strip the postcode, compare → the GDEX row explains the postcode, not a generic failure.
   - Clear Scheduled, compare → GDEX still quotes (a rate needs no date), but attempting to book refuses naming Scheduled. *(If you would rather it refuse at quote time, move the `pickupInfo` call into `quote` — but a rate that costs nothing is worth showing.)*
4. **A real sandbox booking**, with the user present. Book the weighted job with GDEX. Expect: a `Delivery` row with `carrierId: "gdex"`, a `carrierOrderId` shaped `MY17…`, `trackingUrl` null, status `BOOKED`, and a `DeliveryEvent` whose `raw` holds the consignment reply. Then press Refresh on the shipment panel → a `POLL` event appears; if its message names a status word not in `CARRIER_STATUS_MAPS.gdex`, add it in a follow-up commit to `status.ts` alone.
   Also check `labelUrl`: it should hold a Blob URL that opens as a printable consignment note. A null here is a Task 5 failure, not a booking failure — read the `gdex.label.*` trace lines with `LOGISTICS_DEBUG=1`.
5. **The webhook route is inert for GDEX, by design.** `curl -X POST localhost:3000/api/webhooks/gdex -d '{}'` → `200 {"received":true}`. Nothing is written. That is the adapter having no `verifyWebhook`, not a bug.
6. **The cron sweep picks it up.** With a booked GDEX job, `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/track-deliveries` → `{"ok":true,"polled":1,"failed":0}`.

---

## Open questions — raise with the client, do not guess in code

- **The public tracking URL.** GDEX returns no share link, so `trackingUrl` is null and the admin has nothing to send the customer. GDEX's website tracks by consignment number; the URL format is not in the API documentation. One answer from the client removes the `ponytail:` comment in `book`.
- **`ShipmentValue`.** Sent as `0` with `IsInsurance: false`. The field is what enhanced liability prices on, and nothing in this app knows what a box of handles is worth. If EzCabinet wants cover on parcels, this becomes a form field and `IsInsurance` becomes a choice.
- **Pickup transportation.** `TRANSPORTATION` maps our four vehicle classes onto GDEX's three by size. Whether GDEX charges differently for a van versus a motorbike collection is not in the rate API, which prices only weight and lane.
- **The sender is always the GDEX account's registered address.** If an admin edits `pickupAddress` to somewhere else, GDEX still collects from the account address, because `LocationId` cannot be derived from arbitrary text without a `GetPostcodeLocations` lookup that returns many locations per postcode with no way to choose. If collecting from a second address is a real need, that is a follow-up using `GetPostcodeLocations`.
- **Transit time.** `etaMinutes` is null. GDEX publishes lane transit days but not through this API.
- **Is a public label URL acceptable?** The consignment note carries the customer's name, phone and full address, and Task 5 stores it in a public Blob so a warehouse phone can open it without an admin cookie. The pathname is the consignment number, which is guessable. The alternative is a private blob behind `/api/admin/deliveries/[id]/label`.

---

## Appendix A — the GDEX operations this plan uses

Transcribed from the myGDEX Open API (Testing) portal, 2026-09-06. Sandbox base `https://myopenapi.gdexpress.com/test/api/MyGDex`. Auth is a `User-Token` header; the portal's Overview page also documents an APIM subscription key as a separate "Developer Access Token". Every reply is `{ statusCode, data, message }`.

**`POST /GetShippingRate`** — body is an array of `{ ReferenceNumber: int, FromPostCode: string, ToPostCode: string, ParcelType: "Parcel"|"Document", Weight: double (kg), Country: "MYS" }`. Reply `data: [{ ReferenceNumber, Rate, HasError, Error }]`. A bad postcode returns **200** with `HasError: true`, `Rate: 0`, `Error: "Postal code 460501 not found"`.

**`POST /CreateConsignment`** — max 10 consignment notes per call. Charges the e-Wallet. Sender fields required: `Name`, `Mobile`, `Email`, `Address1`, `Postcode`, `LocationId` (int), `Location`. Optional: `Address2`, `Address3`, `City`, `State`, `Pickup`.
`Pickup` = `{ Transportation: "Motorbike"|"Van"|"OffsizeTruck", ParcelReadyTime, PickupDate (date-time, max 5 days advance), PickupRemark?, IsTrolleyRequired: bool }`.
`Consignments[]` required: `ParcelType`, `ShipmentValue` (double, RM), `Pieces` (max 15), `Weight` (kg), `Mobile`, `Address1`, `Postcode`, `Country`. Optional: `OrderId`, `ShipmentContent`, `Name`, `Email`, `Address2`, `Address3`, `City`, `State`, `IsInsurance`, `IsTrackingSms`, `Note1`, `Note2`, `internationalItem`.
Reply `data: { InvoiceNumber, ConsignmentNumbers: [], Consignments: [{ OrderId, ConsignmentNumber, Rate }], GrandTotal, EWalletBalance }`.
400 messages include `"Insufficient Credit"`, `"Invalid PostCode 12345"`, `"Service Temporarily suspended for this postcode 53100"`, `"Invalid Weight"`.

**`POST /GetLastShipmentStatus`** — body is an array of consignment numbers. Reply `data: [{ ConsignmentNote, ConsignmentNoteStatus }]`. The documented example status is `"Pending"`.

**`GET /GetShipmentStatusDetail?ConsignmentNumber=`** — the same plus a `Scans` array (chronology). 400 `"Consignment Number Not Found"`. Not used by this plan; the upgrade path if per-scan timestamps are ever wanted.

**`PUT /CancelConsignment?ConsignmentNumber=`** — refunds to the e-Wallet. 400 messages: `"No record found"`, `"Unauthorized access"`, `"Consignment already cancelled"`, `"Unable to cancel consignment after 14 days"`, `"Shipment is already shipped"`.

**`GET /GetConsignmentsImage?ConsignmentNumber=`** — note the plural in the path; the portal lists it as "Get Consignment Image". Returns the consignment note **as a PDF body**, not JSON. Only served while the shipment is pending: 400 `"Image cannot be provided as Consignment has been cancelled "`, `"… has been delivered"`, `"… has been returned"`, `"Invalid Consignment Number"`. There is also a `POST /GetConsignmentImagesZipped` for batches, unused here.

**`GET /GetUserDetails`** — `data: { Name, Email, MobileNumber, Address1, Address2, PostalCode, City, LocationId, Location, State, Country }`. This is the sender block.

**`GET /GetUserTokenValidity`** — 200 `data: null` when valid, 401 `"Invalid User Token"` otherwise.

**`GET /GetPostcodeLocations?Postcode=`** — `data: { Postcode, State, StateId, DistrictList: [{ DistrictId, District, LocationList: [{ LocationId, Location, IsNSA }] }] }`. Not used by this plan — the sender's `LocationId` comes from the account profile instead.

**`GET /CheckEWalletBalance`** — `data` is a bare number. Deliberately unused; see decision 4 in Context.

**There is no webhook, callback, or subscription operation.** The seventeen operations are the four above plus pickup management (`Cancel Pick Up`, `Get Available Pick Up Time Slots`, `Get Pick Up Date Listing`, `Get Pick Up Reference`, `Get Upcoming Pick Up Details`), consignment images, station codes, and the wallet. Tracking is a poll.
