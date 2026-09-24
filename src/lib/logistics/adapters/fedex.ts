import "server-only";
import { put } from "@vercel/blob";
import { z } from "zod";
import { prisma } from "@/lib/catalogue/db";
import { pickupPlace, WORKSHOP_CLOSE_TIME, WORKSHOP_PHONE } from "../carriers";
import { CarrierHttpError, carrierFetch } from "../http";
import { labelPathname } from "../label";
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
export function shipBody(
	job: DeliveryJob,
	account: string,
	serviceType: string,
) {
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
		created.shipmentDocuments?.find(
			(d) => d.contentType === "MERGED_LABELS_ONLY",
		)?.url ??
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
