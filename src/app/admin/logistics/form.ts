import type { DeliveryItem, DeliveryStatusName } from "@/lib/logistics/types";

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
	labelUrl: string | null;
	driverName: string | null;
	driverPhone: string | null;
	vehiclePlate: string | null;
	lastLatitude: number | null;
	lastLongitude: number | null;
	lastLocationAt: string | null;
	bookedBy: string | null;
	/** The job this one was cut out of, when it was — see `Delivery`. */
	splitFromNumber: number | null;
	/** The unguessable half of the customer's `/track/…` link — see `Delivery`. */
	publicToken: string;
	/** The paid order this job delivers, when it came from one. */
	orderId: string | null;
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
	/** Advisory — the row still books. Distinct from `error`, which does not. */
	warning?: string;
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
	orderId: null as string | null,
	customerName: "",
	customerPhone: "",
	siteAddress: "",
	addressNotes: "",
	pickupAddress: workshopAddress,
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

/** An existing job back into the same form. */
export const formFrom = (row: DeliveryRow): FormState => ({
	id: row.id,
	orderId: row.orderId,
	customerName: row.customerName,
	customerPhone: row.customerPhone,
	siteAddress: row.siteAddress,
	addressNotes: row.addressNotes ?? "",
	pickupAddress: row.pickupAddress,
	scheduledAt: localDateTime(row.scheduledAt),
	items: row.items.map((item) => ({ ...item, uid: crypto.randomUUID() })),
});

/**
 * A paid order as a new job: its customer, its address, and one row per
 * cabinet from `lib/orders/items.ts`. The admin still reviews before saving —
 * weights can be blank, and worktops or panels are not rows yet.
 */
export const formFromOrder = (
	order: {
		id: string;
		customerName: string;
		customerPhone: string;
		siteAddress: string;
		addressNotes: string | null;
	},
	items: DeliveryItem[],
	workshopAddress: string,
): FormState => ({
	...blankForm(workshopAddress),
	orderId: order.id,
	customerName: order.customerName,
	customerPhone: order.customerPhone,
	siteAddress: order.siteAddress,
	addressNotes: order.addressNotes ?? "",
	items:
		items.length > 0
			? items.map((item) => ({ ...item, uid: crypto.randomUUID() }))
			: [emptyItem()],
});

/**
 * The form as the create and edit endpoints want it.
 *
 * The four pin fields are always null. This form has no pin inputs — an admin
 * types the address and the geocode finds the pin, which is what a person
 * actually does. The endpoints still accept an override because
 * `resolveCoordinates` rule 1 is the escape hatch for a geocode that landed on
 * the wrong taman, and because `pinFor` still reads a coordinate pair or a Maps
 * link typed into the *address* field as the pin — the paste that actually
 * happens, in the field the admin was already in.
 */
export function toPayload(state: FormState) {
	return {
		customerName: state.customerName,
		customerPhone: state.customerPhone,
		siteAddress: state.siteAddress,
		addressNotes: state.addressNotes || null,
		pickupAddress: state.pickupAddress,
		siteLat: null,
		siteLng: null,
		pickupLat: null,
		pickupLng: null,
		scheduledAt: state.scheduledAt
			? new Date(state.scheduledAt).toISOString()
			: null,
		items: state.items
			.filter((i) => i.label.trim() !== "")
			.map(({ uid: _uid, ...item }) => item),
		orderId: state.orderId,
	};
}
