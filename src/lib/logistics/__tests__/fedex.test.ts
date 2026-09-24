import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]) => ({ pathname: "p" })),
);
vi.mock("@vercel/blob", () => ({ put }));

const findMany = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));
const create = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
vi.mock("@/lib/catalogue/db", () => ({
	prisma: { deliveryEvent: { findMany, create } },
}));

import {
	chooseRate,
	FedexNotDeliverable,
	fedexAdapter,
	fedexBook,
	fedexCancel,
	fedexConfigured,
	fedexQuote,
	fedexTrack,
	forgetFedexToken,
	MAX_LINE_ITEMS,
	packagesOf,
	pickupBody,
	pickupDate,
	pickupPlaceOf,
	rateBody,
	readPickupRef,
	readTracking,
	SANDBOX,
	shipBody,
	sitePlaceOf,
	streetLines,
	trackingUrlFor,
} from "../adapters/fedex";
import { WORKSHOP_ADDRESS } from "../carriers";
import {
	CarrierNotConfigured,
	type DeliveryItem,
	type DeliveryJob,
} from "../types";
import {
	cancelPickupReply,
	cancelShipmentReply,
	pickupReply,
	rateReply,
	rateReplyEmpty,
	rateReplyInUsd,
	rateReplyWithoutPriority,
	shipReply,
	tokenReply,
	trackReply,
	trackReplyNotFound,
	unauthorised,
} from "./fixtures/fedex";

/**
 * Pinned so `job()`'s date stays in the future: the GDEX suite went red on a
 * calendar page turning, and this one should not.
 */
beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date("2026-09-22T02:00:00.000Z"));
	vi.stubEnv("FEDEX_API_KEY", "key_test");
	vi.stubEnv("FEDEX_API_PASSWORD", "secret_test");
	vi.stubEnv("FEDEX_ACCOUNT_NUMBER", "740561073");
	vi.stubEnv("FEDEX_API_URL", "");
	forgetFedexToken();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	put.mockClear();
	findMany.mockReset();
	findMany.mockResolvedValue([]);
	create.mockReset();
	create.mockResolvedValue({});
});

const handles: DeliveryItem = {
	label: "Handle set",
	qty: 2,
	widthMm: 300,
	heightMm: 100,
	depthMm: 80,
	weightKg: 1.5,
};

const job = (over: Partial<DeliveryJob> = {}): DeliveryJob => ({
	id: "dlv_1",
	number: 7,
	customerName: "Chan Kin Kong",
	customerPhone: "012-345 6789",
	siteAddress: "No. 45, Persiaran Mahsuri 1/3, 11950 Bayan Baru, Pulau Pinang",
	sitePostcode: "11950",
	siteCity: "Bayan Baru",
	siteState: "MY-07",
	pickupPostcode: null,
	pickupCity: null,
	pickupState: null,
	addressNotes: "Guard house, ask for block C",
	pickupAddress: WORKSHOP_ADDRESS,
	siteLat: null,
	siteLng: null,
	pickupLat: null,
	pickupLng: null,
	items: [handles],
	totalWeightKg: 3,
	totalVolumeM3: 0.005,
	scheduledAt: new Date("2026-09-24T01:00:00.000Z"),
	...over,
});

