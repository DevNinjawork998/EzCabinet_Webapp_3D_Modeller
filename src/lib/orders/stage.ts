import type { ProductionStage } from "@/generated/prisma/enums";

/**
 * The factory steps a paid order moves through, in order.
 *
 * An admin advances them one at a time from `/admin/orders/[id]`; Factory
 * Tracker will push onto the same endpoint in Phase 4. Forward-only and one
 * step at a time, so a double-click or a stale tab cannot skip a step or send
 * the customer the same WhatsApp message twice.
 */
export const STAGES = [
	"MEASURE",
	"CUTTING",
	"EDGING",
	"ASSEMBLY",
	"QC",
	"READY",
] as const satisfies readonly ProductionStage[];

export function nextStage(
	current: ProductionStage | null,
): ProductionStage | null {
	const index = current === null ? -1 : STAGES.indexOf(current);
	return STAGES[index + 1] ?? null;
}

/** Why an admin may not move this order to `requested`, or null if they may. */
export function stageRefusal(
	order: { status: string; productionStage: ProductionStage | null },
	requested: ProductionStage,
): "not_paid" | "not_next_stage" | null {
	if (order.status !== "PAID") return "not_paid";
	if (nextStage(order.productionStage) !== requested) return "not_next_stage";
	return null;
}

export const stageReached = (
	current: ProductionStage | null,
	stage: ProductionStage,
): boolean =>
	current !== null && STAGES.indexOf(stage) <= STAGES.indexOf(current);
