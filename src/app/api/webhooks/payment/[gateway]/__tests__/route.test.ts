import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one route that turns an online payment into PAID. What must hold, for
 * any gateway: a forgery writes nothing, a charge that differs from the stored
 * total writes nothing, and a genuine matching payment marks the order paid.
 * Exercised through the Stripe adapter because it is the one built.
 */

const markOrderPaid = vi.fn();
vi.mock("@/lib/orders/markPaid", () => ({ markOrderPaid }));
vi.mock("@/lib/catalogue/db", () => ({
	prisma: {
		order: { findUnique: vi.fn(async () => ({ totalRm: 2641.76 })) },
	},
}));

const SECRET = "whsec_test";
process.env.STRIPE_SECRET_KEY = "sk_test_x";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_x";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const { POST } = await import("../route");

function succeeded(amountReceived: number) {
	return JSON.stringify({
		id: "evt_1",
		object: "event",
		type: "payment_intent.succeeded",
		data: {
			object: {
				id: "pi_1",
				object: "payment_intent",
				metadata: { orderId: "ord1" },
				amount: 264176,
				amount_received: amountReceived,
				currency: "myr",
				status: "succeeded",
			},
		},
	});
}

function post(body: string, signature: string) {
	return POST(
		new Request("http://x/api/webhooks/payment/stripe", {
			method: "POST",
			body,
			headers: { "stripe-signature": signature },
		}),
		{ params: Promise.resolve({ gateway: "stripe" }) },
	);
}

const sign = (payload: string) =>
	new Stripe("sk_test_x").webhooks.generateTestHeaderString({
		payload,
		secret: SECRET,
	});

describe("payment webhook", () => {
	beforeEach(() => markOrderPaid.mockClear());

	it("refuses a forged signature and writes nothing", async () => {
		const res = await post(succeeded(264176), "t=1,v1=forged");
		expect(res.status).toBe(400);
		expect(markOrderPaid).not.toHaveBeenCalled();
	});

	it("marks a matching payment paid", async () => {
		const body = succeeded(264176);
		const res = await post(body, sign(body));
		expect(res.status).toBe(200);
		expect(markOrderPaid).toHaveBeenCalledWith("ord1", {
			paymentProvider: "stripe",
			paymentRef: "pi_1",
		});
	});

	it("never marks paid when the charge differs from the order total", async () => {
		const body = succeeded(100);
		const res = await post(body, sign(body));
		expect(res.status).toBe(200);
		expect(markOrderPaid).not.toHaveBeenCalled();
	});

	it("404s a gateway that is not configured", async () => {
		const res = await POST(new Request("http://x", { method: "POST" }), {
			params: Promise.resolve({ gateway: "fiuu" }),
		});
		expect(res.status).toBe(404);
	});
});
