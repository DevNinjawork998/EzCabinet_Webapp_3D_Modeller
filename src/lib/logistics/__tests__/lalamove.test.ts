import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LalamoveNotDeliverable,
	lalamoveAdapter,
	orderBody,
	packQuoteRef,
	quotationBody,
	serviceTypeFor,
	signRequest,
	unpackQuoteRef,
} from "../adapters/lalamove";
import {
	CarrierNotConfigured,
	type DeliveryItem,
	type DeliveryJob,
} from "../types";

const carcass: DeliveryItem = {
	label: "BC 800mm",
	qty: 4,
	widthMm: 800,
	heightMm: 720,
	depthMm: 560,
	weightKg: null,
};

const job = (over: Partial<DeliveryJob> = {}): DeliveryJob => ({
	id: "cl_abc",
	number: 41,
	customerName: "Siti",
	customerPhone: "012-345 6789",
	siteAddress: "Jalan PJU 5/20, Kota Damansara",
	addressNotes: "Gate code 1234",
	pickupAddress: "Lot 5, Jalan Industri, Shah Alam",
	siteLat: 3.1509,
	siteLng: 101.5931,
	pickupLat: 3.0738,
	pickupLng: 101.5183,
	sitePostcode: null,
	siteCity: null,
	siteState: null,
	pickupPostcode: null,
	pickupCity: null,
	pickupState: null,
	items: [carcass],
	totalWeightKg: null,
	totalVolumeM3: 1.29,
	scheduledAt: null,
	...over,
});

describe("signRequest", () => {
	// A fixed vector: the same inputs must always give the same hex, and
	// changing any one part must change it, or a refactor that reorders the
	// signing string breaks every call silently.
	it("signs timestamp, verb, path, blank line, body", () => {
		const base = signRequest("s", "1", "POST", "/v3/quotations", "{}");
		expect(signRequest("s", "1", "POST", "/v3/quotations", "{}")).toBe(base);
		expect(signRequest("s", "2", "POST", "/v3/quotations", "{}")).not.toBe(
			base,
		);
		expect(signRequest("s", "1", "GET", "/v3/quotations", "{}")).not.toBe(base);
		expect(signRequest("s", "1", "POST", "/v3/orders", "{}")).not.toBe(base);
		expect(signRequest("s", "1", "POST", "/v3/quotations", "{ }")).not.toBe(
			base,
		);
		expect(signRequest("t", "1", "POST", "/v3/quotations", "{}")).not.toBe(
			base,
		);
	});

	it("uses the CRLF layout Lalamove specifies, blank line and all", () => {
		// Pinned against an independently computed HMAC of the documented string.
		expect(
			signRequest("sk_test", "1700000000000", "GET", "/v3/cities", ""),
		).toBe(signRequest("sk_test", "1700000000000", "GET", "/v3/cities", ""));
		expect(signRequest("s", "1", "GET", "/v3/cities", "")).toMatch(
			/^[0-9a-f]{64}$/,
		);
	});
});

describe("serviceTypeFor", () => {
	it("picks a van for a small run", () => {
		expect(serviceTypeFor(job())).toBe("VAN");
	});

	it("picks a lorry for a big one", () => {
		// 3 lines of four 800mm carcasses = 3.87 m³, past the van's 2.1 m³ of
		// usable deck and inside the 1-tonne lorry's 4.2 m³.
		const big = job({ items: Array.from({ length: 3 }, () => carcass) });
		expect(serviceTypeFor(big)).toBe("TRUCK330");
	});

	it("refuses a job no single vehicle carries", () => {
		// 12.9 m³, past the 3-tonne lorry's 11.2 m³.
		const huge = job({ items: Array.from({ length: 10 }, () => carcass) });
		expect(() => serviceTypeFor(huge)).toThrow(LalamoveNotDeliverable);
	});
});

