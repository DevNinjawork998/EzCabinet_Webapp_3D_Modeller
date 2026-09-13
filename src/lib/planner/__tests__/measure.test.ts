import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "../catalogue";
import { emptyLayout, plannerEngine, setDoor } from "../layout";

const engine = plannerEngine(PLANNER_CATALOGUE);
const { addModule, allPositions } = engine;

import {
	APERTURE_PX,
	apertureMm,
	cabinetBoundsMm,
	cabinetCornersMm,
	constrainToAxis,
	type DesignPartBox,
	distanceMm,
	dominantAxis,
	measure,
	snapToCabinet,
	type Vec3Mm,
} from "../measure";
import { cabinetPartsMm } from "../parts";

const WALL_MM = 4000;

describe("measure", () => {
	it("derives W/D/H from a cabinet's own two opposite corners", () => {
		const layout = addModule(emptyLayout(WALL_MM), "base-cabinet", 0);
		const [position] = allPositions(layout);
		const bounds = cabinetBoundsMm(position, layout, engine);
		const corners = cabinetCornersMm(position, layout, engine);

		const result = measure(corners[0], corners[7]);

		expect(result.widthMm).toBeCloseTo(bounds.maxX - bounds.minX);
		expect(result.heightMm).toBeCloseTo(bounds.maxY - bounds.minY);
		expect(result.depthMm).toBeCloseTo(bounds.maxZ - bounds.minZ);
		expect(result.distanceMm).toBeCloseTo(distanceMm(corners[0], corners[7]));
	});

	it("snaps a near-corner hit to the exact vertex", () => {
		const layout = addModule(emptyLayout(WALL_MM), "base-cabinet", 0);
		const [position] = allPositions(layout);
		const [corner] = cabinetCornersMm(position, layout, engine);

		const nearHit = { x: corner.x + 5, y: corner.y - 3, z: corner.z + 2 };
		const snapped = snapToCabinet(nearHit, position, layout, engine);

		expect(snapped.point).toEqual(corner);
		expect(snapped.kind).toBe("corner");
	});

	it("leaves a hit unsnapped once it's outside the tolerance", () => {
		const layout = addModule(emptyLayout(WALL_MM), "base-cabinet", 0);
		const [position] = allPositions(layout);
		const [corner] = cabinetCornersMm(position, layout, engine);

		const farHit = { x: corner.x + 500, y: corner.y, z: corner.z };
		const snapped = snapToCabinet(farHit, position, layout, engine);

		expect(snapped.point).toEqual(farHit);
		expect(snapped.kind).toBe("surface");
	});
});

