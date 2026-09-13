import { checkBotId } from "botid/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/catalogue/db";
import { getPublishedPlannerCatalogue } from "@/lib/catalogue/store";
import { toE164 } from "@/lib/logistics/phone";
import {
	ORDER_DESIGN_VERSION,
	plannerLayoutSchema,
} from "@/lib/orders/layoutSchema";
import { PAYMENT_PROVIDER } from "@/lib/orders/payment";
import { priceOrder } from "@/lib/orders/price";
import { validateOrder } from "@/lib/orders/validate";

export const runtime = "nodejs";

/**
 * Checkout: a customer's design becomes an order.
 *
 * Public — no login to buy, same as no login to plan — which makes this the one
 * public endpoint that writes. So it is guarded three ways: BotID turns away
 * scripts, zod turns away malformed bodies, and `validateOrder` turns away a
 * design the catalogue cannot actually sell. The price is never read from the
 * body; it is computed here against the published catalogue.
 */
const orderInputSchema = z.object({
	roomId: z.string().min(1).max(40),
	finishId: z.string().min(1).max(128),
	layout: plannerLayoutSchema,
	customer: z.object({
		name: z.string().trim().min(1).max(200),
		phone: z.string().trim().min(1).max(40),
		email: z.email().max(200).nullable().default(null),
		siteAddress: z.string().trim().min(5).max(500),
		addressNotes: z.string().trim().max(500).nullable().default(null),
	}),
	/** The re-measure notice is a condition of the order, not a preference. */
	remeasureAccepted: z.literal(true),
});

export async function POST(request: Request) {
	const verification = await checkBotId();
	if (verification.isBot) {
		return NextResponse.json({ error: "bot" }, { status: 403 });
	}

	const parsed = orderInputSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const { roomId, finishId, layout, customer } = parsed.data;

	// A number a driver cannot ring is the order's real failure mode, so it is
	// refused here rather than discovered on delivery day.
	const phone = toE164(customer.phone);
	if (phone === null) {
		return NextResponse.json({ error: "bad_phone" }, { status: 422 });
	}

	const published = await getPublishedPlannerCatalogue();
	const check = validateOrder(layout, roomId, finishId, published.data);
	if (!check.ok) {
		return NextResponse.json(
			{
				error: "invalid_design",
				problem: check.problem,
				moduleId: check.moduleId,
			},
			{ status: 422 },
		);
	}

	const price = priceOrder(layout, finishId, published.data);
	const order = await prisma.order.create({
		data: {
			customerName: customer.name,
			customerPhone: phone,
			customerEmail: customer.email,
			siteAddress: customer.siteAddress,
			addressNotes: customer.addressNotes || null,
			roomId,
			finishId,
			design: { schemaVersion: ORDER_DESIGN_VERSION, layout } as never,
			catalogueVersionId: published.id,
			breakdown: price.breakdown as never,
			cabinetsRm: price.cabinetsRm,
			deliveryRm: price.deliveryRm,
			totalRm: price.totalRm,
			paymentProvider: PAYMENT_PROVIDER,
		},
		select: { publicToken: true },
	});

	return NextResponse.json({ token: order.publicToken }, { status: 201 });
}
