/**
 * The contract every online payment gateway implements — Stripe today, Fiuu
 * next, whichever EzCabinet keeps after that.
 *
 * The same shape as `lib/logistics` carriers: routes and pages talk to this
 * contract only, so a gateway is added or removed as one adapter file plus a
 * line in `registry.ts`. Everything that must not differ between gateways —
 * the amount check, the one write that marks an order paid, its WhatsApp
 * message — lives in the webhook route, outside any adapter.
 */

/** The slice of an order a gateway needs. Never the client's figures. */
export type PaymentOrder = {
	id: string;
	/** Human order reference (`IC-20260926-015`), shown on the gateway's page. */
	ref: string;
	totalRm: number;
	customerName: string;
	customerEmail: string | null;
	customerPhone: string;
	/** The gateway's id from an earlier attempt on this order, to resume it. */
	previousRef: string | null;
};

/**
 * What the checkout page needs before an order exists, so it can draw the
 * payment step. Gateways split two ways: fields embedded in our page
 * (Stripe's Payment Element), or a hosted page the customer is sent to with
 * signed fields (Fiuu and most local gateways).
 */
export type PaymentClient =
	| { kind: "stripe-elements"; publishableKey: string }
	| { kind: "redirect" };

/** What the browser does once the order exists. */
export type PaymentStart = { ref: string } & (
	| { kind: "stripe-elements"; publishableKey: string; clientSecret: string }
	| {
			kind: "redirect";
			url: string;
			method: "GET" | "POST";
			fields: Record<string, string>;
	  }
);

/** A verified notification, normalised. */
export type PaymentEvent = {
	orderId: string;
	outcome: "paid" | "failed" | "pending";
	/** In sen. Compared against the stored order total before anything is written. */
	amountSen: number;
	/** ISO 4217, lower case. */
	currency: string;
	/** The gateway's own id for the payment, stored as `Order.paymentRef`. */
	ref: string;
};

export class BadSignature extends Error {}

/** The order already has a payment the gateway is settling; starting another could charge twice. */
export class PaymentInProgress extends Error {}

export type PaymentGateway = {
	/** Stored as `Order.paymentProvider`, and the webhook path segment. */
	id: string;
	client: PaymentClient;
	start(
		order: PaymentOrder,
		urls: {
			/** Where the customer lands afterwards. Display only — never trusted. */
			returnUrl: string;
			/** Server-to-server notification, for gateways that take it per request. */
			notifyUrl: string;
		},
	): Promise<PaymentStart>;
	/**
	 * Verify and read one inbound notification. Throws `BadSignature` on a
	 * forgery; null for a genuine event that needs no action.
	 */
	verify(rawBody: string, headers: Headers): Promise<PaymentEvent | null>;
	/** The body the gateway expects back, when it wants more than a 200. */
	ack?(): Response;
};

/** Ringgit to sen — gateways charge in the currency's smallest unit. */
export const toSen = (rm: number) => Math.round(rm * 100);