describe("snap targets from the cabinet's parts", () => {
	const layoutWith = (familyId: string) =>
		addModule(emptyLayout(WALL_MM), familyId, 0);

	/** A part's world-space box, the same way `measure` builds it. */
	const worldBox = (
		position: ReturnType<typeof allPositions>[number],
		layout: ReturnType<typeof emptyLayout>,
		role: string,
		index = 0,
	) => {
		const bounds = cabinetBoundsMm(position, layout, engine);
		const part = cabinetPartsMm(
			position.family,
			position.widthMm,
			position.placed.doorStyleId !== null,
		).find((p) => p.role === role && p.index === index);
		if (!part) throw new Error(`no ${role}[${index}] on this cabinet`);
		return {
			centre: {
				x: (bounds.minX + bounds.maxX) / 2 + part.centreMm.x,
				y: bounds.minY + part.centreMm.y,
				z: (bounds.minZ + bounds.maxZ) / 2 + part.centreMm.z,
			},
			size: part.sizeMm,
		};
	};

	it("reaches a shelf, which the bounding box alone never could", () => {
		const layout = layoutWith("base-cabinet");
		const [position] = allPositions(layout);
		const shelf = worldBox(position, layout, "shelf");

		const shelfCorner: Vec3Mm = {
			x: shelf.centre.x - shelf.size.x / 2,
			y: shelf.centre.y - shelf.size.y / 2,
			z: shelf.centre.z + shelf.size.z / 2,
		};
		const snapped = snapToCabinet(
			{ x: shelfCorner.x + 3, y: shelfCorner.y + 2, z: shelfCorner.z - 4 },
			position,
			layout,
			engine,
		);

		expect(snapped.kind).toBe("corner");
		expect(snapped.role).toBe("shelf");
		expect(snapped.point.x).toBeCloseTo(shelfCorner.x);
		expect(snapped.point.y).toBeCloseTo(shelfCorner.y);
	});

	it("snaps to an edge midpoint when no corner is within reach", () => {
		const layout = layoutWith("base-cabinet");
		const [position] = allPositions(layout);
		const bounds = cabinetBoundsMm(position, layout, engine);

		// Halfway up the cabinet's front-left vertical edge: both its corners are
		// most of a cabinet-height away, so only the midpoint is in the aperture.
		const mid: Vec3Mm = {
			x: bounds.minX,
			y: (bounds.minY + bounds.maxY) / 2,
			z: bounds.maxZ,
		};
		const snapped = snapToCabinet(
			{ x: mid.x + 2, y: mid.y + 6, z: mid.z - 1 },
			position,
			layout,
			engine,
			20,
		);

		expect(snapped.kind).toBe("midpoint");
		expect(snapped.point.y).toBeCloseTo(mid.y);
	});

	it("prefers a corner over a nearer midpoint, the way OSNAP ranks", () => {
		const layout = layoutWith("base-cabinet");
		const [position] = allPositions(layout);
		const bounds = cabinetBoundsMm(position, layout, engine);

		// Sit close to the bottom edge's midpoint but still inside the aperture of
		// the corner it runs to; the corner has to win regardless.
		const corner: Vec3Mm = { x: bounds.minX, y: bounds.minY, z: bounds.maxZ };
		const snapped = snapToCabinet(
			{ x: corner.x + 30, y: corner.y, z: corner.z },
			position,
			layout,
			engine,
			60,
		);

		expect(snapped.kind).toBe("corner");
	});

	it("only offers door leaves once a door has been chosen", () => {
		// A placed cabinet arrives with a door now; take it off to get a bare one.
		const placed = layoutWith("base-cabinet");
		const bare = setDoor(placed, allPositions(placed)[0].placed.id, null);
		const [barePosition] = allPositions(bare);
		expect(barePosition.placed.doorStyleId).toBeNull();

		const dressed = setDoor(bare, barePosition.placed.id, "slab");
		const [position] = allPositions(dressed);
		const leaf = worldBox(position, dressed, "doorLeaf");

		const front: Vec3Mm = {
			x: leaf.centre.x - leaf.size.x / 2,
			y: leaf.centre.y - leaf.size.y / 2,
			z: leaf.centre.z + leaf.size.z / 2,
		};
		const snapped = snapToCabinet(
			{ x: front.x + 4, y: front.y + 4, z: front.z },
			position,
			dressed,
			engine,
		);

		expect(snapped.role).toBe("doorLeaf");
		expect(snapped.kind).toBe("corner");
	});

	it("widening the aperture snaps where a narrow one does not", () => {
		const layout = layoutWith("base-cabinet");
		const [position] = allPositions(layout);
		const [corner] = cabinetCornersMm(position, layout, engine);
		const hit = { x: corner.x + 25, y: corner.y + 25, z: corner.z };

		expect(snapToCabinet(hit, position, layout, engine, 5).kind).toBe(
			"surface",
		);
		expect(snapToCabinet(hit, position, layout, engine, 80).kind).toBe(
			"corner",
		);
	});
});

describe("apertureMm", () => {
	// 12px at 3m through a 40° lens on an 800px canvas: the frustum is
	// 2·3·tan(20°) = 2.184m tall, so a pixel is 2.73mm and twelve are ~32.8.
	it("converts a pixel aperture to millimetres at that distance", () => {
		expect(apertureMm(3, 40, 800, 12)).toBeCloseTo(32.757, 2);
	});

	it("grows with distance — which the old fixed 40mm could not", () => {
		const near = apertureMm(1, 40, 800);
		const far = apertureMm(6, 40, 800);
		expect(far).toBeGreaterThan(near);
		// Linear in distance, so pulling back to frame a whole run scales it.
		expect(far / near).toBeCloseTo(6);
	});

	it("shrinks on a taller viewport and grows with the pixel aperture", () => {
		expect(apertureMm(3, 40, 1600)).toBeLessThan(apertureMm(3, 40, 800));
		expect(apertureMm(3, 40, 800, 24)).toBeCloseTo(
			apertureMm(3, 40, 800, 12) * 2,
		);
	});

	it("defaults to a usable aperture rather than zero before layout", () => {
		expect(apertureMm(3, 40, 0)).toBeGreaterThan(0);
		expect(APERTURE_PX).toBeGreaterThan(0);
	});
});

