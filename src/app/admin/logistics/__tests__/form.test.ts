import { describe, expect, it } from "vitest";
import {
	blankForm,
	type DeliveryRow,
	formFrom,
	formFromOrder,
	toPayload,
} from "../form";

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
		{
			label: "Base unit",
			qty: 2,
			widthMm: 800,
			heightMm: 720,
			depthMm: 560,
			weightKg: null,
		},
	],
	totalWeightKg: null,
	totalVolumeM3: 0.645,
	scheduledAt: null,
	carrierId: null,
	status: "DRAFT",
	quotedPriceRm: null,
	carrierOrderId: null,
	trackingUrl: null,
	labelUrl: null,
	driverName: null,
	driverPhone: null,
	vehiclePlate: null,
	lastLatitude: null,
	lastLongitude: null,
	lastLocationAt: null,
	bookedBy: null,
	splitFromNumber: null,
	publicToken: "tok_d1",
	orderId: null,
	createdAt: "2026-09-05T13:28:14.000Z",
};

describe("formFromOrder", () => {
	const order = {
		id: "o1",
		customerName: "Jia Wei Tan",
		customerPhone: "+60123384471",
		siteAddress: "12 Jalan Meranti 4, 47120 Puchong",
		addressNotes: null,
	};

	it("opens a new job with the order's customer, address and cabinets", () => {
		const state = formFromOrder(order, row.items, "Workshop");

		expect(state).toMatchObject({
			id: null,
			orderId: "o1",
			customerName: "Jia Wei Tan",
			siteAddress: "12 Jalan Meranti 4, 47120 Puchong",
			addressNotes: "",
			pickupAddress: "Workshop",
		});
		expect(toPayload(state)).toMatchObject({
			orderId: "o1",
			items: row.items,
		});
	});

	it("still gives the admin a row to type into when the design had no cabinets left", () => {
		expect(formFromOrder(order, [], "Workshop").items).toHaveLength(1);
	});
});

describe("formFrom", () => {
	it("carries the row's id so a save becomes a PATCH", () => {
		expect(formFrom(row).id).toBe("d1");
	});

	it("gives every item a key React can keep across edits", () => {
		const uids = formFrom({
			...row,
			items: [...row.items, ...row.items],
		}).items.map((i) => i.uid);
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

	// The form has no pin inputs: an admin types the address and the geocode
	// finds the pin. Sending an override would make `resolveCoordinates` rule 1
	// authoritative and stop a corrected address from ever being re-geocoded.
	it("never sends a coordinate override, for a new job or an edited one", () => {
		const nulls = {
			siteLat: null,
			siteLng: null,
			pickupLat: null,
			pickupLng: null,
		};
		expect(toPayload(blankForm("Workshop"))).toMatchObject(nulls);
		expect(toPayload(formFrom(row))).toMatchObject(nulls);
	});

	it("round-trips a scheduled time through the local datetime field", () => {
		const iso = new Date("2026-09-10T09:30:00+08:00").toISOString();
		const state = formFrom({ ...row, scheduledAt: iso });
		expect(toPayload(state).scheduledAt).toBe(iso);
	});
});
