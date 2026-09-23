import type { DeliveryStatusName } from "./types";

/**
 * One carrier's word for where a job is, translated into ours.
 *
 * Pure, and the only place a carrier's vocabulary is allowed to appear. Every
 * partner has its own spelling of the same six or seven states, and letting
 * those strings reach the UI is how a page ends up with a switch per carrier.
 *
 * An unrecognised status returns null and the caller leaves the row alone. That
 * is deliberate: a status we cannot read is not a reason to invent a transition,
 * and the raw payload is kept on the DeliveryEvent for whoever investigates.
 */

/** `"IN TRANSIT"`, `"in-transit"` and `"In_Transit"` are one key. */
export function normaliseStatusKey(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

/**
 * Per-carrier translation tables, keyed by normalised status.
 *
 * `manual`, `lalamove` and `easyparcel` are filled in; `gdex` and `citylink`
 * stay empty until their API documentation arrives — a guessed table would
 * map a status nobody sends and silently fail to map the ones they do.
 *
 * ponytail: empty tables until the carrier docs land; add each partner's real
 * statuses with its adapter, in the same commit.
 */
export const CARRIER_STATUS_MAPS: Record<
	string,
	Record<string, DeliveryStatusName>
> = {
	manual: {
		booked: "BOOKED",
		driver_assigned: "DRIVER_ASSIGNED",
		picked_up: "PICKED_UP",
		in_transit: "IN_TRANSIT",
		delivered: "DELIVERED",
		cancelled: "CANCELLED",
		failed: "FAILED",
	},
	/**
	 * Lalamove's seven order states. Two things to note:
	 *
	 * - They spell it `CANCELED`; we spell it `CANCELLED`. Both keys are here
	 *   because their own docs and dashboard are not consistent.
	 * - There is no in-transit state. A Lalamove driver who has collected stays
	 *   `PICKED_UP` until `COMPLETED`, so a Lalamove job never reaches our
	 *   `IN_TRANSIT` — which is the truth, not a hole in the table.
	 */
	lalamove: {
		assigning_driver: "BOOKED",
		on_going: "DRIVER_ASSIGNED",
		picked_up: "PICKED_UP",
		completed: "DELIVERED",
		canceled: "CANCELLED",
		cancelled: "CANCELLED",
		rejected: "FAILED",
		expired: "FAILED",
	},
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
	citylink: {},
	/**
	 * EasyParcel's shipment status *codes*, as strings.
	 *
	 * Keyed on the number rather than the text because the text is the courier's,
	 * not EasyParcel's: the same code arrives as "Parcel been collected at ABC"
	 * from one courier and "Collected" from another, and their own documented
	 * sample contains the typo "Deliverd To Suntech". The code is the stable
	 * half.
	 *
	 * 7 ("Schedule In Arrangement") and 2 ("To Be Collected") are both the state
	 * between booking and pickup, so both map to BOOKED. 8 ("On Hold") and 11
	 * are deliberately absent: On Hold is not a step along the route, and an
	 * unmapped status leaves the row alone rather than inventing a transition.
	 */
	easyparcel: {
		"0": "CANCELLED",
		"2": "BOOKED",
		"3": "PICKED_UP",
		"4": "IN_TRANSIT",
		"5": "DELIVERED",
		"6": "FAILED",
		"7": "BOOKED",
	},
};

export function mapCarrierStatus(
	carrierId: string,
	raw: string,
): DeliveryStatusName | null {
	const table = CARRIER_STATUS_MAPS[carrierId];
	if (!table) return null;
	return table[normaliseStatusKey(raw)] ?? null;
}

/**
 * Which way a job is meant to move. Used to reject a stale update: a webhook
 * and a poll can arrive out of order, and a late "picked up" must not drag a
 * delivered job backwards.
 *
 * The terminal three sit at the end together — nothing follows them, and
 * nothing outranks them.
 */
const RANK: Record<DeliveryStatusName, number> = {
	DRAFT: 0,
	QUOTED: 1,
	BOOKED: 2,
	DRIVER_ASSIGNED: 3,
	PICKED_UP: 4,
	IN_TRANSIT: 5,
	DELIVERED: 6,
	CANCELLED: 6,
	FAILED: 6,
};

/**
 * True when `next` is a forward move from `current`.
 *
 * Terminal states are final: once a job is delivered, cancelled or failed, a
 * straggling update can add an event but must not reopen it. Correcting a
 * wrongly-terminal job is an admin action, not something a carrier retry does.
 */
export function isForwardTransition(
	current: DeliveryStatusName,
	next: DeliveryStatusName,
): boolean {
	if (current === next) return false;
	if (RANK[current] === 6) return false;
	return RANK[next] > RANK[current];
}
