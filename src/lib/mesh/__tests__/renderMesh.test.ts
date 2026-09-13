import { describe, expect, it } from "vitest";
import { readObjMesh } from "../objRead";
import {
	buildRenderMesh,
	decodeRenderMesh,
	encodeRenderMesh,
	splitDoorLeaves,
} from "../renderMesh";

/**
 * A cabinet drawn the way the client's exporter actually draws one: in inches,
 * Z-up, with quads rather than triangles, and named the way their drafter names
 * things.
 *
 * 800 wide × 600 deep × 720 tall, in inches: 31.496 × 23.622 × 28.346. Two
 * 16mm (0.63") end panels, a back at the low end of depth, and a door at the
 * high end.
 */
function inchBox(
	name: string,
	[x0, y0, z0]: number[],
	[x1, y1, z1]: number[],
	vertexBase: number,
): string {
	const corners = [
		[x0, y0, z0],
		[x1, y0, z0],
		[x1, y1, z0],
		[x0, y1, z0],
		[x0, y0, z1],
		[x1, y0, z1],
		[x1, y1, z1],
		[x0, y1, z1],
	];
	const faces = [
		[1, 2, 3, 4],
		[5, 8, 7, 6],
		[1, 5, 6, 2],
		[3, 7, 8, 4],
		[2, 6, 7, 3],
		[1, 4, 8, 5],
	];
	return [
		`g ${name}`,
		...corners.map((c) => `v ${c.join(" ")}`),
		// Quads, with the `a/b/c` form the exporter writes.
		...faces.map(
			(f) => `f ${f.map((i) => `${vertexBase + i}/${i}/${i}`).join(" ")}`,
		),
	].join("\n");
}

const IN = 1 / 25.4;
const mm = (v: number) => v * IN;

/** Depth runs 0..600 with the back at 0, so the front is the *low* end of the
 * raw depth axis — which is what the client's own export does, and the case
 * that mirrors the geometry. */
const CABINET = [
	inchBox("G-UEnd_(L)", [0, 0, 0], [mm(16), mm(600), mm(720)], 0),
	inchBox("G-UEnd_(R)", [mm(784), 0, 0], [mm(800), mm(600), mm(720)], 8),
	inchBox("G-UBack", [0, mm(584), 0], [mm(800), mm(600), mm(720)], 16),
	inchBox("Door_L_", [0, 0, 0], [mm(800), mm(16), mm(720)], 24),
	// A top and a bottom, because every cabinet has them and because the
	// up-axis vote needs the horizontals to outnumber the sides — which is the
	// whole reason `inferUpAxis` counts them.
	inchBox("G-Bottom", [mm(16), 0, 0], [mm(784), mm(584), mm(16)], 32),
	inchBox("G-Top", [mm(16), 0, mm(704)], [mm(784), mm(584), mm(720)], 40),
	inchBox(
		"G-Fixed_Shelf",
		[mm(16), 0, mm(400)],
		[mm(784), mm(584), mm(416)],
		48,
	),
].join("\n");

describe("readObjMesh", () => {
	it("triangulates quads and keeps every record", () => {
		const mesh = readObjMesh(CABINET);
		expect(mesh.records).toHaveLength(7);
		// Six quads a box, two triangles a quad, three indices a triangle.
		for (const record of mesh.records) {
			expect(record.indices).toHaveLength(6 * 2 * 3);
		}
		expect(mesh.positions).toHaveLength(7 * 8 * 3);
	});

	it("resolves negative face indices against the vertices so far", () => {
		const mesh = readObjMesh(
			["g Panel", "v 0 0 0", "v 1 0 0", "v 1 1 0", "f -3 -2 -1"].join("\n"),
		);
		expect(mesh.records[0].indices).toEqual([0, 1, 2]);
	});

	it("keeps faces written before any name, rather than dropping them", () => {
		const mesh = readObjMesh(
			["v 0 0 0", "v 1 0 0", "v 1 1 0", "f 1 2 3"].join("\n"),
		);
		expect(mesh.records).toHaveLength(1);
		expect(mesh.records[0].indices).toHaveLength(3);
	});
});

