import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { getAdapter } from "@/lib/logistics/registry";
import { applyTrackingUpdate } from "@/lib/logistics/store";
import type {
	CarrierAdapter,
	CarrierWebhookEvent,
} from "@/lib/logistics/types";

export const runtime = "nodejs";

/**
 * Where a logistics partner tells us a job moved.
 *
 * Deliberately outside `/api/admin`: `proxy.ts` gates that prefix behind the
 * admin cookie, which a carrier does not have and cannot get. So this route is
 * public, and it verifies itself.
 *
 * Three rules, all of them load-bearing:
 *
 * - Read the body as **text**. A signature is computed over raw bytes, and
 *   `request.json()` reserialises them into something that will not match.
 * - Verification failure writes nothing. Anyone on the internet can POST here.
 * - An unknown event or a job we do not have is a quiet accept, not a 500. A
 *   carrier that gets an error back retries the same payload for hours.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ carrier: string }> },
) {
	const { carrier } = await params;

	// Before anything else, and as text — see above.
	const rawBody = await request.text();

	let adapter: CarrierAdapter;
	try {
		adapter = getAdapter(carrier);
	} catch {
		return NextResponse.json({ error: "unknown_carrier" }, { status: 400 });
	}

	if (!adapter.verifyWebhook) {
		// This partner is polled, not called back. Saying so with an error would
		// blame the carrier for our configuration.
		return NextResponse.json({ received: true });
	}

	let event: CarrierWebhookEvent | null;
	try {
		event = adapter.verifyWebhook(
			rawBody,
			request.headers,
			new URL(request.url),
		);
	} catch {
		event = null;
	}

	if (!event) {
		return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
	}

	// Verified, and nothing here to act on — a wallet balance, a proof of
	// delivery, an event type added after this code was written. Answering
	// anything but 200 has the carrier resending it for hours.
	if (event.kind === "ignored") {
		return NextResponse.json({ received: true });
	}

	const delivery = await prisma.delivery.findUnique({
		where: { carrierOrderId: event.carrierOrderId },
	});
	// Only the partner that booked the job may move it. Carrier order ids are
	// not secret — an EasyParcel AWB is printed on the label — so a payload
	// verified as one carrier must not reach another carrier's delivery.
	if (!delivery || delivery.carrierId !== carrier) {
		return NextResponse.json({ received: true });
	}

	await applyTrackingUpdate(delivery.id, event.update, "CARRIER_WEBHOOK");

	return NextResponse.json({ received: true });
}
