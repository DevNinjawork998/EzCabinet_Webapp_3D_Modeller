import { NextResponse } from "next/server";
import { authEnabled } from "@/lib/auth/enabled";
import { BYPASS_USER } from "@/lib/auth/requireAuth";
import { currentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/catalogue/db";
import { canViewOrder } from "@/lib/orders/access";
import { startPayment } from "@/lib/payments/start";

export const runtime = "nodejs";

const STATUS = {
	not_configured: 503,
	not_found: 404,
	not_awaiting_payment: 409,
	payment_in_progress: 409,
} as const;

/**
 * Pay (again) for an existing order — the order page's retry after a failed
 * or abandoned attempt. Resumes the order's open payment where the gateway
 * allows it. The body is ignored.
 *
 * Owner or staff only, like the order page (`lib/orders/access.ts`): the
 * reply carries a payment session for the customer's name, email and phone.
 * Anyone else — signed out included, since an API cannot redirect — gets the
 * same 404 as a made-up token.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;
	const viewer = authEnabled() ? await currentUser() : BYPASS_USER;
	const order = await prisma.order.findUnique({
		where: { publicToken: token },
		select: { userId: true },
	});
	if (order === null || !canViewOrder(viewer, order)) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	const result = await startPayment(token, new URL(request.url).origin);
	return result.ok
		? NextResponse.json(result.start)
		: NextResponse.json(
				{ error: result.error },
				{ status: STATUS[result.error] },
			);
}
