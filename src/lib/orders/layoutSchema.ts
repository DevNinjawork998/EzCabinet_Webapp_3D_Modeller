import { z } from "zod";
import type { PlannerLayout } from "@/lib/planner/layout";

/**
 * The layout document as it arrives from a customer's browser at checkout.
 *
 * `PlannerLayout` is a plain TypeScript type because the engine only ever built
 * layouts itself. An order is the first time one crosses a trust boundary, so
 * this is its zod twin. `satisfies` keeps the two from drifting: add a field to
 * `PlannerLayout` that this does not produce and the build fails.
 *
 * Zod strips unknown keys, so nothing a client adds rides into the database.
 */
const placedModuleSchema = z.object({
	id: z.string().min(1).max(64),
	familyId: z.string().min(1).max(128),
	widthMm: z.number().positive().max(10_000),
	doorStyleId: z.string().min(1).max(128).nullable(),
	hinge: z.enum(["left", "right"]),
	xMm: z.number().min(0).max(20_000),
	hangAtMm: z.number().min(0).max(10_000).optional(),
	rotationDeg: z.number().int().min(-360).max(360).optional(),
});

export const plannerLayoutSchema = z.object({
	wallWidthMm: z.number().positive(),
	roomDepthMm: z.number().positive(),
	ceilingHeightMm: z.number().positive(),
	hangingHeightMm: z.number().min(0),
	wallToCeiling: z.boolean(),
	baseSkirting: z.boolean(),
	wallToWall: z.boolean(),
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
}) satisfies z.ZodType<PlannerLayout>;

/**
 * What an order stores. The version is the promise that an order placed today
 * still reads after `PlannerLayout` changes shape — CLAUDE.md's `schemaVersion`
 * rule.
 */
export const ORDER_DESIGN_VERSION = 1;

export type OrderDesign = {
	schemaVersion: typeof ORDER_DESIGN_VERSION;
	layout: PlannerLayout;
};

export const orderDesignSchema = z.object({
	schemaVersion: z.literal(ORDER_DESIGN_VERSION),
	layout: plannerLayoutSchema,
});
