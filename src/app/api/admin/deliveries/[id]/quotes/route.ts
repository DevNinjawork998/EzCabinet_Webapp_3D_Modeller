import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { CARRIERS } from "@/lib/logistics/carriers";
import { refreshGeocoderHealth } from "@/lib/logistics/geocode";
import { findAdapter } from "@/lib/logistics/registry";
import { toJob } from "@/lib/logistics/store";
import { trace } from "@/lib/logistics/trace";
import type { CarrierQuote } from "@/lib/logistics/types";

export const runtime = "nodejs";

type QuoteRow = CarrierQuote & { error?: string };

/**
 * Ask every partner we can reach what this job costs.
 *
 * `allSettled`, not `all`: one carrier being down must not blank the whole
 * comparison. A partner that fails comes back as a row carrying its error, so
 * the admin sees "GDEX: timed out" next to the prices that did arrive and can
 * still book one of them.
 *
 * Every carrier gets a row, including the ones with no credentials. They used
 * to be filtered out before the comparison, which is correct as far as it goes
 * — an admin cannot fix a missing environment variable from this page — but it
 * made "Lalamove is switched off" and "Lalamove refused this job" the same
 * blank screen.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (_request, { params }) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({ where: { id } });
		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		// Before anyone is asked, settle whether the geocoder works. Both parcel
		// adapters refuse a job with no postcode, and the sentence they show turns
		// on *why* there is none — an address the admin should fix, or a key Google
		// is refusing, which no amount of editing that address will change. This is
		// the screen where that sentence is read and acted on, so it is worth one
		// probe every five minutes to have it be true.
		await refreshGeocoderHealth();

		const job = toJob(delivery);
		const adapters = CARRIERS.map((carrier) => ({
			id: carrier.id,
			adapter: findAdapter(carrier.id),
		}));
		const asked = adapters.filter(
			(row) => row.adapter?.isConfigured() === true,
		);

		trace("compare", {
			deliveryId: id,
			all: adapters.map((row) => row.id),
			asked: asked.map((row) => row.id),
			site: { lat: delivery.siteLat, lng: delivery.siteLng },
			pickup: { lat: delivery.pickupLat, lng: delivery.pickupLng },
		});

		const settled = await Promise.allSettled(
			asked.map((row) =>
				(row.adapter as NonNullable<typeof row.adapter>).quote(job),
			),
		);

		const answered: QuoteRow[] = settled.map((result, i) => {
			const row: QuoteRow =
				result.status === "fulfilled"
					? result.value
					: {
							carrierId: asked[i].id,
							priceRm: null,
							etaMinutes: null,
							error: (result.reason as Error).message,
						};
			trace("compare.result", {
				carrierId: row.carrierId,
				priceRm: row.priceRm,
				error: row.error ?? null,
			});
			return row;
		});

		const quotes: QuoteRow[] = adapters.map(
			(row) =>
				answered.find((quote) => quote.carrierId === row.id) ?? {
					carrierId: row.id,
					priceRm: null,
					etaMinutes: null,
					error: "No credentials on this deployment — nothing was asked.",
				},
		);

		// QUOTED only ever moves a DRAFT forward — re-comparing a booked job is a
		// legitimate thing to do and must not rewrite its status.
		if (delivery.status === "DRAFT") {
			await prisma.delivery.update({
				where: { id },
				data: {
					status: "QUOTED",
					events: {
						create: {
							source: "ADMIN",
							status: "QUOTED",
							message: `Compared ${quotes.length} partner${quotes.length === 1 ? "" : "s"}`,
							raw: quotes as never,
						},
					},
				},
			});
		}

		return NextResponse.json({ quotes });
	},
);
