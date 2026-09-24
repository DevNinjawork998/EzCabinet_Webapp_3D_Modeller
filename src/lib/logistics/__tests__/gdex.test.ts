import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const put = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]) => ({ pathname: "p" })),
);
vi.mock("@vercel/blob", () => ({ put }));

import {
	consignmentBody,
	GdexNotDeliverable,
	gdexAdapter,
	pickupConfirmation,
	pickupDays,
	pickupInfo,
	piecesOf,
	rateBody,
	transportationFor,
	weightOf,
} from "../adapters/gdex";
import {
	CarrierNotConfigured,
	type DeliveryItem,
	type DeliveryJob,
} from "../types";
import { pickupCancelledRefusal, pickupReferenceReply } from "./fixtures/gdex";

/**
 * The clock, pinned to the day these fixtures were captured against the GDEX
 * sandbox.
 *
 * `job()` is scheduled for 2026-09-10, which was inside the five days GDEX
 * would collect within *on the 6th* and outside them a week later — so twenty
 * tests in this file went red on 2026-09-11 on a calendar page turning rather
 * than on anything anyone changed. `shouldAdvanceTime` keeps the fetch mocks'
 * timeouts and retries working against a frozen `Date`.
 */
beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date("2026-09-06T02:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

const carton: DeliveryItem = {
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
	pickupAddress: "EzCabinet Sdn Bhd, Klang Valley, Selangor",
	siteLat: null,
	siteLng: null,
	pickupLat: null,
	pickupLng: null,
	items: [carton],
	totalWeightKg: 3,
	totalVolumeM3: 0.005,
	scheduledAt: new Date("2026-09-10T08:00:00.000Z"),
	...over,
});

const sender = {
	Name: "EzCabinet Sdn Bhd",
	Email: "sales@ezcabinet.com.my",
	MobileNumber: "+60355112233",
	Address1: "No. 19, Jalan Tandang",
	Address2: null,
	PostalCode: "46050",
	City: "Petaling Jaya",
	LocationId: 33500,
	Location: "Jalan Tandang Seksyen 51",
	State: "Selangor",
};

describe("weightOf", () => {
	it("is the job's total weight", () => {
		expect(weightOf(job())).toBe(3);
	});

	it("refuses an unweighed job rather than guessing", () => {
		expect(() => weightOf(job({ totalWeightKg: null }))).toThrow(
			GdexNotDeliverable,
		);
		expect(() => weightOf(job({ totalWeightKg: null }))).toThrow(/weight/i);
	});

	it("refuses a zero weight, which is not a parcel", () => {
		expect(() => weightOf(job({ totalWeightKg: 0 }))).toThrow(
			GdexNotDeliverable,
		);
	});
});

describe("piecesOf", () => {
	it("sums the quantities", () => {
		expect(piecesOf(job({ items: [carton, { ...carton, qty: 3 }] }))).toBe(5);
	});

	it("refuses more than fifteen pieces, which GDEX caps", () => {
		// The message must name the cap — the admin's fix is to split the job.
		expect(() => piecesOf(job({ items: [{ ...carton, qty: 16 }] }))).toThrow(
			/at most 15/,
		);
	});

	it("refuses a job with no items", () => {
		expect(() => piecesOf(job({ items: [] }))).toThrow(GdexNotDeliverable);
	});
});

describe("transportationFor", () => {
	it("maps our vehicle classes to GDEX's three", () => {
		expect(transportationFor(job())).toBe("Motorbike");
	});

	it("asks for an offsize truck when the job needs a lorry", () => {
		const big = {
			...carton,
			qty: 1,
			widthMm: 2400,
			heightMm: 900,
			depthMm: 600,
			weightKg: 90,
		};
		expect(transportationFor(job({ items: [big], totalWeightKg: 90 }))).toBe(
			"OffsizeTruck",
		);
	});

	it("refuses a job that fits in no vehicle at all", () => {
		const huge = {
			...carton,
			qty: 40,
			widthMm: 2400,
			heightMm: 2400,
			depthMm: 600,
			weightKg: 200,
		};
		expect(() =>
			transportationFor(job({ items: [huge], totalWeightKg: 8000 })),
		).toThrow(GdexNotDeliverable);
	});
});