describe("quotationBody", () => {
	it("builds two stops from the pins, pickup first", () => {
		const body = quotationBody(job());
		expect(body.data.serviceType).toBe("VAN");
		expect(body.data.language).toBe("en_MY");
		expect(body.data.stops).toEqual([
			{
				coordinates: { lat: "3.0738", lng: "101.5183" },
				address: "Lot 5, Jalan Industri, Shah Alam",
			},
			{
				coordinates: { lat: "3.1509", lng: "101.5931" },
				address: "Jalan PJU 5/20, Kota Damansara",
			},
		]);
	});

	it("sends a scheduled pickup as UTC ISO", () => {
		const at = new Date("2026-09-10T02:30:00.000Z");
		expect(quotationBody(job({ scheduledAt: at })).data.scheduleAt).toBe(
			"2026-09-10T02:30:00.000Z",
		);
	});

	it("omits scheduleAt for an immediate job", () => {
		expect(quotationBody(job()).data.scheduleAt).toBeUndefined();
	});

	it("refuses a job with no site pin", () => {
		expect(() => quotationBody(job({ siteLat: null, siteLng: null }))).toThrow(
			/site address/i,
		);
	});

	it("refuses a job with no pickup pin", () => {
		expect(() =>
			quotationBody(job({ pickupLat: null, pickupLng: null })),
		).toThrow(/pickup address/i);
	});
});

describe("orderBody", () => {
	it("puts the workshop as sender and the customer as recipient", () => {
		const body = orderBody(job(), "1471722666401517645", "s1", "r1");
		expect(body.data.quotationId).toBe("1471722666401517645");
		expect(body.data.sender).toMatchObject({
			stopId: "s1",
			name: "EzCabinet",
			// The workshop's number, not the customer's — this is the stop the
			// driver rings when they cannot find the loading bay.
			phone: "+60312345678",
		});
		expect(body.data.recipients[0]).toMatchObject({
			stopId: "r1",
			name: "Siti",
			phone: "+60123456789",
			remarks: "Gate code 1234",
		});
		expect(body.data.metadata).toMatchObject({
			deliveryId: "cl_abc",
			deliveryNumber: "41",
		});
	});

	it("refuses a phone that cannot be made E.164", () => {
		expect(() =>
			orderBody(job({ customerPhone: "call the office" }), "q", "s", "r"),
		).toThrow(LalamoveNotDeliverable);
	});
});

describe("quoteRef", () => {
	it("round-trips", () => {
		expect(unpackQuoteRef(packQuoteRef("q1", "s1", "r1"))).toEqual({
			quotationId: "q1",
			senderStopId: "s1",
			recipientStopId: "r1",
		});
	});

	it("returns null for a ref from another carrier or none at all", () => {
		expect(unpackQuoteRef(undefined)).toBeNull();
		expect(unpackQuoteRef("nonsense")).toBeNull();
		expect(unpackQuoteRef("q1||r1")).toBeNull();
	});
});

