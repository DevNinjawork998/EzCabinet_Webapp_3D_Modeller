import "server-only";
import { prisma } from "@/lib/catalogue/db";
import { orderRef } from "@/lib/orders/ref";
import { activeGateway } from "./registry";
import { PaymentInProgress, type PaymentStart } from "./types";

/**
 * Start (or resume) paying for one order on the active gateway, and record
 * which gateway and which of its payments the order is now waiting on.
 *
 * The one path for both checkout (`POST /api/orders`, straight after the
 * order is created) and a retry from the order page (`POST .../pay`), so a
 * retry resumes the first attempt instead of opening a second one.
 *
 * The amount is the stored total — priced on the server when the order was
 * created — never a figure from the browser.
 */
export async function startPayment(
	token: string,
	origin: string,
): Promise<
	| { ok: true; start: PaymentStart }
	| {
			ok: false;
			error:
				| "not_configured"
				| "not_found"
				| "not_awaiting_payment"
				| "payment_in_progress";
	  }
> {
	const gateway = await activeGateway();
	if (!gateway) return { ok: false, error: "not_configured" };

	const order = await prisma.order.findUnique({
		where: { publicToken: token },
		select: {
			id: true,
			number: true,
			createdAt: true,
			status: true,
			totalRm: true,
			customerName: true,
			customerEmail: true,
			customerPhone: true,
			locale: true,
			paymentProvider: true,
			paymentRef: true,
		},
	});
	if (!order) return { ok: false, error: "not_found" };
	if (order.status !== "AWAITING_PAYMENT") {
		return { ok: false, error: "not_awaiting_payment" };
	}

	let start: PaymentStart;
	try {
		start = await gateway.start(
			{
				...order,
				ref: orderRef(order.number, order.createdAt),
				previousRef:
					order.paymentProvider === gateway.id ? order.paymentRef : null,
			},
			{
				returnUrl: `${origin}/${order.locale}/order/${token}`,
				notifyUrl: `${origin}/api/webhooks/payment/${gateway.id}`,
			},
		);
	} catch (error) {
		if (error instanceof PaymentInProgress) {
			return { ok: false, error: "payment_in_progress" };
		}
		throw error;
	}

	await prisma.order.updateMany({
		where: { id: order.id, status: "AWAITING_PAYMENT" },
		data: { paymentProvider: gateway.id, paymentRef: start.ref },
	});
	return { ok: true, start };
}
