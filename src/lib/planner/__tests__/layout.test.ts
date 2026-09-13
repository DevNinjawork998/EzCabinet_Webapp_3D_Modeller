import { beforeEach, describe, expect, it } from "vitest";
import {
	CEILING_LIMITS,
	CONSTRUCTION,
	familyIn,
	PLANNER_CATALOGUE,
	ROOM_DEPTH_LIMITS,
	WALL_HANG_LIMITS,
} from "../catalogue";
import {
	depthSpreadMm,
	emptyLayout,
	type PlannerLayout,
	plannerEngine,
	type Row,
	rowFor,
	SNAP_MM,
	setDoor,
	setDoors,
	setHinge,
	spreadMm,
	WALL_LIMITS,
} from "../layout";
import { standOf } from "../parts";
import { furnished as furnishedRun } from "./furnished";

/** The seed is the right catalogue for engine tests: they assert placement
 * rules, not a publish. Destructured so the assertions below read exactly as
 * they did when these were module functions. */
const engine = plannerEngine(PLANNER_CATALOGUE);
const {
	addModule,
	closeGaps,
	dragModule,
	dropModule,
	duplicateModule,
	endPanels,
	firstFreeXMm,
	fits,
	floorHeightMmOf,
	flushWallToTallTops,
	freeSpans,
	hangingHeightMmOf,
	hangTargets,
	minWallWidthMm,
	moveModule,
	occupiedSpans,
	overhangingIds,
	overhangMm,
	positionsOf,
	removeModule,
	removeModules,
	replaceFamily,
	runExtentMm,
	setBaseSkirting,
	setCeilingHeight,
	setHangAt,
	setHangingHeight,
	setRoomDepth,
	setRotation,
	setWallToCeiling,
	setWallToWall,
	setWallWidth,
	setWidth,
	skirtingSpans,
	swapWithNeighbour,
	widthOptionsFor,
} = engine;

const WALL_MM = 4000;

let layout: PlannerLayout;
beforeEach(() => {
	layout = emptyLayout(WALL_MM);
});

const xs = (l: PlannerLayout, row: Row) =>
	positionsOf(l, row).map((position) => position.xMm);

const at = (l: PlannerLayout, id: string) => {
	const all = [...l.floor, ...l.wall].find((placed) => placed.id === id);
	if (!all) throw new Error(`no module ${id}`);
	return all.xMm;
};

/**
 * The invariant the whole engine exists to protect.
 *
 * A nanometre of tolerance on the flush case. Since cabinets can be turned,
 * an edge is `|w·cosθ| + |d·sinθ|` rather than an integer, and one settled
 * flush against its neighbour lands on the boundary by construction — where
 * the two figures disagree in the thirteenth decimal place. A millionth of a
 * millimetre is far below anything this engine means and far above float dust.
 */
const FLUSH_TOLERANCE_MM = 1e-6;

function expectNoOverlaps(l: PlannerLayout) {
	for (const row of ["floor", "wall"] as const) {
		const spans = occupiedSpans(l, row);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].startMm).toBeGreaterThanOrEqual(
				spans[i - 1].endMm - FLUSH_TOLERANCE_MM,
			);
		}
		// Footprints, not `xMm`. `xMm` is the *unrotated* left edge, and a turned
		// cabinet's footprint is centred on the same middle — so a 900-wide,
		// 397-deep wall cabinet turned square occupies less wall than it is wide
		// and its stored x legitimately lands outside its own footprint, negative
		// when it is packed against the left wall. What has to stay on the wall
		// is the box you can see.
		for (const position of positionsOf(l, row)) {
			const spread = spreadMm(position);
			expect(position.xMm - spread).toBeGreaterThanOrEqual(-FLUSH_TOLERANCE_MM);
			expect(position.xMm + position.widthMm + spread).toBeLessThanOrEqual(
				l.wallWidthMm + FLUSH_TOLERANCE_MM,
			);
		}
	}
}

describe("placing a cabinet", () => {
	it("puts it where it was dropped", () => {
		const next = addModule(layout, "base-cabinet", 1500, "a", 900);
		expect(at(next, "a")).toBe(1500);
		expectNoOverlaps(next);
	});

	it("keeps a gap the customer left on purpose", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 2000, "b", 600);
		// Nothing slides back to close the space between them.
		expect(xs(next, "floor")).toEqual([0, 2000]);
	});

	it("slides to the nearest free space when dropped on an occupant", () => {
		// A 900 sits across 1000–1900, so a 600 dropped on it has to go either
		// side. It goes to whichever side the pointer was nearest.
		const occupied = addModule(layout, "base-cabinet", 1000, "a", 900);

		const right = addModule(occupied, "base-cabinet", 1800, "b", 600);
		expect(at(right, "b")).toBe(1900);
		expectNoOverlaps(right);

		const left = addModule(occupied, "base-cabinet", 1050, "c", 600);
		expect(at(left, "c")).toBe(400);
		expectNoOverlaps(left);
	});

	it("refuses only when the wall is genuinely full", () => {
		let small = emptyLayout(1000);
		small = addModule(small, "base-cabinet", 0, "a", 900);
		expect(fits(small, "base-cabinet", 600)).toBe(false);
		expect(addModule(small, "base-cabinet", 0, undefined, 600)).toBe(small);
		// A 400 does not fit the 100mm left either.
		expect(firstFreeXMm(small, "floor", 400)).toBeNull();
	});

	it("keeps the two rows independent", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "wall-cabinet", 2000, "b", 400);
		expect(xs(next, "floor")).toEqual([0]);
		expect(xs(next, "wall")).toEqual([2000]);
	});
});

describe("the bug this fixes: a wall cabinet in the gap over the base run", () => {
	/**
	 * The layout from the client demo: a tall unit in the run, base cabinets
	 * beside it, and a stretch of wall above the base run with nothing on it.
	 * The old engine derived wall positions by packing, so a wall cabinet could
	 * not be put in that stretch — it was pushed past the tall unit instead.
	 */
	const demoRun = () => {
		let next = emptyLayout(WALL_MM);
		next = addModule(next, "base-cabinet", 0, "base1", 900);
		next = addModule(next, "base-cabinet", 900, "base2", 900);
		next = addModule(next, "tall-cabinet", 1800, "tall", 600);
		next = addModule(next, "wall-cabinet", 2400, "hung", 900);
		return next;
	};

	it("drops a wall cabinet into the gap and leaves it there", () => {
		const next = addModule(demoRun(), "wall-cabinet", 600, "infill", 800);
		expect(at(next, "infill")).toBe(600);
		expectNoOverlaps(next);
	});

	it("lets that cabinet be dragged along the gap afterwards", () => {
		let next = addModule(demoRun(), "wall-cabinet", 600, "infill", 800);
		next = moveModule(next, "infill", 200);
		expect(at(next, "infill")).toBe(200);
		next = moveModule(next, "infill", 900);
		expect(at(next, "infill")).toBe(900);
		expectNoOverlaps(next);
	});

	it("stops it at the tall unit rather than hanging it in front", () => {
		let next = addModule(demoRun(), "wall-cabinet", 600, "infill", 800);
		next = moveModule(next, "infill", 1700);
		// The tall unit owns 1800–2400, so an 800 wall cabinet stops at 1000.
		expect(at(next, "infill")).toBe(1000);
		expectNoOverlaps(next);
	});
});

describe("dragging into a neighbour", () => {
	const pair = () => {
		let next = emptyLayout(WALL_MM);
		next = addModule(next, "base-cabinet", 0, "left", 900);
		next = addModule(next, "base-cabinet", 2000, "right", 900);
		return next;
	};

	it("butts up against it and stops", () => {
		const next = moveModule(pair(), "left", 1800);
		expect(at(next, "left")).toBe(1100);
		expectNoOverlaps(next);
	});

	it("never overlaps, wherever the pointer goes", () => {
		let next = pair();
		for (let x = -500; x <= WALL_MM + 500; x += 37) {
			next = moveModule(next, "left", x);
			expectNoOverlaps(next);
		}
	});

	it("moves again the instant the drag reverses", () => {
		let next = moveModule(pair(), "left", 1800);
		expect(at(next, "left")).toBe(1100);
		next = moveModule(next, "left", 1000);
		expect(at(next, "left")).toBe(1000);
	});

	it("stays on the wall at both ends", () => {
		let next = moveModule(pair(), "left", -900);
		expect(at(next, "left")).toBe(0);
		next = moveModule(next, "right", 99999);
		expect(at(next, "right")).toBe(WALL_MM - 900);
	});
});