describe("rateBody", () => {
	it("prices one line, postcode to postcode, in kilograms", () => {
		expect(rateBody(job(), "46050")).toEqual([
			{
				ReferenceNumber: 7,
				FromPostCode: "46050",
				ToPostCode: "11950",
				ParcelType: "Parcel",
				Weight: 3,
				Country: "MYS",
			},
		]);
	});

	it("refuses a job whose address never geocoded to a postcode", () => {
		expect(() => rateBody(job({ sitePostcode: null }), "46050")).toThrow(
			/postcode/i,
		);
	});
});

describe("pickupInfo", () => {
	it("asks for a pickup on the scheduled day", () => {
		expect(pickupInfo(job())).toEqual({
			Transportation: "Motorbike",
			// 08:00 UTC is 16:00 in Malaysia, and Malaysia is where the driver is.
			ParcelReadyTime: "16:00:00",
			// Midnight, and naive local. GetPickUpDateListing returns the days
			// GDEX will collect as "2026-09-10T00:00:00" and CreateConsignment
			// matches PickupDate against that list — sending 16:00:00 here is
			// refused as "Pick Up Day Unavailable" on a day it is offering.
			// Verified against the sandbox 2026-09-06.
			PickupDate: "2026-09-10T00:00:00",
			PickupRemark: "Guard house, ask for block C",
			IsTrolleyRequired: false,
		});
	});

	it("refuses a job with no scheduled date, because a pickup needs a day", () => {
		expect(() => pickupInfo(job({ scheduledAt: null }))).toThrow(/scheduled/i);
	});

	it("omits the remark when there are no address notes", () => {
		expect(
			pickupInfo(job({ addressNotes: null })).PickupRemark,
		).toBeUndefined();
	});
});

describe("consignmentBody", () => {
	it("puts the account profile in the sender block and the customer in the consignment", () => {
		const body = consignmentBody(job(), sender);

		expect(body.Name).toBe("EzCabinet Sdn Bhd");
		expect(body.Postcode).toBe("46050");
		expect(body.LocationId).toBe(33500);
		expect(body.Consignments).toHaveLength(1);

		const [consignment] = body.Consignments;
		expect(consignment.OrderId).toBe("ICB-7");
		expect(consignment.Mobile).toBe("60123456789");
		expect(consignment.Postcode).toBe("11950");
		expect(consignment.Country).toBe("MYS");
		expect(consignment.Weight).toBe(3);
		expect(consignment.Pieces).toBe(2);
		expect(consignment.IsInsurance).toBe(false);
	});

	it("carries the pickup arrangement", () => {
		expect(consignmentBody(job(), sender).Pickup?.Transportation).toBe(
			"Motorbike",
		);
	});

	it("refuses a customer phone GDEX cannot call", () => {
		expect(() =>
			consignmentBody(job({ customerPhone: "n/a" }), sender),
		).toThrow(GdexNotDeliverable);
	});
});

const userDetailsResponse = {
	statusCode: 200,
	data: sender,
	message: null,
};

const rateResponse = {
	statusCode: 200,
	data: [{ ReferenceNumber: 7, Rate: 12.4, HasError: false, Error: null }],
	message: null,
};

const consignmentResponse = {
	statusCode: 200,
	data: {
		InvoiceNumber: "120CPA0001234",
		ConsignmentNumbers: ["MY1700012345"],
		Consignments: [
			{ OrderId: "ICB-7", ConsignmentNumber: "MY1700012345", Rate: 12.4 },
		],
		GrandTotal: 12.4,
		EWalletBalance: 980.6,
	},
	message: null,
};

