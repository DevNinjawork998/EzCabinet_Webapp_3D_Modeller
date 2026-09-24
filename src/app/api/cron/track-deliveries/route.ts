import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { getAdapter } from "@/lib/logistics/registry";
import { applyTrackingUpdate } from "@/lib/logistics/store";
import { ACTIVE_STATUSES } from "@/lib/logistics/types";
import { secretsMatch } from "@/lib/secretsMatch";
import { flush } from "@/lib/whatsapp/outbox";

export const runtime = "nodejs";

/**
 * The fallback half of tracking: poll every job that is still moving.
 *
 * Webhooks are the fast path, but not every partner has them, and the ones that
 * do drop a callback occasionally. This runs on a Vercel cron (see
 * `vercel.json`) and is the reason a job never sits on a stale status forever.
 * It also retries pending WhatsApp messages — lib/whatsapp/outbox.ts.
 *
 * Public prefix, so it checks its own bearer token — `proxy.ts` only gates
 * `/admin` and `/api/admin`. Vercel sends `Authorization: Bearer $CRON_SECRET`.
 *
 * ponytail: one sequential pass over active jobs, capped, followed by the
 * WhatsApp outbox's own capped flush (up to 50 sends). Hundreds of live
 * deliveries would want batching or a queue; at this company's volume the two
 * caps together are the whole safeguard against the 30s function limit.
 */
const MAX_PER_RUN = 50;

export async function GET(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) {
		console.error("CRON_SECRET is not set; refusing to poll");
		return NextResponse.json({ error: "not_configured" }, { status: 500 });
	}
	if (
		!secretsMatch(
			request.headers.get("authorization") ?? "",
			`Bearer ${secret}`,
		)
	) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const active = await prisma.delivery.findMany({
		where: {
			status: { in: [...ACTIVE_STATUSES] },
			carrierOrderId: { not: null },
		},
		orderBy: { updatedAt: "asc" },
		take: MAX_PER_RUN,
	});

	let polled = 0;
	let failed = 0;

	for (const delivery of active) {
		if (!delivery.carrierId || !delivery.carrierOrderId) continue;
		try {
			const update = await getAdapter(delivery.carrierId).track(
				delivery.carrierOrderId,
			);
			await applyTrackingUpdate(delivery.id, update, "POLL");
			polled++;
		} catch (error) {
			// One unreachable carrier must not stop the rest of the sweep.
			failed++;
			console.error(
				JSON.stringify({
					type: "DELIVERY_POLL_FAILED",
					deliveryId: delivery.id,
					carrierId: delivery.carrierId,
					message: (error as Error).message,
					timestamp: new Date().toISOString(),
				}),
			);
		}
	}

	// The WhatsApp outbox's retry pass rides on this cron rather than adding a
	// second one: same cadence, same auth, and the polls above have just queued
	// whatever deliveries moved.
	const notifications = await flush().catch((error) => {
		console.error("WhatsApp retry failed", (error as Error).message);
		return null;
	});

	return NextResponse.json({ ok: true, polled, failed, notifications });
}
