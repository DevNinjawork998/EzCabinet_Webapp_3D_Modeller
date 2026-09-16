/**
 * A mock L-shaped corner unit as OBJ text, in EzCabinet's SketchUp part naming.
 *
 * Millimetres, Y up, +z out into the room, drawn for the **left-hand** corner:
 * one arm runs along the back wall (x), the other along the left wall (z), and
 * the doors face into the L. Every part is a box, which is all `readObj` reads.
 *
 * Throwaway: replace with the client's real export when they draw one.
 */
type Box = {
	name: string;
	min: [number, number, number];
	max: [number, number, number];
};

function boxObj(box: Box, offset: number): string {
	const [x0, y0, z0] = box.min;
	const [x1, y1, z1] = box.max;
	const v = [
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
		[2, 6, 7, 3],
		[3, 7, 8, 4],
		[4, 8, 5, 1],
	];
	return [
		`o ${box.name}`,
		...v.map((p) => `v ${p.join(" ")}`),
		...faces.map((f) => `f ${f.map((i) => i + offset).join(" ")}`),
	].join("\n");
}

/**
 * An ordinary (non-corner) box cabinet, same naming and coordinate convention
 * as `cornerObj`. Exists to pin that a square *front* — width tied with
 * height, as an 600×600 or 900×900 base unit draws — is not mistaken for a
 * corner unit's square *footprint*. `inferUpAxis` tells them apart by which
 * axis the horizontal boards (top, bottom, shelf) are thin on; this fixture's
 * top/bottom/shelf are thin on height, same as any other box cabinet.
 */
export function boxCabinetObj({
	widthMm: w,
	heightMm: h,
	depthMm: d,
}: {
	widthMm: number;
	heightMm: number;
	depthMm: number;
}): string {
	const t = 16; // board
	const boxes: Box[] = [
		{ name: "G-UEnd_(L)", min: [0, 0, 0], max: [t, h, d] },
		{ name: "G-UEnd_(R)", min: [w - t, 0, 0], max: [w, h, d] },
		{ name: "G-Top", min: [0, h - t, 0], max: [w, h, d] },
		{ name: "G-Bottom", min: [0, 0, 0], max: [w, t, d] },
		{ name: "G-Back", min: [0, 0, 0], max: [w, h, t] },
		{
			name: "G-Adjustable_Shelf",
			min: [t, h / 2, t],
			max: [w - t, h / 2 + t, d - t],
		},
		{ name: "Door_L_", min: [t, t, d - 18], max: [w - t, h - t, d] },
	];
	return [
		"# Mock box cabinet — see src/lib/mesh/__tests__/cornerMock.ts",
		...boxes.map((box, i) => boxObj(box, i * 8)),
		"",
	].join("\n");
}

/**
 * A blind corner with one door: no adjustable shelf, neither `_Return` board,
 * and only `Door_L_` — the second arm has no separate front to name.
 *
 * Reproduces a real failure mode: with fewer named boards, the smallest axis
 * no longer strictly wins the plate vote (`G-Bottom`/`G-Top` are outvoted by
 * `G-UBack`/`G-UEnd_(L)`/`Door_L_`, all thin on the other tied axis), so the
 * corner branch in `inferUpAxis` declines and depth-first reads it lying on
 * its back — the vote margin between the two floor axes still looks
 * "decisive" on its own, which is exactly what used to let this through with
 * no warning.
 */
export function blindCornerObj({
	sizeMm: s,
	heightMm: h,
	armMm: a,
	legMm: l,
}: {
	sizeMm: number;
	heightMm: number;
	armMm: number;
	legMm: number;
}): string {
	const t = 16; // board
	const boxes: Box[] = [
		{ name: "G-UBack", min: [0, l, 0], max: [s, h, t] },
		{ name: "G-UBack_Return", min: [0, l, 0], max: [t, h, s] },
		{ name: "G-UEnd_(R)", min: [s - t, l, 0], max: [s, h, a] },
		{ name: "G-UEnd_(L)", min: [0, l, s - t], max: [a, h, s] },
		{ name: "G-Bottom", min: [0, l, 0], max: [s, l + t, a] },
		{ name: "G-Top", min: [0, h - t, 0], max: [s, h, a] },
		{ name: "Door_L_", min: [a, l + t, a - 18], max: [s - t, h - t, a] },
		// A wall unit hangs, so it has no feet.
		...(l > 0
			? [
					[40, 40],
					[s - 90, 40],
					[40, s - 90],
					[a - 90, a - 90],
				]
			: []
		).map(([x, z], i) => ({
			name: `Leveller_${i + 1}`,
			min: [x, 0, z] as [number, number, number],
			max: [x + 50, l, z + 50] as [number, number, number],
		})),
	];
	return [
		"# Mock blind corner unit — see src/lib/mesh/__tests__/cornerMock.ts",
		...boxes.map((box, i) => boxObj(box, i * 8)),
		"",
	].join("\n");
}

export function cornerObj({
	sizeMm: s,
	heightMm: h,
	armMm: a,
	legMm: l,
}: {
	sizeMm: number;
	heightMm: number;
	armMm: number;
	legMm: number;
}): string {
	const t = 16; // board
	const boxes: Box[] = [
		{ name: "G-UBack", min: [0, l, 0], max: [s, h, t] },
		{ name: "G-UBack_Return", min: [0, l, 0], max: [t, h, s] },
		{ name: "G-UEnd_(R)", min: [s - t, l, 0], max: [s, h, a] },
		{ name: "G-UEnd_(L)", min: [0, l, s - t], max: [a, h, s] },
		{ name: "G-Bottom", min: [0, l, 0], max: [s, l + t, a] },
		{ name: "G-Bottom_Return", min: [0, l, a], max: [a, l + t, s - t] },
		{ name: "G-Top", min: [0, h - t, 0], max: [s, h, a] },
		{ name: "G-Top_Return", min: [0, h - t, a], max: [a, h, s - t] },
		{
			name: "G-Adjustable_Shelf",
			min: [t, (l + h) / 2, t],
			max: [s - t, (l + h) / 2 + t, a - t],
		},
		{ name: "Door_L_", min: [a, l + t, a - 18], max: [s - t, h - t, a] },
		{ name: "Door_R_", min: [a - 18, l + t, a], max: [a, h - t, s - t] },
		// A wall unit hangs, so it has no feet.
		...(l > 0
			? [
					[40, 40],
					[s - 90, 40],
					[40, s - 90],
					[a - 90, a - 90],
				]
			: []
		).map(([x, z], i) => ({
			name: `Leveller_${i + 1}`,
			min: [x, 0, z] as [number, number, number],
			max: [x + 50, l, z + 50] as [number, number, number],
		})),
	];
	return [
		"# Mock corner unit — see src/lib/mesh/__tests__/cornerMock.ts",
		...boxes.map((box, i) => boxObj(box, i * 8)),
		"",
	].join("\n");
}