/** One queued Response per fetch, in order. */
function stubFetch(...replies: Array<{ status?: number; body: unknown }>) {
	const fetchMock = vi.fn();
	for (const { status = 200, body } of replies) {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const ok = (body: unknown) => ({ body });
const sent = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
	JSON.parse(fetchMock.mock.calls[call][1].body as string);
/** The `data` a mocked `prisma` write was called with, untyped like the mock itself. */
const dataOf = (mock: ReturnType<typeof vi.fn>, call = 0) =>
	(mock.mock.calls[call][0] as { data: any }).data;

describe("fedexConfigured", () => {
	it("needs the key, the password and the account number", () => {
		expect(fedexConfigured()).toBe(true);
		vi.stubEnv("FEDEX_ACCOUNT_NUMBER", "");
		expect(fedexConfigured()).toBe(false);
	});
});

describe("packagesOf", () => {
	it("sends one line item per row, qty as the package count, in kg and cm", () => {
		expect(packagesOf(job())).toEqual([
			{
				groupPackageCount: 2,
				weight: { units: "KG", value: 1.5 },
				dimensions: { length: 8, width: 30, height: 10, units: "CM" },
			},
		]);
	});

	it("rounds millimetres up to whole centimetres, never down", () => {
		const [pkg] = packagesOf(
			job({ items: [{ ...handles, widthMm: 301, heightMm: 99, depthMm: 5 }] }),
		);
		expect(pkg.dimensions).toEqual({
			length: 1,
			width: 31,
			height: 10,
			units: "CM",
		});
	});

	it("refuses a job with nothing in it", () => {
		expect(() => packagesOf(job({ items: [] }))).toThrow(FedexNotDeliverable);
	});

	it("refuses an unweighed row rather than guessing", () => {
		expect(() =>
			packagesOf(job({ items: [{ ...handles, weightKg: null }] })),
		).toThrow(/Handle set has no weight/);
	});

	it("refuses a box over 68 kg", () => {
		expect(() =>
			packagesOf(job({ items: [{ ...handles, weightKg: 70 }] })),
		).toThrow(/at most 68 kg/);
	});

	it("refuses more rows than FedEx takes on one shipment", () => {
		const items = Array.from({ length: MAX_LINE_ITEMS + 1 }, () => handles);
		expect(() => packagesOf(job({ items }))).toThrow(/at most 30/);
	});
});

describe("places", () => {
	it("reads the site postcode and town off the job", () => {
		expect(sitePlaceOf(job())).toEqual({
			postcode: "11950",
			city: "Bayan Baru",
		});
	});

	it("refuses a site without a five-digit postcode", () => {
		expect(() => sitePlaceOf(job({ sitePostcode: null }))).toThrow(
			FedexNotDeliverable,
		);
		expect(() => sitePlaceOf(job({ sitePostcode: "1195" }))).toThrow(
			/five-digit postcode \(1195\)/,
		);
	});

	it("falls back to the workshop's postcode for a workshop pickup", () => {
		expect(pickupPlaceOf(job())).toEqual({
			postcode: "43800",
			city: "Dengkil",
		});
	});

	it("refuses an edited pickup that was never geocoded", () => {
		expect(() =>
			pickupPlaceOf(job({ pickupAddress: "Lot 5, Jalan Kilang, Shah Alam" })),
		).toThrow(/pickup address has no five-digit postcode/);
	});
});

describe("pickupDate", () => {
	it("is the scheduled day in Malaysian time", () => {
		// 2026-09-23T17:00Z is 01:00 on the 24th in Kuala Lumpur.
		expect(
			pickupDate(job({ scheduledAt: new Date("2026-09-23T17:00:00.000Z") })),
		).toBe("2026-09-24");
	});

	it("refuses a job with no scheduled date", () => {
		expect(() => pickupDate(job({ scheduledAt: null }))).toThrow(
			/no scheduled date/,
		);
	});

	it("refuses a day that has gone", () => {
		expect(() =>
			pickupDate(job({ scheduledAt: new Date("2026-09-20T01:00:00.000Z") })),
		).toThrow(/which is past/);
	});
});

describe("rateBody", () => {
	it("asks for account rates in ringgit, collected from the workshop", () => {
		expect(rateBody(job(), "740561073")).toEqual({
			accountNumber: { value: "740561073" },
			requestedShipment: {
				shipper: {
					address: { postalCode: "43800", city: "Dengkil", countryCode: "MY" },
				},
				recipient: {
					address: {
						postalCode: "11950",
						city: "Bayan Baru",
						countryCode: "MY",
					},
				},
				pickupType: "CONTACT_FEDEX_TO_SCHEDULE",
				packagingType: "YOUR_PACKAGING",
				rateRequestType: ["ACCOUNT"],
				preferredCurrency: "MYR",
				requestedPackageLineItems: packagesOf(job()),
			},
		});
	});

	it("refuses an unschedulable job before anything is priced", () => {
		expect(() => rateBody(job({ scheduledAt: null }), "740561073")).toThrow(
			FedexNotDeliverable,
		);
	});
});

describe("chooseRate", () => {
	it("prefers FedEx Priority, the domestic parcel service", () => {
		expect(chooseRate(rateReply)).toEqual({
			serviceType: "FEDEX_PRIORITY",
			serviceName: "FEDEX PRIORITY",
			priceRm: 38.4,
		});
	});

	it("falls back to the cheapest service when Priority is not offered", () => {
		expect(chooseRate(rateReplyWithoutPriority).serviceType).toBe(
			"INTERNATIONAL_ECONOMY",
		);
	});

	it("refuses a price in any currency but ringgit", () => {
		expect(() => chooseRate(rateReplyInUsd)).toThrow(/USD, not ringgit/);
	});

	it("refuses a reply that priced nothing", () => {
		expect(() => chooseRate(rateReplyEmpty)).toThrow(/priced nothing/);
	});

	it("names the shape it could not read", () => {
		expect(() => chooseRate({ nope: true })).toThrow(
			/FedEx's rate reply was not the shape we expect/,
		);
	});
});

describe("fedexQuote", () => {
	it("gets a token, then prices at the sandbox by default", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		const quote = await fedexQuote(job());

		expect(fetchMock.mock.calls[0][0]).toBe(`${SANDBOX}/oauth/token`);
		expect(fetchMock.mock.calls[0][1].body).toContain(
			"grant_type=client_credentials",
		);
		expect(fetchMock.mock.calls[1][0]).toBe(`${SANDBOX}/rate/v1/rates/quotes`);
		expect(fetchMock.mock.calls[1][1].headers.authorization).toBe(
			"Bearer tok_test",
		);
		expect(sent(fetchMock, 1).requestedShipment.preferredCurrency).toBe("MYR");
		expect(quote).toEqual({
			carrierId: "fedex",
			priceRm: 38.4,
			etaMinutes: null,
			quoteRef: "FEDEX_PRIORITY",
			notes: "Parcel, 3 kg — FEDEX PRIORITY",
		});
	});

	it("uses FEDEX_API_URL when it is set, without a trailing slash", async () => {
		vi.stubEnv("FEDEX_API_URL", "https://apis.fedex.com/");
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		await fedexQuote(job());

		expect(fetchMock.mock.calls[1][0]).toBe(
			"https://apis.fedex.com/rate/v1/rates/quotes",
		);
	});

	it("reuses a live token instead of asking for a new one", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply), ok(rateReply));

		await fedexQuote(job());
		await fedexQuote(job());

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("asks for a fresh token once when FedEx says the old one is dead", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			{ status: 401, body: unauthorised },
			ok({ ...tokenReply, access_token: "tok_fresh" }),
			ok(rateReply),
		);

		const quote = await fedexQuote(job());

		expect(quote.priceRm).toBe(38.4);
		expect(fetchMock.mock.calls[3][1].headers.authorization).toBe(
			"Bearer tok_fresh",
		);
	});

	it("refuses to call at all without an account number", async () => {
		vi.stubEnv("FEDEX_ACCOUNT_NUMBER", "");
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		await expect(fedexQuote(job())).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses an unweighed job before it dials", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(rateReply));

		await expect(
			fedexQuote(job({ items: [{ ...handles, weightKg: null }] })),
		).rejects.toBeInstanceOf(FedexNotDeliverable);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("streetLines", () => {
	it("wraps an address into lines of at most 35 characters", () => {
		const lines = streetLines(
			"No. 45, Persiaran Mahsuri 1/3, 11950 Bayan Baru, Pulau Pinang",
		);
		expect(lines).toEqual([
			"No. 45, Persiaran Mahsuri 1/3,",
			"11950 Bayan Baru, Pulau Pinang",
		]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(35);
	});

	it("keeps three lines at most, which is all FedEx reads", () => {
		const long =
			"Lot 1234, Jalan Perindustrian Bukit Minyak 7, Kawasan Perindustrian Bukit Minyak, Mukim 13, 14100 Simpang Ampat, Seberang Perai Tengah, Pulau Pinang";
		expect(streetLines(long)).toHaveLength(3);
	});
});

describe("shipBody", () => {
	it("books the priced service, paid by us, labels merged into one PDF", () => {
		const body = shipBody(job(), "740561073", "FEDEX_PRIORITY");

		expect(body.accountNumber).toEqual({ value: "740561073" });
		expect(body.labelResponseOptions).toBe("URL_ONLY");
		expect(body.mergeLabelDocOption).toBe("LABELS_ONLY");
		const shipment = body.requestedShipment;
		expect(shipment.serviceType).toBe("FEDEX_PRIORITY");
		expect(shipment.pickupType).toBe("CONTACT_FEDEX_TO_SCHEDULE");
		expect(shipment.packagingType).toBe("YOUR_PACKAGING");
		expect(shipment.shippingChargesPayment).toEqual({ paymentType: "SENDER" });
		expect(shipment.labelSpecification).toEqual({
			imageType: "PDF",
			labelStockType: "PAPER_4X6",
		});
		expect(shipment.shipDatestamp).toBe("2026-09-24");
		expect(shipment.totalWeight).toBe(3);
		expect(shipment.recipients[0]).toEqual({
			contact: { personName: "Chan Kin Kong", phoneNumber: "60123456789" },
			address: {
				streetLines: [
					"No. 45, Persiaran Mahsuri 1/3,",
					"11950 Bayan Baru, Pulau Pinang",
				],
				postalCode: "11950",
				city: "Bayan Baru",
				countryCode: "MY",
			},
		});
		expect(shipment.shipper.contact.companyName).toBe("EzCabinet Sdn Bhd");
	});

	it("refuses a customer number FedEx cannot ring", () => {
		expect(() =>
			shipBody(
				job({ customerPhone: "+65 6123 4567" }),
				"740561073",
				"FEDEX_PRIORITY",
			),
		).toThrow(/not a Malaysian number FedEx can call/);
	});
});

describe("pickupBody", () => {
	it("asks FedEx Express to collect from the workshop at the scheduled time", () => {
		expect(pickupBody(job(), "740561073")).toEqual({
			associatedAccountNumber: { value: "740561073" },
			originDetail: {
				pickupLocation: {
					contact: {
						companyName: "EzCabinet Sdn Bhd",
						phoneNumber: "60312345678",
					},
					address: {
						streetLines: ["EzCabinet Sdn Bhd, Klang Valley,", "Selangor"],
						postalCode: "43800",
						city: "Dengkil",
						countryCode: "MY",
					},
				},
				readyDateTimestamp: "2026-09-24T09:00:00",
				customerCloseTime: "18:00:00",
			},
			carrierCode: "FDXE",
		});
	});
});

describe("fedexBook", () => {
	const quote = {
		carrierId: "fedex",
		priceRm: 38.4,
		etaMinutes: null,
		quoteRef: "FEDEX_PRIORITY",
	};
	const pdf = () => ({ status: 200, body: "%PDF-1.4" });

	it("creates the shipment, books the collection and keeps the label", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(shipReply),
			ok(pickupReply),
			pdf(),
		);

		const booking = await fedexBook(job(), quote);

		expect(fetchMock.mock.calls[1][0]).toBe(`${SANDBOX}/ship/v1/shipments`);
		expect(fetchMock.mock.calls[2][0]).toBe(`${SANDBOX}/pickup/v1/pickups`);
		expect(fetchMock.mock.calls[3][0]).toBe(
			"https://wwwtest.fedex.com/document/v1/cache/merged.pdf",
		);
		expect(put.mock.calls[0][0]).toBe("logistics/fedex/794953535000.pdf");
		expect(put.mock.calls[0][2]).toMatchObject({ access: "private" });
		expect(fetchMock.mock.calls[3][1].redirect).toBe("error");
		expect(booking).toEqual({
			carrierOrderId: "794953535000",
			trackingUrl: trackingUrlFor("794953535000"),
			labelUrl: "/api/admin/deliveries/dlv_1/label",
			pickupRef: JSON.stringify({
				code: "3001",
				date: "2026-09-24",
				location: "KULA",
			}),
			note: "FedEx collection 3001 on 2026-09-24",
		});
	});

	it("never sends the shipment twice, even on FedEx's own 500", async () => {
		const fetchMock = stubFetch(ok(tokenReply), {
			status: 500,
			body: { errors: [{ code: "INTERNAL.SERVER.ERROR" }] },
		});

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/may have created this shipment .* check FedEx Ship Manager before booking again/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("warns rather than refuses when the ship call times out", async () => {
		const fetchMock = vi.fn();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(tokenReply), { status: 200 }),
		);
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/may have created this shipment .* check FedEx Ship Manager before booking again/,
		);
	});

	it("rejects plainly, not with the retry warning, when FedEx refuses the ship call outright", async () => {
		stubFetch(ok(tokenReply), {
			status: 400,
			body: { errors: [{ code: "PACKAGE.INVALID" }] },
		});

		const rejection = await fedexBook(job(), quote).catch((error) => error);
		expect(rejection.message).toMatch(/fedex responded 400/);
		expect(rejection.message).not.toMatch(/may have created/);
	});

	it("warns rather than refuses when the ship reply cannot be read", async () => {
		stubFetch(ok(tokenReply), ok({ output: {} }));

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/may have created this shipment .* check FedEx Ship Manager before booking again/,
		);
	});

	it("refuses a shipment with no tracking number at all", async () => {
		const untracked = structuredClone<Record<string, any>>(shipReply);
		untracked.output.transactionShipments[0].masterTrackingNumber = null;
		untracked.output.transactionShipments[0].pieceResponses = [];
		stubFetch(ok(tokenReply), ok(untracked));

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/returned no tracking number — check FedEx Ship Manager/,
		);
	});

	it("falls back to the piece tracking number when there is no master one", async () => {
		const pieceOnly = structuredClone<Record<string, any>>(shipReply);
		pieceOnly.output.transactionShipments[0].masterTrackingNumber = null;
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(pieceOnly),
			ok(pickupReply),
			pdf(),
		);

		const booking = await fedexBook(job(), quote);

		expect(booking.carrierOrderId).toBe("794953535000");
	});

	it("falls back to the piece label when there is no merged-labels document", async () => {
		const noMerged = structuredClone(shipReply);
		noMerged.output.transactionShipments[0].shipmentDocuments = [];
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(noMerged),
			ok(pickupReply),
			pdf(),
		);

		await fedexBook(job(), quote);

		expect(fetchMock.mock.calls[3][0]).toBe(
			"https://wwwtest.fedex.com/document/v1/cache/piece1.pdf",
		);
	});

	it("cancels the shipment when the collection cannot be booked", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(shipReply),
			{
				status: 400,
				body: {
					errors: [
						{
							code: "PICKUP.DATE.INVALID",
							message: "Pickup date is not available",
						},
					],
				},
			},
			ok(cancelShipmentReply),
		);

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/so the shipment was cancelled: .*Pickup date is not available/,
		);
		expect(fetchMock.mock.calls[3][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
		expect(sent(fetchMock, 3)).toEqual({
			accountNumber: { value: "740561073" },
			trackingNumber: "794953535000",
		});
	});

	it("says the collection may still be booked when FedEx doesn't confirm it (a 5xx or timeout)", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(shipReply),
			{ status: 500, body: { errors: [{ code: "INTERNAL.SERVER.ERROR" }] } },
			ok(cancelShipmentReply),
		);

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/may still be booked/,
		);
		expect(fetchMock.mock.calls[3][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
	});

	it("names the tracking number when neither the pickup nor the undo worked", async () => {
		stubFetch(
			ok(tokenReply),
			ok(shipReply),
			{ status: 400, body: { errors: [{ code: "PICKUP.X", message: "no" }] } },
			{
				status: 400,
				body: { errors: [{ code: "SHIPMENT.X", message: "no" }] },
			},
		);

		await expect(fedexBook(job(), quote)).rejects.toThrow(
			/shipment 794953535000 could not be cancelled .* void it in FedEx Ship Manager/,
		);
	});

	it("still books when the label cannot be fetched", async () => {
		stubFetch(ok(tokenReply), ok(shipReply), ok(pickupReply), {
			status: 404,
			body: {},
		});

		const booking = await fedexBook(job(), quote);

		expect(booking.carrierOrderId).toBe("794953535000");
		expect(booking.labelUrl).toBeNull();
		expect(put).not.toHaveBeenCalled();
	});

	it("never sends our token to a label link off FedEx's domain", async () => {
		const foreign = structuredClone(shipReply);
		foreign.output.transactionShipments[0].shipmentDocuments[0].url =
			"https://example.com/label.pdf";
		const fetchMock = stubFetch(ok(tokenReply), ok(foreign), ok(pickupReply));

		const booking = await fedexBook(job(), quote);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(booking.labelUrl).toBeNull();
	});

	it("never sends our token to a label link over plain http", async () => {
		const insecure = structuredClone(shipReply);
		insecure.output.transactionShipments[0].shipmentDocuments[0].url =
			"http://wwwtest.fedex.com/document/v1/cache/merged.pdf";
		const fetchMock = stubFetch(ok(tokenReply), ok(insecure), ok(pickupReply));

		const booking = await fedexBook(job(), quote);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(booking.labelUrl).toBeNull();
		expect(put).not.toHaveBeenCalled();
	});

	it("refuses an unbookable job before creating anything", async () => {
		const fetchMock = stubFetch(ok(tokenReply));

		await expect(
			fedexBook(job({ scheduledAt: null }), quote),
		).rejects.toBeInstanceOf(FedexNotDeliverable);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("readTracking", () => {
	it("maps FedEx's code, not its localised description", () => {
		expect(
			readTracking(
				trackReply("794953535000", "DL", "Entregado"),
				"794953535000",
			),
		).toMatchObject({
			status: "DELIVERED",
			message: "FedEx reports Entregado",
		});
	});

	it("leaves an exception unmapped, so the row stays where it is", () => {
		expect(
			readTracking(trackReply("794953535000", "DE"), "794953535000").status,
		).toBeNull();
	});

	it("reports a number FedEx does not know as no status, not as booked", () => {
		expect(
			readTracking(trackReplyNotFound("794953535000"), "794953535000"),
		).toMatchObject({
			status: null,
			message:
				"FedEx has no tracking for 794953535000 (TRACKING.TRACKINGNUMBER.NOTFOUND)",
		});
	});
});

describe("fedexTrack", () => {
	it("asks for one number, without the scan history", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(trackReply("794953535000", "OD")),
		);

		const update = await fedexTrack("794953535000");

		expect(fetchMock.mock.calls[1][0]).toBe(
			`${SANDBOX}/track/v1/trackingnumbers`,
		);
		expect(sent(fetchMock, 1)).toEqual({
			includeDetailedScans: false,
			trackingInfo: [
				{ trackingNumberInfo: { trackingNumber: "794953535000" } },
			],
		});
		expect(update.status).toBe("IN_TRANSIT");
	});
});

