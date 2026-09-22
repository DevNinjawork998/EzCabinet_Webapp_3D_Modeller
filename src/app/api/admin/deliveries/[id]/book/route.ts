import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { getAdapter } from "@/lib/logistics/registry";
import { toJob } from "@/lib/logistics/store";
import { bookInputSchema, CarrierNotConfigured } from "@/lib/logistics/types";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import { draftFor, NOTIFY_ORDER_SELECT } from "@/lib/whatsapp/templates";

export const runtime = "nodejs";

/**
 * Book the pickup. The only call in the app that spends money.
 *
 * Four guards, in order of how much they cost to get wrong:
 *
 * 1. Already booked → return what exists. A double-submitted form, a retried
 *    request or an impatient second click must not buy a second lorry.
 * 2. The row is claimed — `carrierOrderId: null` flipped to a `bookedBy` row
 *    — before the adapter is ever called. `@unique` on `carrierOrderId` only
 *    stops two *different* deliveries from sharing one order id; it does
 *    nothing for two concurrent POSTs on the *same* delivery, which both read
 *    null and would otherwise both reach `submit_orders`, double-spending the
 *    wallet and leaving one order id orphaned when the second write
 *    overwrites the first. The `updateMany` below is the actual backstop: it
 *    only touches a row still `carrierOrderId: null`, so only the first of two
 *    racing requests can claim it.
 * 3. The booking call is never retried. `carrierFetch` only retries calls the
 *    adapter marks idempotent, and booking is not one of them.
 * 4. `bookedBy` is required. The handler now runs behind `withAuth`, which
 *    resolves the real signed-in actor — but `book`/`split` still record the
 *    name typed on the confirm step, not that session actor; moving them onto
 *    it is a scheduled follow-up (Known issue 11, CLAUDE.md). Until then, this
 *    client-supplied name plus the event row is the entire record of who
 *    committed the spend.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (request, { params }) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({ where: { id } });
		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		if (delivery.carrierOrderId) {
			return NextResponse.json({ delivery, alreadyBooked: true });
		}

		const parsed = bookInputSchema.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		const { carrierId, bookedBy, quotedPriceRm } = parsed.data;

		// Claim the row before any money moves. If the adapter call below throws,
		// `bookedBy` stays set but `carrierOrderId` stays null, so a retry still
		// finds the row claimable and proceeds — this only ever blocks a second
		// request that arrives while the first is still in flight.
		const claimed = await prisma.delivery.updateMany({
			where: { id, carrierOrderId: null },
			data: { bookedBy },
		});
		if (claimed.count === 0) {
			// Someone else claimed it between our read above and here.
			const existing = await prisma.delivery.findUnique({ where: { id } });
			return NextResponse.json({ delivery: existing, alreadyBooked: true });
		}

		const job = toJob(delivery);

		try {
			const adapter = getAdapter(carrierId);
			// Re-quote immediately before booking rather than trusting the figure the
			// page has been holding: a quote goes stale, and the price we record must
			// be the one the carrier just agreed to.
			const quote = await adapter.quote(job);

			// If the carrier now wants materially more than the admin confirmed, stop
			// and make them look again. Not a rounding guard — a 10% move on a lorry
			// is a different decision.
			if (
				quotedPriceRm !== null &&
				quote.priceRm !== null &&
				quote.priceRm > quotedPriceRm * 1.1
			) {
				return NextResponse.json(
					{
						error: "price_moved",
						quotedPriceRm,
						currentPriceRm: quote.priceRm,
					},
					{ status: 409 },
				);
			}

			const booking = await adapter.book(job, quote);

			const booked = await prisma.delivery.update({
				where: { id },
				data: {
					carrierId,
					bookedBy,
					status: "BOOKED",
					quotedPriceRm: quote.priceRm ?? quotedPriceRm,
					carrierOrderId: booking.carrierOrderId,
					trackingUrl: booking.trackingUrl,
					labelUrl: booking.labelUrl ?? null,
					events: {
						create: {
							source: "ADMIN",
							status: "BOOKED",
							actor: bookedBy,
							message: `Booked with ${carrierId}${
								quote.priceRm === null ? "" : ` for RM ${quote.priceRm}`
							}`,
							raw: { booking, quote } as never,
						},
					},
				},
			});

			// Deliberately not in the booking write's transaction: that write
			// records money already spent at the carrier, and a failed insert here
			// must never roll it back — the row would look unbooked and a retry
			// would buy a second lorry.
			const orderId = booked.orderId;
			if (orderId) {
				try {
					const ids = await prisma.$transaction(async (tx) => {
						const order = await tx.order.findUniqueOrThrow({
							where: { id: orderId },
							select: NOTIFY_ORDER_SELECT,
						});
						return enqueue(tx, [
							draftFor({
								kind: "DELIVERY_BOOKED",
								order,
								delivery: {
									id: booked.id,
									publicToken: booked.publicToken,
									carrierId,
									carrierOrderId: booking.carrierOrderId,
								},
							}),
						]);
					});
					flushSoon(ids);
				} catch (error) {
					console.error(
						JSON.stringify({
							type: "WHATSAPP_ENQUEUE_FAILED",
							deliveryId: booked.id,
							message: (error as Error).message,
						}),
					);
				}
			}

			return NextResponse.json({ delivery: booked }, { status: 201 });
		} catch (error) {
			if (error instanceof CarrierNotConfigured) {
				return NextResponse.json(
					{ error: "carrier_not_configured" },
					{
						status: 409,
					},
				);
			}
			// The booking may or may not have landed at the carrier — record the
			// attempt either way, so a lorry that turns up unexplained has a trail.
			await prisma.deliveryEvent.create({
				data: {
					deliveryId: id,
					source: "ADMIN",
					actor: bookedBy,
					message: `Booking with ${carrierId} failed: ${(error as Error).message}`,
				},
			});
			// A code rather than a sentence, so `messageFor` can translate it — and
			// the carrier's own words alongside, because "Insufficient Credit" is
			// something the admin can act on and the generic fallback is not.
			return NextResponse.json(
				{ error: "carrier_refused", message: (error as Error).message },
				{ status: 502 },
			);
		}
	},
);
