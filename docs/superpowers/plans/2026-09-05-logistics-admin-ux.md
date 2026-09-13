# Deliveries screen UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/admin/logistics` say what it knows and offer every action it
tells an admin to take — starting with editing a job whose address did not
geocode.

**Architecture:** The screen keeps its shape: one client component
(`LogisticsManager.tsx`) fetching `/api/admin/deliveries*` and re-reading after
each mutation. The change is to pull the pure parts out of that component into
two plain modules that vitest can hold — form state mapping colocated in
`src/app/admin/logistics/form.ts`, coordinate and pin reasoning in
`src/lib/logistics/coords.ts` — and then render what those functions return.
No new endpoint: `PATCH /api/admin/deliveries/[id]` already exists and already
refuses booked jobs.

**Tech Stack:** Next.js App Router (client component), TypeScript, Tailwind,
Vitest, Biome, Prisma (untouched).

**Spec:** `docs/superpowers/specs/2026-09-05-logistics-admin-ux.md`

## Global Constraints

- Package manager is **pnpm**. Tests: `pnpm vitest run <path>`. Lint and format:
  `pnpm biome check --write <path>`. Types: `npx tsc --noEmit`.
- UI copy is **sentence case**. Prices are **RM**.
- `src/lib/planner` must stay framework-free — untouched by this plan.
- `src/lib/logistics/coords.ts` is **isomorphic**: no `server-only`, no
  `process.env`, no `prisma`. It is imported by a client component. Modules
  that hold credentials (`registry.ts`, the adapters, `geocode.ts`) are
  `server-only` and must never be imported from `LogisticsManager.tsx`.
- Zod stays the source of truth for API payloads; this plan adds no new
  request shape, so `deliveryInputSchema` is not edited.
- A booked job (`carrierOrderId !== null`, or status past `QUOTED`) is never
  editable from this screen.
- Commit each task on its own. Do not amend a previous task's commit.

## Starting state

The working tree already carries an **uncommitted, unreviewed** first cut of
the edit path in `src/app/admin/logistics/LogisticsManager.tsx`: an `id` on the
form state, `formFrom`, `localDateTime`, an `EDITABLE` set, an `Edit` button on
each row, and a `save()` that PATCHes when `state.id !== null`. Task 1 is where
that work gets extracted, tested and committed. Do not `git checkout` the file;
build on it.

## File structure

| File | Responsibility |
| --- | --- |
| `src/app/admin/logistics/form.ts` | **new.** Form state: its shape, a blank one, one built from a saved row, and the request body it becomes. Pure, no React. |
| `src/app/admin/logistics/__tests__/form.test.ts` | **new.** Round-trip and payload tests for the above. |
| `src/lib/logistics/coords.ts` | **new.** A pasted pin parsed into numbers, and the three-way state of a stored pin. Isomorphic. |
| `src/lib/logistics/__tests__/coords.test.ts` | **new.** |
| `src/app/admin/logistics/errors.ts` | **new.** API error code to a sentence an admin can act on. |
| `src/app/admin/logistics/__tests__/errors.test.ts` | **new.** |
| `src/app/admin/logistics/LogisticsManager.tsx` | Rendering only: consumes the three modules above. |
| `src/app/admin/logistics/page.tsx` | Passes `geocodingConfigured` down. |
| `src/app/api/admin/deliveries/route.ts` | GET also reports `geocodingConfigured`. |

---

### Task 1: The edit path, extracted and tested

**Files:**
- Create: `src/app/admin/logistics/form.ts`
- Create: `src/app/admin/logistics/__tests__/form.test.ts`
- Modify: `src/app/admin/logistics/LogisticsManager.tsx`

**Interfaces:**
- Consumes: `DeliveryItem` from `@/lib/logistics/types`; `DeliveryRow` as
  exported today from `LogisticsManager.tsx`.
- Produces:
  - `type FormItem = DeliveryItem & { uid: string }`
  - `type FormState` — `{ id: string | null; customerName: string; customerPhone: string; siteAddress: string; addressNotes: string; pickupAddress: string; siteCoords: string; pickupCoords: string; scheduledAt: string; items: FormItem[] }`
  - `emptyItem(): FormItem`
  - `blankForm(workshopAddress: string): FormState`
  - `formFrom(row: DeliveryRow): FormState`
  - `localDateTime(iso: string | null): string`
  - `toPayload(state: FormState): Record<string, unknown>`
  - `EDITABLE: Set<DeliveryStatusName>`

