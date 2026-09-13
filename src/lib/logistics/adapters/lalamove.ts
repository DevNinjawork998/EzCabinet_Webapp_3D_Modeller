import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WORKSHOP_PHONE } from "../carriers";
import { carrierFetch } from "../http";
import { suggestVehicle, type VehicleClass } from "../measure";
import { toE164 } from "../phone";
import { mapCarrierStatus } from "../status";
import { trace } from "../trace";
import {
	type CarrierAdapter,
	type CarrierBooking,
	CarrierNotConfigured,
	type CarrierQuote,
	type CarrierWebhookEvent,
	type DeliveryJob,
	type TrackingUpdate,
} from "../types";

/**
 * Lalamove — the vehicle partner, and the only one that says where the driver is.
 *
 * The v3 API is a three-call chain: `POST /v3/quotations` returns a price and a
 * `quotationId` good for five minutes, `POST /v3/orders` spends it, and
 * `GET /v3/orders/{id}` is how we find out what happened. `book/route.ts`
 * already re-quotes immediately before booking, so that five-minute window is
 * handled by code that exists — this adapter only has to carry the quotation's
 * stop ids from one call to the next, which is what `quoteRef` is for.
 */

/**
 * A job Lalamove cannot be asked about — no pin, no readable phone, too big for
 * one vehicle.
 *
 * Separate from `CarrierNotConfigured` because the cause is the job, not the
 * environment, and the message goes straight onto the comparison row where the
 * admin can act on it: `quotes/route.ts` puts a rejected quote's message in the
 * `error` field of that carrier's row.
 */
export class LalamoveNotDeliverable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LalamoveNotDeliverable";
	}
}

/**
 * Our vehicle classes in Lalamove's words.
 *
 * ponytail: hardcoded for the MY market. Lalamove's own docs warn these keys
 * differ per city and that `GET /v3/cities` is the authority — worth calling
 * and caching if a second market is ever added, or if a quote starts coming
 * back ERR_INVALID_SERVICE_TYPE.
 */
export const SERVICE_TYPE: Record<VehicleClass, string> = {
	car: "CAR",
	van: "VAN",
	lorry_1t: "TRUCK330",
	lorry_3t: "TRUCK550",
};

/** For the note on the comparison row — "Van, MYR" reads better than "VAN". */
export const SERVICE_TYPE_LABEL: Record<string, string> = {
	CAR: "Car",
	VAN: "Van",
	TRUCK330: "1-tonne lorry",
	TRUCK550: "3-tonne lorry",
};

export const MARKET = "MY";
export const LANGUAGE = "en_MY";

/**
 * `HmacSHA256(<ts>CRLF<VERB>CRLF<path>CRLF CRLF<body>)`, hex.
 *
 * The blank line between the path and the body is part of the spec, not a
 * typo. `body` is the empty string for GET and DELETE, and must be
 * byte-identical to what goes on the wire — which is why `carrierFetch` takes
 * a pre-serialised string.
 */
export function signRequest(
	secret: string,
	timestamp: string,
	method: string,
	path: string,
	body: string,
): string {
	return createHmac("sha256", secret)
		.update(`${timestamp}\r\n${method}\r\n${path}\r\n\r\n${body}`)
		.digest("hex");
}

/** The smallest Lalamove vehicle this job fits in. */
export function serviceTypeFor(job: DeliveryJob): string {
	const suggestion = suggestVehicle(job.items);
	if (suggestion.id === null) {
		trace("lalamove.refused", { why: "vehicle", reason: suggestion.reason });
		throw new LalamoveNotDeliverable(
			`This job is ${suggestion.reason} — Lalamove books one vehicle at a time`,
		);
	}
	return SERVICE_TYPE[suggestion.id];
}

/** Lalamove takes coordinates as strings, and rejects a stop without one. */
function stop(
	lat: number | null,
	lng: number | null,
	address: string,
	which: string,
) {
	if (lat === null || lng === null) {
		// Traced, because this throw happens before any request: without a line
		// here the failure leaves no trace at all, which is how "no quotation and
		// no explanation" happened in the first place.
		trace("lalamove.refused", { why: "no pin", stop: which, address });
		throw new LalamoveNotDeliverable(
			`The ${which} address has no map location — edit it, or paste a pin`,
		);
	}
	return { coordinates: { lat: String(lat), lng: String(lng) }, address };
}