/** One queued JSON Response per call, in order. Same helper as lalamove.test.ts. */
function stubResponses(...bodies: unknown[]) {
	const fetchMock = vi.fn();
	for (const body of bodies) {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("gdexAdapter", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is not configured without a user token", () => {
		vi.stubEnv("GDEX_USER_TOKEN", "");
		expect(gdexAdapter.isConfigured()).toBe(false);
	});

	it("sends both credentials, and the renamed subscription header", async () => {
		const fetchMock = stubResponses(userDetailsResponse, rateResponse);
		await gdexAdapter.quote(job());
		const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(String(url)).toBe(
			"https://myopenapi.gdexpress.com/test/api/MyGDex/GetShippingRate",
		);
		// Not Ocp-Apim-Subscription-Key — GDEX's gateway ignores that one and
		// answers "missing subscription key" to a request that carries it.
		expect(headers["subscription-key"]).toBe("sub_test_xyz");
		expect(headers["User-Token"]).toBe("utok_test_abc");
		expect(headers["Ocp-Apim-Subscription-Key"]).toBeUndefined();
	});

	it("is not configured on the subscription key alone, and never calls out", async () => {
		vi.stubEnv("GDEX_USER_TOKEN", "");
		const fetchMock = stubResponses(userDetailsResponse, rateResponse);
		expect(gdexAdapter.isConfigured()).toBe(false);
		await expect(gdexAdapter.quote(job())).rejects.toBeInstanceOf(
			CarrierNotConfigured,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is not configured without a subscription key either", () => {
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "");
		expect(gdexAdapter.isConfigured()).toBe(false);
	});

	it("has no webhook, because GDEX has no callback operation", () => {
		expect(gdexAdapter.verifyWebhook).toBeUndefined();
	});

	describe("quote", () => {
		it("reads the sender postcode from the account, then prices against it", async () => {
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);

			const quote = await gdexAdapter.quote(job());

			expect(quote).toMatchObject({
				carrierId: "gdex",
				priceRm: 12.4,
				etaMinutes: null,
			});
			expect(fetchMock.mock.calls[0][0]).toContain("/GetUserDetails");
			expect(fetchMock.mock.calls[1][0]).toContain("/GetShippingRate");
			expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual([
				{
					ReferenceNumber: 7,
					FromPostCode: "46050",
					ToPostCode: "11950",
					ParcelType: "Parcel",
					Weight: 3,
					Country: "MYS",
				},
			]);
		});

		it("sends the user token as a header", async () => {
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);
			await gdexAdapter.quote(job());
			expect(fetchMock.mock.calls[0][1].headers["User-Token"]).toBe(
				"utok_test_abc",
			);
		});

		it("turns a per-row HasError into a refusal, not a price of zero", async () => {
			stubResponses(userDetailsResponse, {
				statusCode: 200,
				data: [
					{
						ReferenceNumber: 7,
						Rate: 0,
						HasError: true,
						Error: "Postal code 11950 not found",
					},
				],
				message: null,
			});

			await expect(gdexAdapter.quote(job())).rejects.toThrow(
				/Postal code 11950 not found/,
			);
		});

		it("refuses to call at all without credentials", async () => {
			vi.stubEnv("GDEX_USER_TOKEN", "");
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);

			await expect(gdexAdapter.quote(job())).rejects.toBeInstanceOf(
				CarrierNotConfigured,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("refuses an unweighed job before it dials", async () => {
			const fetchMock = stubResponses(userDetailsResponse, rateResponse);

			await expect(
				gdexAdapter.quote(job({ totalWeightKg: null })),
			).rejects.toBeInstanceOf(GdexNotDeliverable);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("book", () => {
		it("returns the consignment number as the carrier order id", async () => {
			const fetchMock = stubResponses(userDetailsResponse, consignmentResponse);

			const booking = await gdexAdapter.book(job(), {
				carrierId: "gdex",
				priceRm: 12.4,
				etaMinutes: null,
			});

			expect(booking.carrierOrderId).toBe("MY1700012345");
			expect(fetchMock.mock.calls[1][0]).toContain("/CreateConsignment");
		});

		it("surfaces an insufficient balance as the carrier's own sentence", async () => {
			const fetchMock = vi.fn();
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify(userDetailsResponse), { status: 200 }),
			);
			fetchMock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						statusCode: 400,
						data: null,
						message: "Insufficient Credit",
					}),
					{ status: 400 },
				),
			);
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				gdexAdapter.book(job(), {
					carrierId: "gdex",
					priceRm: 12.4,
					etaMinutes: null,
				}),
			).rejects.toThrow(/Insufficient Credit/);
		});

		it("never retries the booking call", async () => {
			const fetchMock = vi.fn();
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify(userDetailsResponse), { status: 200 }),
			);
			fetchMock.mockResolvedValueOnce(
				new Response("upstream is down", { status: 503 }),
			);
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				gdexAdapter.book(job(), {
					carrierId: "gdex",
					priceRm: 12.4,
					etaMinutes: null,
				}),
			).rejects.toThrow();
			// GetUserDetails plus one CreateConsignment. A second consignment is a
			// second parcel and a second e-Wallet debit.
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});

	describe("track", () => {
		it("reads the last shipment status for the consignment", async () => {
			const fetchMock = stubResponses({
				statusCode: 200,
				data: [
					{ ConsignmentNote: "MY1700012345", ConsignmentNoteStatus: "Pending" },
				],
				message: null,
			});

			const update = await gdexAdapter.track("MY1700012345");

			expect(update.message).toContain("Pending");
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([
				"MY1700012345",
			]);
		});

		it("leaves the status null when GDEX returns a word we have not mapped", async () => {
			stubResponses({
				statusCode: 200,
				data: [
					{ ConsignmentNote: "MY1700012345", ConsignmentNoteStatus: "Bagged" },
				],
				message: null,
			});

			expect((await gdexAdapter.track("MY1700012345")).status).toBeNull();
		});
	});

	describe("cancel", () => {
		it("puts the consignment number on the query string", async () => {
			const fetchMock = stubResponses({
				statusCode: 200,
				data: null,
				message: null,
			});
			await gdexAdapter.cancel?.("MY1700012345");
			expect(fetchMock.mock.calls[0][0]).toContain(
				"ConsignmentNumber=MY1700012345",
			);
			expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
		});
	});
});

