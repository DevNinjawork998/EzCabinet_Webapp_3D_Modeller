import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { STAGES, stageRefusal } from "@/lib/orders/stage";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import {
	draftFor,
	localeOf,
	NOTIFY_ORDER_SELECT,
} from "@/lib/whatsapp/templates";

export const runtime = "nodejs";

const bodySchema = z.object({ stage: z.enum(STAGES) });

/**
 * Advance a paid order one production stage, and tell the customer.
 *
 * The body names the stage the admin saw as next, and the update is
 * conditional on the stage it was read at — so a double-click or a stale tab
 * is refused rather than skipping a step or messaging twice. Gated like
 * marking paid: the same people run the order today.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"orders:markPaid",
	async (request, { params }) => {
		const { id } = await params;
		const parsed = bodySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		const { stage } = parsed.data;

		// The dictionary lookup is not DB work; loading it before the
		// transaction keeps the open transaction to reads and writes only.
		const localeRow = await prisma.order.findUnique({
			where: { id },
			select: { locale: true },
		});
		if (!localeRow) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		const t = await getDictionary(localeOf(localeRow.locale));
		const stageLabel = t.order.stages[stage];

		const result = await prisma.$transaction(async (tx) => {
			const order = await tx.order.findUnique({
				where: { id },
				select: { ...NOTIFY_ORDER_SELECT, status: true, productionStage: true },
			});
			if (!order) return { error: "not_found" as const };
			const refusal = stageRefusal(order, stage);
			if (refusal) return { error: refusal };

			const { count } = await tx.order.updateMany({
				where: { id, productionStage: order.productionStage },
				data: { productionStage: stage },
			});
			if (count !== 1) return { error: "not_next_stage" as const };

			const ids = await enqueue(tx, [
				draftFor({ kind: "STAGE", order, stage, stageLabel }),
			]);
			return { ids };
		});

		if ("error" in result) {
			return NextResponse.json(
				{ error: result.error },
				{ status: result.error === "not_found" ? 404 : 409 },
			);
		}
		flushSoon(result.ids);
		return NextResponse.json({ ok: true });
	},
);