describe("snapping on release", () => {
	const withNeighbour = () =>
		addModule(emptyLayout(WALL_MM), "base-cabinet", 0, "a", 900);

	it("lands flush against a neighbour when released close to it", () => {
		let next = addModule(withNeighbour(), "base-cabinet", 2000, "b", 600);
		next = dropModule(next, "b", 900 + SNAP_MM - 10);
		expect(at(next, "b")).toBe(900);
	});

	it("leaves a deliberate gap alone", () => {
		let next = addModule(withNeighbour(), "base-cabinet", 2000, "b", 600);
		const far = 900 + SNAP_MM + 100;
		next = dropModule(next, "b", far);
		expect(at(next, "b")).toBe(far);
	});

	it("lands flush on the end of the wall", () => {
		let next = addModule(emptyLayout(WALL_MM), "base-cabinet", 2000, "b", 600);
		next = dropModule(next, "b", WALL_MM - 600 - 20);
		expect(at(next, "b")).toBe(WALL_MM - 600);
	});

	it("lines a wall unit up with the base cabinet below it", () => {
		let next = addModule(
			emptyLayout(WALL_MM),
			"base-cabinet",
			900,
			"base",
			900,
		);
		next = addModule(next, "wall-cabinet", 2500, "hung", 800);
		// Released a few centimetres off the base cabinet's left edge.
		next = dropModule(next, "hung", 900 + 25);
		expect(at(next, "hung")).toBe(900);
		expectNoOverlaps(next);
	});
});

describe("tall units", () => {
	it("block the hung row across their own span only", () => {
		let next = addModule(layout, "base-cabinet", 0, "base", 900);
		next = addModule(next, "tall-cabinet", 900, "tall", 600);

		const spans = occupiedSpans(next, "wall");
		expect(spans).toEqual([{ startMm: 900, endMm: 1500 }]);
		// A wall cabinet fits either side of it.
		expect(firstFreeXMm(next, "wall", 800)).toBe(0);
	});

	it("push wall cabinets clear when dropped underneath them", () => {
		let next = addModule(layout, "wall-cabinet", 0, "hung", 900);
		next = addModule(next, "tall-cabinet", 300, "tall", 600);

		expectNoOverlaps(next);
		// The wall unit moved out of the tall unit's span rather than vanishing.
		expect(next.wall).toHaveLength(1);
		expect(at(next, "hung")).toBeGreaterThanOrEqual(900);
	});

	/**
	 * The other direction. A tall unit blocking the hung row was already true;
	 * the hung row blocking a tall unit was not, so a tall unit placed clear
	 * could then be dragged or widened straight through the wall cabinet
	 * beside it — one cabinet merged into the next.
	 */
	it("stop against a wall cabinet when dragged under it", () => {
		let next = addModule(layout, "wall-cabinet", 0, "hung", 900);
		next = addModule(next, "tall-cabinet", 2000, "tall", 600);

		next = dropModule(next, "tall", 0);
		expect(at(next, "tall")).toBe(900);
		expectNoOverlaps(next);
	});

	it("stop against a wall cabinet mid-drag, not only on release", () => {
		let next = addModule(layout, "wall-cabinet", 0, "hung", 900);
		next = addModule(next, "tall-cabinet", 2000, "tall", 600);

		next = moveModule(next, "tall", 400);
		expect(at(next, "tall")).toBe(900);
		expectNoOverlaps(next);
	});

	it("cannot be widened into a wall cabinet", () => {
		let next = addModule(layout, "tall-cabinet", 0, "tall", 600);
		next = addModule(next, "wall-cabinet", 600, "hung", 900);

		const wider = familyIn(PLANNER_CATALOGUE, "tall-cabinet")?.sizes.find(
			(size) => size.widthMm > 600,
		)?.widthMm;
		if (wider === undefined) throw new Error("tall ladder has no wider rung");

		expect(
			widthOptionsFor(next, "tall").find((option) => option.widthMm === wider)
				?.fits,
		).toBe(false);
		expect(setWidth(next, "tall", wider)).toBe(next);
		expectNoOverlaps(next);
	});

	it("still resizes freely with the hung row out of its way", () => {
		let next = addModule(layout, "tall-cabinet", 0, "tall", 600);
		next = addModule(next, "wall-cabinet", 2000, "hung", 900);

		const wider = familyIn(PLANNER_CATALOGUE, "tall-cabinet")?.sizes.find(
			(size) => size.widthMm > 600,
		)?.widthMm;
		if (wider === undefined) throw new Error("tall ladder has no wider rung");

		expect(at(setWidth(next, "tall", wider), "tall")).toBe(0);
		expect(setWidth(next, "tall", wider).floor[0].widthMm).toBe(wider);
	});

	it("leave a base cabinet free to sit under a wall cabinet", () => {
		let next = addModule(layout, "wall-cabinet", 0, "hung", 900);
		next = addModule(next, "base-cabinet", 2000, "base", 600);

		// The block is a property of tall units, not of the floor row.
		next = dropModule(next, "base", 0);
		expect(at(next, "base")).toBe(0);
	});
});

describe("freeSpans", () => {
	it("reports the clear stretches in order", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 2000, "b", 900);
		expect(freeSpans(next, "floor")).toEqual([
			{ startMm: 900, endMm: 2000 },
			{ startMm: 2900, endMm: WALL_MM },
		]);
	});
});

describe("closeGaps", () => {
	it("packs both rows left and keeps the order", () => {
		let next = addModule(layout, "base-cabinet", 1500, "a", 900);
		next = addModule(next, "base-cabinet", 3000, "b", 600);
		next = addModule(next, "wall-cabinet", 2200, "c", 800);

		const packed = closeGaps(next);
		expect(xs(packed, "floor")).toEqual([0, 900]);
		expect(at(packed, "a")).toBe(0);
		expect(at(packed, "b")).toBe(900);
		expect(at(packed, "c")).toBe(0);
		expectNoOverlaps(packed);
	});

	it("steps the hung row over a tall unit", () => {
		let next = addModule(layout, "base-cabinet", 0, "base", 900);
		next = addModule(next, "tall-cabinet", 900, "tall", 600);
		next = addModule(next, "wall-cabinet", 2500, "hung", 800);

		const packed = closeGaps(next);
		// Base at 0–900, tall at 900–1500: an 800 wall unit fits at 0.
		expect(at(packed, "hung")).toBe(0);
		expectNoOverlaps(packed);
	});
});

describe("removeModules", () => {
	const three = () => {
		let next = addModule(emptyLayout(WALL_MM), "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 900, "b", 600);
		next = addModule(next, "wall-cabinet", 1500, "c", 400);
		return next;
	};

	it("takes out several at once, across both rows", () => {
		const gone = removeModules(three(), ["a", "c"]);
		expect(gone.floor.map((placed) => placed.id)).toEqual(["b"]);
		expect(gone.wall).toEqual([]);
	});

	it("leaves the survivors exactly where they were", () => {
		const gone = removeModules(three(), ["a"]);
		expect(at(gone, "b")).toBe(900);
		expect(at(gone, "c")).toBe(1500);
	});

	it("ignores ids that are not there, and does nothing for none", () => {
		const before = three();
		expect(removeModules(before, [])).toBe(before);
		expect(removeModules(before, ["nope"]).floor).toHaveLength(2);
	});
});

describe("removeModule", () => {
	it("takes one out and leaves the others where they are", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 900, "b", 600);
		next = addModule(next, "base-cabinet", 1500, "c", 400);

		const gone = removeModule(next, "b");
		expect(at(gone, "a")).toBe(0);
		expect(at(gone, "c")).toBe(1500);
	});
});

describe("dragModule", () => {
	it("slides a floor cabinet along the wall", () => {
		const placed = addModule(layout, "base-cabinet", 0, "a", 600);
		const next = dragModule(placed, "a", { xMm: 900 });
		expect(at(next, "a")).toBe(900);
	});

	it("moves a wall cabinet on both axes at once", () => {
		const placed = addModule(layout, "wall-cabinet", 0, "w", 600);
		const next = dragModule(placed, "w", { xMm: 800, hangAtMm: 1650 });
		expect(at(next, "w")).toBe(800);
		expect(next.wall.find((m) => m.id === "w")?.hangAtMm).toBe(1650);
	});

	it("lifts a floor cabinet off the floor as readily as it slides it", () => {
		const placed = addModule(layout, "base-cabinet", 0, "a", 600);
		const next = dragModule(placed, "a", { xMm: 300, hangAtMm: 400 });
		expect(at(next, "a")).toBe(300);
		expect(next.floor.find((m) => m.id === "a")?.hangAtMm).toBe(400);
	});

	it("clamps the hang height to the slider's own range", () => {
		const placed = addModule(layout, "wall-cabinet", 0, "w", 600);
		const low = dragModule(placed, "w", { xMm: 0, hangAtMm: 100 });
		const high = dragModule(placed, "w", { xMm: 0, hangAtMm: 9000 });
		// The literals, not WALL_HANG_LIMITS: asserting the constant `setHangAt`
		// clamps with restates the implementation and would follow it anywhere.
		expect(low.wall.find((m) => m.id === "w")?.hangAtMm).toBe(1200);
		expect(high.wall.find((m) => m.id === "w")?.hangAtMm).toBe(1800);
	});

	it("clamps both axes in the one call", () => {
		let placed = addModule(layout, "wall-cabinet", 0, "w", 600);
		placed = addModule(placed, "wall-cabinet", 600, "n", 600);
		const next = dragModule(placed, "w", { xMm: 500, hangAtMm: 9000 });
		expect(at(next, "w")).toBe(0);
		expect(next.wall.find((m) => m.id === "w")?.hangAtMm).toBe(1800);
		expectNoOverlaps(next);
	});

	it("leaves the hang height alone in ceiling mode, which aligns the tops", () => {
		const hung = addModule(layout, "wall-cabinet", 0, "w", 600);
		const ceiling = setWallToCeiling(hung, true);
		const next = dragModule(ceiling, "w", { xMm: 600, hangAtMm: 1700 });
		expect(at(next, "w")).toBe(600);
		expect(next.wall.find((m) => m.id === "w")?.hangAtMm).toBeUndefined();
	});

	it("stops against a neighbour rather than overlapping it", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 600);
		placed = addModule(placed, "base-cabinet", 600, "b", 600);
		const next = dragModule(placed, "a", { xMm: 500 });
		// Clamped flush against "b" at 600, not sitting inside it.
		expect(at(next, "a")).toBe(0);
		expectNoOverlaps(next);
	});

	// The wall row is where the new axis lives, and its neighbour set is not
	// the floor row's — a tall unit occupies both.
	it("stops against a neighbour on the wall row too", () => {
		let placed = addModule(layout, "wall-cabinet", 0, "w", 600);
		placed = addModule(placed, "tall-cabinet", 600, "t", 600);
		const next = dragModule(placed, "w", { xMm: 500, hangAtMm: 1500 });
		expect(at(next, "w")).toBe(0);
		expectNoOverlaps(next);
	});

	it("leaves an unknown id alone", () => {
		const placed = addModule(layout, "base-cabinet", 0, "a", 600);
		expect(dragModule(placed, "nope", { xMm: 900 })).toBe(placed);
	});
});