describe("gdexAdapter.book label capture", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
		put.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("stores the note privately and links to our own route, not the blob", async () => {
		const fetchMock = stubResponses(userDetailsResponse, consignmentResponse);
		fetchMock.mockResolvedValueOnce(
			new Response("%PDF-1.4", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			}),
		);

		const booking = await gdexAdapter.book(job(), {
			carrierId: "gdex",
			priceRm: 12.4,
			etaMinutes: null,
		});

		expect(put).toHaveBeenCalledTimes(1);
		const [pathname, , options] = put.mock.calls[0] as [
			string,
			unknown,
			{ access: string },
		];
		expect(pathname).toBe("logistics/gdex/MY1700012345.pdf");
		// Private, always. The note carries the customer's home address and the
		// consignment number in the path is guessable.
		expect(options.access).toBe("private");
		expect(booking.labelUrl).toBe("/api/admin/deliveries/dlv_1/label");
	});

	it("still books when the note cannot be fetched — the wallet is already spent", async () => {
		const fetchMock = stubResponses(userDetailsResponse, consignmentResponse);
		fetchMock.mockResolvedValueOnce(new Response("nope", { status: 400 }));

		const booking = await gdexAdapter.book(job(), {
			carrierId: "gdex",
			priceRm: 12.4,
			etaMinutes: null,
		});

		// The consignment exists and was paid for. Throwing here would fail a
		// booking that succeeded and leave a parcel nobody knows about.
		expect(booking.carrierOrderId).toBe("MY1700012345");
		expect(booking.labelUrl).toBeNull();
		expect(put).not.toHaveBeenCalled();
	});
});

