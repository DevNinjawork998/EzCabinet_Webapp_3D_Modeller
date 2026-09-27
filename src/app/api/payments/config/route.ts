import { NextResponse } from "next/server";
import { activeGateway } from "@/lib/payments/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the checkout page needs to draw its payment step before any order
 * exists: which kind of gateway is live (the `payment-gateway` flag) and, for
 * Stripe, its publishable key. Null means bank transfer. Asked at runtime
 * rather than baked into the planner, so the planner stays static and a flag
 * flip needs no redeploy.
 */
export async function GET() {
	const gateway = await activeGateway();
	return NextResponse.json(
		{ client: gateway?.client ?? null },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
