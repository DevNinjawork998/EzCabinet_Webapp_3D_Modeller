import "server-only";
import { z } from "zod";
import { secretsMatch } from "@/lib/secretsMatch";
import { pickupPlace, WORKSHOP_ADDRESS, WORKSHOP_PHONE } from "../carriers";
import { geocoderFault } from "../geocode";
import { carrierFetch } from "../http";
import { longestEdgeMm } from "../measure";
import { easyparcelAppConfigured } from "../oauth";
import { toE164 } from "../phone";
import { mapCarrierStatus } from "../status";
import { accessTokenFor } from "../tokens";
import { trace } from "../trace";
import type {
	CarrierAdapter,
	CarrierBooking,
	CarrierQuote,
	CarrierWebhookEvent,
	DeliveryJob,
	TrackingUpdate,
} from "../types";

const WEBHOOK_TOKEN = () => process.env.EASYPARCEL_WEBHOOK_TOKEN ?? "";

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
 * carcasses and the `parcel` ones carry hardware, samples and spare doors.
 *
 * There is **no weight cap here any more**, because EasyParcel publishes none:
 * their `shipment/quotation` takes `weight` as a bare `double(8,2)` in KG with
 * no documented minimum or maximum, caps are each courier's own, and the only
 * thing they say about it is the error string `"Weight exceeds service limits"`.
 * `courier/list` cannot be asked either — it returns `courier_id`, `uuid`,
 * `courier_name`, `short_name`, `courier_logo` and `country`, and nothing about
 * what any of them will carry. A 30 kg guess here refused jobs some couriers
 * would have taken, and reported the refusal in EasyParcel's voice. Their
 * quotation endpoint is the only authority on what a courier will accept, so
 * the job goes out and their answer is what the admin reads — `quote()` already
 * surfaces both shapes it can come back as: their own per-shipment `errors`,
 * and an empty rate list.
 *
 * The edge cap stays, and is a different kind of number: it is a *gauge*, not a
 * price. A 2.4m panel does not fit through a courier's counter at any weight,
 * and unlike weight there is no cheap way to find that out — a quotation that
 * ignores dimensions will happily return a rate for it.
 *
 * ponytail: one conservative edge across all couriers. Raise it if a real
 * consignment is refused that a courier would have taken.
 */
export const MAX_EDGE_MM = 1_500;

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
 * ponytail: the dimensions sent to EasyParcel still describe only the
 * largest box, so a job of several bulky lines is quoted at that box's size
 * and the full weight — which under-states volumetric charge. It holds for
 * what this partner is actually for — a couple of doors, a box of hinges. If
 * invoices start disagreeing, the fix is one shipment per line item, which
 * the `shipment[]` array already supports and `carrierOrderId` does not.
 * What it can no longer do is under-state the *edge*: the oversize check
 * below runs against the longest edge across every item on the job, not just
 * the chosen box, so a long, low-volume item (a trim strip) cannot hide
 * behind a bulkier, shorter one and slip past the cap unchecked.
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
	// Checked against the whole job, not just the chosen box below — a long
	// item can lose the volume contest and still be the one a courier refuses.
	const longestEdge = longestEdgeMm(job.items);
	if (longestEdge > MAX_EDGE_MM) {
		throw new EasyParcelNotDeliverable(
			`${longestEdge} mm on its longest edge is past what a courier will take — this is a lorry job`,
		);
	}

	// The biggest box on the job, by its own volume — what actually gets sent
	// as the parcel's dimensions. See the ponytail note above.
	const largest = job.items.reduce((a, b) =>
		a.widthMm * a.heightMm * a.depthMm >= b.widthMm * b.heightMm * b.depthMm
			? a
			: b,
	);
	const edges = [largest.widthMm, largest.heightMm, largest.depthMm].sort(
		(a, b) => b - a,
	);

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
		trace("easyparcel.refused", {
			why: "no place",
			end: which,
			postcode,
			state,
		});

		// "Edit it and save again" is only advice when re-saving could actually
		// help. When the geocoder is what is broken there is nothing to re-read
		// the address with, so every save leaves these fields null and the admin
		// is sent round a loop that cannot terminate — a correct message
		// pointing at the wrong thing, which is worse than no message. Name the
		// missing field too: this throws on either half, and telling someone
		// their postcode is unreadable when the state is what is missing sends
		// them to edit a line that is already right.
		const fault = geocoderFault();
		if (fault !== null) {
			throw new EasyParcelNotDeliverable(
				`${fault}. EasyParcel prices by postcode and cannot quote until that is fixed`,
			);
		}

		const missing =
			postcode === null && state === null
				? "postcode or state"
				: postcode === null
					? "postcode"
					: "state";
		throw new EasyParcelNotDeliverable(
			`The ${which} address has no ${missing} we could read — edit it and save again`,
		);
	}
	return { postcode, subdivision_code: state, country: COUNTRY };
}