describe("gdexAdapter.track against an unknown consignment", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("does not read a status off a row GDEX flags as not real", async () => {
		// Verbatim from `pnpm gdex:ping` against a made-up number, 2026-09-06.
		// HTTP 200, and "Pending" — the same word a real new consignment carries.
		// `IsValid` is the only thing separating them, and it is undocumented.
		stubResponses({
			statusCode: 200,
			data: [
				{
					ConsignmentNote: "MY0000000000",
					ConsignmentNoteStatus: "Pending",
					IsValid: false,
				},
			],
			message: null,
		});

		const update = await gdexAdapter.track("MY0000000000");

		// Not BOOKED. Reporting a parcel that does not exist as booked would
		// stick, because nothing in a later reply ever contradicts it.
		expect(update.status).toBeNull();
		expect(update.message).toMatch(/does not recognise/i);
	});

	it("reads the status when GDEX says the consignment is real", async () => {
		stubResponses({
			statusCode: 200,
			data: [
				{
					ConsignmentNote: "MY1700012345",
					ConsignmentNoteStatus: "Pending",
					IsValid: true,
				},
			],
			message: null,
		});

		expect((await gdexAdapter.track("MY1700012345")).status).toBe("BOOKED");
	});

	it("treats an absent IsValid as valid — a field they may stop sending", async () => {
		stubResponses({
			statusCode: 200,
			data: [
				{ ConsignmentNote: "MY1700012345", ConsignmentNoteStatus: "Delivered" },
			],
			message: null,
		});

		expect((await gdexAdapter.track("MY1700012345")).status).toBe("DELIVERED");
	});
});

describe("rateBody's refusal when there is no postcode", () => {
	afterEach(() => {
		// Assigning `undefined` stores the STRING "undefined", which is non-empty
		// and reads as a configured key. Delete it. Same note as easyparcel.test.
		delete process.env.GOOGLE_GEOCODING_API_KEY;
	});

	it("blames the deployment, not the address, when there is no geocoding key", () => {
		delete process.env.GOOGLE_GEOCODING_API_KEY;
		// "Correct the address" is only advice if re-saving could help. With no
		// key there is nothing to re-read the address with, so every save leaves
		// the postcode null and the admin loops forever on a line already right.
		expect(() => rateBody(job({ sitePostcode: null }), "46050")).toThrow(
			/GOOGLE_GEOCODING_API_KEY/,
		);
	});

	it("blames the address when the key is set and it still did not resolve", () => {
		process.env.GOOGLE_GEOCODING_API_KEY = "k";
		expect(() => rateBody(job({ sitePostcode: null }), "46050")).toThrow(
			/edit it and save again/i,
		);
	});
});

describe("the pickup window", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// 2026-09-06 10:00 in Malaysia. GDEX's own GetPickUpDateListing on this
		// day offered 09-07 through 09-11 — five days, and not today.
		vi.setSystemTime(new Date("2026-09-06T02:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("refuses a day past the five GDEX will collect within, before calling out", () => {
		const fetchMock = stubResponses(userDetailsResponse, rateResponse);
		// The real failure: booking a job scheduled for the 12th came back
		// "Pick Up Day Unavailable" — a message that names no window at all.
		expect(() =>
			rateBody(
				job({ scheduledAt: new Date("2026-09-12T02:00:00.000Z") }),
				"46050",
			),
		).toThrow(/5 days/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a day already gone", () => {
		expect(() =>
			rateBody(
				job({ scheduledAt: new Date("2026-09-05T02:00:00.000Z") }),
				"46050",
			),
		).toThrow(/past/i);
	});

	it("allows the last day inside the window", () => {
		expect(
			rateBody(
				job({ scheduledAt: new Date("2026-09-11T02:00:00.000Z") }),
				"46050",
			),
		).toHaveLength(1);
	});

	it("quotes and books off the same window, so a price is never unbookable", () => {
		// pickupInfo used to be the only caller, which meant quote() succeeded on
		// a job book() would refuse — the admin picks a partner, then cannot use it.
		const far = job({ scheduledAt: new Date("2026-09-30T02:00:00.000Z") });
		expect(() => rateBody(far, "46050")).toThrow(/5 days/);
		expect(() => pickupInfo(far)).toThrow(/5 days/);
	});
});

