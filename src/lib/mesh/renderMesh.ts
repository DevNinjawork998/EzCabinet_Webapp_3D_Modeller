import type { HingeSide } from "@/lib/planner/layout";
import { normalise } from "./normalise";
import {
	coalesceParts,
	type MeshPart,
	panelName,
	readObj,
	readObjMesh,
	type Vec3,
} from "./objRead";
import {
	boundsOf,
	classify,
	hingeSideFromName,
	type PartRole,
	roleFromName,
} from "./roles";

/**
 * The drafted cabinet, ready to draw.
 *
 * This is the change of direction the whole planner turns on: the customer sees
 * the model Infinite Cabinet's drafter actually drew, not a box rebuilt from a
 * count of shelves. The drawing already exists — re-deriving it from eleven
 * numbers was both more work and less faithful, and it is why a Häfele Axilo 48
 * leveller was rendering as a plain grey cylinder.
 *
 * What this does *not* change: the customer still picks from a fixed set of
 * widths, because that is how the client manufactures. They already maintain
 * one export per width, so each rung of the size ladder stops being "regenerate
 * at this width" and becomes "fetch the file drawn at this width". Nothing the
 * customer can do is given up.
 *
 * ### Why the triangles are bucketed by role
 *
 * Two features carry the sale — the finish picker and the doors-open toggle —
 * and both need to know which triangles are fronts. So the mesh is not one
 * lump: `roles.ts` classifies each named record the drafter wrote (`Door_L_`,
 * `G-UEnd_(R)`) and the triangles are grouped by what they turned out to be.
 * The planner then paints *our* material per group. The drafter's own materials
 * are dropped on purpose — the export carries ~900KB of re-encoded texture
 * copies (`RotText12.jpg`) whose names no longer map to anything, and we
 * already have one 54KB grain tile tinted per finish.
 *
 * Classification happens here, once, on the server. The browser receives
 * grouped binary geometry and never sees an OBJ or a loader.
 *
 * ### Nothing is dropped
 *
 * A record `roles.ts` cannot place lands in `other` and is still drawn, with a
 * neutral material. `readObj` discards `G-Object.041` as carrying no design
 * intent it can read, but in the client's own sample job that record *is* the
 * adjustable feet. Unrecognised is not unwanted.
 */

/** What the planner paints a group with. Coarser than `PartRole` on purpose:
 * the renderer cares which *material* a triangle takes, not whether a board is
 * a top or a bottom. */
export type MeshGroupRole =
	| "carcass"
	| "door"
	| "drawerFront"
	| "shelf"
	| "hardware"
	| "other";

const GROUP_ROLES: MeshGroupRole[] = [
	"carcass",
	"door",
	"drawerFront",
	"shelf",
	"hardware",
	"other",
];

export type MeshGroup = {
	role: MeshGroupRole;
	/** Flat xyz in millimetres, in the cabinet's own frame: x centred on the
	 * width, y up from the cabinet's underside, z centred on the depth with the
	 * customer-facing side at +z. That is exactly the frame `Cabinet.tsx`
	 * renders its procedural boxes in, so placement math is unchanged. */
	positions: Float32Array;
	/** Local to this group's own `positions`. */
	indices: Uint32Array;
	/** The measuring tool's snap targets. Kept per group because a snap onto
	 * "the shelf" is worth more than a snap onto "the cabinet". */
	bboxMm: { min: Vec3; max: Vec3 };
	/**
	 * Which stile the drafter hung this door on, when they said so.
	 *
	 * Only ever set for a file holding a SINGLE door. A pair already hinges
	 * outward from the middle — the only way a pair is hung — so a name adds
	 * nothing there, and `Door_L_` more likely means "the left-hand leaf" than
	 * "hinged left". A lone leaf is the case where nothing else in the file
	 * says which stile, so it is the case worth carrying.
	 *
	 * Advisory, not authoritative: the customer's own choice rides in the
	 * layout document and reaches the SKU list, so this seeds a review in
	 * `/admin/cabinet-designs` rather than overriding what they picked.
	 */
	hingeSide?: HingeSide;
};