describe("duplicateModule", () => {
	it("copies family, size and door, and leaves the original where it was", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = setDoor(next, "a", "shaker");
		next = setHinge(next, "a", "right");

		const dup = duplicateModule(next, "a", "a2");
		expect(at(dup, "a")).toBe(0);
		const copy = positionsOf(dup, "floor").find((p) => p.placed.id === "a2");
		expect(copy?.family.id).toBe("base-cabinet");
		expect(copy?.widthMm).toBe(900);
		expect(copy?.placed.doorStyleId).toBe("shaker");
		expect(copy?.placed.hinge).toBe("right");
		expect(copy?.xMm).toBeGreaterThanOrEqual(900);
	});

	it("does nothing when there is no room for a second one", () => {
		const tight = addModule(emptyLayout(900), "base-cabinet", 0, "a", 900);
		expect(duplicateModule(tight, "a", "a2")).toBe(tight);
	});

	it("does nothing for an id that is not placed", () => {
		expect(duplicateModule(layout, "missing", "x")).toBe(layout);
	});
});

describe("wall length", () => {
	it("takes any measured length inside the limits", () => {
		expect(setWallWidth(layout, 3750).wallWidthMm).toBe(3750);
		expect(setWallWidth(layout, 5280).wallWidthMm).toBe(5280);
	});

	it("clamps a mistyped figure rather than making an unusable room", () => {
		expect(setWallWidth(layout, 10).wallWidthMm).toBe(WALL_LIMITS.minMm);
		expect(setWallWidth(layout, 999999).wallWidthMm).toBe(WALL_LIMITS.maxMm);
	});

	it("will not shrink below the run, and leaves the cabinets alone", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 900, "b", 900);

		// 1500 would leave 300mm of cabinet hanging past the end of the wall,
		// over no floor. The wall stops at the run instead.
		const shorter = setWallWidth(next, 1500);
		expect(shorter.wallWidthMm).toBe(1800);
		expect(shorter.floor).toHaveLength(2);
		expect(at(shorter, "b")).toBe(900);
		expect(overhangMm(shorter)).toBe(0);
	});

	it("goes down to exactly the run, which is the point of the limit", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 900, "b", 900);
		expect(minWallWidthMm(next)).toBe(1800);
		expect(setWallWidth(next, 1800).wallWidthMm).toBe(1800);
	});

	it("takes the longer of the two rows as the limit", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "wall-cabinet", 0, "w1", 900);
		next = addModule(next, "wall-cabinet", 900, "w2", 900);
		// The hung row is the longer one here, so it decides.
		expect(runExtentMm(next)).toBe(1800);
		expect(minWallWidthMm(next)).toBe(1800);
	});

	it("falls back to the catalogue minimum in an empty room", () => {
		expect(minWallWidthMm(layout)).toBe(WALL_LIMITS.minMm);
	});

	it("returns the same layout when the clamp lands on what it already was", () => {
		const next = addModule(layout, "base-cabinet", 0, "a", 900);
		const atRun = setWallWidth(next, 900);
		expect(setWallWidth(atRun, 100)).toBe(atRun);
	});

	it("closing the gaps still shortens a run, freeing the wall to follow", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = addModule(next, "base-cabinet", 2000, "b", 600);
		expect(minWallWidthMm(next)).toBe(2600);

		// `closeGaps` is no longer the way back from an overhang — there is no
		// overhang to come back from — but packing the run left is still what
		// lets the customer then pull the wall in.
		const packed = closeGaps(next);
		expect(minWallWidthMm(packed)).toBe(1500);
		expect(setWallWidth(packed, 1500).wallWidthMm).toBe(1500);
	});
});

describe("overhangingIds", () => {
	it("finds nothing in a layout built through the setters", () => {
		let next = addModule(layout, "base-cabinet", 0, "a", 900);
		next = setWallWidth(next, 1000);
		expect(overhangingIds(next).size).toBe(0);
	});

	it("catches a module past the wall that no setter vetted", () => {
		// The shape a share link could deliver once layouts are parsed from JSON.
		const next = addModule(layout, "base-cabinet", 0, "a", 900);
		const tampered: PlannerLayout = { ...next, wallWidthMm: 600 };

		expect(overhangMm(tampered)).toBe(300);
		expect([...overhangingIds(tampered)]).toEqual(["a"]);
	});
});

describe("ceiling height", () => {
	it("starts at a real default and can be changed", () => {
		expect(layout.ceilingHeightMm).toBe(2700);
		expect(setCeilingHeight(layout, 3000).ceilingHeightMm).toBe(3000);
	});

	it("clamps a mistyped figure rather than making an unusable room", () => {
		expect(setCeilingHeight(layout, 10).ceilingHeightMm).toBe(
			CEILING_LIMITS.minMm,
		);
		expect(setCeilingHeight(layout, 999999).ceilingHeightMm).toBe(
			CEILING_LIMITS.maxMm,
		);
	});

	it("leaves the run alone — a lower ceiling never moves a cabinet", () => {
		const furnished = furnishedRun(engine, "kitchen");
		const lower = setCeilingHeight(furnished, 2400);
		expect(lower.floor).toEqual(furnished.floor);
		expect(lower.wall).toEqual(furnished.wall);
		expect(lower.roomDepthMm).toBe(furnished.roomDepthMm);
	});
});

describe("room depth", () => {
	it("starts at a real default and can be changed", () => {
		expect(layout.roomDepthMm).toBe(3600);
		expect(setRoomDepth(layout, 2800).roomDepthMm).toBe(2800);
	});

	it("clamps a mistyped figure rather than making an unusable room", () => {
		expect(setRoomDepth(layout, 10).roomDepthMm).toBe(ROOM_DEPTH_LIMITS.minMm);
		expect(setRoomDepth(layout, 999999).roomDepthMm).toBe(
			ROOM_DEPTH_LIMITS.maxMm,
		);
	});

	it("is independent of wall width — resizing one leaves the other alone", () => {
		const wider = setWallWidth(layout, 6000);
		expect(wider.roomDepthMm).toBe(layout.roomDepthMm);
		const deeper = setRoomDepth(layout, 5000);
		expect(deeper.wallWidthMm).toBe(layout.wallWidthMm);
	});
});

describe("hanging height", () => {
	it("starts at the height the client hangs them and can be changed", () => {
		expect(layout.hangingHeightMm).toBe(1500);
		expect(setHangingHeight(layout, 1400).hangingHeightMm).toBe(1400);
	});
});

describe("flushWallToTallTops", () => {
	const withTallAndWall = (hangingHeightMm: number) => {
		let next = addModule(layout, "tall-cabinet", 0, "t", 600);
		next = addModule(next, "wall-cabinet", 0, "w", 900);
		return setHangingHeight(next, hangingHeightMm);
	};

	it("moves the hang height so the wall cabinet's top meets the tall unit's top", () => {
		// tall-cabinet is 2380mm; wall-cabinet is 880mm — flush is 1500mm,
		// which happens to be the catalogue default.
		const off = withTallAndWall(1700);
		expect(off.hangingHeightMm).toBe(1700);
		expect(flushWallToTallTops(off).hangingHeightMm).toBe(1500);
	});

	it("does nothing without a tall unit to line up against", () => {
		const wallOnly = addModule(layout, "wall-cabinet", 0, "w", 900);
		expect(flushWallToTallTops(wallOnly)).toBe(wallOnly);
	});

	it("does nothing without a wall cabinet to move", () => {
		const tallOnly = addModule(layout, "tall-cabinet", 0, "t", 600);
		expect(flushWallToTallTops(tallOnly)).toBe(tallOnly);
	});
});

