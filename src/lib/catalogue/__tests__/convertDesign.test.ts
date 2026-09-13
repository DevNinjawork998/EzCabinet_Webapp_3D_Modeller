import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Converting a design file on upload: a real cabinet gets its fit-out and a
 * render mesh written onto the row; a file that is not one cabinet is refused
 * with nothing written.
 *
 * Blob and Postgres are faked; the OBJ parse and the mesh build are real.
 */

/** One axis-aligned box as an OBJ object. `readObj` reads `o` and `v` only. */
function box(
	name: string,
	[x0, y0, z0]: number[],
	[x1, y1, z1]: number[],
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
	return [`o ${name}`, ...corners.map((c) => `v ${c.join(" ")}`)].join("\n");
}

/** An 800 × 880 × 600 carcass in millimetres, Y-up, 18mm board. */
const OBJ_TEXT = [
	box("G-UEnd_(L)", [0, 0, 0], [18, 880, 600]),
	box("G-UEnd_(R)", [782, 0, 0], [800, 880, 600]),
	box("G-Top", [18, 862, 0], [782, 880, 600]),
	box("G-Bottom", [18, 0, 0], [782, 18, 600]),
	box("G-Back", [18, 18, 0], [782, 862, 18]),
	box("G-Shelf", [18, 430, 18], [782, 448, 600]),
	box("G-Door(R)", [0, 0, 600], [800, 880, 618]),
].join("\n");

/**
 * What the client actually uploaded as "FLAT PACK": a 2400 x 3848 panel layout,
 * not an assembled cabinet. Nothing is 3,848mm tall — that is past every
 * ceiling the planner will let a customer set.
 */
const SHEET_OBJ_TEXT = [
	box("G-UEnd_(L)", [0, 0, 0], [18, 3848, 600]),
	box("G-UEnd_(R)", [2382, 0, 0], [2400, 3848, 600]),
	box("G-Top", [18, 3830, 0], [2382, 3848, 600]),
	box("G-Bottom", [18, 0, 0], [2382, 18, 600]),
	box("G-Back", [18, 18, 0], [2382, 3830, 18]),
	box("G-Shelf", [18, 1900, 18], [2382, 1918, 600]),
	box("G-Door(R)", [0, 0, 600], [2400, 3848, 618]),
].join("\n");

const state = vi.hoisted(() => ({
	updates: [] as { where: { id: string }; data: Record<string, unknown> }[],
}));

vi.mock("../db", () => ({
	prisma: {
		cabinetDesign: {
			update: async (args: (typeof state.updates)[number]) => {
				state.updates.push(args);
				return {};
			},
		},
	},
}));

vi.mock("../meshBlob", () => ({
	fetchMeshFile: async (pathname: string) =>
		Buffer.from(pathname.includes("sheet") ? SHEET_OBJ_TEXT : OBJ_TEXT, "utf8"),
	putRenderMeshFile: async () => undefined,
	renderMeshPathname: (id: string, sha: string) =>
		`render/${id}/${sha}.icbmesh`,
	sha256Hex: (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("hex"),
}));

const { convertDesign } = await import("../convertDesign");

const design = (id: string, widthMm = 800) => ({
	id,
	name: `Design ${id}`,
	filename: `${id}.obj`,
	blobPathname: `mesh/${id}/${id}.obj`,
	widthMm,
});

describe("convertDesign", () => {
	beforeEach(() => {
		state.updates = [];
	});

	it("writes the fit-out, and clears the mesh when the file draws nothing", async () => {
		// The fixture has vertices but no faces, so it measures as a cabinet and
		// yields no triangles — the soft failure: still sellable, drawn
		// procedurally, and never left pointing at a replaced file's mesh.
		const result = await convertDesign(design("a"));

		expect("ok" in result && result.meshNote).toMatch(/procedurally/);
		expect(state.updates).toHaveLength(1);
		const { where, data } = state.updates[0];
		expect(where.id).toBe("a");
		expect(data.geometry).toMatchObject({ doorLeaves: expect.any(Number) });
		expect(data.meshPathname).toBeNull();
		expect(data.meshBytes).toBeNull();
	});

	/**
	 * The guard this replaces compared the server's measurement against
	 * `design.widthMm` — which the upload form filled from that same
	 * measurement, so it was a number compared with itself and could never
	 * fire. A 2400 x 3848 panel layout walked straight into the catalogue as a
	 * "tall cabinet" priced at RM 8,000.
	 */
	it("refuses a file taller than any room the planner allows", async () => {
		const result = await convertDesign(design("sheet", 2400));

		expect("error" in result && result.error).toBe("taller_than_any_room");
		expect("message" in result && result.message).toContain("3848mm");
		// Nothing may be written from a refused file.
		expect(state.updates).toHaveLength(0);
	});
});
