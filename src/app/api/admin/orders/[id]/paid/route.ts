import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";

export const runtime = "nodejs";

const bodySchema = z.object({
	paymentRef: z.string().trim().max(120).nullable().default(null),
});

/**
 * Manual payment: an admin confirms the bank transfer arrived.
 *
 * A conditional update rather than read-then-write, so two admins pressing at
 * once cannot both mark it, and a cancelled order cannot be revived as paid.
 *
 * `paidBy` is still written alongside `paidByUserId` because the column is
 * still there until Task 12, and an order marked paid between these two
 * tasks should not lose its record either way. `BYPASS_USER.id` is not a
 * real row, so it must not go into a foreign key.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"orders:markPaid",
	async (request, { params }, user) => {
		const { id } = await params;
		const parsed = bodySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		const { count } = await prisma.order.updateMany({
			where: { id, status: "AWAITING_PAYMENT" },
			data: {
				status: "PAID",
				paidAt: new Date(),
				paidBy: user.name,
				paidByUserId: user.id === "auth-disabled" ? null : user.id,
				paymentRef: parsed.data.paymentRef,
			},
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
