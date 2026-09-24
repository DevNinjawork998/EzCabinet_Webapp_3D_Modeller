import { describe, expect, it } from "vitest";
import { CARRIER_IDS } from "../carriers";
import {
	CARRIER_STATUS_MAPS,
	isForwardTransition,
	mapCarrierStatus,
	normaliseStatusKey,
} from "../status";

describe("normaliseStatusKey", () => {
	it("folds case, spacing and hyphens into one key", () => {
		expect(normaliseStatusKey("  IN TRANSIT ")).toBe("in_transit");
		expect(normaliseStatusKey("In-Transit")).toBe("in_transit");
		expect(normaliseStatusKey("in_transit")).toBe("in_transit");
	});
});

describe("mapCarrierStatus", () => {
	it("translates a known status however the carrier spelled it", () => {
		expect(mapCarrierStatus("manual", "PICKED UP")).toBe("PICKED_UP");
		expect(mapCarrierStatus("manual", "picked-up")).toBe("PICKED_UP");
	});

	it("returns null for a status it does not recognise, rather than guessing", () => {
		expect(mapCarrierStatus("manual", "held_at_depot")).toBeNull();
	});

	it("returns null for a carrier with no table yet", () => {
		// citylink is the remaining empty table; gdex gained one with its adapter.
		expect(mapCarrierStatus("citylink", "COMPLETED")).toBeNull();
	});

	it("returns null for a carrier that does not exist", () => {
		expect(mapCarrierStatus("nonesuch", "delivered")).toBeNull();
	});

	it("has a table for every carrier in the vocabulary", () => {
		for (const id of CARRIER_IDS) {
			expect(CARRIER_STATUS_MAPS[id]).toBeDefined();
		}
	});
});

describe("isForwardTransition", () => {
	it("allows a move along the journey", () => {
		expect(isForwardTransition("BOOKED", "PICKED_UP")).toBe(true);
	});

	it("rejects a late update that would move the job backwards", () => {
		expect(isForwardTransition("IN_TRANSIT", "PICKED_UP")).toBe(false);
	});

	it("rejects a repeat of the current status", () => {
		expect(isForwardTransition("IN_TRANSIT", "IN_TRANSIT")).toBe(false);
	});

	it("treats delivered, cancelled and failed as final", () => {
		expect(isForwardTransition("DELIVERED", "IN_TRANSIT")).toBe(false);
		expect(isForwardTransition("CANCELLED", "DELIVERED")).toBe(false);
		expect(isForwardTransition("FAILED", "DELIVERED")).toBe(false);
	});
});

describe("lalamove statuses", () => {
	it("maps every order state Lalamove sends", () => {
		expect(mapCarrierStatus("lalamove", "ASSIGNING_DRIVER")).toBe("BOOKED");
		expect(mapCarrierStatus("lalamove", "ON_GOING")).toBe("DRIVER_ASSIGNED");
		expect(mapCarrierStatus("lalamove", "PICKED_UP")).toBe("PICKED_UP");
		expect(mapCarrierStatus("lalamove", "COMPLETED")).toBe("DELIVERED");
		expect(mapCarrierStatus("lalamove", "CANCELED")).toBe("CANCELLED");
		expect(mapCarrierStatus("lalamove", "REJECTED")).toBe("FAILED");
		expect(mapCarrierStatus("lalamove", "EXPIRED")).toBe("FAILED");
	});

	it("maps our own spelling of cancelled too", () => {
		expect(mapCarrierStatus("lalamove", "CANCELLED")).toBe("CANCELLED");
	});

	it("returns null for a state nobody has seen", () => {
		expect(mapCarrierStatus("lalamove", "TELEPORTED")).toBeNull();
	});
});

describe("easyparcel status codes", () => {
	it("reads the numeric shipment status code", () => {
		expect(mapCarrierStatus("easyparcel", "2")).toBe("BOOKED");
		expect(mapCarrierStatus("easyparcel", "3")).toBe("PICKED_UP");
		expect(mapCarrierStatus("easyparcel", "4")).toBe("IN_TRANSIT");
		expect(mapCarrierStatus("easyparcel", "5")).toBe("DELIVERED");
		expect(mapCarrierStatus("easyparcel", "0")).toBe("CANCELLED");
		expect(mapCarrierStatus("easyparcel", "6")).toBe("FAILED");
	});

	it("leaves a job alone for a code that is not a transition", () => {
		// 8 is "On Hold" — a real state, and not a step along the route.
		expect(mapCarrierStatus("easyparcel", "8")).toBeNull();
		expect(mapCarrierStatus("easyparcel", "99")).toBeNull();
	});
});

describe("gdex statuses", () => {
	it("maps a freshly created consignment to booked", () => {
		expect(mapCarrierStatus("gdex", "Pending")).toBe("BOOKED");
	});

	it("normalises spacing and case the way every other carrier's table is", () => {
		expect(mapCarrierStatus("gdex", "IN TRANSIT")).toBe("IN_TRANSIT");
		expect(mapCarrierStatus("gdex", "in-transit")).toBe("IN_TRANSIT");
	});

	it("maps collection and delivery", () => {
		expect(mapCarrierStatus("gdex", "Picked Up")).toBe("PICKED_UP");
		expect(mapCarrierStatus("gdex", "Delivered")).toBe("DELIVERED");
	});

	it("maps the two ways a parcel ends badly", () => {
		expect(mapCarrierStatus("gdex", "Cancelled")).toBe("CANCELLED");
		expect(mapCarrierStatus("gdex", "Returned")).toBe("FAILED");
	});

	it("returns null for a word we have not seen, rather than inventing a move", () => {
		expect(mapCarrierStatus("gdex", "Bagged")).toBeNull();
	});
});

describe("fedex status table", () => {
	it.each([
		["OC", "BOOKED"],
		["PD", "BOOKED"],
		["DS", "BOOKED"],
		["PU", "PICKED_UP"],
		["DO", "PICKED_UP"],
		["IP", "PICKED_UP"],
		["IT", "IN_TRANSIT"],
		["AR", "IN_TRANSIT"],
		["AF", "IN_TRANSIT"],
		["DP", "IN_TRANSIT"],
		["TR", "IN_TRANSIT"],
		["OD", "IN_TRANSIT"],
		["DL", "DELIVERED"],
		["RS", "FAILED"],
		["CA", "CANCELLED"],
	])("maps %s to %s", (code, status) => {
		expect(mapCarrierStatus("fedex", code)).toBe(status);
	});

	it.each(["DE", "DD", "SE", "HP"])(
		"leaves the exception %s unmapped, so the row stays where it is",
		(code) => {
			expect(mapCarrierStatus("fedex", code)).toBeNull();
		},
	);
});