describe("pickupDays", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("returns the days GDEX offers, as plain dates", async () => {
		// Verbatim from the sandbox, 2026-09-06: naive local, always midnight.
		stubResponses(userDetailsResponse, {
			statusCode: 200,
			data: [
				"2026-09-07T00:00:00",
				"2026-09-08T00:00:00",
				"2026-09-09T00:00:00",
			],
			message: null,
		});
		expect(await pickupDays()).toEqual([
			"2026-09-07",
			"2026-09-08",
			"2026-09-09",
		]);
	});

	it("asks against the sender's own postcode, which the endpoint requires", async () => {
		const fetchMock = stubResponses(userDetailsResponse, {
			statusCode: 200,
			data: [],
			message: null,
		});
		await pickupDays();
		// Without it: 400 "Please Provide PostCode".
		expect(String(fetchMock.mock.calls[1][0])).toContain("PostCode=46050");
	});

	it("slices the date rather than parsing it", async () => {
		// `new Date("2026-09-08T00:00:00")` is read as UTC by Date.parse, which
		// moves the day backwards for everyone east of Greenwich — Malaysia
		// included. The string already carries the day GDEX means.
		stubResponses(userDetailsResponse, {
			statusCode: 200,
			data: ["2026-09-08T00:00:00"],
			message: null,
		});
		expect(await pickupDays()).toEqual(["2026-09-08"]);
	});
});

describe("gdexAdapter.quote wallet warning", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	const wallet = (amount: number) => ({
		statusCode: 200,
		data: amount,
		message: null,
	});

	it("warns when the wallet will not cover the quote, and still quotes", async () => {
		stubResponses(userDetailsResponse, rateResponse, wallet(4.1));
		const quote = await gdexAdapter.quote(job());
		expect(quote.priceRm).toBe(12.4);
		// Still bookable. GDEX decides whether to take it, not us.
		expect(quote.warning).toMatch(/RM 4\.10/);
	});

	it("says nothing when the wallet covers it", async () => {
		stubResponses(userDetailsResponse, rateResponse, wallet(1020));
		expect((await gdexAdapter.quote(job())).warning).toBeUndefined();
	});

	it("still returns the price when the balance cannot be read", async () => {
		const fetchMock = vi.fn();
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		fetchMock.mockResolvedValueOnce(json(userDetailsResponse));
		fetchMock.mockResolvedValueOnce(json(rateResponse));
		fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		// The wallet read is advisory. Losing it must never cost the price —
		// that would turn a nicety into an outage.
		const quote = await gdexAdapter.quote(job());
		expect(quote.priceRm).toBe(12.4);
		expect(quote.warning).toBeUndefined();
	});
});

describe("pickupConfirmation", () => {
	beforeEach(() => {
		vi.stubEnv("GDEX_USER_TOKEN", "utok_test_abc");
		vi.stubEnv("GDEX_PRIMARY_API_KEY", "sub_test_xyz");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("reports the collection GDEX has on its board", async () => {
		const fetchMock = stubResponses(pickupReferenceReply);
		const confirmed = await pickupConfirmation("TCN170001588");

		expect(confirmed.reference).toBe("CPAA166526");
		expect(confirmed.status).toBe("Pending");
		expect(confirmed.collectingOn).toBe("2026-09-08");
		// ConsignmentNo, not ConsignmentNumber. The sibling operations take the
		// long name and this one answers "Consignment Number Not Found" to it.
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"ConsignmentNo=TCN170001588",
		);
	});

	it("shows GDEX's own words when there is no collection any more", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(pickupCancelledRefusal), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		// A refusal is information here, not an error: cancelling a consignment
		// cancels its collection, and saying so is the useful answer.
		const confirmed = await pickupConfirmation("TCN170001588");
		expect(confirmed.reference).toBeNull();
		expect(confirmed.message).toMatch(/Already Cancelled/i);
	});
});
