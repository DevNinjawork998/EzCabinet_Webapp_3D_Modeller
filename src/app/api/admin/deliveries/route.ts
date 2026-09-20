import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { pickupPin, WORKSHOP_ADDRESS } from "@/lib/logistics/carriers";
import { pinFor } from "@/lib/logistics/coords";
import {
	refreshGeocoderHealth,
	resolveCoordinates,
} from "@/lib/logistics/geocode";
import {
	suggestVehicle,
	totalVolumeM3,
	totalWeightKg,
} from "@/lib/logistics/measure";
import { trace } from "@/lib/logistics/trace";
import { deliveryInputSchema } from "@/lib/logistics/types";

export const runtime = "nodejs";

/** Every delivery for the admin list, newest job number first. */
export const GET = withAuth("logistics:read", async () => {
	const deliveries = await prisma.delivery.findMany({
		orderBy: { number: "desc" },
	});
	return NextResponse.json({
		deliveries,
		workshopAddress: WORKSHOP_ADDRESS,
		geocodingConfigured: (await refreshGeocoderHealth()).ok,
	});
});

export const POST = withAuth("logistics:book", async (request) => {
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
		// Pulled out of `rest` on purpose: these are the admin's *override*, not
		// columns to write. Left in the spread they would overwrite the pin
		// `resolveCoordinates` is about to find, with the null they usually are.
		siteLat,
		siteLng,
		pickupLat,
		pickupLng,
		...rest
	} = parsed.data;

	// Only a paid order becomes a delivery — the same gate the order page puts
	// on its button, held here because a URL can be typed.
	if (rest.orderId !== null) {
		const order = await prisma.order.findUnique({
			where: { id: rest.orderId },
			select: { status: true },
		});
		if (order?.status !== "PAID") {
			return NextResponse.json({ error: "order_not_paid" }, { status: 409 });
		}
	}

	// Geocode here rather than at quote time: an address Google cannot place is
	// the admin's typo, and they are far more likely to fix it now than when a
	// partner comparison silently comes back one row short.
	const blank = {
		lat: null,
		lng: null,
		geocodedFor: null,
		postcode: null,
		city: null,
		state: null,
	};
	trace("save", {
		what: "create",
		siteAddress: rest.siteAddress,
		sitePinGiven:
			siteLat !== null && siteLng !== null ? [siteLat, siteLng] : null,
		pickupAddress: rest.pickupAddress,
		pickupPinGiven:
			pickupLat !== null && pickupLng !== null ? [pickupLat, pickupLng] : null,
	});
	const [site, pickup] = await Promise.all([
		resolveCoordinates(
			rest.siteAddress,
			blank,
			pinFor(siteLat, siteLng, rest.siteAddress),
		),
		resolveCoordinates(
			rest.pickupAddress,
			blank,
			pickupPin(rest.pickupAddress, pickupLat, pickupLng),
		),
	]);

	trace("save.resolved", {
		what: "create",
		site: [site.lat, site.lng],
		pickup: [pickup.lat, pickup.lng],
	});

	const delivery = await prisma.delivery.create({
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
			// Derived on write so the carrier payload builders and the list can
			// read them without recomputing, and so a later change to the maths
			// is visible as a migration rather than a silently different quote.
			totalVolumeM3: totalVolumeM3(items),
			totalWeightKg: totalWeightKg(items),
			events: {
				create: {
					source: "ADMIN",
					message: `Delivery created — ${suggestVehicle(items).label}`,
				},
			},
		},
	});

	return NextResponse.json({ delivery }, { status: 201 });
});