/**
 * The quotation payload.
 *
 * Two stops, pickup first: Lalamove reads stop order as route order, and the
 * cabinets are leaving the workshop.
 *
 * The optional `item` object is deliberately absent. Its `weight` field is a
 * per-city enum bucket the docs do not enumerate for MY, the catalogue carries
 * no weights anyway, and a guessed bucket would be rejected for no gain.
 */
export function quotationBody(job: DeliveryJob) {
	return {
		data: {
			serviceType: serviceTypeFor(job),
			language: LANGUAGE,
			stops: [
				stop(job.pickupLat, job.pickupLng, job.pickupAddress, "pickup"),
				stop(job.siteLat, job.siteLng, job.siteAddress, "site"),
			],
			// Lalamove wants UTC ISO 8601, and omitting it means "as soon as
			// possible" — which is not the same as sending a null.
			...(job.scheduledAt ? { scheduleAt: job.scheduledAt.toISOString() } : {}),
		},
	};
}

function phoneOrThrow(raw: string, whose: string): string {
	const e164 = toE164(raw);
	if (e164 === null) {
		throw new LalamoveNotDeliverable(
			`The ${whose} phone number (${raw}) is not a number Lalamove can call`,
		);
	}
	return e164;
}

/**
 * The order payload.
 *
 * `sender` is the workshop and `recipients[0]` is the customer, each pinned to
 * the `stopId` the quotation came back with — Lalamove matches them by id, not
 * by position, and a mismatch is a 422.
 *
 * `addressNotes` becomes the recipient's `remarks`: gate codes and unit numbers
 * are exactly what a driver at the boom gate needs, and they are kept out of
 * the address line precisely so they can go here.
 */
export function orderBody(
	job: DeliveryJob,
	quotationId: string,
	senderStopId: string,
	recipientStopId: string,
) {
	return {
		data: {
			quotationId,
			sender: {
				stopId: senderStopId,
				name: "EzCabinet",
				// The workshop's own number. Emphatically not the customer's: this
				// is the contact a driver rings from the loading bay, and pointing
				// it at the customer means they get called to explain where their
				// own cabinets are.
				phone: phoneOrThrow(WORKSHOP_PHONE, "workshop's"),
			},
			recipients: [
				{
					stopId: recipientStopId,
					name: job.customerName,
					phone: phoneOrThrow(job.customerPhone, "customer's"),
					...(job.addressNotes ? { remarks: job.addressNotes } : {}),
				},
			],
			// Ours, echoed back on every webhook — the fastest way to tie a
			// Lalamove order in their dashboard to a job number staff say aloud.
			metadata: {
				deliveryId: job.id,
				deliveryNumber: String(job.number),
			},
		},
	};
}

/**
 * `book()` needs three strings from `quote()` and `CarrierQuote` gives it one.
 *
 * Joined rather than JSON so the value stays readable in the
 * `DeliveryEvent.raw` of the booking event, which is where anyone debugging a
 * 422 will look first.
 */
export function packQuoteRef(
	quotationId: string,
	senderStopId: string,
	recipientStopId: string,
): string {
	return [quotationId, senderStopId, recipientStopId].join("|");
}

export function unpackQuoteRef(ref: string | undefined) {
	const parts = (ref ?? "").split("|");
	if (parts.length !== 3 || parts.some((p) => p === "")) return null;
	return {
		quotationId: parts[0],
		senderStopId: parts[1],
		recipientStopId: parts[2],
	};
}

const KEY = () => process.env.LALAMOVE_API_KEY ?? "";
const SECRET = () => process.env.LALAMOVE_API_SECRET ?? "";

/**
 * Sandbox or production, decided by the key rather than a second variable.
 *
 * Lalamove prefixes test keys `pk_test`, and a separate LALAMOVE_BASE_URL
 * would only ever be a way to point a production key at sandbox by accident.
 */
function baseUrl(): string {
	return KEY().startsWith("pk_test")
		? "https://rest.sandbox.lalamove.com"
		: "https://rest.lalamove.com";
}

