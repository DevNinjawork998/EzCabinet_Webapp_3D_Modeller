import { describe, expect, it } from "vitest";
import { hingeOf } from "@/components/planner/Hinge";
import { CONSTRUCTION, PLANNER_CATALOGUE } from "../catalogue";
import { sideGapsMm } from "../exposure";
import { type HingeSide, plannerEngine } from "../layout";
import { cabinetPartsMm } from "../parts";
import { type BoxMm, swingOf } from "../swing";
import { furnished } from "./furnished";

const engine = plannerEngine(PLANNER_CATALOGUE);

/** A leaf in world plan coords, plus the height band it occupies. */
type Leaf = {
	label: string;
	px: number;
	pz: number;
	tx: number;
	tz: number;
	y0: number;
	y1: number;
};

function cross(a: Leaf, b: Leaf) {
	// Height bands must overlap for two leaves to be able to meet at all.
	if (a.y1 <= b.y0 + 1 || b.y1 <= a.y0 + 1) return null;
	const d = (a.tx - a.px) * (b.tz - b.pz) - (a.tz - a.pz) * (b.tx - b.px);
	if (Math.abs(d) < 1e-9) return null;
	const u = ((b.px - a.px) * (b.tz - b.pz) - (b.pz - a.pz) * (b.tx - b.px)) / d;
	const v = ((b.px - a.px) * (a.tz - a.pz) - (b.pz - a.pz) * (a.tx - a.px)) / d;
	const E = 1e-6;
	return u > E && u < 1 - E && v > E && v < 1 - E
		? { x: a.px + u * (a.tx - a.px), z: a.pz + u * (a.tz - a.pz) }
		: null;
}

describe("two open doors never sweep through each other", () => {
	/**
	 * The bug this guards: a pair's outer leaf is forced to the cabinet's outer
	 * stile by `hingeOf`, so a single-door cabinet hinged toward that same
	 * shared edge pivots 8mm away from it. One leaf sweeps right and the other
	 * left, and their paths scissor.
	 *
	 * Exhaustive over every hinge combination in the run rather than a single
	 * arrangement, because the first attempt at this was checked against one
	 * layout, found nothing, and shipped a fix for a problem that was not there.
	 */
	it.each([0, 30, 80, 150, 400])(
		"across every hinge combination, with the run spread by %imm",
		(spreadMm) => {
			const base = furnished(engine, "kitchen");
			// Slide each cabinet progressively right, which is what the user did:
			// the gaps open up, nothing is "touching" any more, and a boolean view
			// of the neighbour would switch every limit off at once.
			const positions = engine
				.positionsOf(base, "floor")
				.map((p, i) => ({ ...p, xMm: p.xMm + i * spreadMm }));
			const out: string[] = [];

			// Every cabinet with leaves, each way round.
			const n = positions.length;
			for (let mask = 0; mask < 1 << n; mask++) {
				const sides: HingeSide[] = positions.map((_, i) =>
					mask & (1 << i) ? "right" : "left",
				);
				const leaves: Leaf[] = [];

				positions.forEach((p, i) => {
					const parts = cabinetPartsMm(p.family, p.widthMm, true, CONSTRUCTION);
					const doors = parts.filter((q) => q.role === "doorLeaf");
					const gaps = sideGapsMm(positions, i);
					const d = p.family.depthMm;

					const rads: number[] = [];
					doors.forEach((leaf) => {
						const side = hingeOf(leaf.index, doors.length, sides[i]);
						const hb = {
							min: {
								x: leaf.centreMm.x - leaf.sizeMm.x / 2,
								y: leaf.centreMm.y - leaf.sizeMm.y / 2,
								z: leaf.centreMm.z - leaf.sizeMm.z / 2,
							},
							max: {
								x: leaf.centreMm.x + leaf.sizeMm.x / 2,
								y: leaf.centreMm.y + leaf.sizeMm.y / 2,
								z: leaf.centreMm.z + leaf.sizeMm.z / 2,
							},
						};
						rads.push(
							swingOf(
								hb,
								{
									min: { x: -p.widthMm / 2, y: 0, z: -d / 2 },
									max: { x: p.widthMm / 2, y: p.family.heightMm, z: d / 2 },
								},
								side,
								gaps[side],
							).maxRad,
						);
					});
					const shared = Math.min(...rads);

					doors.forEach((leaf) => {
						const side = hingeOf(leaf.index, doors.length, sides[i]);
						const half = leaf.sizeMm.x / 2;
						const leafBox = {
							min: {
								x: leaf.centreMm.x - half,
								y: leaf.centreMm.y - leaf.sizeMm.y / 2,
								z: leaf.centreMm.z - leaf.sizeMm.z / 2,
							},
							max: {
								x: leaf.centreMm.x + half,
								y: leaf.centreMm.y + leaf.sizeMm.y / 2,
								z: leaf.centreMm.z + leaf.sizeMm.z / 2,
							},
						};
						const carcassBox = {
							min: { x: -p.widthMm / 2, y: 0, z: -d / 2 },
							max: { x: p.widthMm / 2, y: p.family.heightMm, z: d / 2 },
						};
						const spec = swingOf(leafBox, carcassBox, side, gaps[side]);
						const W = leaf.sizeMm.x;
						const px = p.xMm + p.widthMm / 2 + spec.pivotXMm;
						const t = shared;
						const floor = p.family.floorHeightMm;
						leaves.push({
							label: `${p.family.id}@${p.xMm}#${leaf.index}(${side})`,
							px,
							pz: spec.pivotZMm,
							tx: side === "left" ? px + W * Math.cos(t) : px - W * Math.cos(t),
							tz: spec.pivotZMm + W * Math.sin(t),
							y0: floor + leafBox.min.y,
							y1: floor + leafBox.max.y,
						});
					});
				});

				for (let a = 0; a < leaves.length; a++) {
					for (let b = a + 1; b < leaves.length; b++) {
						const hit = cross(leaves[a], leaves[b]);
						if (hit) {
							out.push(
								`hinges=[${sides.join(",")}] ${leaves[a].label} X ${leaves[b].label} at x=${hit.x.toFixed(0)} z=${hit.z.toFixed(0)}`,
							);
						}
					}
				}
			}

			expect([...new Set(out)]).toEqual([]);
		},
	);
});

