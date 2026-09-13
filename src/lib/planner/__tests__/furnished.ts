import { PLANNER_CATALOGUE, type RoomTypeId, roomTypeIn } from "../catalogue";
import { emptyLayout, type PlannerEngine, type PlannerLayout } from "../layout";

/**
 * The furnished runs each seed room used to open on, kept as test fixtures.
 *
 * The planner opens on an empty wall now, but the engine rules these runs
 * exercise — packing, collision, pricing, door swing — are unchanged, and a
 * realistic run of mixed cabinets is still the best thing to test them on.
 */
const RUNS: Record<RoomTypeId, { familyId: string; widthMm: number }[]> = {
	kitchen: [
		{ familyId: "base-cabinet", widthMm: 900 },
		{ familyId: "base-drawers", widthMm: 400 },
		{ familyId: "base-cabinet", widthMm: 900 },
		{ familyId: "tall-cabinet", widthMm: 600 },
		{ familyId: "wall-cabinet", widthMm: 900 },
		{ familyId: "wall-cabinet", widthMm: 400 },
		{ familyId: "wall-cabinet", widthMm: 900 },
	],
	living: [
		{ familyId: "tv-ledge", widthMm: 1800 },
		{ familyId: "tv-ledge", widthMm: 1200 },
		{ familyId: "tv-tall", widthMm: 600 },
	],
	bedroom: [
		{ familyId: "wardrobe", widthMm: 1200 },
		{ familyId: "wardrobe", widthMm: 900 },
		{ familyId: "wardrobe", widthMm: 900 },
	],
	foyer: [
		{ familyId: "shoe-cabinet", widthMm: 900 },
		{ familyId: "shoe-cabinet", widthMm: 600 },
		{ familyId: "shoe-bench", widthMm: 600 },
	],
};

/** Each dropped at 0, so each takes the leftmost gap and the run packs left. */
export function furnished(
	engine: PlannerEngine,
	roomId: RoomTypeId,
): PlannerLayout {
	let layout = emptyLayout(
		roomTypeIn(PLANNER_CATALOGUE, roomId).defaultWallWidthMm,
	);
	for (const item of RUNS[roomId]) {
		layout = engine.addModule(
			layout,
			item.familyId,
			0,
			undefined,
			item.widthMm,
		);
	}
	return layout;
}
