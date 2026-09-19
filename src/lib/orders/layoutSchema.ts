import { z } from "zod";
import { planIsValid, vertexKind, wallsOf } from "@/lib/planner/floorplan";
import type { PlacedModule, PlannerLayout } from "@/lib/planner/layout";
import {
	asRoom,
	type CornerUnits,
	type RoomLayout,
	type Run,
} from "@/lib/planner/room";

/**
 * The layout document as it arrives from a customer's browser at checkout —
 * the zod twin of the planner's types. `satisfies` keeps the two from drifting.
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
	ceilingHeightMm: z.number().positive(),
	hangingHeightMm: z.number().min(0),
	wallToCeiling: z.boolean(),
	baseSkirting: z.boolean(),
};

/** The fields a room had before it had a floor plan (design v1 and v2). */
const legacySettings = {
	...settings,
	wallWidthMm: z.number().positive(),
	roomDepthMm: z.number().positive(),
	wallToWall: z.boolean(),
};

const rowsSchema = {
	floor: z.array(placedModuleSchema).max(60),
	wall: z.array(placedModuleSchema).max(60),
};

/** One wall, as orders stored it before L-shapes (design v1). */
export const plannerLayoutSchema = z.object({
	...legacySettings,
	...rowsSchema,
}) satisfies z.ZodType<PlannerLayout>;

const runSchema = z.object(rowsSchema);

/** One wall or an L, as orders stored it before room shapes (design v2). */
const roomLayoutV2Schema = z
	.object({
		...legacySettings,
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
	});

const planSchema = z
	.union([
		z.object({
			template: z.literal("rect"),
			widthMm: z.number(),
			depthMm: z.number(),
		}),
		z.object({
			template: z.literal("l"),
			widthMm: z.number(),
			depthMm: z.number(),
			notchWidthMm: z.number(),
			notchDepthMm: z.number(),
			mirror: z.boolean(),
		}),
	])
	// The editor's own clamp, as a yes or no: one set of limits, not two.
	.refine(planIsValid, { message: "a room outside its template's limits" });

/** The room document: a floor plan, a run per wall, corner units by vertex. */
export const roomLayoutSchema = z
	.object({
		...settings,
		plan: planSchema,
		runs: z.array(runSchema).min(4).max(6),
		corners: z
			.array(
				z.object({
					vertex: z.number().int().min(0),
					floor: placedModuleSchema.nullable(),
					wall: placedModuleSchema.nullable(),
				}),
			)
			.max(6),
	})
	.refine((room) => room.runs.length === wallsOf(room.plan).length, {
		message: "one run per wall",
	})
	.refine(
		(room) =>
			room.corners.every(
				(c) =>
					c.vertex < room.runs.length &&
					vertexKind(room.plan, c.vertex) === "inside",
			),
		{ message: "a corner unit stands only in an inside corner" },
	)
	.refine(
		(room) =>
			new Set(room.corners.map((c) => c.vertex)).size === room.corners.length,
		{
			message: "one slot per corner",
		},
	) satisfies z.ZodType<RoomLayout>;

/**
 * What an order stores. The version is the promise that an order placed today
 * still reads after the layout changes shape. Versions 1 and 2 are read as a
 * rectangle, so every reader downstream only ever sees version 3.
 */
export const ORDER_DESIGN_VERSION = 3;

export type OrderDesign = {
	schemaVersion: typeof ORDER_DESIGN_VERSION;
	layout: RoomLayout;
};

/** A v2 room onto a rectangle. The v2 side wall was the left wall for a left
 * L and the right wall for a right one; the winding matches, so `xMm` carries
 * over. A corner unit's stored turn was never trusted and is dropped. */
function fromV2(v2: z.infer<typeof roomLayoutV2Schema>): RoomLayout {
	const {
		wallWidthMm,
		roomDepthMm,
		wallToWall: _gone,
		runs,
		corner,
		...rest
	} = v2;
	const empty = (): Run => ({ floor: [], wall: [] });
	const next: Run[] = [runs[0], empty(), empty(), empty()];
	const corners: CornerUnits[] = [];
	if (corner && runs[1]) {
		next[corner.side === "left" ? 3 : 1] = runs[1];
		const bare = (unit: PlacedModule | null): PlacedModule | null => {
			if (!unit) return null;
			const { rotationDeg: _turn, ...kept } = unit;
			return kept;
		};
		if (corner.floor || corner.wall) {
			corners.push({
				vertex: corner.side === "left" ? 3 : 0,
				floor: bare(corner.floor),
				wall: bare(corner.wall),
			});
		}
	}
	return {
		...rest,
		plan: { template: "rect", widthMm: wallWidthMm, depthMm: roomDepthMm },
		runs: next,
		corners,
	};
}

export const orderDesignSchema = z.union([
	z.object({ schemaVersion: z.literal(3), layout: roomLayoutSchema }),
	z
		.object({ schemaVersion: z.literal(2), layout: roomLayoutV2Schema })
		.transform(({ layout }) => ({
			schemaVersion: 3 as const,
			layout: fromV2(layout),
		})),
	z
		.object({ schemaVersion: z.literal(1), layout: plannerLayoutSchema })
		.transform(({ layout }) => ({
			schemaVersion: 3 as const,
			layout: asRoom(layout),
		})),
]);
