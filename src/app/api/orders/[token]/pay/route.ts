import { NextResponse } from "next/server";
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
 * allows it. Reached by the unguessable `publicToken`; the body is ignored.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const result = await startPayment(
		(await params).token,
		new URL(request.url).origin,
	);
	return result.ok
		? NextResponse.json(result.start)
		: NextResponse.json(
				{ error: result.error },
				{ status: STATUS[result.error] },
			);
}