describe("wallToCeiling", () => {
	// wall-cabinet is 880mm and the capping strip is 40mm, so against the
	// default 2700 ceiling the underside lands at 2700 - 40 - 880 = 1780.
	const FLUSH_AT_2700 = 1780;

	const withWall = () => addModule(layout, "wall-cabinet", 0, "w", 900);

	it("is off on a fresh layout — the run hangs until asked otherwise", () => {
		expect(layout.wallToCeiling).toBe(false);
		expect(hangingHeightMmOf(withWall())).toBe(1500);
	});

	it("lifts the run so the cabinet tops sit a trim strip below the ceiling", () => {
		const flushed = setWallToCeiling(withWall(), true);
		expect(hangingHeightMmOf(flushed)).toBe(FLUSH_AT_2700);
		expect(hangingHeightMmOf(flushed) + 880 + 40).toBe(flushed.ceilingHeightMm);
	});

	it("tracks a re-measured ceiling, because the height is derived not stored", () => {
		const flushed = setWallToCeiling(withWall(), true);
		// 3000 - 40 - 880. No second call: raising the ceiling is the only edit.
		expect(hangingHeightMmOf(setCeilingHeight(flushed, 3000))).toBe(2080);
	});

	it("goes above the hang slider's range, which only governs the slider", () => {
		// The tall rooms are the ones that need this: 3200 - 40 - 880 = 2280,
		// 480mm past where the slider stops. Clamping here would leave the gap
		// open in exactly the rooms the feature exists for.
		const tall = setCeilingHeight(setWallToCeiling(withWall(), true), 3200);
		expect(hangingHeightMmOf(tall)).toBe(2280);
		expect(hangingHeightMmOf(tall)).toBeGreaterThan(WALL_HANG_LIMITS.maxMm);
	});

	it("keeps the customer's own hang height across the round trip", () => {
		const set = setHangingHeight(withWall(), 1300);
		const flushed = setWallToCeiling(set, true);
		expect(flushed.hangingHeightMm).toBe(1300);
		expect(hangingHeightMmOf(setWallToCeiling(flushed, false))).toBe(1300);
	});

	it("leaves the stored figure showing when nothing is hung yet", () => {
		expect(hangingHeightMmOf(setWallToCeiling(layout, true))).toBe(1500);
	});

	it("moves no cabinet sideways — this is a vertical change only", () => {
		const furnished = furnishedRun(engine, "kitchen");
		const flushed = setWallToCeiling(furnished, true);
		expect(flushed.floor).toEqual(furnished.floor);
		expect(flushed.wall).toEqual(furnished.wall);
	});

	it("returns the same layout when the mode is already what was asked for", () => {
		expect(setWallToCeiling(layout, false)).toBe(layout);
	});
});

describe("floorHeightMmOf", () => {
	it("reads a floor unit's own height and the layout's for a wall unit", () => {
		let next = addModule(layout, "base-cabinet", 0, "b", 800);
		next = addModule(next, "wall-cabinet", 0, "w", 900);
		const [base] = positionsOf(next, "floor");
		const [wall] = positionsOf(next, "wall");

		expect(floorHeightMmOf(base, next)).toBe(0);
		expect(floorHeightMmOf(wall, next)).toBe(1500);
	});

	it("is the single place ceiling mode reaches, so every reader agrees", () => {
		const flushed = setWallToCeiling(
			addModule(layout, "wall-cabinet", 0, "w", 900),
			true,
		);
		const [wall] = positionsOf(flushed, "wall");
		expect(floorHeightMmOf(wall, flushed)).toBe(hangingHeightMmOf(flushed));
		expect(floorHeightMmOf(wall, flushed)).toBe(1780);
	});
});

describe("skirtingSpans", () => {
	it("gives one board across cabinets that touch", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "base-drawers", 900, "b2", 400);
		const spans = skirtingSpans(next);

		expect(spans).toHaveLength(1);
		expect(spans[0].startMm).toBe(0);
		expect(spans[0].endMm).toBe(1300);
	});

	it("breaks at a gap, so the run is not charged across a hole", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "base-cabinet", 1500, "b2", 900);
		const spans = skirtingSpans(next);

		expect(spans).toHaveLength(2);
		expect(spans.map((span) => span.endMm - span.startMm)).toEqual([900, 900]);
	});

	it("runs no board under a cabinet lifted off the floor, and does not span it", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "base-cabinet", 900, "b2", 900);
		next = addModule(next, "base-cabinet", 1800, "b3", 900);
		expect(skirtingSpans(next)).toHaveLength(1);

		const lifted = setHangAt(next, "b2", 400);
		const spans = skirtingSpans(lifted);

		expect(spans).toHaveLength(2);
		expect(spans.map((span) => span.startMm)).toEqual([0, 1800]);
	});

	it("runs no board under a cabinet turned off the wall", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "base-cabinet", 900, "b2", 900);
		const spans = skirtingSpans(setRotation(next, "b2", 90));

		expect(spans).toHaveLength(1);
		expect(spans[0].endMm).toBe(900);
	});

	it("takes the tallest stand in the stretch, so no leg is left showing", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "tall-cabinet", 900, "t1", 600);
		const [span] = skirtingSpans(next);
		const stands = positionsOf(next, "floor").map(
			(position) => standOf(position.family).heightMm,
		);

		expect(span.heightMm).toBe(Math.max(...stands));
	});

	it("sets the board no further back than the frontmost foot", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "tall-cabinet", 900, "t1", 600);
		const [span] = skirtingSpans(next);
		const insets = positionsOf(next, "floor").map(
			(position) => standOf(position.family).insetMm,
		);

		// The shallowest inset wins. Anything deeper and the feet it exists to
		// hide are still in front of it — the bug the first version shipped with.
		expect(span.recessMm).toBe(Math.min(...insets));
		expect(span.recessMm).toBeLessThanOrEqual(Math.max(...insets));
	});

	it("reaches out to the deepest carcass it covers", () => {
		let next = addModule(layout, "base-cabinet", 0, "b1", 900);
		next = addModule(next, "tall-cabinet", 900, "t1", 600);
		const [span] = skirtingSpans(next);
		const depths = positionsOf(next, "floor").map((p) => p.family.depthMm);

		expect(span.depthMm).toBe(Math.max(...depths));
	});

	it("is on by default — a finished kitchen hides its legs", () => {
		expect(layout.baseSkirting).toBe(true);
	});

	it("draws and charges nothing once the customer turns the board off", () => {
		const run = addModule(layout, "base-cabinet", 0, "b1", 900);
		expect(skirtingSpans(run)).not.toEqual([]);
		expect(skirtingSpans(setBaseSkirting(run, false))).toEqual([]);
	});

	it("moves no cabinet when the board is turned off", () => {
		const run = addModule(layout, "base-cabinet", 0, "b1", 900);
		const bare = setBaseSkirting(run, false);
		expect(bare.floor).toEqual(run.floor);
		expect(bare.wall).toEqual(run.wall);
	});

	it("returns the same layout when the board is already as asked", () => {
		expect(setBaseSkirting(layout, true)).toBe(layout);
	});

	it("has nothing to cover in a room with only wall units", () => {
		expect(
			skirtingSpans(addModule(layout, "wall-cabinet", 0, "w", 900)),
		).toEqual([]);
	});

	it("ignores the hung row entirely — a kick board is a floor thing", () => {
		const floorOnly = addModule(layout, "base-cabinet", 0, "b1", 900);
		const both = addModule(floorOnly, "wall-cabinet", 0, "w", 900);
		expect(skirtingSpans(both)).toEqual(skirtingSpans(floorOnly));
	});
});