describe("buildRenderMesh", () => {
	const mesh = buildRenderMesh(CABINET);

	it("reads a file with no faces as nothing to draw", () => {
		expect(buildRenderMesh("v 0 0 0\nv 1 1 1\n")).toBeNull();
	});

	it("infers inches and Z-up rather than assuming them", () => {
		const [widthMm, depthMm, heightMm] = mesh?.sizeMm ?? [];
		expect(widthMm).toBeCloseTo(800, 0);
		expect(depthMm).toBeCloseTo(600, 0);
		expect(heightMm).toBeCloseTo(720, 0);
	});

	it("buckets triangles by what the drafter called them", () => {
		const roles = mesh?.groups.map((g) => g.role) ?? [];
		expect(roles).toContain("carcass");
		expect(roles).toContain("door");
		expect(roles).toContain("shelf");
		// Two ends and a back are one carcass group, not three.
		expect(roles.filter((r) => r === "carcass")).toHaveLength(1);
	});

	it("puts the cabinet in the frame Cabinet.tsx renders in", () => {
		const all = mesh?.groups.flatMap((g) => Array.from(g.positions)) ?? [];
		const axis = (i: number) => all.filter((_, n) => n % 3 === i);
		const x = axis(0);
		const y = axis(1);

		// x centred on the width.
		expect(Math.min(...x)).toBeCloseTo(-400, 0);
		expect(Math.max(...x)).toBeCloseTo(400, 0);
		// y measured up from the underside.
		expect(Math.min(...y)).toBeCloseTo(0, 0);
		expect(Math.max(...y)).toBeCloseTo(720, 0);
	});

	it("puts the door at +z, whichever end of the file's depth axis it was on", () => {
		const door = mesh?.groups.find((g) => g.role === "door");
		const carcass = mesh?.groups.find((g) => g.role === "carcass");
		expect(door).toBeDefined();
		// The back is at the far end from the door, and the door is the side the
		// customer stands at.
		expect(door?.bboxMm.max[2]).toBeGreaterThan(
			(carcass?.bboxMm.min[2] ?? 0) + 1,
		);
		expect(door?.bboxMm.max[2]).toBeCloseTo(300, 0);
	});

	it("keeps winding consistent when the depth axis is mirrored", () => {
		// A mirrored axis reverses triangle winding, which points every normal
		// inward and renders the cabinet black. Check the outward face of the
		// door: its normal must have a positive z.
		const door = mesh?.groups.find((g) => g.role === "door");
		if (!door) throw new Error("no door group");

		let outward = 0;
		for (let i = 0; i < door.indices.length; i += 3) {
			const p = (n: number) => [
				door.positions[door.indices[i + n] * 3],
				door.positions[door.indices[i + n] * 3 + 1],
				door.positions[door.indices[i + n] * 3 + 2],
			];
			const [a, b, c] = [p(0), p(1), p(2)];
			const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
			const nz = u[0] * v[1] - u[1] * v[0];
			// Face lying in the z plane at the front, normal along +z.
			if (a[2] > 290 && b[2] > 290 && c[2] > 290) outward += Math.sign(nz);
		}
		// Every triangle on the front face winds the same way.
		expect(Math.abs(outward)).toBeGreaterThan(0);
	});

	it("draws a record it cannot classify rather than dropping it", () => {
		const withJunk = `${CABINET}\n${inchBox(
			"_G-Object.041_(Loose_Mesh)",
			[mm(100), mm(100), 0],
			[mm(140), mm(140), mm(100)],
			56,
		)}`;
		const built = buildRenderMesh(withJunk);
		const roles = built?.groups.map((g) => g.role) ?? [];
		// In the client's own sample job this record is the adjustable feet.
		expect(roles.some((r) => r === "other" || r === "hardware")).toBe(true);
		expect(built?.triangleCount).toBeGreaterThan(mesh?.triangleCount ?? 0);
	});
});

describe("the binary format", () => {
	it("round-trips", () => {
		const built = buildRenderMesh(CABINET);
		if (!built) throw new Error("nothing built");

		const decoded = decodeRenderMesh(encodeRenderMesh(built));

		expect(decoded.triangleCount).toBe(built.triangleCount);
		expect(decoded.sizeMm).toEqual(built.sizeMm);
		expect(decoded.groups).toHaveLength(built.groups.length);
		for (const [i, group] of built.groups.entries()) {
			expect(decoded.groups[i].role).toBe(group.role);
			expect(Array.from(decoded.groups[i].indices)).toEqual(
				Array.from(group.indices),
			);
			expect(Array.from(decoded.groups[i].positions)).toEqual(
				Array.from(group.positions),
			);
			expect(decoded.groups[i].bboxMm).toEqual(group.bboxMm);
		}
	});

	it("survives being handed a view at an unaligned offset", () => {
		const built = buildRenderMesh(CABINET);
		if (!built) throw new Error("nothing built");
		const bytes = encodeRenderMesh(built);

		// What a Node Buffer from a fetch or a Blob read looks like: the same
		// bytes, at an offset that is not a multiple of four.
		const padded = new Uint8Array(bytes.length + 1);
		padded.set(bytes, 1);
		const view = padded.subarray(1);

		expect(decodeRenderMesh(view).triangleCount).toBe(built.triangleCount);
	});

	it("refuses bytes that are not a cabinet mesh", () => {
		expect(() => decodeRenderMesh(new Uint8Array(64))).toThrow();
	});
});

