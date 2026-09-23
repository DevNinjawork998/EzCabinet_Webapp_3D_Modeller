import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]) => ({ pathname: "p" })),
);
vi.mock("@vercel/blob", () => ({ put }));

const findMany = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));
vi.mock("@/lib/catalogue/db", () => ({
	prisma: { deliveryEvent: { findMany } },
}));

import {
	chooseRate,
	FedexNotDeliverable,
	fedexConfigured,
	fedexQuote,
	forgetFedexToken,
	MAX_LINE_ITEMS,
	packagesOf,
	pickupDate,
	pickupPlaceOf,
	rateBody,
	SANDBOX,
	sitePlaceOf,
} from "../adapters/fedex";
import { WORKSHOP_ADDRESS } from "../carriers";
import {
	CarrierNotConfigured,
	type DeliveryItem,
	type DeliveryJob,
} from "../types";
import {
	rateReply,
	rateReplyEmpty,
	rateReplyInUsd,
	rateReplyWithoutPriority,
	tokenReply,
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
