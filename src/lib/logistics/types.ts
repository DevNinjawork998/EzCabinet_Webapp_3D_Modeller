import { z } from "zod";
import { CARRIER_IDS } from "./carriers";

/**
 * The shapes a delivery moves through, and the one contract every logistics
 * partner implements.
 *
 * Zod first, TypeScript inferred from it — the project rule. Every one of these
 * schemas guards a payload that arrives from outside the process.
 */

/**
 * One line on the job. Dimensions are millimetres like everywhere else in this
 * codebase; weight is the only kilogram in the app and is named so.
 *
 * Weight is optional because the catalogue does not carry any. Nobody has
 * weighed a carcass, and a fabricated number here would be quoted against and
 * then invoiced differently. Null means "we did not say", which a carrier's own
 * form can then ask for.
 */
export const deliveryItemSchema = z.object({
	label: z.string().trim().min(1).max(120),
	qty: z.number().int().min(1).max(999),
	widthMm: z.number().int().min(1).max(10_000),
	heightMm: z.number().int().min(1).max(10_000),
	depthMm: z.number().int().min(1).max(10_000),
	weightKg: z.number().min(0).max(2_000).nullable().default(null),
});

export type DeliveryItem = z.infer<typeof deliveryItemSchema>;

/** What the admin form sends to create or edit a job. */
export const deliveryInputSchema = z.object({
	customerName: z.string().trim().min(1).max(200),
	customerPhone: z.string().trim().min(1).max(40),
	siteAddress: z.string().trim().min(1).max(500),
	addressNotes: z.string().trim().max(500).nullable().default(null),
	pickupAddress: z.string().trim().min(1).max(500),
	/**
	 * The admin's own pin, when they have one. Normally absent: the address is
	 * geocoded on save. Present only when the geocode landed somewhere wrong and
	 * someone corrected it by hand, so it overrides rather than seeds.
	 */
	siteLat: z.number().min(-90).max(90).nullable().default(null),
	siteLng: z.number().min(-180).max(180).nullable().default(null),
	pickupLat: z.number().min(-90).max(90).nullable().default(null),
	pickupLng: z.number().min(-180).max(180).nullable().default(null),
	items: z.array(deliveryItemSchema).max(200).default([]),
	// Accepts the ISO string a JSON body carries; null clears the date.
	scheduledAt: z.iso.datetime().nullable().default(null),
	/** The paid order this job delivers, when it was created from one. */
	orderId: z.string().min(1).max(64).nullable().default(null),
});

export type DeliveryInput = z.infer<typeof deliveryInputSchema>;

export const bookInputSchema = z.object({
	carrierId: z.enum(CARRIER_IDS),
	/** Who is spending the money. Required — see `Delivery.bookedBy`. */
	bookedBy: z.string().trim().min(1).max(120),
	/**
	 * The figure the admin was looking at when they clicked. Sent back so the
	 * route can refuse a booking made against a quote that has since moved.
	 */
	quotedPriceRm: z.number().min(0).nullable().default(null),
});

/**
 * What an adapter is handed. Deliberately not the Prisma row: an adapter has no
 * business seeing `bookedBy` or the event history, and keeping this narrow is
 * what lets the pure builders be tested without a database.
 */
export type DeliveryJob = {
	id: string;
	number: number;
	customerName: string;
	customerPhone: string;
	siteAddress: string;
	addressNotes: string | null;
	pickupAddress: string;
	/** Null when the address would not geocode — see `lib/logistics/geocode.ts`. */
	siteLat: number | null;
	siteLng: number | null;
	pickupLat: number | null;
	pickupLng: number | null;
	/**
	 * Null when the geocode did not return them — see `lib/logistics/geocode.ts`.
	 * A parcel partner refuses the job rather than guessing.
	 */
	sitePostcode: string | null;
	siteCity: string | null;
	siteState: string | null;
	pickupPostcode: string | null;
	pickupCity: string | null;
	pickupState: string | null;
	items: DeliveryItem[];
	totalWeightKg: number | null;
	totalVolumeM3: number | null;
	scheduledAt: Date | null;
};

