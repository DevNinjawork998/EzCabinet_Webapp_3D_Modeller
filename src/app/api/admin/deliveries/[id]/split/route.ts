import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import {
	suggestVehicle,
	totalVolumeM3,
	totalWeightKg,
} from "@/lib/logistics/measure";
import { splitItems } from "@/lib/logistics/split";
import { readItems } from "@/lib/logistics/store";
import type { DeliveryItem } from "@/lib/logistics/types";

export const runtime = "nodejs";

const splitInputSchema = z.object({
	/** Rows of `items` that move to the new job, by position. */
	itemIndexes: z.array(z.number().int()).min(1),
	actor: z.string().trim().min(1).max(120),
});

/**
 * Cut one delivery into two ordinary ones.
 *
 * The reason is freight class, not size: carcasses need a lorry and the boxed
 * hardware would ride a parcel network for a tenth of the price, but a job is
 * quoted whole, so a mixed load gets refused by every parcel partner on girth
 * and priced by the vehicle partners as if the handles needed their own lorry.
 * Each half then quotes and books on its own.
 *
 * The original is consumed rather than kept. It never reached a carrier — this
 * route refuses if it did — so there is nothing to preserve but a draft that
 * would sit in the list as a job nobody can act on. Both halves record where
 * they came from in `splitFromNumber` and in their first timeline event.
 *
 * Addresses, pins and postcodes are copied across rather than re-geocoded: the
 * halves go to the same site from the same workshop, and asking Google the
 * same question twice can only cost money and answer differently.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (request, { params }) => {
		const { id } = await params;
		const parsed = splitInputSchema.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		const delivery = await prisma.delivery.findUnique({ where: { id } });
		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		// Splitting deletes the original, so a job the carrier is already holding
		// must never reach it — that would leave a booked lorry with no row.
		if (delivery.carrierOrderId !== null) {
			return NextResponse.json({ error: "already_booked" }, { status: 409 });
		}

		const { moved, kept } = splitItems(
			readItems(delivery.items),
			parsed.data.itemIndexes,
		);
		// A "split" with an empty half is the original under a new id. Refused here
		// as well as disabled in the panel, because the panel may be looking at a
		// job someone else has since edited.
		if (moved.length === 0 || kept.length === 0) {
			return NextResponse.json({ error: "invalid_split" }, { status: 400 });
		}

		const half = (items: DeliveryItem[]) => ({
			customerName: delivery.customerName,
			customerPhone: delivery.customerPhone,
			siteAddress: delivery.siteAddress,
			addressNotes: delivery.addressNotes,
			pickupAddress: delivery.pickupAddress,
			siteLat: delivery.siteLat,
			siteLng: delivery.siteLng,
			siteGeocodedFor: delivery.siteGeocodedFor,
			sitePostcode: delivery.sitePostcode,
			siteCity: delivery.siteCity,
			siteState: delivery.siteState,
			pickupLat: delivery.pickupLat,
			pickupLng: delivery.pickupLng,
			pickupGeocodedFor: delivery.pickupGeocodedFor,
			pickupPostcode: delivery.pickupPostcode,
			pickupCity: delivery.pickupCity,
			pickupState: delivery.pickupState,
			scheduledAt: delivery.scheduledAt,
			splitFromNumber: delivery.number,
			// Both halves still deliver the same order.
			orderId: delivery.orderId,
			items: items as never,
			totalVolumeM3: totalVolumeM3(items),
			totalWeightKg: totalWeightKg(items),
			events: {
				create: {
					source: "ADMIN" as const,
					actor: parsed.data.actor,
					message: `Split from #${delivery.number} — ${suggestVehicle(items).label}`,
				},
			},
		});

		// One transaction: two rows and a deletion that are only ever correct
		// together. A half created without the original going away is a load
		// quoted twice.
		const [a, b] = await prisma.$transaction([
			prisma.delivery.create({ data: half(moved) }),
			prisma.delivery.create({ data: half(kept) }),
			prisma.delivery.delete({ where: { id } }),
		]);

		return NextResponse.json({ deliveries: [a, b] }, { status: 201 });
	},
);