To avoid a cycle (`form.ts` needs `DeliveryRow`, which lives in the component
that imports `form.ts`), move the `DeliveryRow`, `DeliveryEventRow` and
`QuoteRow` type declarations **into `form.ts`** and re-export them from
`LogisticsManager.tsx` for any existing importer:
`export type { DeliveryRow } from "./form";`

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/logistics/__tests__/form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type DeliveryRow, blankForm, formFrom, toPayload } from "../form";

const row: DeliveryRow = {
	id: "d1",
	number: 3,
	customerName: "Tesing Customer",
	customerPhone: "012345678",
	siteAddress: "12 Jalan Setia, Shah Alam",
	addressNotes: "Gate code 1234",
	pickupAddress: "EzCabinet Sdn Bhd, Klang Valley, Selangor",
	siteLat: 3.1509,
	siteLng: 101.5931,
	pickupLat: null,
	pickupLng: null,
	items: [
		{ label: "Base unit", qty: 2, widthMm: 800, heightMm: 720, depthMm: 560, weightKg: null },
	],
	totalWeightKg: null,
	totalVolumeM3: 0.645,
	scheduledAt: null,
	carrierId: null,
	status: "DRAFT",
	quotedPriceRm: null,
	carrierOrderId: null,
	trackingUrl: null,
	driverName: null,
	driverPhone: null,
	vehiclePlate: null,
	lastLatitude: null,
	lastLongitude: null,
	lastLocationAt: null,
	bookedBy: null,
	createdAt: "2026-09-05T13:28:14.000Z",
};

describe("formFrom", () => {
	it("carries the row's id so a save becomes a PATCH", () => {
		expect(formFrom(row).id).toBe("d1");
	});

	it("shows the stored pin in the coords field", () => {
		expect(formFrom(row).siteCoords).toBe("3.1509, 101.5931");
	});

	it("leaves the coords field empty when there is no pin", () => {
		expect(formFrom(row).pickupCoords).toBe("");
	});

	it("gives every item a key React can keep across edits", () => {
		const uids = formFrom({ ...row, items: [...row.items, ...row.items] }).items.map(
			(i) => i.uid,
		);
		expect(new Set(uids).size).toBe(2);
	});
});

