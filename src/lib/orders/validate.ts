import {
	CEILING_LIMITS,
	doorStyleIn,
	familyIn,
	isCorner,
	WALL_HANG_LIMITS,
} from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { planIsValid } from "@/lib/planner/floorplan";
import { rowFor } from "@/lib/planner/layout";
import { type RoomLayout, roomEngine } from "@/lib/planner/room";

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
	layout: RoomLayout,
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
		!planIsValid(layout.plan) ||
		!within(layout.ceilingHeightMm, CEILING_LIMITS) ||
		!within(layout.hangingHeightMm, WALL_HANG_LIMITS)
	) {
		return { ok: false, problem: "out_of_range" };
	}

	const rows = [
		...layout.runs.flatMap((run) => [
			...run.floor.map((placed) => ({
				placed,
				row: "floor" as const,
				corner: false,
			})),
			...run.wall.map((placed) => ({
				placed,
				row: "wall" as const,
				corner: false,
			})),
		]),
		...layout.corners.flatMap((corner) =>
			(["floor", "wall"] as const).flatMap((row) => {
				const placed = corner[row];
				return placed ? [{ placed, row, corner: true }] : [];
			}),
		),
	];
	if (rows.length === 0) return { ok: false, problem: "empty" };

	const ids = new Set<string>();
	for (const { placed } of rows) {
		if (ids.has(placed.id)) {
			return { ok: false, problem: "duplicate_id", moduleId: placed.id };
		}
		ids.add(placed.id);
	}

	const engine = roomEngine(catalogue);
	for (const { placed, row, corner } of rows) {
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
		// A corner unit belongs in the corner and only there.
		if (isCorner(family) !== corner) return fail("does_not_fit");
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

	// A cabinet inside a corner square, or a square grown into a run, is not a
	// design anyone can fit.
	if (!engine.isClear(layout)) return { ok: false, problem: "does_not_fit" };

	return { ok: true };
}