describe("axis lock", () => {
	const from: Vec3Mm = { x: 100, y: 200, z: 300 };
	const mostlyUp: Vec3Mm = { x: 112, y: 1100, z: 297 };

	it("auto zeroes the other two axes exactly, not nearly", () => {
		const locked = constrainToAxis(from, mostlyUp, "auto");
		const result = measure(from, locked);

		expect(dominantAxis(from, mostlyUp)).toBe("y");
		expect(result.heightMm).toBe(900);
		expect(result.widthMm).toBe(0);
		expect(result.depthMm).toBe(0);
	});

	it("free leaves the point alone, so two corners still give W/H/D", () => {
		expect(constrainToAxis(from, mostlyUp, "free")).toEqual(mostlyUp);
	});

	it("an explicit axis overrides what auto would have picked", () => {
		const locked = constrainToAxis(from, mostlyUp, "x");
		expect(locked).toEqual({ x: 112, y: 200, z: 300 });
		expect(measure(from, locked).widthMm).toBe(12);
	});
});

describe("snapping to a drafted cabinet", () => {
	/**
	 * A shelf where the drafter actually put it, rather than where
	 * `cabinetPartsMm` would compute it. The point of these two tests is that
	 * those are different places — a dimension line taken against the idealised
	 * shelf while the scene draws the real one is a wrong number shown to a
	 * customer.
	 */
	const shelfAt = (yMm: number): DesignPartBox[] => [
		{
			role: "shelf",
			minMm: { x: -384, y: yMm, z: -278 },
			maxMm: { x: 384, y: yMm + 16, z: 256 },
		},
	];

	/** The cabinet's own frame maps into world millimetres the same way for both
	 * sources — x and z about the centre, y up from the underside. */
	const frameOf = (
		position: ReturnType<typeof allPositions>[number],
		layout: ReturnType<typeof emptyLayout>,
	) => {
		const b = cabinetBoundsMm(position, layout, engine);
		return {
			x: (b.minX + b.maxX) / 2,
			y: b.minY,
			z: (b.minZ + b.maxZ) / 2,
		};
	};

	it("snaps to the design's own shelf, not the computed one", () => {
		const layout = addModule(emptyLayout(WALL_MM), "base-cabinet", 0);
		const [position] = allPositions(layout);
		const frame = frameOf(position, layout);

		// Nowhere near where an evenly-split opening would put a shelf.
		const design = shelfAt(214);
		const target: Vec3Mm = {
			x: frame.x - 384,
			y: frame.y + 214,
			z: frame.z - 278,
		};

		const snapped = snapToCabinet(
			{ x: target.x + 6, y: target.y + 4, z: target.z - 3 },
			position,
			layout,
			engine,
			40,
			design,
		);

		expect(snapped.kind).toBe("corner");
		expect(snapped.role).toBe("shelf");
		expect(snapped.point.y).toBeCloseTo(target.y);
		expect(snapped.point.x).toBeCloseTo(target.x);
	});

	it("falls back to the procedural boxes while the mesh has not arrived", () => {
		const layout = addModule(emptyLayout(WALL_MM), "base-cabinet", 0);
		const [position] = allPositions(layout);
		const frame = frameOf(position, layout);
		const shelf = cabinetPartsMm(
			position.family,
			position.widthMm,
			position.placed.doorStyleId !== null,
		).find((part) => part.role === "shelf");
		if (!shelf) throw new Error("no procedural shelf to compare against");

		const y = frame.y + shelf.centreMm.y - shelf.sizeMm.y / 2;
		const x = frame.x + shelf.centreMm.x - shelf.sizeMm.x / 2;
		const z = frame.z + shelf.centreMm.z - shelf.sizeMm.z / 2;
		const hit = { x: x + 5, y: y + 4, z: z + 3 };

		// null and [] both mean "no mesh drawn", and must behave identically.
		for (const design of [null, [] as DesignPartBox[]]) {
			const snapped = snapToCabinet(hit, position, layout, engine, 60, design);
			expect(snapped.kind).toBe("corner");
			expect(snapped.point.y).toBeCloseTo(y);
		}
	});
});
