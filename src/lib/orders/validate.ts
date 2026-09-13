import {
	CEILING_LIMITS,
	doorStyleIn,
	familyIn,
	ROOM_DEPTH_LIMITS,
	WALL_HANG_LIMITS,
} from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import {
	type PlannerLayout,
	plannerEngine,
	rowFor,
	WALL_LIMITS,
} from "@/lib/planner/layout";

/**
 * Whether a customer's design can be sold as it stands.
 *
 * The engine forgives bad input quietly, which is right for a canvas and wrong
 * for a payment: `positioned` drops a cabinet whose family it does not know,
 * and `sizePriceRmIn` prices a width that is not on the ladder at RM0. A
 * tampered or stale layout would check out cheaper than the design it draws.
 * So every rule is stated here, and the first one broken is the answer.
 *
 * Pure, like the engine — the checkout route calls it with the published
 * catalogue, and the tests with the seed.
 */

export type OrderProblem =
	| "unknown_room"
	| "unknown_finish"
	| "empty"
	| "duplicate_id"
	| "unknown_cabinet"
	| "not_in_room"
	| "off_ladder"
	| "unknown_door"
	| "does_not_fit"
	| "out_of_range";

export type OrderCheck =
	| { ok: true }
	| { ok: false; problem: OrderProblem; moduleId?: string };

const within = (value: number, limits: { minMm: number; maxMm: number }) =>
	value >= limits.minMm && value <= limits.maxMm;

export function validateOrder(
	layout: PlannerLayout,
	roomId: string,
	finishId: string,
	catalogue: PlannerCatalogue,
): OrderCheck {
	const room = catalogue.roomTypes.find((r) => r.id === roomId);
	if (!room) return { ok: false, problem: "unknown_room" };
	if (!catalogue.finishes.some((f) => f.id === finishId)) {
		return { ok: false, problem: "unknown_finish" };
	}

	if (
		!within(layout.wallWidthMm, WALL_LIMITS) ||
		!within(layout.ceilingHeightMm, CEILING_LIMITS) ||
		!within(layout.roomDepthMm, ROOM_DEPTH_LIMITS) ||
		!within(layout.hangingHeightMm, WALL_HANG_LIMITS)
	) {
		return { ok: false, problem: "out_of_range" };
	}

	const rows = [
		...layout.floor.map((placed) => ({ placed, row: "floor" as const })),
		...layout.wall.map((placed) => ({ placed, row: "wall" as const })),
	];
	if (rows.length === 0) return { ok: false, problem: "empty" };

	const ids = new Set<string>();
	for (const { placed } of rows) {
		if (ids.has(placed.id)) {
			return { ok: false, problem: "duplicate_id", moduleId: placed.id };
		}
		ids.add(placed.id);
	}

	const engine = plannerEngine(catalogue);
	for (const { placed, row } of rows) {
		const fail = (problem: OrderProblem): OrderCheck => ({
			ok: false,
			problem,
			moduleId: placed.id,
		});
		const family = familyIn(catalogue, placed.familyId);
		if (!family) return fail("unknown_cabinet");
		if (!room.familyIds.includes(family.id)) return fail("not_in_room");
		if (!family.sizes.some((size) => size.widthMm === placed.widthMm)) {
			return fail("off_ladder");
		}
		if (
			placed.doorStyleId !== null &&
			!doorStyleIn(catalogue, placed.doorStyleId)
		) {
			return fail("unknown_door");
		}
		if (rowFor(family.kind) !== row) return fail("does_not_fit");
		if (
			placed.hangAtMm !== undefined &&
			placed.hangAtMm > layout.ceilingHeightMm
		) {
			return fail("out_of_range");
		}
		const fits = engine
			.widthOptionsFor(layout, placed.id)
			.find((option) => option.widthMm === placed.widthMm)?.fits;
		if (!fits) return fail("does_not_fit");
	}

	const overhanging = [...engine.overhangingIds(layout)];
	if (overhanging.length > 0) {
		return { ok: false, problem: "does_not_fit", moduleId: overhanging[0] };
	}

	return { ok: true };
}