export type RenderMesh = {
	groups: MeshGroup[];
	/** Whole-cabinet extent in millimetres, `[width, depth, height]`. Agrees
	 * with `measureDesign` by construction — same reader, same normalisation. */
	sizeMm: Vec3;
	/** Triangles across every group, for the review table and a sanity gate. */
	triangleCount: number;
};

/** A design past this is not a cabinet — a whole room, or a file with the
 * client's furniture library left switched on. Refuse rather than ship it to a
 * phone on mobile data. The client's entire wall run is 13,896. */
export const MAX_TRIANGLES = 200_000;

const ROLE_GROUP: Record<PartRole, MeshGroupRole> = {
	end: "carcass",
	top: "carcass",
	bottom: "carcass",
	back: "carcass",
	// Drawer sides and bottoms are interior carcass board, and take the same
	// material as the box they sit in. Only the *front* is a finished face.
	drawerBox: "carcass",
	door: "door",
	drawerFront: "drawerFront",
	shelfAdjustable: "shelf",
	shelfFixed: "shelf",
	hardware: "hardware",
	unknown: "other",
};

/**
 * Which end of the depth axis the customer stands at, from a panel the drafter
 * actually named a front. Null when nothing in the file is named one.
 *
 * This beats every signal `inferFrontSide` has, and it is worth preferring
 * because those signals are about a *run*: handles (this cabinet has none — its
 * only hardware is four levellers) and how tightly the two ends of a row of
 * mixed-depth cabinets cluster (meaningless for a file holding one cabinet).
 * If the drafter typed `Door_L_`, that panel's side is the front.
 *
 * Names only, never `roleFromGeometry` — that decides door-versus-back *from*
 * the front side, so asking it here would be circular.
 */
function frontSideFromFronts(parts: MeshPart[]): "min" | "max" | null {
	const depths = parts
		.filter((part) => {
			const role = roleFromName(part.name);
			return role === "door" || role === "drawerFront";
		})
		.map((part) => part.minMm[1] + part.sizeMm[1] / 2);
	if (depths.length === 0) return null;

	const mid =
		(Math.min(...parts.map((p) => p.minMm[1])) +
			Math.max(...parts.map((p) => p.minMm[1] + p.sizeMm[1]))) /
		2;
	const avg = depths.reduce((sum, d) => sum + d, 0) / depths.length;
	return avg > mid ? "max" : "min";
}

/**
 * Reads a single-cabinet export into drawable geometry.
 *
 * Returns null for a file with no faces — a valid OBJ that is all construction
 * lines, or a `.zip` handed in by mistake. The caller keeps the procedural
 * fallback for that case rather than showing the customer nothing.
 */