describe("toPayload", () => {
	it("strips the form-only uid", () => {
		const body = toPayload(formFrom(row));
		expect(JSON.stringify(body)).not.toContain("uid");
	});

	it("drops items with no label, so a blank spare row is not saved", () => {
		const state = blankForm("Workshop");
		expect(toPayload(state).items).toEqual([]);
	});

	it("sends an empty access note as null, not an empty string", () => {
		expect(toPayload(blankForm("Workshop")).addressNotes).toBeNull();
	});

	it("sends the pasted pin as a coordinate override", () => {
		const state = { ...blankForm("Workshop"), siteCoords: "3.15, 101.59" };
		expect(toPayload(state)).toMatchObject({ siteLat: 3.15, siteLng: 101.59 });
	});

	it("round-trips a scheduled time through the local datetime field", () => {
		const iso = new Date("2026-09-10T09:30:00+08:00").toISOString();
		const state = formFrom({ ...row, scheduledAt: iso });
		expect(toPayload(state).scheduledAt).toBe(iso);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/admin/logistics/__tests__/form.test.ts`
Expected: FAIL — `Failed to resolve import "../form"`.

- [ ] **Step 3: Create `form.ts` by moving code out of the component**

Cut `FormItem`, `emptyItem`, `blankForm`, `FormState`, `localDateTime`,
`formFrom`, `EDITABLE`, `parseCoords` and the row types out of
`LogisticsManager.tsx` into `src/app/admin/logistics/form.ts`, and add
`toPayload` built from the body `save()` currently inlines:

```ts
import type {
	DeliveryItem,
	DeliveryStatusName,
} from "@/lib/logistics/types";

/**
 * The delivery form as state, and the two translations either side of it: a
 * saved row into fields, and fields into the request body.
 *
 * Split out of the component because it is the only part of this screen worth
 * testing — a timezone slip or a dropped field here is a lorry at the wrong
 * place, and none of it needs React to prove.
 */

/** A delivery as JSON hands it back: dates are strings on this side. */
export type DeliveryRow = {
	id: string;
	number: number;
	customerName: string;
	customerPhone: string;
	siteAddress: string;
	addressNotes: string | null;
	pickupAddress: string;
	siteLat: number | null;
	siteLng: number | null;
	pickupLat: number | null;
	pickupLng: number | null;
	items: DeliveryItem[];
	totalWeightKg: number | null;
	totalVolumeM3: number | null;
	scheduledAt: string | null;
	carrierId: string | null;
	status: DeliveryStatusName;
	quotedPriceRm: number | null;
	carrierOrderId: string | null;
	trackingUrl: string | null;
	driverName: string | null;
	driverPhone: string | null;
	vehiclePlate: string | null;
	lastLatitude: number | null;
	lastLongitude: number | null;
	lastLocationAt: string | null;
	bookedBy: string | null;
	createdAt: string;
};

export type DeliveryEventRow = {
	id: string;
	at: string;
	source: string;
	status: DeliveryStatusName | null;
	message: string;
	actor: string | null;
};

export type QuoteRow = {
	carrierId: string;
	priceRm: number | null;
	etaMinutes: number | null;
	notes?: string;
	error?: string;
};

/** What `PATCH /api/admin/deliveries/[id]` accepts: nothing a carrier holds yet. */
export const EDITABLE = new Set<DeliveryStatusName>(["DRAFT", "QUOTED"]);

/**
 * A form row carries a `uid` the item itself does not: React needs a stable key
 * while rows are added and removed mid-edit, and an index would re-use the key
 * of a deleted row and hand its input state to its replacement. Stripped before
 * the job is saved — nothing outside this form knows about it.
 */
export type FormItem = DeliveryItem & { uid: string };

export const emptyItem = (): FormItem => ({
	uid: crypto.randomUUID(),
	label: "",
	qty: 1,
	widthMm: 600,
	heightMm: 720,
	depthMm: 560,
	weightKg: null,
});

export const blankForm = (workshopAddress: string) => ({
	id: null as string | null,
	customerName: "",
	customerPhone: "",
	siteAddress: "",
	addressNotes: "",
	pickupAddress: workshopAddress,
	siteCoords: "",
	pickupCoords: "",
	scheduledAt: "",
	items: [emptyItem()],
});

export type FormState = ReturnType<typeof blankForm>;

/** `<input type="datetime-local">` wants local wall time, not the stored UTC. */
export function localDateTime(iso: string | null): string {
	if (!iso) return "";
	const at = new Date(iso);
	return new Date(at.getTime() - at.getTimezoneOffset() * 60000)
		.toISOString()
		.slice(0, 16);
}

const pinField = (lat: number | null, lng: number | null) =>
	lat !== null && lng !== null ? `${lat}, ${lng}` : "";

/**
 * An existing job back into the same form. A pin only shows here if one was
 * pasted or geocoded; either way it is what the next save re-sends, so clearing
 * the field is how an admin asks for the address to be looked up again.
 */
export const formFrom = (row: DeliveryRow): FormState => ({
	id: row.id,
	customerName: row.customerName,
	customerPhone: row.customerPhone,
	siteAddress: row.siteAddress,
	addressNotes: row.addressNotes ?? "",
	pickupAddress: row.pickupAddress,
	siteCoords: pinField(row.siteLat, row.siteLng),
	pickupCoords: pinField(row.pickupLat, row.pickupLng),
	scheduledAt: localDateTime(row.scheduledAt),
	items: row.items.map((item) => ({ ...item, uid: crypto.randomUUID() })),
});

/** The form as the create and edit endpoints want it. */
export function toPayload(state: FormState) {
	// Task 2 replaces this with the `{ ok }` result from
	// `@/lib/logistics/coords`; until then it is the null-returning copy moved
	// out of the component, and the two `?? null`s below are the same fallback.
	const site = parseCoords(state.siteCoords);
	const pickup = parseCoords(state.pickupCoords);
	return {
		customerName: state.customerName,
		customerPhone: state.customerPhone,
		siteAddress: state.siteAddress,
		addressNotes: state.addressNotes || null,
		pickupAddress: state.pickupAddress,
		siteLat: site?.lat ?? null,
		siteLng: site?.lng ?? null,
		pickupLat: pickup?.lat ?? null,
		pickupLng: pickup?.lng ?? null,
		scheduledAt: state.scheduledAt
			? new Date(state.scheduledAt).toISOString()
			: null,
		items: state.items
			.filter((i) => i.label.trim() !== "")
			.map(({ uid: _uid, ...item }) => item),
	};
}
```

Move the existing `parseCoords` into `form.ts` unchanged for now — it returns
`{ lat, lng } | null`. Task 2 replaces it with the `{ ok }` result from
`@/lib/logistics/coords` and rewrites those four lines. The tests above assert
the payload, not the parser, so they hold across that swap.

- [ ] **Step 4: Point the component at the new module**

In `LogisticsManager.tsx`: delete the moved declarations, add

```ts
import {
	EDITABLE,
	type DeliveryRow,
	type FormItem,
	type FormState,
	blankForm,
	emptyItem,
	formFrom,
	toPayload,
} from "./form";

export type { DeliveryEventRow, DeliveryRow, QuoteRow } from "./form";
```

and reduce `save()`'s body to `body: JSON.stringify(toPayload(state))`.

- [ ] **Step 5: Say which job is being edited**

The form renders at the top of the page, far from the row that opened it. In
`DeliveryForm`, above the first field grid:

```tsx
{state.id !== null && (
	<p className="text-[13px] text-neutral-500">
		Editing <span className="text-neutral-900">{state.customerName}</span>.
		Saving re-checks the address, so a corrected line gets a fresh map pin.
	</p>
)}
```

and in `LogisticsManager`, make the Edit button scroll the form into view:

```tsx
onClick={() => {
	setForm(formFrom(row));
	window.scrollTo({ top: 0, behavior: "smooth" });
}}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `pnpm vitest run src/app/admin/logistics/__tests__/form.test.ts && npx tsc --noEmit`
Expected: all form tests PASS, tsc silent.

- [ ] **Step 7: Format and commit**

```bash
pnpm biome check --write src/app/admin/logistics
git add src/app/admin/logistics
git commit -m "feat(logistics): edit a delivery that has not been booked"
```

---

### Task 2: A pasted pin that is read, or refused out loud

**Files:**
- Create: `src/lib/logistics/coords.ts`
- Create: `src/lib/logistics/__tests__/coords.test.ts`
- Modify: `src/app/admin/logistics/form.ts` (import `parseCoords` from the new module, delete the local copy)
- Modify: `src/app/admin/logistics/LogisticsManager.tsx` (render the hint under the two pin fields)

**Interfaces:**
- Produces:
  - `type ParsedCoords = { ok: true; lat: number; lng: number } | { ok: false; reason: "empty" | "short-link" | "unreadable" }`
  - `parseCoords(raw: string): ParsedCoords`
  - `COORDS_HINT: Record<"short-link" | "unreadable", string>`
- Consumed by: `form.ts` (`toPayload`) and `DeliveryForm`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/logistics/__tests__/coords.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCoords } from "../coords";

describe("parseCoords", () => {
	it("reads the bare pair a long-press copies", () => {
		expect(parseCoords("3.1509, 101.5931")).toEqual({
			ok: true,
			lat: 3.1509,
			lng: 101.5931,
		});
	});

	it("reads it without the space", () => {
		expect(parseCoords("3.1509,101.5931")).toMatchObject({ ok: true });
	});

	it("reads the pin out of a full Google Maps url", () => {
		expect(
			parseCoords("https://www.google.com/maps/@3.1509,101.5931,17z"),
		).toEqual({ ok: true, lat: 3.1509, lng: 101.5931 });
	});

	it("reads the pin out of a place url's q parameter", () => {
		expect(
			parseCoords("https://maps.google.com/?q=3.1509,101.5931&z=17"),
		).toEqual({ ok: true, lat: 3.1509, lng: 101.5931 });
	});

	it("reads the !3d!4d pin a shared place url carries", () => {
		expect(
			parseCoords(
				"https://www.google.com/maps/place/Shah+Alam/data=!3m1!4b1!4d101.5931!3d3.1509",
			),
		).toEqual({ ok: true, lat: 3.1509, lng: 101.5931 });
	});

	it("names a short link rather than shrugging at it", () => {
		expect(parseCoords("https://maps.app.goo.gl/abc123")).toEqual({
			ok: false,
			reason: "short-link",
		});
	});

	it("treats an empty field as empty, not as a mistake", () => {
		expect(parseCoords("   ")).toEqual({ ok: false, reason: "empty" });
	});

	it("refuses a pair that is not on Earth", () => {
		expect(parseCoords("300, 101.5931")).toEqual({
			ok: false,
			reason: "unreadable",
		});
	});

	it("refuses a lone number", () => {
		expect(parseCoords("3.1509")).toEqual({ ok: false, reason: "unreadable" });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/coords.test.ts`
Expected: FAIL — `Failed to resolve import "../coords"`.

- [ ] **Step 3: Write `coords.ts`**

```ts
/**
 * A map pin as an admin pasted it.
 *
 * Pure and isomorphic — the delivery form imports this, so nothing here may
 * touch the network, the environment, or a credential.
 *
 * The field used to take one shape, `"3.15, 101.59"`, and answer every other
 * paste with null — which the form stored as "no pin given", indistinguishable
 * from an empty field. What a phone puts on the clipboard from Google Maps is
 * a URL, so the common paste was the silent one.
 */

export type ParsedCoords =
	| { ok: true; lat: number; lng: number }
	| { ok: false; reason: "empty" | "short-link" | "unreadable" };

/** Malaysia is well inside both, but a swapped pair is not, so check the world. */
const onEarth = (lat: number, lng: number) =>
	Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

const PAIR = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/;
/** `/@lat,lng,17z` — the map's own viewport, and the pin when one is dropped. */
const AT = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
/** `!3dlat!4dlng` — how a shared place url carries the pin. Longitude first. */
const BANG = /!3d(-?\d+(?:\.\d+)?).*?!4d(-?\d+(?:\.\d+)?)|!4d(-?\d+(?:\.\d+)?).*?!3d(-?\d+(?:\.\d+)?)/;

export function parseCoords(raw: string): ParsedCoords {
	const text = raw.trim();
	if (text === "") return { ok: false, reason: "empty" };

	// A shortened link is a redirect, and following it is a server-side fetch of
	// a url someone pasted. Ask for the pin instead — Maps offers it two taps
	// away, and this stays a pure function.
	if (/goo\.gl|maps\.app|g\.co\//i.test(text)) {
		return { ok: false, reason: "short-link" };
	}

	const bang = BANG.exec(text);
	if (bang) {
		const lat = Number(bang[1] ?? bang[4]);
		const lng = Number(bang[2] ?? bang[3]);
		if (onEarth(lat, lng)) return { ok: true, lat, lng };
	}

	const at = AT.exec(text);
	if (at) {
		const lat = Number(at[1]);
		const lng = Number(at[2]);
		if (onEarth(lat, lng)) return { ok: true, lat, lng };
	}

	// Last, and only on the query part of a url, so a street number in a path
	// cannot be read as a latitude.
	const pair = PAIR.exec(text.includes("?") ? text.slice(text.indexOf("?")) : text);
	if (pair) {
		const lat = Number(pair[1]);
		const lng = Number(pair[2]);
		if (onEarth(lat, lng)) return { ok: true, lat, lng };
	}

	return { ok: false, reason: "unreadable" };
}

export const COORDS_HINT = {
	"short-link":
		"That is a shortened Maps link. Open it, long-press the pin, and paste the numbers it copies.",
	unreadable:
		"That is not a map pin. Paste two numbers — “3.1509, 101.5931” — or a full Google Maps link.",
} as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/logistics/__tests__/coords.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Use it in the form, and show the hint**

In `form.ts`, delete the local `parseCoords`, add
`import { parseCoords } from "@/lib/logistics/coords";`, and change the four
override lines in `toPayload`:

```ts
		siteLat: site.ok ? site.lat : null,
		siteLng: site.ok ? site.lng : null,
		pickupLat: pickup.ok ? pickup.lat : null,
		pickupLng: pickup.ok ? pickup.lng : null,
```

In `DeliveryForm`, under each of the two pin inputs:

```tsx
{(() => {
	const parsed = parseCoords(state.siteCoords);
	return parsed.ok || parsed.reason === "empty" ? null : (
		<span className="text-[11px] text-amber-700">
			{COORDS_HINT[parsed.reason]}
		</span>
	);
})()}
```

Same block for `state.pickupCoords`, reading `COORDS_HINT` and `parseCoords`
from `@/lib/logistics/coords`. Both inputs already sit inside a `<label>` with
`flex-col`, so the hint lands under the field.

- [ ] **Step 6: Prove the wiring holds**

Run: `pnpm vitest run src/app/admin/logistics/__tests__/form.test.ts src/lib/logistics/__tests__/coords.test.ts && npx tsc --noEmit`
Expected: PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src/app/admin/logistics src/lib/logistics
git add src/lib/logistics/coords.ts src/lib/logistics/__tests__/coords.test.ts src/app/admin/logistics
git commit -m "feat(logistics): read a pasted maps pin, and say so when it cannot"
```

---

### Task 3: A pin state that names its own cause, in the list as well as the row

**Files:**
- Modify: `src/lib/logistics/coords.ts` (add `pinState`)
- Modify: `src/lib/logistics/__tests__/coords.test.ts`
- Modify: `src/app/api/admin/deliveries/route.ts:14-20` (GET reports `geocodingConfigured`)
- Modify: `src/app/admin/logistics/page.tsx` (pass the flag)
- Modify: `src/app/admin/logistics/LogisticsManager.tsx` (badge on the row, warn about pickup too, keep the saved row open)

**Interfaces:**
- Consumes: `isGeocodingConfigured()` from `@/lib/logistics/geocode` (server-only — imported by `page.tsx` and the route, never by the client component).
- Produces:
  - `type PinState = "located" | "geocoder-off" | "not-found"`
  - `pinState(lat: number | null, geocodingConfigured: boolean): PinState`
  - `LogisticsManager` prop `geocodingConfigured: boolean`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/logistics/__tests__/coords.test.ts`:

```ts
import { pinState } from "../coords";

describe("pinState", () => {
	it("is located when there is a pin", () => {
		expect(pinState(3.1509, true)).toBe("located");
	});

	it("blames the missing key, not the admin's typing, when geocoding is off", () => {
		expect(pinState(null, false)).toBe("geocoder-off");
	});

	it("blames the address when geocoding is on and found nothing", () => {
		expect(pinState(null, true)).toBe("not-found");
	});

	it("is located even with geocoding off, because the pin was pasted by hand", () => {
		expect(pinState(3.1509, false)).toBe("located");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/logistics/__tests__/coords.test.ts`
Expected: FAIL — `pinState is not a function`.

- [ ] **Step 3: Add `pinState` to `coords.ts`**

```ts
/**
 * Why a delivery has no pin, which decides what the admin should do about it.
 *
 * "Did not resolve" reads as a typo, and with no `GOOGLE_GEOCODING_API_KEY`
 * every address ever typed resolves to nothing. Telling an admin to fix an
 * address that was never looked up sends them round a loop they cannot win.
 */
export type PinState = "located" | "geocoder-off" | "not-found";

export function pinState(
	lat: number | null,
	geocodingConfigured: boolean,
): PinState {
	if (lat !== null) return "located";
	return geocodingConfigured ? "not-found" : "geocoder-off";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/lib/logistics/__tests__/coords.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Plumb the flag through the server**

In `src/app/api/admin/deliveries/route.ts`, add the import and one field:

```ts
import { isGeocodingConfigured } from "@/lib/logistics/geocode";
// …
	return NextResponse.json({
		deliveries,
		workshopAddress: WORKSHOP_ADDRESS,
		geocodingConfigured: isGeocodingConfigured(),
	});
```

In `src/app/admin/logistics/page.tsx`:

```tsx
import { isGeocodingConfigured } from "@/lib/logistics/geocode";
// …
				<LogisticsManager
					initial={JSON.parse(JSON.stringify(deliveries))}
					workshopAddress={WORKSHOP_ADDRESS}
					geocodingConfigured={isGeocodingConfigured()}
				/>
```

- [ ] **Step 6: Render it — badge, both stops, and a banner when the key is missing**

`LogisticsManager` takes `geocodingConfigured: boolean` and passes it to
`DeliveryDetail`. Above the list, once:

```tsx
{!geocodingConfigured && (
	<p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
		Addresses are not being looked up — GOOGLE_GEOCODING_API_KEY is not set on
		this deployment. Paste a pin on each job, or vehicle partners cannot quote.
	</p>
)}
```

On each row, beside the status badge:

```tsx
{!row.carrierOrderId &&
	(pinState(row.siteLat, geocodingConfigured) !== "located" ||
		pinState(row.pickupLat, geocodingConfigured) !== "located") && (
		<span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-[11px] text-amber-800">
			No map pin
		</span>
	)}
```

In `DeliveryDetail`, replace the single site warning with one that covers both
stops and names the cause. `pinState` and `PinState` come from
`@/lib/logistics/coords`; `PIN_TROUBLE` sits beside the component:

```tsx
const PIN_TROUBLE: Record<Exclude<PinState, "located">, string> = {
	"geocoder-off":
		"was not looked up — address lookup is switched off on this deployment.",
	"not-found":
		"did not resolve to a map location — the address may be too vague to place.",
};
```

```tsx
{(["site", "pickup"] as const).map((stop) => {
	const state = pinState(
		stop === "site" ? delivery.siteLat : delivery.pickupLat,
		geocodingConfigured,
	);
	if (state === "located") return null;
	return (
		<p key={stop} className="text-amber-700 sm:col-span-2">
			The {stop} address {PIN_TROUBLE[state]} Vehicle partners price by
			coordinate, so only own lorry can be booked. Use Edit above to fix the
			address or paste a pin.
		</p>
	);
})}
```

Keep the existing "Site pin: …" line for the located case.

- [ ] **Step 7: Show the result of a save without a second click**

At the end of `save()`, after `await load()`, open the row that was just
written so its pin state is on screen:

```ts
const body = await res.json().catch(() => null);
if (body?.delivery?.id) setOpenId(body.delivery.id);
```

(`POST` returns `{ delivery }` with 201; `PATCH` returns `{ delivery }`.)

- [ ] **Step 8: Verify**

Run: `pnpm vitest run src/lib/logistics src/app/admin/logistics && npx tsc --noEmit`
Expected: PASS, tsc silent.

Then check by hand: `pnpm dev`, open `/admin/logistics`, save a job with a
nonsense address, and confirm the row shows "No map pin", the row opens by
itself, and the panel blames the geocoder (locally, with no key set) rather
than the address.

- [ ] **Step 9: Commit**

```bash
pnpm biome check --write src/app/admin/logistics src/app/api/admin/deliveries src/lib/logistics
git add src/lib/logistics src/app/admin/logistics src/app/api/admin/deliveries/route.ts
git commit -m "feat(logistics): say why a stop has no pin, and flag it in the list"
```

---

### Task 4: Errors in words

**Files:**
- Create: `src/app/admin/logistics/errors.ts`
- Create: `src/app/admin/logistics/__tests__/errors.test.ts`
- Modify: `src/app/admin/logistics/LogisticsManager.tsx` (`save`, `remove`, `book`, `refreshFromCarrier`, `advance`)

**Interfaces:**
- Produces: `messageFor(code: unknown, fallback: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/logistics/__tests__/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { messageFor } from "../errors";

describe("messageFor", () => {
	it("turns a known code into an instruction", () => {
		expect(messageFor("already_booked", "fallback")).toMatch(/carrier/i);
	});

	it("never shows a raw code to an admin", () => {
		expect(messageFor("invalid_body", "fallback")).not.toContain("invalid_body");
	});

	it("falls back when the server said something new", () => {
		expect(messageFor("teapot", "Could not save this delivery")).toBe(
			"Could not save this delivery",
		);
	});

	it("falls back when there was no body at all", () => {
		expect(messageFor(undefined, "Could not save this delivery")).toBe(
			"Could not save this delivery",
		);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/app/admin/logistics/__tests__/errors.test.ts`
Expected: FAIL — `Failed to resolve import "../errors"`.

- [ ] **Step 3: Write `errors.ts`**

```ts
/**
 * What the delivery API refuses with, said as the thing to do about it.
 *
 * The codes are the API's vocabulary and belong in it; an admin booking a
 * lorry should never read one. Anything unrecognised falls back to the
 * caller's own sentence rather than surfacing a new code the day it is added.
 */
const MESSAGE: Record<string, string> = {
	already_booked:
		"This job is with a carrier already — change or cancel it with them first.",
	not_found: "This delivery is gone. Someone may have deleted it.",
	invalid_body:
		"Something in the form is not right — check the phone number and the item sizes.",
	carrier_not_configured:
		"That partner has no credentials on this deployment yet.",
};

export function messageFor(code: unknown, fallback: string): string {
	return typeof code === "string" && code in MESSAGE ? MESSAGE[code] : fallback;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/app/admin/logistics/__tests__/errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it at all five call sites**

Replace each `setError(body?.error ?? "…")` / `onError(body?.error ?? "…")`
with `messageFor(body?.error, "…")`, keeping the sentence already there as the
fallback. The two cases that read extra fields off the body stay special-cased
ahead of it:

```ts
// book()
if (body?.error === "price_moved") {
	onError(`The price moved to RM ${body.currentPriceRm} — compare again before booking.`);
	return;
}
onError(messageFor(body?.error, "Booking failed"));
```

```ts
// advance()
if (body?.error === "carrier_refused_cancel") {
	onError(`The carrier would not cancel this job — ring them. (${body.message})`);
	return;
}
onError(messageFor(body?.error, "Could not update this job"));
```

- [ ] **Step 6: Verify**

Run: `pnpm vitest run src/app/admin/logistics && npx tsc --noEmit`
Expected: PASS, tsc silent.

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write src/app/admin/logistics
git add src/app/admin/logistics
git commit -m "feat(logistics): show an admin a sentence, not an error code"
```

---

### Task 5: The admin's name, typed once

**Files:**
- Modify: `src/app/admin/logistics/LogisticsManager.tsx` (`DeliveryDetail`: `bookedBy` state, `advance`, the booking confirm block)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing exported. `localStorage` key `"ic.logistics.actor"`.

`advance()` currently calls `prompt()`, which blocks the page, is suppressed in
some browser contexts, and asks the same three people for the same name every
time. The booking panel already has the field; make it the one place, and
remember it.

- [ ] **Step 1: Seed the field from the last name used**

```ts
const [bookedBy, setBookedBy] = useState("");

// Read after mount, not in the initial state: `localStorage` does not exist on
// the server, and a value read during render would not survive hydration.
useEffect(() => {
	setBookedBy(localStorage.getItem("ic.logistics.actor") ?? "");
}, []);

const rememberActor = (name: string) => {
	setBookedBy(name);
	localStorage.setItem("ic.logistics.actor", name);
};
```

Point the booking input's `onChange` at `rememberActor(e.target.value)`.

- [ ] **Step 2: Give the status buttons the same field**

Above the row of `Mark …` / `Cancel job` buttons in the booked branch:

```tsx
<label className="flex flex-col gap-1 text-[12px] text-neutral-500">
	Your name — recorded against every update
	<input
		className={fieldClass(false, "max-w-[260px]")}
		value={bookedBy}
		onChange={(e) => rememberActor(e.target.value)}
	/>
</label>
```

- [ ] **Step 3: Drop `prompt()`**

```ts
async function advance(status: DeliveryStatusName) {
	if (bookedBy.trim() === "") {
		onError("Put your name in the field above — it goes on the record.");
		return;
	}
	setBusy(status);
	onError(null);
	const res = await fetch(`/api/admin/deliveries/${id}/advance`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status, actor: bookedBy }),
	});
	// …unchanged from here…
}
```

- [ ] **Step 4: Verify by hand**

Run: `pnpm dev`. On a booked job, mark the next status: no dialog appears, the
timeline records the name, and the name is still in the field after a reload.

Then: `pnpm vitest run && npx tsc --noEmit` — the whole suite, since this is
the last task.
Expected: PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
pnpm biome check --write src/app/admin/logistics
git add src/app/admin/logistics
git commit -m "feat(logistics): remember who is booking instead of prompting"
```

---

## Deliberately not in this plan

- **Search, filter and pagination on the delivery list.** Three admins, a
  handful of open jobs. Add when the list needs scrolling.
- **An embedded map picker.** A pasted pin plus a Maps link covers the failure
  it would fix, at no bundle cost.
- **Following a shortened Maps link server-side.** It is a fetch of a URL a
  human pasted, from an admin endpoint. Task 2 asks for the pin instead.
- **`WORKSHOP_ADDRESS` and `WORKSHOP_PHONE`.** Task 3 makes the placeholder's
  consequence visible on every job; the fix is the client answering the open
  question in CLAUDE.md, not a commit.
