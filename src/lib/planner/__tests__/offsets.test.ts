import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import { emptyLayout, plannerEngine } from "../layout";

/**
 * Where a selected cabinet sits, as the numbers the callouts draw.
 *
 * The planner locks every cabinet to one wall, so its position is one figure
 * along that wall plus, for a hung unit, how high it is off the floor. These
 * are the gaps either side of it — to a neighbour if there is one, to the wall
 * if there is not.
 */

const engine = plannerEngine(PLANNER_CATALOGUE);

/** A layout with the given floor cabinets, placed exactly where asked. */
function withFloor(...at: { familyId: string; xMm: number }[]) {
	let layout = emptyLayout(4000);
	for (const { familyId, xMm } of at) {
		layout = engine.addModule(layout, familyId, xMm);
	}
	return layout;
}

const firstId = (layout: ReturnType<typeof withFloor>, row: "floor" | "wall") =>
	layout[row][0].id;

describe("offsetsOf", () => {
	it("measures both gaps to the walls when a cabinet stands alone", () => {
		const layout = withFloor({ familyId: "base-cabinet", xMm: 1000 });
		const id = firstId(layout, "floor");
		const width = layout.floor[0].widthMm;

		const offsets = engine.offsetsOf(layout, id);

		expect(offsets).not.toBeNull();
		expect(offsets?.leftMm).toBe(1000);
		expect(offsets?.rightMm).toBe(4000 - 1000 - width);
		expect(offsets?.leftAnchorMm).toBe(0);
		expect(offsets?.rightAnchorMm).toBe(4000);
	});

	it("measures to a neighbour's edge rather than past it to the wall", () => {
		const layout = withFloor(
			{ familyId: "base-cabinet", xMm: 0 },
			{ familyId: "base-cabinet", xMm: 1500 },
		);
		const [left, right] = [...layout.floor].sort((a, b) => a.xMm - b.xMm);

		const offsets = engine.offsetsOf(layout, right.id);

		expect(offsets?.leftAnchorMm).toBe(left.xMm + left.widthMm);
		expect(offsets?.leftMm).toBe(right.xMm - (left.xMm + left.widthMm));
	});

	it("reports zero on a side that is flush against a neighbour", () => {
		const layout = withFloor(
			{ familyId: "base-cabinet", xMm: 0 },
			{ familyId: "base-cabinet", xMm: 0 },
		);
		const [, right] = [...layout.floor].sort((a, b) => a.xMm - b.xMm);

		expect(engine.offsetsOf(layout, right.id)?.leftMm).toBe(0);
	});

	it("treats a tall unit in the floor row as a wall cabinet's neighbour", () => {
		let layout = emptyLayout(4000);
		layout = engine.addModule(layout, "tall-cabinet", 0);
		layout = engine.addModule(layout, "wall-cabinet", 2000);
		const tall = layout.floor[0];
		const hung = layout.wall[0];

		const offsets = engine.offsetsOf(layout, hung.id);

		expect(offsets?.leftAnchorMm).toBe(tall.xMm + tall.widthMm);
	});

	it("reports how high a wall cabinet hangs, and nothing for a floor one", () => {
		let layout = emptyLayout(4000);
		layout = engine.addModule(layout, "wall-cabinet", 0);
		layout = engine.addModule(layout, "base-cabinet", 2000);
		const hung = engine.offsetsOf(layout, layout.wall[0].id);
		const standing = engine.offsetsOf(layout, layout.floor[0].id);

		expect(hung?.floorMm).toBe(layout.hangingHeightMm);
		expect(standing?.floorMm).toBeNull();
	});

	it("is null for a cabinet that is not in the layout", () => {
		expect(engine.offsetsOf(emptyLayout(4000), "nope")).toBeNull();
	});
});

describe("setGap", () => {
	it("puts a lone cabinet the typed distance off the left wall", () => {
		const layout = withFloor({ familyId: "base-cabinet", xMm: 1000 });
		const id = firstId(layout, "floor");

		const moved = engine.setGap(layout, id, "left", 500);

		expect(engine.offsetsOf(moved, id)?.leftMm).toBe(500);
	});

	it("puts it the typed distance off the right wall", () => {
		const layout = withFloor({ familyId: "base-cabinet", xMm: 1000 });
		const id = firstId(layout, "floor");

		const moved = engine.setGap(layout, id, "right", 300);

		expect(engine.offsetsOf(moved, id)?.rightMm).toBe(300);
	});

	it("measures from the neighbour, the gap the dimension line shows", () => {
		const layout = withFloor(
			{ familyId: "base-cabinet", xMm: 0 },
			{ familyId: "base-cabinet", xMm: 1500 },
		);
		const [left, right] = [...layout.floor].sort((a, b) => a.xMm - b.xMm);

		const moved = engine.setGap(layout, right.id, "left", 200);
		const placed = moved.floor.find((p) => p.id === right.id);

		expect(engine.offsetsOf(moved, right.id)?.leftMm).toBe(200);
		expect(placed?.xMm).toBe(left.xMm + left.widthMm + 200);
	});

	it("stops flush against a neighbour rather than passing through it", () => {
		const layout = withFloor(
			{ familyId: "base-cabinet", xMm: 0 },
			{ familyId: "base-cabinet", xMm: 1500 },
		);
		const [, right] = [...layout.floor].sort((a, b) => a.xMm - b.xMm);

		const moved = engine.setGap(layout, right.id, "right", 99_999);

		expect(engine.offsetsOf(moved, right.id)?.leftMm).toBe(0);
	});

	it("never hops a cabinet over its neighbour onto clear wall beyond it", () => {
		// A mistyped 3500 for 350: the target lands clear of everything past the
		// far neighbour, which is exactly where `moveModule` alone lets it go.
		let layout = emptyLayout(8000);
		for (const xMm of [0, 1500, 3000]) {
			layout = engine.addModule(layout, "base-cabinet", xMm);
		}
		const [, middle, far] = [...layout.floor].sort((a, b) => a.xMm - b.xMm);

		const moved = engine.setGap(layout, middle.id, "left", 3500);
		const placed = moved.floor.find((p) => p.id === middle.id);

		expect(placed?.xMm).toBe(far.xMm - middle.widthMm);
		expect(engine.offsetsOf(moved, middle.id)?.rightMm).toBe(0);
	});

	it("ignores a figure that is not a distance", () => {
		const layout = withFloor({ familyId: "base-cabinet", xMm: 1000 });
		const id = firstId(layout, "floor");

		expect(engine.setGap(layout, id, "left", -5)).toBe(layout);
		expect(engine.setGap(layout, id, "left", Number.NaN)).toBe(layout);
	});
});
