import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { getAdapter } from "@/lib/logistics/registry";
import { isForwardTransition } from "@/lib/logistics/status";
import {
	DELIVERY_STATUSES,
	type DeliveryStatusName,
} from "@/lib/logistics/types";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import {
	deliveryKindFor,
	draftFor,
	NOTIFY_ORDER_SELECT,
} from "@/lib/whatsapp/templates";

export const runtime = "nodejs";

const advanceSchema = z.object({
	status: z.enum(DELIVERY_STATUSES),
	note: z.string().trim().max(500).optional(),
});

/**
 * Move a job along by hand.
 *
 * This is how the `manual` partner works at all — nobody's own lorry posts a
 * webhook — and it is the escape hatch when a real carrier's callback never
 * arrives. It goes through the same forward-only rule as an automatic update,
 * with two deliberate exceptions: an admin may cancel or fail a job outright,
 * because those are decisions rather than observations.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"logistics:book",
	async (request, { params }, user) => {
		const { id } = await params;
		const delivery = await prisma.delivery.findUnique({
			where: { id },
			include: { order: { select: NOTIFY_ORDER_SELECT } },
		});
		if (!delivery) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		const parsed = advanceSchema.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		const { status, note } = parsed.data;
		const actor = user.name;

		const current = delivery.status as DeliveryStatusName;
		const isAbort = status === "CANCELLED" || status === "FAILED";
		if (!isAbort && !isForwardTransition(current, status)) {
			return NextResponse.json(
				{ error: "invalid_transition", from: current, to: status },
				{ status: 409 },
			);
		}

		// Cancelling our row is not cancelling the delivery. A booked carrier has
		// a driver on the way, and marking the job cancelled here while a lorry is
		// still coming is worse than not offering the button at all.
		if (
			status === "CANCELLED" &&
			delivery.carrierId &&
			delivery.carrierOrderId
		) {
			const adapter = getAdapter(delivery.carrierId);
			if (adapter.cancel) {
				try {
					await adapter.cancel(delivery.carrierOrderId);
				} catch (error) {
					// A refusal is not always a live job. Lalamove answers the same
					// `422 ERR_CANCELLATION` whether the cancel window has closed or
					// the order is already cancelled — and an order cancelled in the
					// carrier's own dashboard would otherwise leave this row stuck
					// booked for ever, since every retry refuses the same way. So ask
					// what state the order is actually in before refusing.
					let carrierStatus: DeliveryStatusName | null = null;
					try {
						carrierStatus = (await adapter.track(delivery.carrierOrderId))
							.status;
					} catch {
						// The refusal is what matters; a failed second call must not
						// replace its message.
					}

					if (carrierStatus !== "CANCELLED") {
						// Record the attempt, then refuse. The admin has to ring the
						// carrier, and the row must not read "cancelled" until they have.
						await prisma.deliveryEvent.create({
							data: {
								deliveryId: id,
								source: "ADMIN",
								actor,
								message: `Cancelling with ${delivery.carrierId} failed: ${(error as Error).message}`,
							},
						});
						return NextResponse.json(
							{
								error: "carrier_refused_cancel",
								message: (error as Error).message,
							},
							{ status: 409 },
						);
					}

					await prisma.deliveryEvent.create({
						data: {
							deliveryId: id,
							source: "ADMIN",
							actor,
							message: `${delivery.carrierId} reports this order was already cancelled`,
						},
					});
				}
			}
		}

		const kind = deliveryKindFor(status);

		const { updated, notificationIds } = await prisma.$transaction(
			async (tx) => {
				const updated = await tx.delivery.update({
					where: { id },
					data: {
						status,
						events: {
							create: {
								source: "ADMIN",
								status,
								actor,
								message: note ?? `Marked ${status} by hand`,
							},
						},
					},
				});
				const notificationIds =
					kind && delivery.order
						? await enqueue(tx, [
								draftFor({
									kind,
									order: delivery.order,
									delivery: {
										id: delivery.id,
										publicToken: delivery.publicToken,
									},
								}),
							])
						: [];
				return { updated, notificationIds };
			},
		);
		flushSoon(notificationIds);

		return NextResponse.json({ delivery: updated });
	},
);