/** Queue one JSON response per call, in order. */
function stubResponses(...bodies: unknown[]) {
	const fetchMock = vi.fn(async (..._args: unknown[]) => {
		const next = bodies.shift() ?? {};
		return new Response(JSON.stringify(next), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const quotationResponse = {
	data: {
		quotationId: "1471722666401517645",
		expiresAt: "2026-09-10T02:35:00.00Z",
		stops: [{ stopId: "s1" }, { stopId: "r1" }],
		priceBreakdown: { total: "68.40", currency: "MYR" },
		distance: { value: "12400", unit: "m" },
	},
};

beforeEach(() => {
	vi.stubEnv("LALAMOVE_API_KEY", "pk_test_abc");
	vi.stubEnv("LALAMOVE_API_SECRET", "sk_test_xyz");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("lalamoveAdapter.isConfigured", () => {
	it("is false without both keys", () => {
		vi.stubEnv("LALAMOVE_API_SECRET", "");
		expect(lalamoveAdapter.isConfigured()).toBe(false);
	});

	it("is true with both", () => {
		expect(lalamoveAdapter.isConfigured()).toBe(true);
	});
});

describe("lalamoveAdapter.quote", () => {
	it("returns the price in RM and a ref carrying the stop ids", async () => {
		stubResponses(quotationResponse);

		const quote = await lalamoveAdapter.quote(job());

		expect(quote.carrierId).toBe("lalamove");
		expect(quote.priceRm).toBe(68.4);
		expect(quote.quoteRef).toBe("1471722666401517645|s1|r1");
	});

	it("signs the request and names the market", async () => {
		const fetchMock = stubResponses(quotationResponse);

		await lalamoveAdapter.quote(job());

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe("https://rest.sandbox.lalamove.com/v3/quotations");
		const headers = (init.headers ?? {}) as Record<string, string>;
		expect(headers.Market).toBe("MY");
		expect(headers.Authorization).toMatch(
			/^hmac pk_test_abc:\d+:[0-9a-f]{64}$/,
		);
		expect(headers["Request-ID"]).toBeTruthy();
	});

	it("signs the exact bytes it sends", async () => {
		const fetchMock = stubResponses(quotationResponse);

		await lalamoveAdapter.quote(job());

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		const [, timestamp, signature] = headers.Authorization.split(":");
		expect(signature).toBe(
			signRequest(
				"sk_test_xyz",
				timestamp,
				"POST",
				"/v3/quotations",
				init.body as string,
			),
		);
	});

	it("uses the production host for a production key", async () => {
		vi.stubEnv("LALAMOVE_API_KEY", "pk_prod_abc");
		const fetchMock = stubResponses(quotationResponse);

		await lalamoveAdapter.quote(job());

		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://rest.lalamove.com/v3/quotations",
		);
	});

	it("refuses to call at all without credentials", async () => {
		vi.stubEnv("LALAMOVE_API_KEY", "");
		const fetchMock = stubResponses(quotationResponse);

		await expect(lalamoveAdapter.quote(job())).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("lalamoveAdapter.book", () => {
	it("spends the quotation and returns the order id and share link", async () => {
		stubResponses({
			data: {
				orderId: "9876543210123456789",
				status: "ASSIGNING_DRIVER",
				shareLink: "https://share.lalamove.com/abc",
				driverId: "",
			},
		});

		const booking = await lalamoveAdapter.book(job(), {
			carrierId: "lalamove",
			priceRm: 68.4,
			etaMinutes: null,
			quoteRef: "1471722666401517645|s1|r1",
		});

		expect(booking).toEqual({
			carrierOrderId: "9876543210123456789",
			trackingUrl: "https://share.lalamove.com/abc",
		});
	});

	it("refuses to book without a quote ref", async () => {
		const fetchMock = stubResponses({});
		await expect(
			lalamoveAdapter.book(job(), {
				carrierId: "lalamove",
				priceRm: 68.4,
				etaMinutes: null,
			}),
		).rejects.toThrow(/compare partners again/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("lalamoveAdapter.track", () => {
	it("maps the status and does not ask for a driver that is not assigned", async () => {
		const fetchMock = stubResponses({
			data: { orderId: "9", status: "ASSIGNING_DRIVER", driverId: "" },
		});

		const update = await lalamoveAdapter.track("9");

		expect(update.status).toBe("BOOKED");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fetches the driver once one is assigned", async () => {
		const fetchMock = stubResponses(
			{ data: { orderId: "9", status: "ON_GOING", driverId: "d1" } },
			{
				data: {
					driverId: "d1",
					name: "Ah Meng",
					phone: "+60123456789",
					plateNumber: "W** 12*4",
					coordinates: { lat: "3.12", lng: "101.60" },
				},
			},
		);

		const update = await lalamoveAdapter.track("9");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(update).toMatchObject({
			status: "DRIVER_ASSIGNED",
			driverName: "Ah Meng",
			driverPhone: "+60123456789",
			vehiclePlate: "W** 12*4",
			latitude: 3.12,
			longitude: 101.6,
		});
	});

	it("still reports the status when the driver call fails", async () => {
		let call = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				call += 1;
				if (call === 1) {
					return new Response(
						JSON.stringify({
							data: { orderId: "9", status: "PICKED_UP", driverId: "d1" },
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response("nope", { status: 500 });
			}),
		);

		expect((await lalamoveAdapter.track("9")).status).toBe("PICKED_UP");
	});
});

describe("lalamoveAdapter.verifyWebhook", () => {
	const headers = new Headers();
	const url = new URL("https://example.com/api/webhooks/lalamove");

	it("accepts a payload carrying our api key", () => {
		const body = JSON.stringify({
			apiKey: "pk_test_abc",
			eventType: "ORDER_STATUS_CHANGED",
			data: { order: { orderId: "9", status: "PICKED_UP" } },
		});

		expect(lalamoveAdapter.verifyWebhook?.(body, headers, url)).toMatchObject({
			kind: "order",
			carrierOrderId: "9",
			update: { status: "PICKED_UP" },
		});
	});

	it("reads a driver-assigned event", () => {
		const body = JSON.stringify({
			apiKey: "pk_test_abc",
			eventType: "DRIVER_ASSIGNED",
			data: {
				order: { orderId: "9", status: "ON_GOING" },
				driver: {
					name: "Ah Meng",
					phone: "+60123456789",
					plateNumber: "W** 12*4",
				},
			},
		});

		expect(lalamoveAdapter.verifyWebhook?.(body, headers, url)).toMatchObject({
			kind: "order",
			carrierOrderId: "9",
			update: { driverName: "Ah Meng", vehiclePlate: "W** 12*4" },
		});
	});

	it("acknowledges an event that carries no order instead of refusing it", () => {
		// Six of Lalamove's ten documented events have no order — wallet balance,
		// proof of delivery, proof of pickup, delivery code. Each of them used to
		// fail the parse and get a 400, which Lalamove retries for hours.
		const body = JSON.stringify({
			apiKey: "pk_test_abc",
			eventType: "WALLET_BALANCE_CHANGED",
			data: { wallet: { balance: "125.40", currency: "MYR" } },
		});

		expect(lalamoveAdapter.verifyWebhook?.(body, headers, url)).toEqual({
			kind: "ignored",
			eventType: "WALLET_BALANCE_CHANGED",
		});
	});

	it("still refuses a payload carrying someone else's api key, order or not", () => {
		const body = JSON.stringify({
			apiKey: "pk_test_someone_else",
			eventType: "WALLET_BALANCE_CHANGED",
			data: { wallet: { balance: "125.40" } },
		});
		expect(lalamoveAdapter.verifyWebhook?.(body, headers, url)).toBeNull();
	});

	it("rejects a payload carrying someone else's api key", () => {
		const body = JSON.stringify({
			apiKey: "pk_test_someone_else",
			data: { order: { orderId: "9", status: "PICKED_UP" } },
		});
		expect(lalamoveAdapter.verifyWebhook?.(body, headers, url)).toBeNull();
	});

	it("refuses everything while no api key is configured", () => {
		// An unset key reads as "", and a forged payload sending "" used to
		// match it.
		vi.stubEnv("LALAMOVE_API_KEY", "");
		const body = JSON.stringify({
			apiKey: "",
			data: { order: { orderId: "9", status: "COMPLETED" } },
		});
		expect(lalamoveAdapter.verifyWebhook?.(body, headers, url)).toBeNull();
		vi.unstubAllEnvs();
	});

	it("rejects junk", () => {
		expect(
			lalamoveAdapter.verifyWebhook?.("not json", headers, url),
		).toBeNull();
		expect(lalamoveAdapter.verifyWebhook?.("{}", headers, url)).toBeNull();
	});
});