export type CarrierQuote = {
	carrierId: string;
	/**
	 * Null when the partner does not price through an API — `manual` is the
	 * standing example. A null price is not an error and must still be bookable.
	 */
	priceRm: number | null;
	etaMinutes: number | null;
	/** Anything the book call needs to reference this exact quote. */
	quoteRef?: string;
	/**
	 * Something the admin should see before booking that is NOT a refusal.
	 *
	 * A warned quote is still bookable, and deliberately so: the partner
	 * decides whether it will take the job, not us. Distinct from `error`,
	 * which means the quote never happened.
	 */
	warning?: string;
	notes?: string;
};

export type CarrierBooking = {
	carrierOrderId: string;
	trackingUrl: string | null;
	/**
	 * The consignment note, when the partner issues one. A parcel courier will
	 * not collect a box without its AWB taped to it, so for `easyparcel` this is
	 * the difference between a booking and a shipment. Null for the vehicle
	 * partners, which have nothing to print.
	 */
	labelUrl?: string | null;
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
};

/** One reading of where a job is. Every field is optional but the status. */
export type TrackingUpdate = {
	status: DeliveryStatusName | null;
	driverName?: string | null;
	driverPhone?: string | null;
	vehiclePlate?: string | null;
	latitude?: number | null;
	longitude?: number | null;
	message?: string;
	raw?: unknown;
};

/**
 * The status vocabulary, mirrored from the Prisma enum as plain strings so the
 * pure modules and the client bundle can name a status without importing the
 * generated Prisma client.
 */
export const DELIVERY_STATUSES = [
	"DRAFT",
	"QUOTED",
	"BOOKED",
	"DRIVER_ASSIGNED",
	"PICKED_UP",
	"IN_TRANSIT",
	"DELIVERED",
	"CANCELLED",
	"FAILED",
] as const;

export type DeliveryStatusName = (typeof DELIVERY_STATUSES)[number];

/** A job is worth polling while it is somewhere between booked and finished. */
export const ACTIVE_STATUSES = [
	"BOOKED",
	"DRIVER_ASSIGNED",
	"PICKED_UP",
	"IN_TRANSIT",
] as const satisfies readonly DeliveryStatusName[];

/**
 * A verified callback, and whether there is anything to do with it.
 *
 * `ignored` is the load-bearing member. Lalamove documents ten event types and
 * only two of them carry an order; the rest — wallet balance, proof of
 * delivery, proof of pickup, delivery code — used to fail the order-shaped
 * parse and leave the route answering 400, which Lalamove reads as a broken
 * endpoint and retries for hours. A verified event we have no use for is a
 * 200 that says so.
 */
export type CarrierWebhookEvent =
	| { kind: "order"; carrierOrderId: string; update: TrackingUpdate }
	| { kind: "ignored"; eventType: string | null };

/** Implemented once per logistics partner. */
export interface CarrierAdapter {
	id: string;
	/** False when credentials are absent, so the UI can say why it is missing. */
	isConfigured(): boolean;
	quote(job: DeliveryJob): Promise<CarrierQuote>;
	book(job: DeliveryJob, quote: CarrierQuote): Promise<CarrierBooking>;
	track(carrierOrderId: string): Promise<TrackingUpdate>;
	cancel?(carrierOrderId: string): Promise<void>;
	/**
	 * Returns null for anything that fails verification — the caller turns that
	 * into a 400 and writes nothing. Absent when the partner has no callbacks
	 * and is tracked by poll only.
	 *
	 * `url` is the request's own URL, and it is not decoration: EasyParcel signs
	 * nothing at all, so a secret in the registered callback URL is the entire
	 * identity check available for that partner. Lalamove ignores it.
	 */
	verifyWebhook?(
		rawBody: string,
		headers: Headers,
		url: URL,
	): CarrierWebhookEvent | null;
}

/** Thrown by the registry when a partner's credentials are not in the env. */
export class CarrierNotConfigured extends Error {
	constructor(readonly carrierId: string) {
		super(`Carrier ${carrierId} is not configured`);
		this.name = "CarrierNotConfigured";
	}
}
