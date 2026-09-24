import "server-only";
import { put } from "@vercel/blob";
import { z } from "zod";
import { geocoderFault } from "../geocode";
import { carrierFetch } from "../http";
import { labelPathname } from "../label";
import { suggestVehicle, type VehicleClass } from "../measure";
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
 * `GetShippingRate` takes no dimensions, so this is actual weight and nothing
 * else. GDEX's real rate card charges volumetric weight on a bulky, light
 * parcel, which means a wide flat door panel can quote low here and invoice
 * high — the same gap `easyparcel.ts` carries and names.
 *
 * ponytail: actual weight only. Add a volumetric max once EzCabinet
 * confirms GDEX's contracted divisor; guessing it over-quotes and loses jobs.
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

		// "Correct the address" is only advice when re-saving could actually
		// help. Whenever the geocoder itself is the reason there is no postcode
		// — no key, a key Google refuses, a geocoder that did not answer — every
		// save leaves the postcode null however the address is written, and the
		// admin is sent round a loop that cannot terminate, editing a line that
		// was already right. `geocoderFault` owns that distinction; the same
		// call guards `endpoint()` in `easyparcel.ts`.
		const fault = geocoderFault();
		if (fault !== null) {
			throw new GdexNotDeliverable(
				`${fault}. GDEX prices postcode to postcode and cannot quote until that is fixed`,
			);
		}

		throw new GdexNotDeliverable(
			"The site address has no postcode we could read — edit it and save again",
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
export function rateBody(
	job: DeliveryJob,
	fromPostcode: string,
): RateRequest[] {
	// Validated here too, so a price is never offered for a day GDEX will not
	// collect on. The return is unused — this is called for its refusal.
	pickupDay(job);

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

/**
 * A moment as the date and wall-clock time it is in Malaysia.
 *
 * `en-CA` is the locale that formats a date as `YYYY-MM-DD`, and `en-GB` with
 * `hour12: false` the one that gives `HH:MM:SS` — the same trick, and the same
 * reason, as `collectionDate` in `easyparcel.ts`.
 */
export function kualaLumpur(at: Date): { date: string; time: string } {
	const timeZone = "Asia/Kuala_Lumpur";
	return {
		date: new Intl.DateTimeFormat("en-CA", { timeZone }).format(at),
		time: new Intl.DateTimeFormat("en-GB", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		}).format(at),
	};
}

/**
 * The day GDEX will collect on, as `YYYY-MM-DD` in Malaysian local time.
 *
 * `GetPickUpDateListing?PostCode=` is the authoritative list and it is short:
 * asked on 2026-09-06 it returned the 7th to the 11th. Five days, and not
 * today. Rather than spend a round trip per quote, the documented cap is
 * enforced here — the common mistake is a job scheduled weeks out, and a
 * refusal is cheaper than a booking that fails.
 *
 * Called from `rateBody` as well as `pickupInfo`. When only the booking path
 * checked, a job outside the window quoted a price nobody could act on: the
 * admin picked GDEX, pressed book, and got "Pick Up Day Unavailable" — a
 * sentence naming neither the window nor the fix.
 *
 * ponytail: the documented five-day cap, not the live listing. A weekend or
 * public holiday inside the window still refuses at GDEX, and their message is
 * what surfaces. Call GetPickUpDateListing here if that starts costing time.
 */
export function pickupDay(job: DeliveryJob): string {
	const at = job.scheduledAt;
	if (at === null) {
		throw new GdexNotDeliverable(
			"This job has no scheduled date — GDEX needs a day to send a driver, so set Scheduled and compare again",
		);
	}

	// Compared as calendar days in Malaysia, not as elapsed hours: "five days
	// ahead" is a date on a wall calendar, and an instant subtraction would make
	// the answer depend on the time of day the admin happens to be working.
	const day = kualaLumpur(at).date;
	const today = kualaLumpur(new Date()).date;
	const ahead = Math.round(
		(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
			86_400_000,
	);

	if (ahead < 0) {
		trace("gdex.refused", { why: "pickup in the past", day, today });
		throw new GdexNotDeliverable(
			`This job is scheduled for ${day}, which is past — GDEX cannot collect on a day that has gone, so pick a new date`,
		);
	}
	if (ahead > MAX_PICKUP_DAYS) {
		trace("gdex.refused", { why: "pickup too far out", day, today, ahead });
		throw new GdexNotDeliverable(
			`GDEX collects within ${MAX_PICKUP_DAYS} days and this job is scheduled for ${day}, ${ahead} days out — bring the date forward or send it by lorry`,
		);
	}
	return day;
}

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
	const date = pickupDay(job);
	const { time } = kualaLumpur(job.scheduledAt as Date);
	return {
		Transportation: transportationFor(job),
		// GDEX takes the moment twice: the day to collect, and the wall-clock
		// time the parcel is on the bench. Both are Malaysian local time, for the
		// same reason `easyparcel.ts` formats `collection_date` in
		// `Asia/Kuala_Lumpur` — a driver reads a clock on a wall in Dengkil, not
		// a UTC offset, and a job scheduled 08:00 UTC is a 16:00 collection.
		ParcelReadyTime: time,
		// Midnight, not the ready time. `GetPickUpDateListing` returns the days it
		// will collect as `2026-09-08T00:00:00` — naive local, no `Z`, and always
		// at midnight — and `CreateConsignment` matches `PickupDate` against that
		// list. Sending the collection *time* here refuses a day GDEX is offering,
		// with "Pick Up Day Unavailable", which reads as a closed depot rather
		// than a malformed field. The time of day is `ParcelReadyTime`'s job.
		//
		// The format also settles the open question this once carried: GDEX's own
		// replies are naive Malaysian local, so that is what it is sent.
		PickupDate: `${date}T00:00:00`,
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

/**
 * A number GDEX will dial, as `60123456789`.
 *
 * `toE164` gives `+60123456789`; the leading `+` comes off because GDEX's own
 * `GetUserDetails` returns `MobileNumber` in the bare form. Same shape as
 * `easyparcel.ts`'s `phoneParts`, which strips `+60` for the same reason —
 * an E.164 string is the thing we can validate, not necessarily the thing the
 * partner's form field accepts.
 *
 * A number typed with another country's code is refused rather than sent: this
 * app only ever ships within Malaysia, and a `+65` number reaching a Malaysian
 * courier is a driver who cannot phone the customer from the gate.
 */
function phoneOrThrow(raw: string, whose: string): string {
	const e164 = toE164(raw);
	if (e164 === null || !e164.startsWith("+60")) {
		throw new GdexNotDeliverable(
			`The ${whose} phone number (${raw}) is not a number GDEX can call`,
		);
	}
	return e164.slice(1);
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
				ShipmentContent: job.items
					.map((i) => i.label)
					.join(", ")
					.slice(0, 200),
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

/**
 * The myGDEX account's User Access Token, from the customer portal's User
 * Profile page — not the developer portal, which issues the subscription key.
 *
 * **Each estate has its own portal and its own accounts**, and a token from one
 * is rejected by the other with "Invalid User Token" — which reads like a bad
 * token and is not. `BASE` below is the sandbox, so this must be a token from
 * https://my-openapi.gdexpress.com, not https://my.gdexpress.com. GDEX's own
 * guide links to both under the same words, "myGDEX Portal".
 *
 * Read per call, not at import, so a test can stub it.
 */
const USER_TOKEN = () => process.env.GDEX_USER_TOKEN ?? "";

/** The Azure APIM subscription key, from the developer portal. */
const SUBSCRIPTION_KEY = () => process.env.GDEX_PRIMARY_API_KEY ?? "";

/**
 * The sandbox, and only the sandbox.
 *
 * Live is the same host without `/test`, but the account holds no active
 * subscription to the live `myGDEX` product — every call would come back
 * "invalid subscription key". A flag that can only select a broken target is
 * worse than a constant, so going live is a deliberate edit here plus an
 * approved live subscription, not an environment variable somebody flips.
 */
const BASE = "https://myopenapi.gdexpress.com/test/api/MyGDex";

/**
 * Every GDEX call. Two credentials, two headers, and they fail differently.
 *
 * `subscription-key` is the gateway's, NOT `Ocp-Apim-Subscription-Key` — GDEX
 * renamed APIM's default, so the standard header is silently ignored and the
 * gateway answers "missing subscription key" while you are sending one. That
 * cost a debugging session on 2026-09-06; do not change it back.
 *
 * The two 401s mean opposite things and name different people to ask: one
 * about the subscription key means the request never reached GDEX, and one
 * about the user token means it did and the account was refused.
 */
async function call<T>(
	method: "GET" | "POST" | "PUT",
	path: string,
	body?: unknown,
	idempotent = false,
): Promise<T> {
	const token = USER_TOKEN();
	const subscriptionKey = SUBSCRIPTION_KEY();
	if (token === "" || subscriptionKey === "") {
		throw new CarrierNotConfigured("gdex");
	}
	return carrierFetch<T>(`${BASE}${path}`, {
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

/**
 * `IsValid` is not in GDEX's documentation, and it is the only thing that makes
 * this reply readable.
 *
 * A consignment number GDEX has never seen comes back **HTTP 200** with
 * `ConsignmentNoteStatus: "Pending"` and `IsValid: false` — the same status
 * word a real, freshly created note carries. Found with `pnpm gdex:ping`
 * against a made-up number; nothing in the docs hints at it.
 *
 * `nullish()` rather than required, because a field they do not document is a
 * field they can stop sending. Absent is treated as valid, which is what the
 * documented shape implies.
 */
const statusSchema = envelope(
	z.array(
		z.object({
			ConsignmentNote: z.string(),
			ConsignmentNoteStatus: z.string().nullish(),
			IsValid: z.boolean().nullish(),
		}),
	),
);

/** Same reasoning as Lalamove's `readReply`: a ZodError path list explains nothing. */
function readReply<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const seen = JSON.stringify(payload) ?? String(payload);
	trace("gdex.unreadable", { what, payload: seen });
	throw new Error(
		`GDEX's ${what} reply was not the shape we expect: ${seen.slice(0, 200)}`,
	);
}

/**
 * The sender block, from the GDEX account's own profile.
 *
 * Fetched on every quote and every booking rather than cached: it is one small
 * GET, it changes when someone edits the account, and a stale `LocationId` is a
 * parcel collected from an address the workshop moved out of.
 */
const pickupDaysSchema = envelope(z.array(z.string()));

/**
 * The days GDEX will actually collect on, soonest first, as `YYYY-MM-DD`.
 *
 * Authoritative where `MAX_PICKUP_DAYS` only guesses: this list already
 * excludes weekends and public holidays, which "five days" does not. The local
 * check stays as the cheap guard that needs no round trip — this is what the
 * admin gets offered.
 *
 * The dates arrive as `2026-09-08T00:00:00`: naive Malaysian local, always
 * midnight. Sliced rather than parsed, because `Date.parse` reads that string
 * as UTC and hands back the previous day for everyone east of Greenwich, which
 * is everyone this app serves.
 *
 * The postcode is the GDEX account's own, not the job's — this asks where a
 * driver would be collecting FROM. Without it the endpoint answers 400
 * "Please Provide PostCode".
 */
export async function pickupDays(): Promise<string[]> {
	const sender = await senderDetails();
	const reply = readReply(
		pickupDaysSchema,
		await call(
			"GET",
			`/GetPickUpDateListing?PostCode=${encodeURIComponent(sender.PostalCode)}`,
			undefined,
			true,
		),
		"pickup day listing",
	);
	return reply.data.map((day) => day.slice(0, 10)).sort();
}

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

/**
 * Fetch the consignment note and keep a copy.
 *
 * GDEX serves the PDF only while the shipment is pending — once it is
 * collected, cancelled or delivered the endpoint refuses — so this is a
 * booking-time capture, not a link we can follow later.
 *
 * A raw `fetch` rather than `call`: `carrierFetch` parses JSON, and this is a
 * PDF body. Failure is swallowed on purpose. The consignment is already created
 * and the e-Wallet already debited by the time this runs, so throwing here
 * would fail a booking that in fact succeeded; a missing label costs a trip to
 * GDEX's portal, and a phantom un-booking costs a parcel nobody sent.
 */
async function storeLabel(consignmentNumber: string): Promise<string | null> {
	try {
		const response = await fetch(
			`${BASE}/GetConsignmentsImage?ConsignmentNumber=${encodeURIComponent(consignmentNumber)}`,
			{
				headers: {
					"User-Token": USER_TOKEN(),
					"subscription-key": SUBSCRIPTION_KEY(),
				},
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) {
			trace("gdex.label", { consignmentNumber, status: response.status });
			return null;
		}
		await put(labelPathname("gdex", consignmentNumber), await response.blob(), {
			access: "private",
			addRandomSuffix: false,
			contentType: "application/pdf",
			allowOverwrite: true,
		});
		return consignmentNumber;
	} catch (error) {
		trace("gdex.label", { consignmentNumber, error: String(error) });
		return null;
	}
}

const walletSchema = envelope(z.number());

/**
 * What GDEX's e-Wallet holds, or null when it cannot be read.
 *
 * Null rather than throwing, because every caller is advisory: this is a
 * courtesy on top of a price, and a wallet endpoint having a bad minute must
 * never cost the quote it is annotating. `CheckeWalletBalance` returns a bare
 * number in `data` — 1020.0000, not an object.
 */
export async function walletBalance(): Promise<number | null> {
	try {
		const reply = readReply(
			walletSchema,
			await call("GET", "/CheckeWalletBalance", undefined, true),
			"wallet balance",
		);
		return reply.data;
	} catch (error) {
		trace("gdex.wallet", { error: String(error) });
		return null;
	}
}

/**
 * One consignment's collection, as GDEX has it on their board.
 *
 * This is the answer to "did the booking actually reach GDEX", which nothing
 * else in the app can give: our own success only proves we sent a request.
 *
 * `GetPickUpReference` takes **`ConsignmentNo`** — not `ConsignmentNumber`,
 * which every other operation in this file takes and which this one answers
 * with "Consignment Number Not Found", blaming the consignment for a
 * misspelled query string. Verified against the sandbox 2026-09-06; do not
 * "correct" it to match its siblings.
 *
 * A refusal is information, not a failure: a cancelled consignment answers
 * "Pickup Is Already Cancelled", which is a true and useful thing to show. So
 * the carrier's own sentence comes back rather than an exception, and the
 * caller renders it.
 */
export type PickupConfirmation = {
	/** GDEX's pickup number — what staff quote to their support. */
	reference: string | null;
	status: string | null;
	/** The day GDEX will collect, `YYYY-MM-DD`. */
	collectingOn: string | null;
	message: string;
};

const pickupSchema = envelope(
	z
		.object({
			PickupNo: z.string().nullish(),
			Status: z.string().nullish(),
			PickupTime: z.string().nullish(),
		})
		.nullish(),
);

export async function pickupConfirmation(
	carrierOrderId: string,
): Promise<PickupConfirmation> {
	const none = (message: string): PickupConfirmation => ({
		reference: null,
		status: null,
		collectingOn: null,
		message,
	});

	let payload: unknown;
	try {
		payload = await call(
			"GET",
			`/GetPickUpReference?ConsignmentNo=${encodeURIComponent(carrierOrderId)}`,
			undefined,
			true,
		);
	} catch (error) {
		// A 400 here carries GDEX's reason — "Pickup Is Already Cancelled" is
		// the common one and is worth showing verbatim.
		trace("gdex.pickup", { carrierOrderId, error: String(error) });
		return none(
			(error as Error).message.replace(/^gdex responded \d+: /, "") ||
				"GDEX did not answer about this collection",
		);
	}

	const reply = readReply(pickupSchema, payload, "pickup reference");
	const row = reply.data;
	if (!row || !row.PickupNo) {
		return none("GDEX has no collection recorded against this consignment");
	}

	return {
		reference: row.PickupNo,
		status: row.Status ?? null,
		// Naive local, midnight, exactly as GetPickUpDateListing returns it.
		collectingOn: row.PickupTime ? row.PickupTime.slice(0, 10) : null,
		message: `GDEX has this collection on their board as ${row.PickupNo}`,
	};
}

export const gdexAdapter: CarrierAdapter = {
	id: "gdex",

	// Both, deliberately. GDEX_PUBLIC_KEY is NOT accepted as a fallback for
	// the user token: it sits in `.env.local` and is proven invalid, so
	// honouring it would turn "nobody set this up" into an unexplained 401.
	isConfigured: () => USER_TOKEN() !== "" && SUBSCRIPTION_KEY() !== "",

	async quote(job): Promise<CarrierQuote> {
		// Before anything is dialled: an unweighed or postcode-less job is
		// refused here, and the message goes on the comparison row.
		const weight = weightOf(job);
		trace("gdex.quote", {
			deliveryId: job.id,
			weight,
			items: job.items.length,
		});

		const sender = await senderDetails();
		const reply = readReply(
			rateSchema,
			await call(
				"POST",
				"/GetShippingRate",
				rateBody(job, sender.PostalCode),
				true,
			),
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
			throw new GdexNotDeliverable(
				row.Error ?? "GDEX would not price this job",
			);
		}

		// Advisory, and checked after the price rather than before it: booking
		// debits the wallet, so "Insufficient Credit" is the likeliest way a
		// GDEX booking fails, and it is the one thing the admin can fix before
		// spending their time picking this carrier. A warning, not a refusal —
		// GDEX decides whether it will take the booking, not us.
		const balance = await walletBalance();
		const short = balance !== null && balance < row.Rate;

		return {
			carrierId: "gdex",
			priceRm: row.Rate,
			// GDEX quotes a rate, not a time. Transit days depend on the lane and
			// are not in this reply; inventing minutes would put a promise on the
			// screen nobody made.
			etaMinutes: null,
			notes: `Parcel, ${weight} kg`,
			...(short
				? {
						warning: `GDEX's wallet holds RM ${(balance as number).toFixed(2)}, less than this booking — top it up or the booking will be refused`,
					}
				: {}),
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

		const consignmentNumber = reply.data.ConsignmentNumbers[0];
		const stored = await storeLabel(consignmentNumber);

		return {
			carrierOrderId: consignmentNumber,
			// Our route, not a blob URL: the note is private and the admin cookie
			// is what opens it. Null when the capture failed, so the print link
			// simply does not render rather than pointing at nothing.
			labelUrl:
				stored === null ? null : `/api/admin/deliveries/${job.id}/label`,
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

		const row =
			reply.data.find((r) => r.ConsignmentNote === carrierOrderId) ??
			reply.data[0];

		// GDEX answers for a number it has never seen with "Pending" — the same
		// word a real new consignment carries — and flags it only in `IsValid`.
		// Reading the status off that row would report a parcel that does not
		// exist as booked, and keep reporting it, because nothing else in the
		// reply ever contradicts it.
		if (row?.IsValid === false) {
			trace("gdex.unknown_consignment", { carrierOrderId });
			return {
				status: null,
				message: `GDEX does not recognise consignment ${carrierOrderId}`,
				raw: reply.data,
			};
		}

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