describe("endPanels", () => {
	it("clads both sides of a cabinet standing on its own", () => {
		const lone = addModule(layout, "base-cabinet", 1000, "b1", 900);
		expect(endPanels(lone).map((p) => p.side)).toEqual(["left", "right"]);
	});

	it("clads only the outer sides of a touching pair, not the join", () => {
		let pair = addModule(layout, "base-cabinet", 0, "b1", 900);
		pair = addModule(pair, "base-cabinet", 900, "b2", 900);
		// Two, not four: the sides that meet are buried against each other.
		expect(endPanels(pair)).toHaveLength(2);
	});

	it("clads the sides facing a gap opened mid-run", () => {
		let apart = addModule(layout, "base-cabinet", 0, "b1", 900);
		apart = addModule(apart, "base-cabinet", 1500, "b2", 900);
		// Four now — a drilled side beside a gap is as visible as one at the end.
		expect(endPanels(apart)).toHaveLength(4);
	});

	it("drops the two wall ends once the run is enclosed", () => {
		let run = addModule(
			setWallWidth(layout, 1800),
			"base-cabinet",
			0,
			"b1",
			900,
		);
		run = addModule(run, "base-cabinet", 900, "b2", 900);
		expect(endPanels(run)).toHaveLength(2);
		expect(endPanels(setWallToWall(run, true))).toEqual([]);
	});

	it("counts the two rows separately — a wall unit hides no base unit", () => {
		let both = addModule(layout, "base-cabinet", 0, "b1", 900);
		both = addModule(both, "wall-cabinet", 0, "w1", 900);
		const panels = endPanels(both);

		expect(panels.filter((p) => p.row === "floor")).toHaveLength(2);
		expect(panels.filter((p) => p.row === "wall")).toHaveLength(2);
	});

	it("records what each panel clads, so it can be priced by kind", () => {
		const tall = addModule(layout, "tall-cabinet", 1000, "t1", 600);
		expect(endPanels(tall).every((p) => p.kind === "tall")).toBe(true);
	});

	const sidesOf = (l: PlannerLayout, id: string) =>
		endPanels(l)
			.filter((p) => p.moduleId === id)
			.map((p) => p.side);

	// A tall unit lives in the floor row but stands as high as the wall row, so
	// the rows cannot be judged apart: the wall unit's side is buried in it.
	it("clads no wall-unit side hung flush against a tall unit", () => {
		let run = addModule(layout, "tall-cabinet", 0, "t1", 600);
		run = addModule(run, "wall-cabinet", 600, "w1", 600);

		expect(sidesOf(run, "w1")).toEqual(["right"]);
		expect(sidesOf(run, "t1")).toEqual(["left"]);
	});

	// EzCabinet's rule (2026-09-13): the strip of a tall side still
	// showing above a base beside it is not clad.
	it("clads neither touching side of a tall unit and a base", () => {
		let run = addModule(layout, "tall-cabinet", 0, "t1", 600);
		run = addModule(run, "base-cabinet", 600, "b1", 900);

		expect(sidesOf(run, "t1")).toEqual(["left"]);
		expect(sidesOf(run, "b1")).toEqual(["right"]);
	});

	it("clads both facing sides once a base is lifted clear of its neighbour", () => {
		let run = addModule(layout, "base-cabinet", 0, "b1", 900);
		run = addModule(run, "base-cabinet", 900, "b2", 900);
		expect(endPanels(run)).toHaveLength(2);

		const lifted = setHangAt(run, "b2", 1200);
		expect(lifted.floor.find((p) => p.id === "b2")?.hangAtMm).toBe(1200);
		expect(endPanels(lifted)).toHaveLength(4);
	});

	it("treats a gap narrower than one board as touching", () => {
		let run = addModule(layout, "base-cabinet", 0, "b1", 900);
		run = addModule(run, "base-cabinet", 2000, "b2", 900);

		expect(endPanels(moveModule(run, "b2", 910))).toHaveLength(2);
		expect(endPanels(moveModule(run, "b2", 920))).toHaveLength(4);
	});
});

describe("sizing a placed cabinet", () => {
	const roomy = () =>
		addModule(emptyLayout(WALL_MM), "base-cabinet", 0, "a", 400);

	it("grows to the right, keeping the left edge where it was", () => {
		const next = setWidth(roomy(), "a", 900);
		expect(at(next, "a")).toBe(0);
		expect(next.floor[0].widthMm).toBe(900);
		expectNoOverlaps(next);
	});

	it("refuses a size the neighbour leaves no room for", () => {
		let next = roomy();
		next = addModule(next, "base-cabinet", 600, "b", 600);
		// a is 0–400 with b at 600: 900 would run straight through it.
		expect(setWidth(next, "a", 900)).toBe(next);
		// 600 exactly meets b, which is allowed.
		expect(setWidth(next, "a", 600).floor[0].widthMm).toBe(600);
	});

	it("refuses a size that would hang off the end of the wall", () => {
		let small = emptyLayout(1000);
		small = addModule(small, "base-cabinet", 400, "a", 400);
		expect(setWidth(small, "a", 900)).toBe(small);
	});

	it("flags which sizes fit, for the dropdown", () => {
		let next = roomy();
		next = addModule(next, "base-cabinet", 600, "b", 600);

		const options = widthOptionsFor(next, "a");
		const fitsAt = (mm: number) =>
			options.find((option) => option.widthMm === mm)?.fits;
		expect(fitsAt(400)).toBe(true);
		expect(fitsAt(600)).toBe(true);
		expect(fitsAt(800)).toBe(false);
		expect(fitsAt(900)).toBe(false);
		// Every option carries its own price for the dropdown to show.
		for (const option of options) expect(option.priceRm).toBeGreaterThan(0);
	});

	it("prices rungs from the catalogue the engine was built with, not the seed", () => {
		const customCatalogue: typeof PLANNER_CATALOGUE = {
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.map((f) =>
				f.id === "base-cabinet"
					? {
							...f,
							sizes: f.sizes.map((size) => ({
								...size,
								priceRm: size.priceRm + 10_000,
							})),
						}
					: f,
			),
		};
		const customEngine = plannerEngine(customCatalogue);
		const next = customEngine.addModule(
			emptyLayout(WALL_MM),
			"base-cabinet",
			0,
			"a",
			900,
		);

		const options = customEngine.widthOptionsFor(next, "a");
		const seedPrice = PLANNER_CATALOGUE.families
			.find((f) => f.id === "base-cabinet")
			?.sizes.find((s) => s.widthMm === 900)?.priceRm;

		for (const option of options) {
			const customPrice = customCatalogue.families
				.find((f) => f.id === "base-cabinet")
				?.sizes.find((s) => s.widthMm === option.widthMm)?.priceRm;
			expect(option.priceRm).toBe(customPrice);
		}
		expect(options.find((o) => o.widthMm === 900)?.priceRm).not.toBe(seedPrice);
	});
});

describe("doors", () => {
	const one = () =>
		addModule(emptyLayout(WALL_MM), "base-cabinet", 0, "a", 600);

	it("arrives wearing the base door style, since its price includes a door", () => {
		expect(one().floor[0].doorStyleId).toBe(PLANNER_CATALOGUE.doorStyles[0].id);
	});

	it("takes a door and gives it back", () => {
		const doored = setDoor(one(), "a", "shaker");
		expect(doored.floor[0].doorStyleId).toBe("shaker");
		expect(setDoor(doored, "a", null).floor[0].doorStyleId).toBeNull();
	});

	it("puts one style on a whole selection", () => {
		let next = one();
		next = addModule(next, "base-cabinet", 600, "b", 600);
		next = setDoors(next, ["a", "b"], "slab");
		expect(next.floor.map((placed) => placed.doorStyleId)).toEqual([
			"slab",
			"slab",
		]);
	});

	it("does not move anything when a door is applied", () => {
		const before = one();
		const after = setDoor(before, "a", "glass");
		expect(at(after, "a")).toBe(at(before, "a"));
	});

	it("hangs on the left until the customer says otherwise", () => {
		expect(one().floor[0].hinge).toBe("left");
	});

	it("rehangs one cabinet without touching its neighbour", () => {
		let next = one();
		next = addModule(next, "base-cabinet", 600, "b", 600);
		next = setHinge(next, "a", "right");
		expect(next.floor.map((placed) => placed.hinge)).toEqual(["right", "left"]);
	});

	it("ignores an id that is not placed", () => {
		const before = one();
		expect(setHinge(before, "missing", "right")).toBe(before);
	});
});

describe("rooms", () => {
	it("only offers families the catalogue carries", () => {
		for (const room of PLANNER_CATALOGUE.roomTypes) {
			for (const familyId of room.familyIds) {
				expect(familyIn(PLANNER_CATALOGUE, familyId)).toBeDefined();
			}
		}
	});
});

describe("catalogue integrity", () => {
	it("gives every family a unique, resolvable id", () => {
		const ids = PLANNER_CATALOGUE.families.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(familyIn(PLANNER_CATALOGUE, id)?.id).toBe(id);
	});

	it("gives every family at least one priced size", () => {
		for (const f of PLANNER_CATALOGUE.families) {
			expect(f.sizes.length).toBeGreaterThan(0);
			for (const size of f.sizes) {
				expect(size.widthMm).toBeGreaterThan(0);
				expect(size.priceRm).toBeGreaterThan(0);
			}
		}
	});

	it("hangs wall units and stands everything else on the floor", () => {
		expect(rowFor("wall")).toBe("wall");
		expect(rowFor("base")).toBe("floor");
		expect(rowFor("tall")).toBe("floor");
	});
});

describe("the engine is bound to the catalogue it was given", () => {
	it("places off the catalogue's own size ladder", () => {
		const narrow = {
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.map((f) =>
				f.id === "base-cabinet"
					? { ...f, sizes: [{ widthMm: 500, priceRm: 1 }] }
					: f,
			),
		};
		const engine = plannerEngine(narrow);
		const placed = engine.addModule(emptyLayout(4000), "base-cabinet", 0);
		expect(placed.floor[0].widthMm).toBe(500);
	});

	it("refuses a family the catalogue does not carry", () => {
		const without = {
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.filter(
				(f) => f.id !== "base-cabinet",
			),
		};
		const engine = plannerEngine(without);
		expect(engine.fits(emptyLayout(4000), "base-cabinet")).toBe(false);
		expect(
			engine.addModule(emptyLayout(4000), "base-cabinet", 0).floor,
		).toHaveLength(0);
	});

	it("two engines over two catalogues do not see each other", () => {
		const a = plannerEngine(PLANNER_CATALOGUE);
		const b = plannerEngine({
			...PLANNER_CATALOGUE,
			families: PLANNER_CATALOGUE.families.filter(
				(f) => f.id !== "base-cabinet",
			),
		});
		expect(a.fits(emptyLayout(4000), "base-cabinet")).toBe(true);
		expect(b.fits(emptyLayout(4000), "base-cabinet")).toBe(false);
	});
});