export function buildRenderMesh(objText: string): RenderMesh | null {
	const mesh = readObjMesh(objText);
	if (mesh.records.length === 0 || mesh.positions.length === 0) return null;

	// The bounding-box pass, for scale, up-axis and roles. Normalise from the
	// records and coalesce after, the same way `measureDesign` does it: SketchUp
	// writes one board as several planar records, so uncoalesced every panel
	// reads as a face with a zero dimension — but the union is by name, so on a
	// file holding more than one cabinet it merges panels metres apart and robs
	// `inferUpAxis` of the horizontal boards it votes with. Inferring first, then
	// unioning, is what keeps a run standing up rather than on its end.
	const boxes = readObj(objText);
	const normalised = normalise(boxes.parts);
	const { panelThicknessMm, scaleFactor, order } = normalised;
	const parts = coalesceParts(normalised.parts);
	if (parts.length === 0) return null;

	// Settle which way the cabinet faces *before* classifying, because
	// `roleFromGeometry` tells a door from a back by which end of the depth axis
	// it sits at — so getting the front wrong gets every unnamed front wrong too.
	const measured = boundsOf(parts, panelThicknessMm);
	const bounds = {
		...measured,
		frontSide: frontSideFromFronts(parts) ?? measured.frontSide,
	};

	// The drafter's own handedness, kept only when the file holds exactly one
	// door. See `MeshGroup.hingeSide` for why a pair is deliberately left out.
	const namedSides = parts
		.map((part) => hingeSideFromName(part.name))
		.filter((side): side is HingeSide => side !== null);
	const hingeSide = namedSides.length === 1 ? namedSides[0] : undefined;

	const roleByName = new Map<string, PartRole>();
	for (const { part, role } of classify(parts, bounds)) {
		roleByName.set(part.name, role);
	}

	// The customer stands at +z. Which end of the depth axis that is varies by
	// file — the client's own export puts the wall at depth zero — so the axis
	// is flipped when the front turned out to be the low end. Flipping an axis
	// mirrors the geometry, which reverses triangle winding, so the indices are
	// emitted backwards to compensate. Without that every normal points inward
	// and the cabinet renders black.
	const depthSign = bounds.frontSide === "min" ? -1 : 1;

	const toMm = (raw: number[], i: number): Vec3 => [
		raw[i * 3 + order[0]] * scaleFactor,
		raw[i * 3 + order[1]] * scaleFactor * depthSign,
		raw[i * 3 + order[2]] * scaleFactor,
	];

	// Group the records first, then walk each group once. Doing the vertex
	// remap per group rather than per record is what keeps shared corners
	// shared — 286 records for seven cabinets, most of them slivers of the same
	// board.
	const byGroup = new Map<MeshGroupRole, number[][]>();
	for (const record of mesh.records) {
		const role = roleByName.get(panelName(record.name)) ?? "unknown";
		const group = ROLE_GROUP[role];
		const bucket = byGroup.get(group);
		if (bucket) bucket.push(record.indices);
		else byGroup.set(group, [record.indices]);
	}

	// One pass to find the cabinet's own frame. Every group is re-origined to
	// the same point, or the doors would drift away from the carcass.
	const lo: Vec3 = [Infinity, Infinity, Infinity];
	const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
	for (const buckets of byGroup.values()) {
		for (const indices of buckets) {
			for (const index of indices) {
				const p = toMm(mesh.positions, index);
				for (let a = 0; a < 3; a++) {
					if (p[a] < lo[a]) lo[a] = p[a];
					if (p[a] > hi[a]) hi[a] = p[a];
				}
			}
		}
	}
	if (!Number.isFinite(lo[0])) return null;

	// Still in normalised order here — `[along the wall, depth, height]`. Width
	// and depth are centred; height is measured up from the underside, which is
	// the frame `Cabinet.tsx` already positions cabinets in.
	const origin: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];

	const groups: MeshGroup[] = [];
	let triangleCount = 0;

	for (const role of GROUP_ROLES) {
		const buckets = byGroup.get(role);
		if (!buckets) continue;

		const remap = new Map<number, number>();
		const positions: number[] = [];
		const indices: number[] = [];
		const gLo: Vec3 = [Infinity, Infinity, Infinity];
		const gHi: Vec3 = [-Infinity, -Infinity, -Infinity];

		const vertexFor = (index: number) => {
			const found = remap.get(index);
			if (found !== undefined) return found;
			const p = toMm(mesh.positions, index);
			const local: Vec3 = [
				p[0] - origin[0],
				p[1] - origin[1],
				p[2] - origin[2],
			];
			const next = positions.length / 3;
			// Three.js is y-up; the normalised order is [wall, depth, height].
			const out: Vec3 = [local[0], local[2], local[1]];
			positions.push(out[0], out[1], out[2]);
			// Recorded in the same frame as the positions, because the measuring
			// tool snaps in scene space — a box in a different axis order would
			// put the dot on a face that isn't there.
			for (let a = 0; a < 3; a++) {
				if (out[a] < gLo[a]) gLo[a] = out[a];
				if (out[a] > gHi[a]) gHi[a] = out[a];
			}
			remap.set(index, next);
			return next;
		};

		for (const source of buckets) {
			for (let i = 0; i + 2 < source.length; i += 3) {
				const a = vertexFor(source[i]);
				const b = vertexFor(source[i + 1]);
				const c = vertexFor(source[i + 2]);
				if (depthSign < 0) indices.push(a, c, b);
				else indices.push(a, b, c);
				triangleCount++;
			}
		}

		if (indices.length === 0) continue;
		groups.push({
			role,
			positions: new Float32Array(positions),
			indices: new Uint32Array(indices),
			bboxMm: { min: gLo, max: gHi },
			...(role === "door" && hingeSide ? { hingeSide } : {}),
		});
	}

	if (groups.length === 0) return null;

	return {
		groups,
		sizeMm: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
		triangleCount,
	};
}

