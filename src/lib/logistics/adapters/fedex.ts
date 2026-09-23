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