describe("splitDoorLeaves", () => {
	/** The same cabinet with its front hung as a pair, 4mm of reveal between the
	 * leaves — which is what the planner's own `DOOR_GAP_MM` draws. */
	const PAIR = [
		inchBox("G-UEnd_(L)", [0, 0, 0], [mm(16), mm(600), mm(720)], 0),
		inchBox("G-UEnd_(R)", [mm(784), 0, 0], [mm(800), mm(600), mm(720)], 8),
		inchBox("G-UBack", [0, mm(584), 0], [mm(800), mm(600), mm(720)], 16),
		inchBox("Door_L_", [0, 0, 0], [mm(398), mm(16), mm(720)], 24),
		inchBox("Door_R_", [mm(402), 0, 0], [mm(800), mm(16), mm(720)], 32),
		inchBox("G-Bottom", [mm(16), 0, 0], [mm(784), mm(584), mm(16)], 40),
		inchBox("G-Top", [mm(16), 0, mm(704)], [mm(784), mm(584), mm(720)], 48),
		// The shelf earns its place in the up-axis vote: without it the two end
		// panels tie with the top and bottom and the cabinet comes out on its side.
		inchBox(
			"G-Fixed_Shelf",
			[mm(16), 0, mm(400)],
			[mm(784), mm(584), mm(416)],
			56,
		),
	].join("\n");

	const doorOf = (obj: string) => {
		const group = buildRenderMesh(obj)?.groups.find((g) => g.role === "door");
		if (!group) throw new Error("no door group");
		return group;
	};

	it("cuts the merged group back into one leaf per door", () => {
		const leaves = splitDoorLeaves(doorOf(PAIR));
		expect(leaves).toHaveLength(2);

		// Left to right, and clear of each other: a leaf that overlapped its
		// neighbour would swing through it.
		const [left, right] = leaves;
		expect(left.bboxMm.max[0]).toBeLessThan(right.bboxMm.min[0]);
		// 800 wide, centred: each leaf is ~398 of it.
		expect(left.bboxMm.max[0] - left.bboxMm.min[0]).toBeCloseTo(398, 0);
		expect(right.bboxMm.max[0] - right.bboxMm.min[0]).toBeCloseTo(398, 0);
	});

	// The client's own exports: BC 600 draws its leaves 2.3mm apart, BC 800
	// exactly 3mm. A threshold of "more than 3mm" split only the 900, and the
	// other two swung open as one leaf.
	it.each([2.3, 3])("splits a pair drawn %smm apart", (revealMm) => {
		const pair = PAIR.replace(
			inchBox("Door_R_", [mm(402), 0, 0], [mm(800), mm(16), mm(720)], 32),
			inchBox(
				"Door_R_",
				[mm(398 + revealMm), 0, 0],
				[mm(800), mm(16), mm(720)],
				32,
			),
		);
		expect(splitDoorLeaves(doorOf(pair))).toHaveLength(2);
	});

	it("keeps every triangle", () => {
		const door = doorOf(PAIR);
		const split = splitDoorLeaves(door);
		const triangles = split.reduce((n, g) => n + g.indices.length / 3, 0);
		expect(triangles).toBe(door.indices.length / 3);
	});

	it("hands a single slab straight back, untouched", () => {
		const door = doorOf(CABINET);
		expect(splitDoorLeaves(door)).toEqual([door]);
	});
});

describe("the drafter's handedness survives intake", () => {
	/**
	 * `NAMING_RULES` matches a bare `\bdoor\b`, so `Door_L_` and `Door_R_` used
	 * to classify identically and the side was gone by the time anything drew
	 * the cabinet. It is carried now — but only where it says something the
	 * geometry does not.
	 */
	const doorOf = (obj: string) => {
		const mesh = buildRenderMesh(obj);
		if (!mesh) throw new Error("no mesh");
		const door = mesh.groups.find((g) => g.role === "door");
		if (!door) throw new Error("no door group");
		return door;
	};

	it("keeps the side of a lone door the drafter handed", () => {
		// CABINET carries a single `Door_L_`.
		expect(doorOf(CABINET).hingeSide).toBe("left");
	});

	it("leaves a pair alone, because the outward rule already answers it", () => {
		// A pair hinges outward from the middle — the only way a pair is hung —
		// so a name adds nothing, and `Door_L_` more likely means "the left-hand
		// leaf" than "hinged left".
		const PAIR = [
			inchBox("G-UEnd_(L)", [0, 0, 0], [mm(16), mm(600), mm(720)], 0),
			inchBox("G-UEnd_(R)", [mm(784), 0, 0], [mm(800), mm(600), mm(720)], 8),
			inchBox("G-UBack", [0, mm(584), 0], [mm(800), mm(600), mm(720)], 16),
			inchBox("Door_L_", [0, 0, 0], [mm(398), mm(16), mm(720)], 24),
			inchBox("Door_R_", [mm(402), 0, 0], [mm(800), mm(16), mm(720)], 32),
			inchBox("G-Bottom", [mm(16), 0, 0], [mm(784), mm(584), mm(16)], 40),
			inchBox("G-Top", [mm(16), 0, mm(704)], [mm(784), mm(584), mm(720)], 48),
			inchBox(
				"G-Fixed_Shelf",
				[mm(16), 0, mm(400)],
				[mm(784), mm(584), mm(416)],
				56,
			),
		].join("\n");
		expect(doorOf(PAIR).hingeSide).toBeUndefined();
	});

	it("survives the round trip through the binary", () => {
		const mesh = buildRenderMesh(CABINET);
		if (!mesh) throw new Error("no mesh");
		const back = decodeRenderMesh(encodeRenderMesh(mesh));
		expect(back.groups.find((g) => g.role === "door")?.hingeSide).toBe("left");
	});
});