/**
 * The merged `door` group split back into one group per leaf.
 *
 * Triangles are bucketed by *role* at intake, so a pair of doors arrives as one
 * lump of geometry — fine for painting a finish on, useless for swinging one
 * leaf open while its neighbour stays shut. Splitting here rather than at intake
 * is deliberate: doing it there changes the binary header and needs every design
 * re-published, and the mesh URL carries the source file's sha256, so
 * regenerated bytes would sit behind an immutable cache keyed to unchanged
 * source. This is a sweep over a few dozen triangles and the caller memoises it.
 *
 * Leaves are found by the gap between them. A leaf's own face spans its whole
 * width, so any clear gap along x is a reveal — and the client draws those
 * tight: 2.3mm on BC 600, 3mm on BC 800, 3.3mm on BC 900. A 3mm threshold
 * split only the 900 and hung the other two as one leaf on one hinge. 1mm is
 * well clear of float noise and under any reveal a fitter would set. One
 * cluster returns the group untouched, so a slab front and every non-door
 * group cost nothing.
 */
export function splitDoorLeaves(group: MeshGroup, gapMm = 1): MeshGroup[] {
	const triangles = group.indices.length / 3;
	if (triangles < 2) return [group];

	// x-extent per triangle, which is what decides the leaf it belongs to.
	const spans: Array<{ tri: number; min: number; max: number }> = [];
	for (let t = 0; t < triangles; t++) {
		let min = Infinity;
		let max = -Infinity;
		for (let v = 0; v < 3; v++) {
			const x = group.positions[group.indices[t * 3 + v] * 3];
			if (x < min) min = x;
			if (x > max) max = x;
		}
		spans.push({ tri: t, min, max });
	}
	spans.sort((a, b) => a.min - b.min);

	// Sweep: a triangle starting beyond the running high-water mark plus the
	// reveal begins a new leaf.
	const clusters: number[][] = [];
	let current: number[] = [];
	let reach = -Infinity;
	for (const span of spans) {
		if (current.length > 0 && span.min > reach + gapMm) {
			clusters.push(current);
			current = [];
			reach = -Infinity;
		}
		current.push(span.tri);
		if (span.max > reach) reach = span.max;
	}
	if (current.length > 0) clusters.push(current);

	if (clusters.length < 2) return [group];

	return clusters.map((tris) => {
		const remap = new Map<number, number>();
		const positions: number[] = [];
		const indices: number[] = [];
		const min: Vec3 = [Infinity, Infinity, Infinity];
		const max: Vec3 = [-Infinity, -Infinity, -Infinity];

		const vertexFor = (index: number) => {
			const found = remap.get(index);
			if (found !== undefined) return found;
			const next = positions.length / 3;
			for (let a = 0; a < 3; a++) {
				const value = group.positions[index * 3 + a];
				positions.push(value);
				if (value < min[a]) min[a] = value;
				if (value > max[a]) max[a] = value;
			}
			remap.set(index, next);
			return next;
		};

		for (const t of tris) {
			indices.push(
				vertexFor(group.indices[t * 3]),
				vertexFor(group.indices[t * 3 + 1]),
				vertexFor(group.indices[t * 3 + 2]),
			);
		}

		return {
			role: group.role,
			positions: new Float32Array(positions),
			indices: new Uint32Array(indices),
			bboxMm: { min, max },
		};
	});
}

// ----------------------------------------------------------------- format --

/**
 * A self-describing binary: an ASCII magic, a JSON header, then the raw arrays.
 *
 * Not glTF. A GLB writer is a dependency and an exporter's worth of spec for a
 * file that only this app writes and only this app reads — the same reasoning
 * that made `scripts/generate-grain-texture.mjs` hand-roll a PNG rather than
 * take `pngjs` back. `BufferGeometry` accepts typed arrays directly, so the
 * browser side of this is a `DataView` and a `set()`.
 *
 * One file rather than a binary plus a sidecar row, so the planner needs one
 * fetch and the bytes are self-contained: a mesh in a cache never disagrees
 * with a group table in the database.
 *
 * ponytail: Float32 positions, no quantization. The client's whole wall run is
 * 176KB and one cabinet ~25KB, which gzips fine and is less than one of their
 * decor photos. Quantize to Int16 over the bbox (0.09mm at 6m) or move to
 * meshopt if a design ever lands that makes this hurt.
 */