/**
 * A required `city` for `submit_orders`, refused rather than sent empty (or
 * guessed).
 *
 * Asymmetric with `endpoint` on purpose: the quotations payload built by
 * `quotationBody` below sends no city at all — `shipment/quotations` does not
 * accept one. Only `submit_orders` marks `sender.city` / `receiver.city` as
 * required, and an empty string in a required field is refused by EasyParcel
 * at booking time, which is the worst possible moment — after the admin has
 * compared partners, picked a courier, and clicked book. Refuse here instead,
 * before the call goes out.
 *
 * Used for both ends. `pickupPlace` supplies `city` together with `postcode`
 * and `state` whenever it returns the workshop's own place, so a workshop
 * pickup never reaches this function's failure path — the only address this
 * can actually refuse is a real, non-workshop pickup whose city Google's
 * `readPlace` dropped. There is no workshop fallback for that case any more
 * than there is one for the receiver: guessing a city on a real address would
 * label a courier's collection point with somewhere it is not.
 */
function cityOf(city: string | null, which: string): string {
	if (city === null || city.trim() === "") {
		trace("easyparcel.refused", { why: "no city", end: which });
		throw new EasyParcelNotDeliverable(
			`The ${which} address has no city we could read — edit it and save again`,
		);
	}
	return city;
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
	// `toE164` defaults to a Malaysian country code but does not refuse a
	// number typed with a different one (`+65…`) — and this app only ever
	// labels a number `MY`. Refuse here rather than mislabel a Singapore
	// number as Malaysian at the one moment this task exists to protect.
	if (e164 === null || !e164.startsWith("+60")) {
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
					city: cityOf(sender.city, "pickup"),
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
					// No workshop fallback on this end — an empty string is refused
					// by EasyParcel's required field, and it is better refused here,
					// before the money moves, than by their API after it does.
					city: cityOf(job.siteCity, "site"),
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

const cancelSchema = z.object({
	data: z.array(
		z.object({
			status: z.string(),
			message: z.string().nullish(),
			errors: z.array(z.string()).default([]),
		}),
	),
});

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
							// Prose in their documentation ("1-3 working days"), a JSON
							// *string* in the live reply (`{"type":"days","value":"3"}`).
							// Unknown rather than either, and read by `durationText`: this
							// field is a label nobody prices against, so a third shape must
							// cost a blank duration and not the whole EasyParcel row.
							delivery_duration: z.unknown(),
							is_pickup: z.boolean().nullish(),
							is_dropoff: z.boolean().nullish(),
						}),
						pricing: z.object({
							currency: z.string().nullish(),
							// Live replies send this as a JSON number (`18.26`); the
							// documented examples and the recorded fixtures send the
							// string `"18.26"`. Both are accepted because the reply that
							// pays the bills is the live one, and pinning either shape
							// alone takes the whole EasyParcel row off the comparison
							// screen with a parse error the admin cannot act on.
							total_amount: z.union([z.string(), z.number()]).nullish(),
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

/**
 * `delivery_duration` as something an admin can read.
 *
 * "1-3 working days" is their documented shape and passes through. The live
 * service sends the JSON string `{"type":"days","value":"3"}`, which went onto
 * the comparison row verbatim, braces and all. Anything else is null — a blank
 * duration next to a real price beats punctuation next to one.
 */
export function durationText(raw: unknown): string | null {
	if (typeof raw === "string") {
		const text = raw.trim();
		if (text === "") return null;
		if (!text.startsWith("{")) return text;
		try {
			return durationText(JSON.parse(text));
		} catch {
			return null;
		}
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { type, value } = raw as { type?: unknown; value?: unknown };
	const amount = String(value ?? "").trim();
	if (amount === "") return null;
	const unit = String(type ?? "").trim();
	return unit === "" ? amount : `${amount} ${unit}`;
}

/** `"9.80"` or `9.8` -> `9.8`; anything unreadable -> null rather than NaN. */
function num(value: string | number | null | undefined): number | null {
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
		.filter(
			(row): row is { q: Quotation; price: number } => row.price !== null,
		);
	if (priced.length === 0) return null;

	priced.sort((a, b) => {
		if (a.price !== b.price) return a.price - b.price;
		return (
			Number(b.q.courier.is_pickup ?? false) -
			Number(a.q.courier.is_pickup ?? false)
		);
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
 * comparison row, and the payload — traced, never shown — explains it.
 */
function readReply<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
	const parsed = schema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const seen = JSON.stringify(payload) ?? String(payload);
	trace("easyparcel.unreadable", { what, payload: seen });
	throw new Error(
		`EasyParcel's ${what} reply could not be read — try again, and tell the developer if it keeps happening.`,
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
		if (first?.status !== "success") {
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

		const duration = durationText(best.courier.delivery_duration);

		return {
			carrierId: "easyparcel",
			priceRm: num(best.pricing.total_amount),
			// `delivery_duration` is prose ("1-3 working days"), not minutes, and
			// converting it would put a made-up number on the screen.
			etaMinutes: null,
			quoteRef: best.courier.service_id,
			notes: `${best.courier.courier_name ?? "Courier"} — ${best.courier.service_name ?? best.courier.service_id}${
				duration === null ? "" : `, ${duration}`
			}`,
		};
	},

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
		if (!first || first.status !== "success") {
			throw new Error(
				first?.errors.join("; ") || "EasyParcel refused the shipment",
			);
		}
		if (!first.shipment_number) {
			// The wallet has already been spent and a consignment note exists on
			// EasyParcel's side — this is not a refusal, and reporting it as one
			// would invite a retry that spends it twice. `carrierOrderId` never
			// reached the DB, so `book/route.ts`'s already-booked guard cannot
			// catch that retry either; the message is the only thing standing
			// between the admin and a double charge.
			throw new Error(
				"EasyParcel accepted the shipment but returned no shipment number — check the EasyParcel portal before booking again",
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
			await call(
				"/shipment/details",
				{ shipment_number: carrierOrderId },
				true,
			),
			"details",
		);

		const row = parsed.data[0];
		if (!row) {
			return { status: null, message: "EasyParcel knows no such shipment" };
		}

		const code = row.shipment_details.shipment_status_code;
		const text = row.shipment_details.shipment_status ?? "no status";

		return {
			// The code, not the text — see the note on the table in `status.ts`.
			status:
				code === null || code === undefined
					? null
					: mapCarrierStatus("easyparcel", String(code)),
			message: `EasyParcel reports ${text}`,
			raw: row,
		};
	},

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
		if (!secretsMatch(url.searchParams.get("token") ?? "", WEBHOOK_TOKEN())) {
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
				status:
					code === null ? null : mapCarrierStatus("easyparcel", String(code)),
				message: `EasyParcel ${topic ?? "webhook"}: ${text}`,
				raw: parsed,
			},
		};
	},

	async cancel(carrierOrderId): Promise<void> {
		// EasyParcel refuses once a courier has collected, and signals it the
		// same way as every other endpoint here — HTTP 200 with `data[0].status`
		// set to "error" — so this has to be parsed and checked like the other
		// two, not just awaited. The caller (`advance/route.ts`) relies entirely
		// on this throwing: with no throw it would fall straight through to
		// marking the job CANCELLED while the parcel is still moving.
		const parsed = readReply(
			cancelSchema,
			await call("/shipment/cancel", {
				cancel_list: [
					{
						shipment_number: carrierOrderId,
						remark: "Cancelled by EzCabinet",
					},
				],
			}),
			"cancel",
		);

		const first = parsed.data[0];
		if (first?.status !== "success") {
			throw new Error(
				first?.errors.join("; ") ||
					first?.message ||
					"EasyParcel would not cancel this shipment",
			);
		}
	},
};