/** The signed call. `path` is the part after the host, and is what gets signed. */
async function call<T>(
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
	idempotent = false,
): Promise<T> {
	const key = KEY();
	const secret = SECRET();
	if (key === "" || secret === "") throw new CarrierNotConfigured("lalamove");

	// Serialised once, signed and sent — see `signRequest`.
	const raw = body === undefined ? "" : JSON.stringify(body);
	const timestamp = String(Date.now());

	return carrierFetch<T>(`${baseUrl()}${path}`, {
		carrierId: "lalamove",
		method,
		headers: {
			Authorization: `hmac ${key}:${timestamp}:${signRequest(secret, timestamp, method, path, raw)}`,
			Market: MARKET,
			"Request-ID": randomUUID(),
		},
		...(body === undefined ? {} : { body: raw }),
		idempotent,
	});
}

const quotationSchema = z.object({
	data: z.object({
		quotationId: z.string(),
		stops: z.array(z.object({ stopId: z.string() })).min(2),
		priceBreakdown: z.object({ total: z.string(), currency: z.string() }),
	}),
});

const orderSchema = z.object({
	data: z.object({
		orderId: z.string(),
		status: z.string(),
		shareLink: z.string().nullish(),
		driverId: z.string().nullish(),
	}),
});

const driverSchema = z.object({
	data: z.object({
		name: z.string().nullish(),
		phone: z.string().nullish(),
		plateNumber: z.string().nullish(),
		coordinates: z
			.object({ lat: z.string().nullish(), lng: z.string().nullish() })
			.nullish(),
	}),
});

/**
 * A reply, or a message naming what arrived instead.
 *
 * `.parse()` threw a ZodError whose message is a path list — accurate, and
 * useless on a comparison row. The payload is the only thing that explains a
 * shape we did not expect, so it goes in the error.
 */
function readReply<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const seen = JSON.stringify(payload) ?? String(payload);
	trace("lalamove.unreadable", { what, payload: seen });
	throw new Error(
		`Lalamove's ${what} reply was not the shape we expect: ${seen.slice(0, 200)}`,
	);
}