const MAGIC = "ICBMESH1";
const HEADER_OFFSET = 12; // magic (8) + header length (4)

type HeaderGroup = {
	role: MeshGroupRole;
	vertexCount: number;
	indexCount: number;
	bboxMm: { min: Vec3; max: Vec3 };
	/** Optional, so a mesh built before this existed still decodes. */
	hingeSide?: HingeSide;
};

type Header = {
	groups: HeaderGroup[];
	sizeMm: Vec3;
	triangleCount: number;
};

/** Float32Array needs a 4-byte-aligned offset into its buffer. */
const align4 = (n: number) => (n + 3) & ~3;

export function encodeRenderMesh(mesh: RenderMesh): Uint8Array {
	const header: Header = {
		groups: mesh.groups.map((g) => ({
			role: g.role,
			vertexCount: g.positions.length / 3,
			indexCount: g.indices.length,
			bboxMm: g.bboxMm,
			...(g.hingeSide ? { hingeSide: g.hingeSide } : {}),
		})),
		sizeMm: mesh.sizeMm,
		triangleCount: mesh.triangleCount,
	};

	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	const bodyStart = align4(HEADER_OFFSET + headerBytes.length);
	const floats = mesh.groups.reduce((n, g) => n + g.positions.length, 0);
	const ints = mesh.groups.reduce((n, g) => n + g.indices.length, 0);

	const out = new Uint8Array(bodyStart + floats * 4 + ints * 4);
	const view = new DataView(out.buffer);

	for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
	view.setUint32(8, headerBytes.length, true);
	out.set(headerBytes, HEADER_OFFSET);

	let offset = bodyStart;
	for (const group of mesh.groups) {
		new Float32Array(out.buffer, offset, group.positions.length).set(
			group.positions,
		);
		offset += group.positions.length * 4;
	}
	for (const group of mesh.groups) {
		new Uint32Array(out.buffer, offset, group.indices.length).set(
			group.indices,
		);
		offset += group.indices.length * 4;
	}

	return out;
}

export function decodeRenderMesh(input: Uint8Array): RenderMesh {
	for (let i = 0; i < MAGIC.length; i++) {
		if (input[i] !== MAGIC.charCodeAt(i)) {
			throw new Error("not a cabinet mesh");
		}
	}

	// A typed array needs a 4-byte-aligned offset into its buffer, and these
	// bytes may be a view into a larger one that starts anywhere — Node's
	// `Buffer` pools small allocations at arbitrary offsets, which is exactly
	// how this fails in a test and not in a browser. Copy when it would throw.
	const bytes = input.byteOffset % 4 === 0 ? input : new Uint8Array(input);
	const base = bytes.byteOffset;
	const view = new DataView(bytes.buffer, base, bytes.byteLength);
	const headerLength = view.getUint32(8, true);
	const header: Header = JSON.parse(
		new TextDecoder().decode(
			bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLength),
		),
	);

	let offset = base + align4(HEADER_OFFSET + headerLength);
	const positions: Float32Array[] = [];
	for (const group of header.groups) {
		positions.push(
			new Float32Array(bytes.buffer, offset, group.vertexCount * 3).slice(),
		);
		offset += group.vertexCount * 3 * 4;
	}

	const groups: MeshGroup[] = header.groups.map((group, i) => {
		const indices = new Uint32Array(
			bytes.buffer,
			offset,
			group.indexCount,
		).slice();
		offset += group.indexCount * 4;
		return {
			role: group.role,
			positions: positions[i],
			indices,
			bboxMm: group.bboxMm,
			// Absent on every mesh built before handedness was carried, which is
			// exactly what the optional field is for — an old mesh decodes and the
			// renderer falls back to the outward rule.
			...(group.hingeSide ? { hingeSide: group.hingeSide } : {}),
		};
	});

	return {
		groups,
		sizeMm: header.sizeMm,
		triangleCount: header.triangleCount,
	};
}
