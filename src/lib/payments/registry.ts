import "server-only";
import { paymentGatewayFlag } from "@/flags";
import { stripeGateway } from "./stripe";
import type { PaymentGateway } from "./types";

/**
 * Which gateway takes payment, chosen by the `payment-gateway` Vercel flag
 * (`src/flags.ts`). `manual`, an unknown value, or a gateway whose keys are
 * missing means none: the order page falls back to manual bank transfer
 * (`lib/orders/payment.ts`).
 *
 * Adding Fiuu is one import and one line in `GATEWAYS`, plus a `fiuu`
 * variant on the flag; removing Stripe is deleting its line, `stripe.ts` and
 * `StripeForm.tsx`.
 */
const GATEWAYS: Record<string, () => PaymentGateway | null> = {
	stripe: stripeGateway,
};

/** The gateway new payments start on. Evaluated per request. */
export async function activeGateway(): Promise<PaymentGateway | null> {
	return gatewayById(await paymentGatewayFlag());
}

/**
 * Any configured gateway, active or not — for webhooks. After switching the
 * flag, the old gateway still confirms payments customers started before the
 * switch, so its webhook must keep working until its keys are removed.
 */
export function gatewayById(id: string): PaymentGateway | null {
	return Object.hasOwn(GATEWAYS, id) ? GATEWAYS[id]() : null;
}