/** `"3.12"` -> `3.12`; anything unreadable -> null rather than NaN. */
function num(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * Lalamove's webhook payload. Only the fields we act on, and every one of them
 * optional — a new event type must be ignorable, not a 500 that makes them
 * retry it for hours.
 */
const webhookSchema = z.object({
	apiKey: z.string(),
	eventType: z.string().nullish(),
	// `order` is optional and `data` is loose on purpose: six of Lalamove's ten
	// documented events carry no order, and a schema tight enough to validate
	// one rejected the rest outright.
	data: z.looseObject({
		order: z
			.object({ orderId: z.string(), status: z.string().nullish() })
			.nullish(),
		driver: z
			.object({
				name: z.string().nullish(),
				phone: z.string().nullish(),
				plateNumber: z.string().nullish(),
			})
			.nullish(),
	}),
});

/** Constant-time, and length-safe — `timingSafeEqual` throws on a length mismatch. */
function secretsMatch(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export const lalamoveAdapter: CarrierAdapter = {
	id: "lalamove",

	isConfigured: () => KEY() !== "" && SECRET() !== "",

	async quote(job): Promise<CarrierQuote> {
		trace("lalamove.quote", {
			deliveryId: job.id,
			pickup: { lat: job.pickupLat, lng: job.pickupLng },
			site: { lat: job.siteLat, lng: job.siteLng },
			scheduledAt: job.scheduledAt?.toISOString() ?? null,
			items: job.items.length,
		});
		const body = quotationBody(job);
		const parsed = readReply(
			quotationSchema,
			await call("POST", "/v3/quotations", body, true),
			"quotation",
		);
		const { quotationId, stops, priceBreakdown } = parsed.data;

		return {
			carrierId: "lalamove",
			priceRm: num(priceBreakdown.total),
			// Lalamove quotes distance, not time. An ETA only exists once a driver
			// is matched, and inventing one here would put a number on the
			// comparison screen that nobody promised.
			etaMinutes: null,
			quoteRef: packQuoteRef(quotationId, stops[0].stopId, stops[1].stopId),
			notes: `${SERVICE_TYPE_LABEL[body.data.serviceType] ?? body.data.serviceType}, ${priceBreakdown.currency}`,
		};
	},

	async book(job, quote): Promise<CarrierBooking> {
		trace("lalamove.book", {
			deliveryId: job.id,
			quoteRef: quote.quoteRef ?? null,
			priceRm: quote.priceRm,
		});
		const ref = unpackQuoteRef(quote.quoteRef);
		if (!ref) {
			throw new LalamoveNotDeliverable(
				"This quote is missing its Lalamove reference — compare partners again",
			);
		}

		// Not idempotent, and `carrierFetch` will not retry it: a retried order
		// is a second lorry.
		const parsed = readReply(
			orderSchema,
			await call(
				"POST",
				"/v3/orders",
				orderBody(job, ref.quotationId, ref.senderStopId, ref.recipientStopId),
			),
			"order",
		);

		return {
			carrierOrderId: parsed.data.orderId,
			trackingUrl: parsed.data.shareLink ?? null,
		};
	},

	async track(carrierOrderId): Promise<TrackingUpdate> {
		const order = readReply(
			orderSchema,
			await call("GET", `/v3/orders/${carrierOrderId}`, undefined, true),
			"order",
		);
		const update: TrackingUpdate = {
			status: mapCarrierStatus("lalamove", order.data.status),
			message: `Lalamove reports ${order.data.status}`,
			raw: order.data,
		};

		const driverId = order.data.driverId ?? "";
		if (driverId === "") return update;

		// A second call, and a failure here must not lose the status from the
		// first: driver details are available only in a window around the pickup,
		// so a 403 outside it is normal rather than an incident.
		try {
			const driver = readReply(
				driverSchema,
				await call(
					"GET",
					`/v3/orders/${carrierOrderId}/drivers/${driverId}`,
					undefined,
					true,
				),
				"driver",
			);
			return {
				...update,
				driverName: driver.data.name ?? null,
				driverPhone: driver.data.phone ?? null,
				vehiclePlate: driver.data.plateNumber ?? null,
				latitude: num(driver.data.coordinates?.lat),
				longitude: num(driver.data.coordinates?.lng),
				raw: { order: order.data, driver: driver.data },
			};
		} catch {
			return update;
		}
	},

	async cancel(carrierOrderId): Promise<void> {
		// Lalamove refuses once a driver has been matched for more than five
		// minutes, and on an order already cancelled — both as
		// `422 ERR_CANCELLATION`. The caller turns that into a message rather
		// than swallowing it: a job that could not be cancelled still has a
		// lorry on its way. Success is `204` with no body, which is why
		// `carrierFetch` has to allow an empty 2xx.
		await call("DELETE", `/v3/orders/${carrierOrderId}`);
	},

	/**
	 * Lalamove does not sign its callbacks; the payload carries the `apiKey` the
	 * order was placed with, and that is the whole identity check available.
	 *
	 * ponytail: apiKey equality is thin. The route only ever acts on a
	 * `carrierOrderId` we already own, which bounds the damage to a forged
	 * status on a known job. Upgrade path is a secret path segment, which needs
	 * `verifyWebhook` widened to see the request URL.
	 */
	verifyWebhook(rawBody): CarrierWebhookEvent | null {
		let parsed: z.infer<typeof webhookSchema>;
		try {
			parsed = webhookSchema.parse(JSON.parse(rawBody));
		} catch {
			return null;
		}

		if (!secretsMatch(parsed.apiKey, KEY())) return null;

		// The one place an undocumented payload can be read from: every event
		// Lalamove sends passes through here, whether we act on it or not.
		trace("lalamove.webhook", {
			eventType: parsed.eventType ?? null,
			data: parsed.data,
		});

		const order = parsed.data.order;
		if (!order) {
			return { kind: "ignored", eventType: parsed.eventType ?? null };
		}

		const status = order.status ?? "";
		const driver = parsed.data.driver;

		return {
			kind: "order",
			carrierOrderId: order.orderId,
			update: {
				status: status === "" ? null : mapCarrierStatus("lalamove", status),
				...(driver
					? {
							driverName: driver.name ?? null,
							driverPhone: driver.phone ?? null,
							vehiclePlate: driver.plateNumber ?? null,
						}
					: {}),
				message: `Lalamove ${parsed.eventType ?? "webhook"}: ${status || "no status"}`,
				raw: parsed,
			},
		};
	},
};
