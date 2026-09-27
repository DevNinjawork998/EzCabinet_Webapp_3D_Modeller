import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { markOrderPaid } from "@/lib/orders/markPaid";
import { gatewayById } from "@/lib/payments/registry";
import { BadSignature, toSen } from "@/lib/payments/types";

export const runtime = "nodejs";

/**
 * Where a payment gateway tells us an order was paid — the only thing that
 * ever marks an online payment PAID. A customer's return to the order page is
 * display only; both Stripe and Fiuu say not to trust it.
 *
 * Public, like the carrier webhooks, so it verifies itself: the body is read
 * as text, because signatures are over the raw bytes, and a forgery writes
 * nothing. The checks after verification belong here rather than in an
 * adapter, so no gateway can skip them:
 *
 * - the charge must equal the stored order total, in ringgit;
 * - `markOrderPaid` is conditional, so a retried notification is a no-op.
 *
 * A genuine event we do not act on is a quiet ack, so the gateway stops
 * retrying.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ gateway: string }> },
) {
	const gateway = gatewayById((await params).gateway);
	if (!gateway) {
		return NextResponse.json({ error: "not_configured" }, { status: 404 });
	}

	const rawBody = await request.text();
	let event: Awaited<ReturnType<typeof gateway.verify>>;
	try {
		event = await gateway.verify(rawBody, request.headers);
	} catch (error) {
		if (error instanceof BadSignature) {
			return NextResponse.json({ error: "bad_signature" }, { status: 400 });
		}
		throw error;
	}
	const ack = () => gateway.ack?.() ?? NextResponse.json({ ok: true });
	if (event?.outcome !== "paid") return ack();

	const order = await prisma.order.findUnique({
		where: { id: event.orderId },
		select: { totalRm: true },
	});
	if (
		!order ||
		event.currency !== "myr" ||
		event.amountSen !== toSen(order.totalRm)
	) {
		// Never marked paid silently; an admin reconciles it by hand.
		console.error("payment webhook: order or amount mismatch", {
			gateway: gateway.id,
			orderId: event.orderId,
			ref: event.ref,
		});
		return ack();
	}

	await markOrderPaid(event.orderId, {
		paymentProvider: gateway.id,
		paymentRef: event.ref,
	});
	return ack();
}
