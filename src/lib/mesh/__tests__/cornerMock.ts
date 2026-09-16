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
