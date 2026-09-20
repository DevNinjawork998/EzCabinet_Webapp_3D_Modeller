import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";

export const runtime = "nodejs";

/**
 * Cancel an order nobody has paid for — a mistaken or junk checkout.
 *
 * Paid orders are not cancelled here: that is a refund, which the manual
 * provider cannot perform and this app does not record.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"orders:markPaid",
	async (_request, { params }) => {
		const { id } = await params;
		const { count } = await prisma.order.updateMany({
			where: { id, status: "AWAITING_PAYMENT" },
			data: { status: "CANCELLED" },
		});
		if (count === 1) return NextResponse.json({ ok: true });

		const exists = await prisma.order.findUnique({
			where: { id },
			select: { id: true },
		});
		return exists
			? NextResponse.json({ error: "not_awaiting_payment" }, { status: 409 })
			: NextResponse.json({ error: "not_found" }, { status: 404 });
	},
);
