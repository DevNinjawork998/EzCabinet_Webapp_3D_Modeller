import { z } from "zod";
import type { PlannerLayout } from "@/lib/planner/layout";
import { asRoom, type RoomLayout } from "@/lib/planner/room";

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

const settings = {
	wallWidthMm: z.number().positive(),
	roomDepthMm: z.number().positive(),
	ceilingHeightMm: z.number().positive(),
	hangingHeightMm: z.number().min(0),
	wallToCeiling: z.boolean(),
	baseSkirting: z.boolean(),
	wallToWall: z.boolean(),
};

/** One wall, as orders stored it before L-shapes (design v1). */
export const plannerLayoutSchema = z.object({
	...settings,
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
}) satisfies z.ZodType<PlannerLayout>;

const runSchema = z.object({
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
});

/** The room document: one wall, or two meeting at a corner. */
export const roomLayoutSchema = z
	.object({
		...settings,
		runs: z.array(runSchema).min(1).max(2),
		corner: z
			.object({
				side: z.enum(["left", "right"]),
				floor: placedModuleSchema.nullable(),
				wall: placedModuleSchema.nullable(),
			})
			.nullable(),
	})
	.refine((room) => (room.runs.length === 2) === (room.corner !== null), {
		message: "a side wall and a corner come together",
	}) satisfies z.ZodType<RoomLayout>;

/**
 * What an order stores. The version is the promise that an order placed today
 * still reads after the layout changes shape — CLAUDE.md's `schemaVersion`
 * rule. Version 1 stored one wall's rows at the top level; it is read as a
 * one-wall room, so every reader downstream only ever sees version 2.
 */
export const ORDER_DESIGN_VERSION = 2;

export type OrderDesign = {
	schemaVersion: typeof ORDER_DESIGN_VERSION;
	layout: RoomLayout;
};

export const orderDesignSchema = z.union([
	z.object({ schemaVersion: z.literal(2), layout: roomLayoutSchema }),
	z
		.object({ schemaVersion: z.literal(1), layout: plannerLayoutSchema })
		.transform(({ layout }) => ({
			schemaVersion: 2 as const,
			layout: asRoom(layout),
		})),
]);