describe("replaceFamily", () => {
	it("swaps the family and keeps the left edge", () => {
		const placed = addModule(layout, "base-cabinet", 600, "a", 600);
		const next = replaceFamily(placed, "a", "base-drawers");
		const module = next.floor.find((m) => m.id === "a");
		expect(module?.familyId).toBe("base-drawers");
		expect(module?.xMm).toBe(600);
	});

	it("lands on the nearest rung of the new ladder", () => {
		// base-cabinet has a 300 rung; base-drawers starts at 400.
		const placed = addModule(layout, "base-cabinet", 0, "a", 300);
		const next = replaceFamily(placed, "a", "base-drawers");
		expect(next.floor.find((m) => m.id === "a")?.widthMm).toBe(400);
	});

	it("refuses a swap the neighbours leave no room for", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 300);
		placed = addModule(placed, "base-cabinet", 300, "b", 300);
		// The nearest drawer rung is 400, which would run into "b".
		expect(replaceFamily(placed, "a", "base-drawers")).toBe(placed);
	});

	it("refuses a swap that would change row", () => {
		const placed = addModule(layout, "base-cabinet", 0, "a", 600);
		expect(replaceFamily(placed, "a", "wall-cabinet")).toBe(placed);
	});

	it("keeps the door and the hinge", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 600);
		placed = setDoor(placed, "a", "shaker");
		placed = setHinge(placed, "a", "right");
		const next = replaceFamily(placed, "a", "base-drawers");
		const module = next.floor.find((m) => m.id === "a");
		expect(module?.doorStyleId).toBe("shaker");
		expect(module?.hinge).toBe("right");
	});

	it("leaves an unknown family or id alone", () => {
		const placed = addModule(layout, "base-cabinet", 0, "a", 600);
		expect(replaceFamily(placed, "a", "nope")).toBe(placed);
		expect(replaceFamily(placed, "nope", "base-drawers")).toBe(placed);
	});
});

describe("setHangAt", () => {
	const hung = () => addModule(layout, "wall-cabinet", 0, "w", 600);

	it("raises one wall cabinet without moving the row", () => {
		const placed = addModule(hung(), "wall-cabinet", 600, "w2", 600);
		const next = setHangAt(placed, "w", 1600);
		const [a, b] = positionsOf(next, "wall");
		expect(floorHeightMmOf(a, next)).toBe(1600);
		expect(floorHeightMmOf(b, next)).toBe(next.hangingHeightMm);
	});

	it("clamps to the hang limits", () => {
		expect(setHangAt(hung(), "w", 100).wall[0].hangAtMm).toBe(
			WALL_HANG_LIMITS.minMm,
		);
		expect(setHangAt(hung(), "w", 9000).wall[0].hangAtMm).toBe(
			WALL_HANG_LIMITS.maxMm,
		);
	});

	// A cabinet cannot pass through the one above it any more than through the
	// one beside it. Nothing had to say so while the floor row could not move
	// vertically; the first thing a lifted base unit did was drive itself into
	// the wall cabinet over it.
	it("stops a rising floor unit under the wall unit above it", () => {
		let placed = addModule(layout, "base-cabinet", 0, "b", 600);
		placed = addModule(placed, "wall-cabinet", 0, "w", 600);
		const [wall] = positionsOf(placed, "wall");
		const [base] = positionsOf(placed, "floor");

		const lifted = setHangAt(placed, "b", 9000);
		expect(lifted.floor[0].hangAtMm).toBe(
			floorHeightMmOf(wall, placed) - base.family.heightMm,
		);
	});

	// Downward, the slider's own floor is what a wall unit meets first: it sits
	// above a resting base unit's worktop, so the cabinet below never becomes
	// the binding constraint. The block is still computed — it is what refuses
	// the *rising* unit above — but this is the end that does not bite.
	it("stops a descending wall unit at the slider's floor", () => {
		let placed = addModule(layout, "base-cabinet", 0, "b", 600);
		placed = addModule(placed, "wall-cabinet", 0, "w", 600);
		const [base] = positionsOf(placed, "floor");

		const restingTopMm =
			base.family.floorHeightMm +
			base.family.heightMm +
			CONSTRUCTION.worktopThicknessMm;
		expect(restingTopMm).toBeLessThan(WALL_HANG_LIMITS.minMm);
		expect(setHangAt(placed, "w", 0).wall[0].hangAtMm).toBe(
			WALL_HANG_LIMITS.minMm,
		);
	});

	// The refusal runs the other way too: a base unit cannot climb into the
	// wall unit, so it never reaches a height where the two interpenetrate.
	it("will not let a floor unit climb past the wall unit above it", () => {
		let placed = addModule(layout, "base-cabinet", 0, "b", 600);
		placed = addModule(placed, "wall-cabinet", 0, "w", 600);
		const [wall] = positionsOf(placed, "wall");
		const [base] = positionsOf(placed, "floor");

		const lifted = setHangAt(placed, "b", WALL_HANG_LIMITS.maxMm);
		const [raised] = positionsOf(lifted, "floor");
		expect(
			floorHeightMmOf(raised, lifted) + raised.family.heightMm,
		).toBeLessThanOrEqual(floorHeightMmOf(wall, placed));
		expect(base.family.heightMm).toBeGreaterThan(0);
	});

	// Only what is actually overhead counts: a wall unit further along the wall
	// is not in the way, however high the base unit goes.
	it("ignores a wall unit that does not sit over it", () => {
		let placed = addModule(layout, "base-cabinet", 0, "b", 600);
		placed = addModule(placed, "wall-cabinet", 2000, "w", 600);
		const [base] = positionsOf(placed, "floor");

		const lifted = setHangAt(placed, "b", 9000);
		expect(lifted.floor[0].hangAtMm).toBe(
			placed.ceilingHeightMm - base.family.heightMm,
		);
	});

	it("raises a floor unit too, and reports it back through the same reader", () => {
		const placed = setHangAt(
			addModule(layout, "base-cabinet", 0, "b", 600),
			"b",
			400,
		);
		const [only] = positionsOf(placed, "floor");
		expect(placed.floor.find((m) => m.id === "b")?.hangAtMm).toBe(400);
		expect(floorHeightMmOf(only, placed)).toBe(400);
	});

	it("clamps a floor unit to the floor and to the ceiling above it", () => {
		const placed = addModule(layout, "base-cabinet", 0, "b", 600);
		const [only] = positionsOf(placed, "floor");
		const headroomMm = placed.ceilingHeightMm - only.family.heightMm;

		const [down] = positionsOf(setHangAt(placed, "b", -500), "floor");
		const up = setHangAt(placed, "b", 9000);
		expect(floorHeightMmOf(down, placed)).toBe(0);
		expect(up.floor[0]?.hangAtMm).toBe(headroomMm);
	});

	it("keeps a hung cabinet under the ceiling, not just under the slider", () => {
		// The slider alone would allow 1800, which a 720-tall unit cannot take in
		// a 2200 ceiling without going through it.
		const low = setCeilingHeight(hung(), 2200);
		const [only] = positionsOf(low, "wall");
		const headroomMm = 2200 - only.family.heightMm;

		expect(setHangAt(low, "w", 1800).wall[0]?.hangAtMm).toBe(
			Math.min(WALL_HANG_LIMITS.maxMm, headroomMm),
		);
	});

	it("puts a raised cabinet back when handed null", () => {
		const raised = setHangAt(
			addModule(layout, "base-cabinet", 0, "b", 600),
			"b",
			400,
		);
		expect(setHangAt(raised, "b", null).floor[0]).not.toHaveProperty(
			"hangAtMm",
		);
	});

	it("is overridden by ceiling mode, which lines every top up", () => {
		const raised = setWallToCeiling(setHangAt(hung(), "w", 1250), true);
		const [only] = positionsOf(raised, "wall");
		expect(floorHeightMmOf(only, raised)).toBe(hangingHeightMmOf(raised));
	});

	it("is dropped by passing null, so the unit rejoins the row", () => {
		const reset = setHangAt(setHangAt(hung(), "w", 1600), "w", null);
		const [only] = positionsOf(reset, "wall");
		expect(reset.wall[0].hangAtMm).toBeUndefined();
		expect(floorHeightMmOf(only, reset)).toBe(reset.hangingHeightMm);
	});
});

