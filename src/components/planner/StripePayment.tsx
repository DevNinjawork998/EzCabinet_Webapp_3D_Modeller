"use client";

import {
	Elements,
	PaymentElement,
	useElements,
	useStripe,
} from "@stripe/react-stripe-js";
import {
	type Appearance,
	loadStripe,
	type Stripe,
	type StripeElementsOptions,
} from "@stripe/stripe-js";
import { type RefObject, useEffect } from "react";

/**
 * Stripe's Payment Element: only the payment method — FPX bank, GrabPay,
 * card — inside our own checkout. Contact and address stay in our form and
 * are handed to Stripe in code, so nothing is typed twice.
 *
 * Stripe.js loads from js.stripe.com through `loadStripe`, never bundled (PCI).
 * The fields live in Stripe's iframes; card numbers never touch our origin.
 *
 * Stripe-only by design: removing Stripe is deleting this file and the
 * `stripe-elements` branches that render it.
 */

/** Must match `STRIPE_METHODS` in `lib/payments/stripe.ts` — the intent's list. */
const METHODS = ["fpx", "grabpay", "card"];

const APPEARANCE: Appearance = {
	theme: "flat",
	variables: {
		fontFamily: "Geist, Arial, sans-serif",
		colorPrimary: "#171717",
		colorText: "#171717",
		colorTextSecondary: "#5c574e",
		colorDanger: "#b42318",
		colorBackground: "#ffffff",
		borderRadius: "8px",
		spacingUnit: "4px",
	},
	rules: {
		".Input": { border: "1px solid #d4d4d4" },
		".AccordionItem": { border: "1px solid #d4d4d4" },
	},
};
const FONTS = [
	{ cssSrc: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600" },
];

export type BillingDetails = {
	name: string;
	email: string;
	phone: string;
	address: string;
};

export type StripePayApi = {
	/** Validate Stripe's own fields. An error message, or null. */
	submit(): Promise<string | null>;
	/**
	 * Confirm the payment. On success the browser leaves for `returnUrl` (FPX
	 * and GrabPay via the bank or Grab first; card after any 3-D Secure pop-up),
	 * so this only ever resolves with an error message.
	 */
	confirm(opts: {
		returnUrl: string;
		/** Deferred mode only — an Elements built from a client secret has it. */
		clientSecret?: string;
		billing?: BillingDetails;
	}): Promise<string>;
};

// One Stripe.js per key per page, however often the component remounts.
const loaded = new Map<string, Promise<Stripe | null>>();
const stripeFor = (key: string) => {
	let stripe = loaded.get(key);
	if (!stripe) {
		stripe = loadStripe(key);
		loaded.set(key, stripe);
	}
	return stripe;
};

export function StripePayment({
	publishableKey,
	amountSen,
	clientSecret,
	collectBilling,
	apiRef,
}: {
	publishableKey: string;
	/**
	 * Deferred mode: the order (and its PaymentIntent) does not exist yet, so
	 * Elements is built from the amount. Ignored when `clientSecret` is given.
	 */
	amountSen?: number;
	/** An existing intent — the order page's retry. */
	clientSecret?: string;
	/**
	 * Let Stripe ask for billing details itself. Only the retry does: it has
	 * no form of ours to take them from.
	 */
	collectBilling?: boolean;
	apiRef: RefObject<StripePayApi | null>;
}) {
	const options: StripeElementsOptions = clientSecret
		? { clientSecret, appearance: APPEARANCE, fonts: FONTS }
		: {
				mode: "payment",
				amount: amountSen ?? 0,
				currency: "myr",
				paymentMethodTypes: METHODS,
				appearance: APPEARANCE,
				fonts: FONTS,
			};
	return (
		<Elements stripe={stripeFor(publishableKey)} options={options}>
			<PaymentFields apiRef={apiRef} collectBilling={!!collectBilling} />
		</Elements>
	);
}

function PaymentFields({
	apiRef,
	collectBilling,
}: {
	apiRef: RefObject<StripePayApi | null>;
	collectBilling: boolean;
}) {
	const stripe = useStripe();
	const elements = useElements();

	useEffect(() => {
		if (!stripe || !elements) return;
		apiRef.current = {
			async submit() {
				const { error } = await elements.submit();
				return error?.message ?? null;
			},
			async confirm({ returnUrl, clientSecret, billing }) {
				// `billingDetails: "never"` below means Stripe will refuse the
				// payment unless every one of these is passed here.
				const address = {
					line1: billing?.address ?? "",
					line2: "",
					city: "",
					state: "",
					postal_code: "",
					country: "MY",
				};
				const { error } = await stripe.confirmPayment({
					elements,
					...(clientSecret ? { clientSecret } : {}),
					confirmParams: {
						return_url: returnUrl,
						...(billing
							? {
									payment_method_data: {
										billing_details: {
											name: billing.name,
											email: billing.email,
											phone: billing.phone,
											address,
										},
									},
									shipping: {
										name: billing.name,
										phone: billing.phone,
										address,
									},
								}
							: {}),
					},
				});
				return error.message ?? "Payment failed";
			},
		};
		return () => {
			apiRef.current = null;
		};
	}, [stripe, elements, apiRef]);

	return (
		<PaymentElement
			options={{
				layout: { type: "accordion", radios: "always" },
				fields: { billingDetails: collectBilling ? "auto" : "never" },
				// Link would ask for the email and phone again; our form already has them.
				wallets: { applePay: "auto", googlePay: "auto", link: "never" },
			}}
		/>
	);
}
