import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { pickupConfirmation } from "@/lib/logistics/adapters/gdex";

export const runtime = "nodejs";

/**
 * Has GDEX actually got this collection on their board?
 *
 * Our own booking succeeding only proves we sent a request they accepted. This
 * asks GDEX what they have scheduled, and it is the difference between a
 * tester believing the integration works and knowing it — without opening
 * their portal in another tab.
 *
 * GDEX-only, and deliberately not behind `getAdapter`. A pickup board is not
 * part of the `CarrierAdapter` contract: Lalamove has no such thing, and
 * inventing a method four adapters would answer null to would be a shape built
 * for one partner. If a second parcel partner grows one, that is when it earns
 * a place on the interface.
 *
 * Nothing is written. The pickup reference is read live rather than stored,
 * because it can change underneath us — cancelling a consignment cancels its
 * collection — and a column that can silently disagree with the carrier is
 * worse than a call.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (_request, { params }) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({
			where: { id },
			select: { carrierId: true, carrierOrderId: true },
		});

		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		if (!delivery.carrierId || !delivery.carrierOrderId) {
			return NextResponse.json({ error: "not_booked" }, { status: 409 });
		}
		if (delivery.carrierId !== "gdex") {
			return NextResponse.json({ error: "no_pickup_board" }, { status: 409 });
		}

		try {
			return NextResponse.json({
				pickup: await pickupConfirmation(delivery.carrierOrderId),
			});
		} catch (error) {
			// `pickupConfirmation` already turns GDEX's own refusals into an answer,
			// so reaching here means the call itself failed — a 502, not a verdict
			// about the collection.
			return NextResponse.json(
				{ error: "pickup_check_failed", message: (error as Error).message },
				{ status: 502 },
			);
		}
	},
);