describe("setRotation", () => {
	const turned = (deg: number, snap = false) =>
		setRotation(addModule(layout, "base-cabinet", 0, "b", 600), "b", deg, snap);

	it("stores a turn the drag could not have landed by hand", () => {
		expect(turned(37).floor[0].rotationDeg).toBe(37);
	});

	// A turn grows what a cabinet occupies along the wall, and a cabinet flush
	// on both sides has nowhere to put the extra. Sliding is all `clampX` can
	// do, so without either a refusal or somewhere to put the growth the
	// cabinet settles overlapping and is drawn through its neighbour.
	it("never settles a turn on top of a neighbour", () => {
		let packed = addModule(layout, "base-cabinet", 0, "a", 600);
		packed = addModule(packed, "base-cabinet", 600, "b", 600);
		packed = addModule(packed, "base-cabinet", 1200, "c", 600);
		const [, middle] = positionsOf(packed, "floor");
		expect(middle.placed.id).toBe("b");

		// Every angle, whether it is taken or refused, leaves a legal run.
		for (let deg = 0; deg < 360; deg += 5) {
			expectNoOverlaps(setRotation(packed, "b", deg));
		}
	});

	// Not eased down to the largest angle that fits, because there is no such
	// thing: the footprint grows to 45° and shrinks again past it. A cabinet
	// deeper than it is wide is *narrower* turned square than left alone, so
	// how far the run has to give way is not monotonic in the angle.
	it("moves the run least for the angle that costs least", () => {
		const packed = () => {
			let l = addModule(layout, "base-cabinet", 0, "a", 600);
			l = addModule(l, "base-cabinet", 600, "b", 600);
			return addModule(l, "base-cabinet", 1200, "c", 600);
		};
		const [, middle] = positionsOf(packed(), "floor");
		// 607 deep against 600 wide: square on it wants 7mm more than it has,
		// where 45° wants over two hundred.
		expect(middle.family.depthMm).toBeGreaterThan(middle.widthMm);

		const pushedBy = (deg: number) =>
			at(setRotation(packed(), "b", deg), "c") - 1200;

		expect(pushedBy(90)).toBeCloseTo(7, 0);
		expect(pushedBy(45)).toBeGreaterThan(200);
		expect(pushedBy(0)).toBe(0);
	});

	// The refusal above was right and still unhelpful: it left a packed run
	// unturnable while 2.2 m of bare wall sat at the end of it. The cabinet
	// cannot slide, but the run can.
	it("pushes the run along to make room for a turn", () => {
		let packed = addModule(layout, "base-cabinet", 0, "a", 600);
		packed = addModule(packed, "base-cabinet", 600, "b", 600);
		packed = addModule(packed, "base-cabinet", 1200, "c", 600);

		const next = setRotation(packed, "b", 30);
		expect(next.floor.find((m) => m.id === "b")?.rotationDeg).toBe(30);

		// "a" held its ground at the wall and "c" gave way, because the free
		// wall is on the right.
		expect(at(next, "a")).toBe(0);
		expect(at(next, "c")).toBeGreaterThan(1200);
		expectNoOverlaps(next);
	});

	it("pushes the other way when the free wall is on the left", () => {
		let packed = addModule(layout, "base-cabinet", 2200, "a", 600);
		packed = addModule(packed, "base-cabinet", 2800, "b", 600);
		packed = addModule(packed, "base-cabinet", 3400, "c", 600);

		const next = setRotation(packed, "b", 30);
		expect(next.floor.find((m) => m.id === "b")?.rotationDeg).toBe(30);
		expect(at(next, "a")).toBeLessThan(2200);
		expect(at(next, "c")).toBe(3400);
		expectNoOverlaps(next);
	});

	it("still refuses when the wall is full and there is no run to push", () => {
		// Three 600s on an 1800 wall: flush at both ends, nothing spare.
		let full = addModule(layout, "base-cabinet", 0, "a", 600);
		full = addModule(full, "base-cabinet", 600, "b", 600);
		full = addModule(full, "base-cabinet", 1200, "c", 600);
		full = setWallWidth(full, 1800);
		expect(full.wallWidthMm).toBe(1800);

		expect(setRotation(full, "b", 30)).toBe(full);
		expect(full.floor.find((m) => m.id === "b")?.rotationDeg).toBeUndefined();
	});

	it("allows a turn with room beside it, and stops it flush", () => {
		let roomy = addModule(layout, "base-cabinet", 0, "a", 600);
		roomy = addModule(roomy, "base-cabinet", 2000, "b", 600);
		const next = setRotation(roomy, "b", 30);
		expect(next.floor.find((m) => m.id === "b")?.rotationDeg).toBe(30);

		// Whatever it settled on, it is not inside anything.
		const after = positionsOf(next, "floor").find((p) => p.placed.id === "b");
		if (!after) throw new Error("the turned cabinet went missing");
		const spread = spreadMm(after);
		for (const other of positionsOf(next, "floor")) {
			if (other.placed.id === "b") continue;
			expect(after.xMm - spread).toBeGreaterThanOrEqual(
				other.xMm + other.widthMm - 0.5,
			);
		}
	});

	// The whole point of the feature, stated as one rule: a turn must never put
	// one cabinet inside another, whatever is done to the run afterwards. Every
	// mutation below used to be written in widths, and a turned cabinet is
	// wider than its width — `closeGaps` packed the next one under its corner,
	// `swapWithNeighbour` dropped the wider footprint into the narrower slot,
	// and `rowEndMm` let `setWallWidth` pull the wall in through it.
	it("keeps every cabinet clear of every other, whatever follows a turn", () => {
		for (const room of ["kitchen", "living", "bedroom", "foyer"] as const) {
			const base = furnishedRun(engine, room);
			for (const row of ["floor", "wall"] as const) {
				for (const target of positionsOf(base, row)) {
					for (const deg of [15, 45, 90, 135, 210, 315]) {
						const turned = setRotation(base, target.placed.id, deg);
						expectNoOverlaps(turned);
						expectNoOverlaps(closeGaps(turned));
						expectNoOverlaps(setWallWidth(turned, minWallWidthMm(turned)));

						for (const other of positionsOf(turned, row)) {
							expectNoOverlaps(moveModule(turned, other.placed.id, 0));
							expectNoOverlaps(
								dropModule(turned, other.placed.id, other.xMm + 250),
							);
							expectNoOverlaps(swapWithNeighbour(turned, other.placed.id, 1));
							expectNoOverlaps(swapWithNeighbour(turned, other.placed.id, -1));
							expectNoOverlaps(duplicateModule(turned, other.placed.id));
						}
					}
				}
			}
		}
	});

	it("normalises a turn the other way into the same circle", () => {
		expect(turned(-90).floor[0].rotationDeg).toBe(270);
		expect(turned(450).floor[0].rotationDeg).toBe(90);
	});

	it("lands a dragged turn on the eighth it was reaching for", () => {
		expect(turned(87, true).floor[0].rotationDeg).toBe(90);
		expect(turned(43, true).floor[0].rotationDeg).toBe(45);
		// Far enough out to be meant.
		expect(turned(78, true).floor[0].rotationDeg).toBe(78);
	});

	it("leaves a typed angle exactly where it was typed", () => {
		// The magnet belongs to the drag. On a typed figure it would pull every
		// small angle back to zero as the first digit landed.
		expect(turned(3).floor[0].rotationDeg).toBe(3);
		expect(turned(87).floor[0].rotationDeg).toBe(87);
	});

	it("drops the field at zero, so square is square however it got there", () => {
		expect(turned(0).floor[0]).not.toHaveProperty("rotationDeg");
		// 358 snaps to 360, which is 0, which is not stored.
		expect(turned(358, true).floor[0]).not.toHaveProperty("rotationDeg");
	});

	it("returns the same layout when the turn changes nothing", () => {
		const placed = turned(90);
		expect(setRotation(placed, "b", 90)).toBe(placed);
		expect(setRotation(placed, "nobody", 90)).toBe(placed);
	});

	it("turns a hung cabinet as readily as one on the floor", () => {
		const placed = addModule(layout, "wall-cabinet", 0, "w", 600);
		expect(setRotation(placed, "w", 90).wall[0].rotationDeg).toBe(90);
	});
});

