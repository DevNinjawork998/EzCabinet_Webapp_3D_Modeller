import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { flushSoon } from "@/lib/whatsapp/outbox";

export const runtime = "nodejs";

/**
 * Put a failed WhatsApp message back in the queue.
 *
 * Only a `FAILED` row, and only one belonging to this order. Resetting
 * `queuedAt` restarts the 48 h expiry — the admin chose to send it late.
 */
export const POST = withAuth<{
	params: Promise<{ id: string; notificationId: string }>;
}>("orders:markPaid", async (_request, { params }) => {
	const { id, notificationId } = await params;
	const { count } = await prisma.notification.updateMany({
		where: { id: notificationId, orderId: id, status: "FAILED" },
		data: {
			status: "PENDING",
			attempts: 0,
			lastError: null,
			queuedAt: new Date(),
		},
	});
	if (count !== 1) {
		return NextResponse.json({ error: "not_failed" }, { status: 409 });
	}
	flushSoon([notificationId]);
	return NextResponse.json({ ok: true });
});
