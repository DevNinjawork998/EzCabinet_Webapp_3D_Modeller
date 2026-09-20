import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { pickupPin } from "@/lib/logistics/carriers";
import { pinFor } from "@/lib/logistics/coords";
import { resolveCoordinates } from "@/lib/logistics/geocode";
import { totalVolumeM3, totalWeightKg } from "@/lib/logistics/measure";
import { trace } from "@/lib/logistics/trace";
import { deliveryInputSchema } from "@/lib/logistics/types";

export const runtime = "nodejs";

/** One delivery plus its timeline — what the detail panel renders. */
export const GET = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:read",
	async (_request, { params }) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({
			where: { id },
			include: { events: { orderBy: { at: "desc" } } },
		});
		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		return NextResponse.json({ delivery });
	},
);

/**
 * Edits are allowed only before the job is booked. Once a carrier holds the
 * details, changing the address here would leave the page disagreeing with the
 * lorry — that correction goes through the carrier, or through a cancel and a
 * fresh booking.
 */
export const PATCH = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (request, { params }) => {
		const { id } = await params;
		const existing = await prisma.delivery.findUnique({ where: { id } });
		if (!existing) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		if (existing.status !== "DRAFT" && existing.status !== "QUOTED") {
			return NextResponse.json({ error: "already_booked" }, { status: 409 });
		}

		const parsed = deliveryInputSchema.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		const {
			items,
			scheduledAt,
			// Out of the spread — see the same note on the create route. These are the
			// admin's override, not the columns to write.
			siteLat,
			siteLng,
			pickupLat,
			pickupLng,
			...rest
		} = parsed.data;

		// `existing` seeds the current pin, so an edit that did not touch the address
		// keeps it and spends no geocoding call.
		trace("save", {
			what: "edit",
			deliveryId: id,
			siteAddress: rest.siteAddress,
			sitePinGiven:
				siteLat !== null && siteLng !== null ? [siteLat, siteLng] : null,
			sitePinStored: [existing.siteLat, existing.siteLng],
			pickupAddress: rest.pickupAddress,
			pickupPinGiven:
				pickupLat !== null && pickupLng !== null
					? [pickupLat, pickupLng]
					: null,
			pickupPinStored: [existing.pickupLat, existing.pickupLng],
		});
		const [site, pickup] = await Promise.all([
			resolveCoordinates(
				rest.siteAddress,
				{
					lat: existing.siteLat,
					lng: existing.siteLng,
					geocodedFor: existing.siteGeocodedFor,
					postcode: existing.sitePostcode,
					city: existing.siteCity,
					state: existing.siteState,
				},
				pinFor(siteLat, siteLng, rest.siteAddress),
			),
			resolveCoordinates(
				rest.pickupAddress,
				{
					lat: existing.pickupLat,
					lng: existing.pickupLng,
					geocodedFor: existing.pickupGeocodedFor,
					postcode: existing.pickupPostcode,
					city: existing.pickupCity,
					state: existing.pickupState,
				},
				pickupPin(rest.pickupAddress, pickupLat, pickupLng),
			),
		]);

		trace("save.resolved", {
			what: "edit",
			site: [site.lat, site.lng],
			pickup: [pickup.lat, pickup.lng],
		});

		const delivery = await prisma.delivery.update({
			where: { id },
			data: {
				...rest,
				items,
				siteLat: site.lat,
				siteLng: site.lng,
				siteGeocodedFor: site.geocodedFor,
				sitePostcode: site.postcode,
				siteCity: site.city,
				siteState: site.state,
				pickupLat: pickup.lat,
				pickupLng: pickup.lng,
				pickupGeocodedFor: pickup.geocodedFor,
				pickupPostcode: pickup.postcode,
				pickupCity: pickup.city,
				pickupState: pickup.state,
				scheduledAt: scheduledAt === null ? null : new Date(scheduledAt),
				totalVolumeM3: totalVolumeM3(items),
				totalWeightKg: totalWeightKg(items),
				events: { create: { source: "ADMIN", message: "Delivery edited" } },
			},
		});

		return NextResponse.json({ delivery });
	},
);

export const DELETE = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (_request, { params }) => {
		const { id } = await params;
		const existing = await prisma.delivery.findUnique({ where: { id } });
		if (!existing) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		// A booked job is a lorry someone is paying for. Cancel it with the carrier
		// first; deleting the row here would only lose the record of it.
		if (existing.carrierOrderId) {
			return NextResponse.json({ error: "already_booked" }, { status: 409 });
		}

		await prisma.delivery.delete({ where: { id } });
		return NextResponse.json({ ok: true });
	},
);