describe("readPickupRef", () => {
	const ref = { code: "3001", date: "2026-09-24", location: "KULA" };

	it("reads the collection back out of the booking event", () => {
		expect(
			readPickupRef({ booking: { pickupRef: JSON.stringify(ref) } }),
		).toEqual(ref);
	});

	it("is null for any other event's raw payload", () => {
		expect(readPickupRef(null)).toBeNull();
		expect(readPickupRef({ booking: {} })).toBeNull();
		expect(readPickupRef({ booking: { pickupRef: "not json" } })).toBeNull();
	});
});

describe("fedexCancel", () => {
	const booked = {
		raw: {
			booking: {
				pickupRef: JSON.stringify({
					code: "3001",
					date: "2026-09-24",
					location: "KULA",
				}),
			},
		},
	};

	it("cancels the collection, then the shipment", async () => {
		findMany.mockResolvedValue([booked] as never);
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok(cancelPickupReply),
			ok(cancelShipmentReply),
		);

		await fedexCancel("794953535000");

		expect(findMany.mock.calls[0][0]).toMatchObject({
			where: { status: "BOOKED", delivery: { carrierOrderId: "794953535000" } },
		});
		expect(fetchMock.mock.calls[1][0]).toBe(
			`${SANDBOX}/pickup/v1/pickups/cancel`,
		);
		expect(sent(fetchMock, 1)).toEqual({
			associatedAccountNumber: { value: "740561073" },
			pickupConfirmationCode: "3001",
			scheduledDate: "2026-09-24",
			carrierCode: "FDXE",
			location: "KULA",
		});
		expect(fetchMock.mock.calls[2][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("still cancels the shipment when the collection cannot be cancelled", async () => {
		findMany.mockResolvedValue([booked] as never);
		const fetchMock = stubFetch(
			ok(tokenReply),
			{ status: 400, body: { errors: [{ code: "PICKUP.ALREADY.DONE" }] } },
			ok(cancelShipmentReply),
		);

		await fedexCancel("794953535000");

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(create).toHaveBeenCalledTimes(1);
		expect(dataOf(create).delivery.connect.carrierOrderId).toBe("794953535000");
		expect(dataOf(create).message).toMatch(
			/collection 3001 on 2026-09-24 could not be cancelled/,
		);
		expect(dataOf(create).source).toBe("ADMIN");
	});

	it("passes FedEx's refusal up when the parcel is already moving", async () => {
		stubFetch(ok(tokenReply), {
			status: 400,
			body: {
				errors: [
					{
						code: "SHIPMENT.CANCEL.NOTALLOWED",
						message: "Shipment already scanned",
					},
				],
			},
		});

		await expect(fedexCancel("794953535000")).rejects.toThrow(
			/Shipment already scanned/,
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("cancels just the shipment when no collection was recorded", async () => {
		const fetchMock = stubFetch(ok(tokenReply), ok(cancelShipmentReply));

		await fedexCancel("794953535000");

		expect(fetchMock.mock.calls[1][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
		expect(dataOf(create).message).toMatch(/No FedEx collection was recorded/);
	});

	it("does not fail the cancel when writing the event log fails", async () => {
		create.mockRejectedValue(new Error("db down"));
		const fetchMock = stubFetch(ok(tokenReply), ok(cancelShipmentReply));

		await expect(fedexCancel("794953535000")).resolves.toBeUndefined();
		expect(fetchMock.mock.calls[1][0]).toBe(
			`${SANDBOX}/ship/v1/shipments/cancel`,
		);
	});

	it("throws when FedEx says the shipment was not cancelled", async () => {
		const fetchMock = stubFetch(
			ok(tokenReply),
			ok({ output: { cancelledShipment: false } }),
		);

		await expect(fedexCancel("794953535000")).rejects.toThrow(
			/FedEx did not cancel shipment 794953535000/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("fedexAdapter", () => {
	it("is the parcel adapter the registry hands out", () => {
		expect(fedexAdapter.id).toBe("fedex");
		expect(fedexAdapter.isConfigured()).toBe(true);
		expect(fedexAdapter.quote).toBe(fedexQuote);
		expect(fedexAdapter.book).toBe(fedexBook);
		expect(fedexAdapter.track).toBe(fedexTrack);
		expect(fedexAdapter.cancel).toBe(fedexCancel);
		expect(fedexAdapter.verifyWebhook).toBeUndefined();
	});
});
