import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { LABEL_FALLBACK, labelPathname } from "@/lib/logistics/label";

export const runtime = "nodejs";

/**
 * The consignment note to print and tape to the box.
 *
 * A route rather than a blob link, because the note carries the customer's
 * name, phone and full home address. The blob is written `access: "private"`
 * and the pathname is the consignment number — sequential, and guessable — so a
 * public object would be a disclosure waiting to happen. Everything under
 * `/api/admin` sits behind the shared-secret cookie `proxy.ts` enforces, which
 * makes this the cheapest correct door: no second auth check to keep in step.
 *
 * The pathname is derived from `carrierOrderId` rather than stored in its own
 * column. `Delivery.labelUrl` already holds this route's URL, and a second
 * column holding a path that is a pure function of an existing one is a column
 * that can disagree with itself.
 *
 * Reads the copy taken at booking time, for every carrier in
 * `LABEL_FALLBACK`. GDEX only serves its PDF while a shipment is pending, and
 * FedEx's label link is not ours to rely on later. A 404 here means that
 * capture failed — the label is still printable from the carrier's own portal.
 */
export const GET = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:read",
	async (_request, { params }) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({
			where: { id },
			select: { carrierId: true, carrierOrderId: true },
		});

		if (
			!delivery ||
			delivery.carrierId === null ||
			!Object.hasOwn(LABEL_FALLBACK, delivery.carrierId) ||
			delivery.carrierOrderId === null
		) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		const result = await get(
			labelPathname(delivery.carrierId, delivery.carrierOrderId),
			{
				access: "private",
				useCache: false,
			},
		);
		if (result?.statusCode !== 200) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		return new Response(result.stream, {
			headers: {
				"Content-Type": "application/pdf",
				// Opens in the browser's viewer, named so a printed stack of notes can
				// be matched back to a consignment without opening each one.
				"Content-Disposition": `inline; filename="${delivery.carrierOrderId}.pdf"`,
				// A consignment note is customer data behind an admin cookie. Shared
				// caches must never hold it, and the bytes never change anyway.
				"Cache-Control": "private, max-age=3600",
			},
		});
	},
);
