import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { getAdapter } from "@/lib/logistics/registry";
import { applyTrackingUpdate } from "@/lib/logistics/store";
import { CarrierNotConfigured } from "@/lib/logistics/types";

export const runtime = "nodejs";

/**
 * The Refresh button: pull this one job's status now rather than waiting.
 *
 * `logistics:read`, not `logistics:book`, unlike its neighbours in this
 * folder. `applyTrackingUpdate` has three callers — this route, the
 * unattended cron, and the carrier webhook, which carries no permission at
 * all — and what it writes is the carrier's own truth, stamped `POLL` and
 * forward-only. This button is a manual trigger of that same machine
 * process, not an operator decision: nothing here is admin-authored the way
 * a quote comparison or a booking is.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:read",
	async (_request, { params }) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({ where: { id } });
		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		if (!delivery.carrierId || !delivery.carrierOrderId) {
			return NextResponse.json({ error: "not_booked" }, { status: 409 });
		}

		try {
			const update = await getAdapter(delivery.carrierId).track(
				delivery.carrierOrderId,
			);
			const updated = await applyTrackingUpdate(id, update, "POLL");
			return NextResponse.json({ delivery: updated });
		} catch (error) {
			if (error instanceof CarrierNotConfigured) {
				return NextResponse.json(
					{ error: "carrier_not_configured" },
					{ status: 409 },
				);
			}
			return NextResponse.json(
				{ error: `tracking failed: ${(error as Error).message}` },
				{ status: 502 },
			);
		}
	},
);