describe("two leaves on a shared stile touch instead of merging", () => {
	/**
	 * The overlap the angle cap cannot reach. Two hinges on one stile sit a
	 * reveal apart on each side while each leaf's own thickness projects toward
	 * the other, so the bodies merge by that spacing at every angle. `clearMm`
	 * slides each leaf out by its own thickness less its own reveal.
	 */
	const carcass: BoxMm = {
		min: { x: -450, y: 0, z: -303.5 },
		max: { x: 450, y: 880, z: 303.5 },
	};
	/** The right leaf of a pair: hinges on the cabinet's right stile. */
	const rightLeaf: BoxMm = {
		min: { x: 4, y: 100, z: 303.5 },
		max: { x: 446, y: 870, z: 321.5 },
	};
	/** A lone leaf on the neighbour, hinging on the stile they share. */
	const leftLeaf: BoxMm = {
		min: { x: -446, y: 100, z: 303.5 },
		max: { x: -4, y: 870, z: 321.5 },
	};

	/** Where a leaf's body sits along the wall at full open, world mm. */
	const bodyAt = (pivotX: number, spec: ReturnType<typeof swingOf>) => {
		const t = spec.maxRad;
		const thickness = 18;
		const dir = spec.side === "left" ? -1 : 1;
		const shift = (spec.side === "left" ? 1 : -1) * spec.clearMm;
		const near = pivotX + shift;
		const far = near + dir * thickness * Math.sin(t);
		return [Math.min(near, far), Math.max(near, far)] as const;
	};

	it("no longer overlap once each has slid clear", () => {
		const right = swingOf(rightLeaf, carcass, "right", 0);
		const left = swingOf(leftLeaf, carcass, "left", 0);

		// Shared stile at x = 2200: one cabinet ends there, the next begins.
		const a = bodyAt(2200 - 4, right);
		const b = bodyAt(2200 + 4, left);
		const overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

		expect(right.clearMm).toBeCloseTo(14);
		expect(left.clearMm).toBeCloseTo(14);
		expect(overlap).toBeLessThanOrEqual(0);
	});

	it("would overlap by the hinge spacing without the shift", () => {
		const right = { ...swingOf(rightLeaf, carcass, "right", 0), clearMm: 0 };
		const left = { ...swingOf(leftLeaf, carcass, "left", 0), clearMm: 0 };
		const a = bodyAt(2200 - 4, right);
		const b = bodyAt(2200 + 4, left);
		expect(Math.min(a[1], b[1]) - Math.max(a[0], b[0])).toBeCloseTo(8);
	});
});