describe("a turned cabinet occupies its footprint, not its width", () => {
	/** One 600-wide base unit hard against the left wall. */
	const flush = () => addModule(layout, "base-cabinet", 0, "b", 600);

	it("reports what a turn adds either side", () => {
		const square = positionsOf(flush(), "floor")[0];
		expect(spreadMm(square)).toBe(0);

		const side = positionsOf(setRotation(flush(), "b", 90), "floor")[0];
		// Square on, it is 600 along the wall; side on, it is its own depth.
		expect(spreadMm(side)).toBeCloseTo(
			(side.family.depthMm - side.widthMm) / 2,
			6,
		);
	});

	it("comes back off the wall when it is turned into it", () => {
		// The reported bug: flush at 0, turned, and its corner swung through the
		// wall — nothing had moved, so nothing re-checked.
		const turned = setRotation(flush(), "b", 90);
		const [only] = positionsOf(turned, "floor");

		expect(only.xMm).toBeCloseTo(spreadMm(only), 6);
		expect(only.xMm - spreadMm(only)).toBeGreaterThanOrEqual(0);
	});

	it("stops a turned cabinet at the far wall too", () => {
		let placed = addModule(layout, "base-cabinet", WALL_MM - 600, "b", 600);
		placed = setRotation(placed, "b", 90);
		const [only] = positionsOf(placed, "floor");

		expect(only.xMm + only.widthMm + spreadMm(only)).toBeCloseTo(WALL_MM, 6);
	});

	it("keeps its corner out of a neighbour", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 900);
		placed = addModule(placed, "base-cabinet", 900, "b", 600);
		placed = setRotation(placed, "b", 90);

		const b = positionsOf(placed, "floor").find((p) => p.placed.id === "b");
		if (!b) throw new Error("no b");
		// Its left corner clears the 900 beside it, not its left *edge*.
		expect(b.xMm - spreadMm(b)).toBeGreaterThanOrEqual(900 - 1e-6);
		expectNoOverlaps(placed);
	});

	it("a dragged turned cabinet stops on its corner, not its edge", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 900);
		placed = addModule(placed, "base-cabinet", 2000, "b", 600);
		placed = setRotation(placed, "b", 90);
		placed = moveModule(placed, "b", 500);

		const b = positionsOf(placed, "floor").find((p) => p.placed.id === "b");
		if (!b) throw new Error("no b");
		expect(b.xMm - spreadMm(b)).toBeCloseTo(900, 6);
	});
});

describe("the vertical snap", () => {
	/** Two wall units side by side, the right one dragged out of the row. */
	const pair = () => {
		let next = addModule(layout, "wall-cabinet", 0, "left", 900);
		next = addModule(next, "wall-cabinet", 900, "right", 900);
		return next;
	};

	it("offers every other cabinet's underside and its top, from both rows", () => {
		let next = addModule(layout, "base-cabinet", 0, "b", 600);
		next = addModule(next, "wall-cabinet", 0, "w", 600);
		const [base] = positionsOf(next, "floor");

		const targets = hangTargets(next, "w");
		expect(targets).toContain(floorHeightMmOf(base, next));
		expect(targets).toContain(
			floorHeightMmOf(base, next) + base.family.heightMm,
		);
	});

	it("leaves the cabinet being dragged out of its own target list", () => {
		const placed = setHangAt(pair(), "right", 1333);
		expect(hangTargets(placed, "right")).not.toContain(1333);
	});

	it("lands a top flush with a top, across rows and across heights", () => {
		// The alignment a customer asks for by name: the wall unit's top level
		// with the tall unit's, which is two different heights meeting.
		let placed = addModule(layout, "tall-cabinet", 0, "t", 600);
		placed = addModule(placed, "wall-cabinet", 1000, "w", 600);

		const [tall] = positionsOf(placed, "floor");
		const [hungOne] = positionsOf(placed, "wall");
		const flushMm =
			floorHeightMmOf(tall, placed) +
			tall.family.heightMm -
			hungOne.family.heightMm;

		const dropped = dropModule(placed, "w", 1000, flushMm - 40);
		const [landed] = positionsOf(dropped, "wall");
		expect(floorHeightMmOf(landed, dropped)).toBe(flushMm);
	});

	it("lands an underside flush from within the snap", () => {
		// Dragged off the row and released just short of it: the cabinet rejoins
		// its neighbours rather than hanging 40mm proud of them.
		const placed = setHangAt(pair(), "right", 1700);
		const [left] = positionsOf(placed, "wall");
		const rowMm = floorHeightMmOf(left, placed);

		const dropped = dropModule(placed, "right", 900, rowMm - 40);
		const landed = positionsOf(dropped, "wall").find(
			(p) => p.placed.id === "right",
		);
		expect(landed && floorHeightMmOf(landed, dropped)).toBe(rowMm);
	});

	it("leaves a height nowhere near a target alone", () => {
		const placed = pair();
		const [left] = positionsOf(placed, "wall");
		const wantedMm = floorHeightMmOf(left, placed) - 120;

		const dropped = dropModule(placed, "right", 900, wantedMm);
		expect(dropped.wall.find((m) => m.id === "right")?.hangAtMm).toBe(wantedMm);
	});

	it("clamps a snap that would land outside the range", () => {
		// The floor is a target, but a wall unit's range starts at the slider's
		// own minimum — the snap is a preference, not a way past the limits.
		const placed = pair();
		const dropped = dropModule(placed, "right", 900, 30);
		expect(dropped.wall.find((m) => m.id === "right")?.hangAtMm).toBe(
			WALL_HANG_LIMITS.minMm,
		);
	});

	it("still snaps sideways when no height is handed in", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 900);
		placed = addModule(placed, "base-cabinet", 2000, "b", 900);
		expect(at(dropModule(placed, "b", 940), "b")).toBe(900);
	});
});

describe("swapWithNeighbour", () => {
	it("trades places with the cabinet to its right, keeping the pair's span", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 300);
		placed = addModule(placed, "base-cabinet", 300, "b", 900);
		const next = swapWithNeighbour(placed, "a", 1);
		expect(at(next, "b")).toBe(0);
		expect(at(next, "a")).toBe(900);
		expectNoOverlaps(next);
	});

	it("trades places with the cabinet to its left", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 300);
		placed = addModule(placed, "base-cabinet", 300, "b", 900);
		const next = swapWithNeighbour(placed, "b", -1);
		expect(at(next, "b")).toBe(0);
		expect(at(next, "a")).toBe(900);
	});

	it("leaves the run alone at the end of the row", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 300);
		placed = addModule(placed, "base-cabinet", 300, "b", 900);
		expect(swapWithNeighbour(placed, "a", -1)).toBe(placed);
		expect(swapWithNeighbour(placed, "b", 1)).toBe(placed);
	});

	it("only ever swaps within one row", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 600);
		placed = addModule(placed, "wall-cabinet", 0, "w", 600);
		// The wall cabinet is the floor cabinet's neighbour in neither direction.
		expect(swapWithNeighbour(placed, "a", 1)).toBe(placed);
		expect(swapWithNeighbour(placed, "w", 1)).toBe(placed);
	});

	it("keeps a gap between the two rather than closing it", () => {
		let placed = addModule(layout, "base-cabinet", 0, "a", 300);
		placed = addModule(placed, "base-cabinet", 900, "b", 600);
		const next = swapWithNeighbour(placed, "a", 1);
		// The pair still spans 0..1500 and neither has grown into the gap.
		expect(at(next, "b")).toBe(0);
		expect(at(next, "a")).toBe(1200);
		expectNoOverlaps(next);
	});

	it("refuses a swap that would put a wall unit over a tall one", () => {
		let placed = addModule(layout, "wall-cabinet", 0, "w1", 400);
		placed = addModule(placed, "wall-cabinet", 400, "w2", 900);
		// A tall unit under w2's stretch: w1 cannot take that place.
		placed = addModule(placed, "tall-cabinet", 800, "t", 600);
		expect(swapWithNeighbour(placed, "w1", 1)).toBe(placed);
	});
});

describe("depthSpreadMm", () => {
	it("is nothing at all for a cabinet square to the wall", () => {
		expect(depthSpreadMm(900, 607, undefined)).toBe(0);
		expect(depthSpreadMm(900, 607, 0)).toBe(0);
	});

	// Turned square, width and depth trade places: a 900-wide carcass occupies
	// 900 of depth about a centre only 303.5 out, so 146.5 of it would be
	// behind the wall. That is exactly how far forward it has to step.
	it("steps a square turn forward by half the difference", () => {
		expect(depthSpreadMm(900, 607, 90)).toBeCloseTo((900 - 607) / 2, 6);
		expect(depthSpreadMm(900, 607, 270)).toBeCloseTo((900 - 607) / 2, 6);
	});

	// Deeper than it is wide, a square turn costs it depth rather than gaining
	// any, and the step goes the other way — back toward the wall, which is
	// right: cabinets hang by their backs, and leaving a hundred millimetres of
	// daylight behind a turned one would read as a mistake.
	it("steps a narrow cabinet back, so its back stays on the wall", () => {
		expect(depthSpreadMm(400, 607, 90)).toBeCloseTo((400 - 607) / 2, 6);
	});

	// Whatever the angle, the cabinet's back lands on the wall and never
	// through it — which is the whole job.
	it("keeps the turned back on the wall at every angle", () => {
		const depthMm = 607;
		for (let deg = 0; deg <= 360; deg += 15) {
			const centreMm = depthMm / 2 + depthSpreadMm(900, depthMm, deg);
			const halfSpanMm =
				(Math.abs(depthMm * Math.cos((deg * Math.PI) / 180)) +
					Math.abs(900 * Math.sin((deg * Math.PI) / 180))) /
				2;
			expect(centreMm - halfSpanMm).toBeCloseTo(0, 6);
		}
	});

	it("is symmetric across the quadrants, like the turn itself", () => {
		for (const deg of [30, 150, 210, 330]) {
			expect(depthSpreadMm(900, 607, deg)).toBeCloseTo(
				depthSpreadMm(900, 607, 30),
				6,
			);
		}
	});
});
