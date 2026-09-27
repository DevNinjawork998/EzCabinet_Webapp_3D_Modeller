import { prisma } from "@/lib/catalogue/db";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import { draftFor, NOTIFY_ORDER_SELECT } from "@/lib/whatsapp/templates";

/**
 * AWAITING_PAYMENT → PAID, with its WhatsApp message queued in the same
 * transaction. The one write path for both an admin confirming a bank
 * transfer and Stripe's webhook confirming a payment.
 *
 * A conditional update rather than read-then-write, so two confirmations at
 * once (two admins, or a webhook retry) cannot both mark it, and a cancelled
 * order cannot be revived as paid. False when nothing changed.
 */
export async function markOrderPaid(
	id: string,
	data: {
		paymentRef: string | null;
		paidByUserId?: string | null;
		paymentProvider?: string;
	},
): Promise<boolean> {
	const notificationIds = await prisma.$transaction(async (tx) => {
		const { count } = await tx.order.updateMany({
			where: { id, status: "AWAITING_PAYMENT" },
			data: { status: "PAID", paidAt: new Date(), ...data },
		});
		if (count !== 1) return null;
		const order = await tx.order.findUniqueOrThrow({
			where: { id },
			select: NOTIFY_ORDER_SELECT,
		});
		return enqueue(tx, [draftFor({ kind: "PAYMENT_CONFIRMED", order })]);
	});
	if (!notificationIds) return false;
	flushSoon(notificationIds);
	return true;
}
