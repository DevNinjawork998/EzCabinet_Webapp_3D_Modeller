/**
 * The logistics partner vocabulary, in one place.
 *
 * The admin form, the API's payload schema and the comparison table all read
 * this list — same reasoning as `lib/tutorials.ts`. Two lists kept in step by
 * hand drift, and here the drift would be a carrier the admin can pick and the
 * booking route cannot reach.
 *
 * Isomorphic: this is imported by client components, so nothing secret belongs
 * here. Credentials live in the adapters, which are `server-only`.
 */

/**
 * `vehicle` books a whole van or lorry by distance; `parcel` books a
 * consignment by weight and dimensions.
 *
 * The distinction is not cosmetic. Finished cabinets are bulky — a 900mm
 * carcass fails the girth and weight caps of every parcel network — so a
 * `vehicle` partner does the real work, and the `parcel` ones carry hardware,
 * samples and spare doors. It is also only the `vehicle` partners that report
 * where the driver currently is.
 */
export type CarrierKind = "vehicle" | "parcel";

export const CARRIERS = [
	{ id: "manual", label: "Own lorry / phoned in", kind: "vehicle" },
	{ id: "lalamove", label: "Lalamove", kind: "vehicle" },
	{ id: "gdex", label: "GDEX", kind: "parcel" },
	{ id: "citylink", label: "City-Link", kind: "parcel" },
	{ id: "easyparcel", label: "EasyParcel", kind: "parcel" },
	{ id: "fedex", label: "FedEx", kind: "parcel" },
] as const satisfies readonly {
	id: string;
	label: string;
	kind: CarrierKind;
}[];

export type CarrierId = (typeof CARRIERS)[number]["id"];

export const CARRIER_IDS = CARRIERS.map((c) => c.id) as [
	CarrierId,
	...CarrierId[],
];

/** `{ lalamove: "Lalamove", … }` for rendering a row or a chip. */
export const LABEL: Record<string, string> = Object.fromEntries(
	CARRIERS.map((c) => [c.id, c.label]),
);

export const KIND: Record<string, CarrierKind> = Object.fromEntries(
	CARRIERS.map((c) => [c.id, c.kind]),
);

/**
 * Where every pickup starts unless the admin edits it. A constant rather than
 * a settings row because there is one workshop, and a Settings table for a
 * single string nobody has asked to change twice is a table nobody maintains.
 */
export const WORKSHOP_ADDRESS = "EzCabinet Sdn Bhd, Klang Valley, Selangor";

/**
 * The workshop's pin, as a constant rather than something we look up.
 *
 * Lalamove prices stop to stop by coordinate and reads the address line only
 * as a label for the driver, so this is the field that actually decides where
 * the lorry starts. It never changes, which makes geocoding it on every save
 * a call that can only ever return the same answer — and today returns none at
 * all, because `WORKSHOP_ADDRESS` is a placeholder too vague to place. Every
 * job has therefore been created with an unlocated pickup, and Lalamove
 * refuses a stop without coordinates, so it could not quote a single one.
 *
 * From the client's own Maps link for INFINITE CABINET SDN BHD. Taken off the
 * `!3d`/`!4d` pin in the expanded url, not the `@` viewport centre — those
 * disagree by about 5 km here, and the viewport is only where the map was
 * scrolled to.
 */
import { pinFor } from "./coords";

export const WORKSHOP_PIN = { lat: 2.9848868, lng: 101.861807 };

/**
 * The pin to send as the pickup override, in precedence order: what the admin
 * typed, then the workshop's own pin when the job leaves from the workshop,
 * then nothing.
 *
 * The address check is what keeps this honest — an admin who edits the pickup
 * to a different address gets a geocode, not the workshop's coordinates
 * silently attached to somewhere else.
 */
export function pickupPin(
	address: string,
	lat: number | null,
	lng: number | null,
): { lat: number; lng: number } | null {
	// `pinFor` also covers coordinates typed into the address box, which is
	// where an admin's pin lands more often than anyone would guess.
	const given = pinFor(lat, lng, address);
	if (given) return given;
	return address.trim() === WORKSHOP_ADDRESS ? WORKSHOP_PIN : null;
}

/**
 * The workshop's postcode, town and state.
 *
 * EasyParcel prices by postcode and subdivision rather than by coordinate, so
 * these are to a parcel quote what `WORKSHOP_PIN` is to a Lalamove one: without
 * them the sender half of the request cannot be built at all.
 *
 * ponytail: derived from `WORKSHOP_PIN`, which sits in the Dengkil/Sepang area
 * of Selangor, and placeholders until the client confirms the street address —
 * the same open question `WORKSHOP_ADDRESS` and `WORKSHOP_PHONE` carry. A wrong
 * postcode here is a quote for the wrong origin zone on every parcel job.
 */
export const WORKSHOP_POSTCODE = "43800";
export const WORKSHOP_CITY = "Dengkil";
export const WORKSHOP_STATE = "MY-10";

export type Place = {
	postcode: string | null;
	city: string | null;
	state: string | null;
};

/**
 * The place to quote a pickup from: what the geocode stored, then the
 * workshop's own, then nothing.
 *
 * Same shape and same reasoning as `pickupPin` — the address check is what
 * keeps an edited pickup from silently inheriting the workshop's postcode.
 */
export function pickupPlace(address: string, stored: Place): Place | null {
	if (stored.postcode !== null && stored.state !== null) return stored;
	return address.trim() === WORKSHOP_ADDRESS
		? {
				postcode: WORKSHOP_POSTCODE,
				city: WORKSHOP_CITY,
				state: WORKSHOP_STATE,
			}
		: null;
}

/**
 * The number a driver rings from the loading bay. Beside the address for the
 * same reason it is: one workshop, one string, no settings table.
 *
 * ponytail: a placeholder until the client gives us the real line. It is sent
 * to Lalamove as the pickup contact, so a wrong number here is a driver who
 * cannot reach anyone — see the open question in CLAUDE.md.
 */
export const WORKSHOP_PHONE = "03-1234 5678";

/**
 * When the workshop stops handing parcels over, as FedEx's pickup request
 * wants it (`customerCloseTime`, `HH:MM:SS`, Malaysian local time).
 *
 * ponytail: a placeholder until the client confirms their hours — the same
 * open question as `WORKSHOP_ADDRESS` and `WORKSHOP_PHONE`. Too early and
 * FedEx refuses a late-afternoon collection; too late and a courier arrives
 * to a locked gate.
 */
export const WORKSHOP_CLOSE_TIME = "18:00:00";
