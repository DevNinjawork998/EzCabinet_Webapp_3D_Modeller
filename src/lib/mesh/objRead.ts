/**
 * Reads a Wavefront OBJ export of one of EzCabinet's designs into
 * named, axis-aligned boxes.
 *
 * This replaced an `openskp` reader: a `.skp` is a SketchUp-proprietary
 * container that only SketchUp reads reliably, so the client exports OBJ
 * instead. Nothing else changed about intake — the file is still a reference
 * for design intent, never a runtime asset. The browser only ever sees the
 * published catalogue.
 *
 * We read part names and `v` positions and nothing else. Faces, normals and UVs
 * are the bulk of the file and none of them tell us anything a bounding box
 * doesn't: every cabinet part is a rectangular panel. Skipping them keeps a
 * 20 MB export as cheap as a 1 MB one.
 *
 * Coordinates come out exactly as the file wrote them — whatever units, whatever
 * axis is up. Guessing that here would bake one exporter's habits into the
 * parser; `normalise.ts` infers both from the geometry instead.
 */

export type Vec3 = [number, number, number];

/**
 * One named box: a panel, a door, a shelf, a drawer side, a knob.
 *
 * After `normalise`, bounds are millimetres ordered `[along the wall, depth,
 * height]`. Straight out of `readObj` they are still the file's own units and
 * axis order — the type is shared because nothing but `normalise` should ever
 * look at a part before it has been normalised.
 */
export type MeshPart = {
	name: string;
	minMm: Vec3;
	sizeMm: Vec3;
};

/** One cabinet: an interval between two end panels, and what sits inside it. */
export type MeshModule = {
	name: string;
	minMm: Vec3;
	sizeMm: Vec3;
	parts: MeshPart[];
};

export type ObjRead = {
	version: string;
	parts: MeshPart[];
	droppedCount: number;
};

/**
 * Blender's copy suffix (`G-Top.017`) and its wrapper for geometry that lost
 * its parent (`_G-Object.001_(Loose_Mesh)`). Neither is a variant, so both
 * collapse to the base name before anything counts parts.
 */
export function baseName(name: string): string {
	return name
		.replace(/^_/, "")
		.replace(/_\(Loose_Mesh\)$/, "")
		.replace(/\.\d{3}$/, "")
		.trim();
}

/**
 * The name of the part a line starts, or null if the line does not start one.
 *
 * Blender writes `o <name>`. SketchUp writes no `o` lines at all — it uses
 * groups, and puts the whole component path on them:
 *
 *     g Mesh9 UEnd__L_1 Base_Cabinet Model
 *
 * The leading `Mesh<n>` is the exporter's own counter and the trailing tokens
 * are the parents the component sits under. Nested components add anonymous
 * `Group<n>` wrappers on the way down:
 *
 *     g Mesh38 Group16 Group13 Hafele_Axilo_48_Leg_Leveller_2_1 Base_Cabinet Model
 *
 * so "the token after the mesh id" is not good enough — it would name that leg
 * `Group16`. The first token the drafter actually typed is the first one that
 * is neither a mesh id nor an anonymous group.
 */
export function partNameFrom(line: string): string | null {
	if (line.startsWith("o ")) return line.slice(2).trim() || null;
	if (!line.startsWith("g ")) return null;

	const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;
	const named = tokens.find((t) => !/^(mesh|group)\d+$/i.test(t));
	return named ?? tokens[0];
}

/**
 * `G-Object.041` is what the exporter calls geometry with no name of its own —
 * in the sample job, the adjustable feet. It carries no design intent we can
 * read, so it never reaches the catalogue.
 */
const isJunk = (name: string) => /^_?G-Object\b/.test(name);

export function readObj(text: string): ObjRead {
	const boxes: { name: string; lo: Vec3; hi: Vec3 }[] = [];
	let version = "unknown";
	let current: { name: string; lo: Vec3; hi: Vec3 } | null = null;

	// A file that has `o` records uses them; `g` is only consulted when there
	// are none. Some exporters write both, and the `g` there is a material or
	// smoothing group rather than a part — splitting on it would shatter every
	// panel into fragments.
	const hasObjects = /^o /m.test(text);

	for (const line of text.split("\n")) {
		const name = hasObjects
			? line.startsWith("o ")
				? partNameFrom(line)
				: null
			: partNameFrom(line);
		if (name !== null) {
			current = {
				name,
				lo: [Infinity, Infinity, Infinity],
				hi: [-Infinity, -Infinity, -Infinity],
			};
			boxes.push(current);
			continue;
		}
		if (line.startsWith("v ") && current) {
			const p = line.slice(2).trim().split(/\s+/).map(Number);
			for (let i = 0; i < 3; i++) {
				if (p[i] < current.lo[i]) current.lo[i] = p[i];
				if (p[i] > current.hi[i]) current.hi[i] = p[i];
			}
			continue;
		}
		if (version === "unknown" && line.startsWith("# ") && line.length > 3) {
			version = line.slice(2).trim();
		}
	}

	// Same base name at the same bounds is one panel the exporter split across
	// several `o` records, once per material. Counting those separately would
	// triple every shelf in the part list.
	const seen = new Set<string>();
	const parts: MeshPart[] = [];
	let droppedCount = 0;

	for (const box of boxes) {
		if (!Number.isFinite(box.lo[0])) continue; // no vertices
		const name = baseName(box.name);
		if (isJunk(name)) {
			droppedCount++;
			continue;
		}
		const minMm = box.lo as Vec3;
		const sizeMm = box.hi.map((v, i) => v - box.lo[i]) as Vec3;
		const key = `${name}|${minMm.map(key6).join(",")}|${sizeMm.map(key6).join(",")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		parts.push({ name, minMm, sizeMm });
	}

	return { version, parts, droppedCount };
}

/** Dedupe key only. Units are still the file's here, so round fine, not to mm. */
const key6 = (v: number) => v.toFixed(6);

/**
 * Strips the counter an exporter adds when it splits one panel across records:
 * `UEnd__L_1` and `UEnd__L_2` are the same left end panel, `Top1` the same top.
 *
 * Deliberately not the same as `baseName`, which removes Blender's `.017`
 * copy suffix. This removes a *trailing* run of digits, which is what SketchUp
 * appends, and keeps everything a drafter actually typed — `Door_L_` stays
 * distinct from `Door_R_`.
 */
export const panelName = (name: string) => name.replace(/\d+$/, "");

/**
 * Unions the records that make up one panel.
 *
 * SketchUp writes a single board as several `g` groups, each a planar face, so
 * every one of them has a zero dimension: the client's `BC 800mm.obj` reads its
 * shelf as `767 × 0 × 16` and its back as `800 × 0 × 770`. Anything downstream
 * that asks "is this a solid part" — `geometryOf`, the cut list — then throws
 * the whole panel away, which is why a cabinet with a shelf, a back and four
 * legs rendered as an empty box on a plinth.
 *
 * Unioning the boxes recovers the real board: `767 × 534 × 16`.
 *
 * **Only safe on a file that holds one cabinet.** Two cabinets side by side in
 * a run have same-named panels that touch, so unioning across a whole wall
 * merges their shelves into one and collapses the file — measured on the
 * `flat-pack` fixture: 154 parts down to 22, three shelves down to one. The
 * run-import path has to coalesce *inside* each grouped module instead, after
 * `groupModules` has decided where one cabinet ends.
 */
export function coalesceParts(parts: MeshPart[]): MeshPart[] {
	const merged = new Map<string, { lo: Vec3; hi: Vec3 }>();
	const order: string[] = [];

	for (const part of parts) {
		const key = panelName(part.name);
		const lo = part.minMm;
		const hi = part.minMm.map((v, i) => v + part.sizeMm[i]) as Vec3;
		const found = merged.get(key);
		if (!found) {
			merged.set(key, { lo: [...lo] as Vec3, hi: [...hi] as Vec3 });
			order.push(key);
			continue;
		}
		for (let i = 0; i < 3; i++) {
			found.lo[i] = Math.min(found.lo[i], lo[i]);
			found.hi[i] = Math.max(found.hi[i], hi[i]);
		}
	}

	return order.map((name) => {
		const box = merged.get(name) as { lo: Vec3; hi: Vec3 };
		return {
			name,
			minMm: box.lo,
			sizeMm: box.hi.map((v, i) => v - box.lo[i]) as Vec3,
		};
	});
}

// ------------------------------------------------------------------ faces --

/**
 * One named record's triangles, indexing into the file's global vertex list.
 *
 * Deliberately still in the file's own coordinates. `renderMesh.ts` puts them
 * through the scale and axis permutation `normalise` inferred, so the mesh and
 * the bounding boxes can never disagree about which way is up.
 */
export type ObjMeshRecord = {
	name: string;
	/** Into `ObjMesh.positions`, three per triangle. */
	indices: number[];
};

export type ObjMesh = {
	/** Flat xyz, raw file units, shared by every record — OBJ face indices are
	 * global, so keeping one array is both smaller and closer to the file. */
	positions: number[];
	records: ObjMeshRecord[];
};

/**
 * The second pass: the faces `readObj` throws away.
 *
 * `readObj` reads names and bounding boxes and nothing else, which is right for
 * measuring — every cabinet part is a rectangular panel, so a box tells you as
 * much as the mesh does, and it keeps a 20 MB export as cheap as a 1 MB one.
 * It is not right for *drawing*, which is what this is for: the planner renders
 * the model the drafter actually drew, so it needs the triangles.
 *
 * Kept as a separate function rather than a flag on `readObj` so the measuring
 * path keeps its fast, allocation-light pass untouched.
 *
 * **Nothing is dropped here.** `readObj` discards `G-Object.041` because it
 * carries no design intent it can read — but in the client's own sample job
 * that record *is* the adjustable feet, and dropping real geometry is exactly
 * the failure this whole change exists to fix. Unrecognised is not the same as
 * unwanted: it gets a neutral material downstream, not a bin.
 */
export function readObjMesh(text: string): ObjMesh {
	const positions: number[] = [];
	const records: ObjMeshRecord[] = [];

	// Same rule as `readObj`, and it has to stay the same rule: the two passes
	// name records identically or the roles classified from one cannot be
	// applied to the other.
	const hasObjects = /^o /m.test(text);

	// Faces can appear before any `o`/`g` line. They are still geometry.
	let current: ObjMeshRecord = { name: "unnamed", indices: [] };
	records.push(current);

	for (const line of text.split("\n")) {
		if (line.startsWith("v ")) {
			const p = line.slice(2).trim().split(/\s+/);
			positions.push(Number(p[0]), Number(p[1]), Number(p[2]));
			continue;
		}

		if (line.startsWith("f ")) {
			const corners = line.slice(2).trim().split(/\s+/);
			const vertexCount = positions.length / 3;
			const resolved: number[] = [];
			for (const corner of corners) {
				// `f a`, `f a/b`, `f a//c`, `f a/b/c` — only the position index
				// matters; normals are recomputed and there are no UVs to keep.
				const raw = Number.parseInt(corner.split("/")[0], 10);
				if (!Number.isFinite(raw) || raw === 0) continue;
				// Negative indices are legal and count back from the end of the
				// list *so far*, which is why `vertexCount` is read per face
				// rather than once at the end.
				const index = raw > 0 ? raw - 1 : vertexCount + raw;
				if (index < 0 || index >= vertexCount) continue;
				resolved.push(index);
			}
			// Fan-triangulate. SketchUp exports quads and the occasional n-gon;
			// cabinet faces are planar and convex, so a fan is exact.
			for (let i = 1; i + 1 < resolved.length; i++) {
				current.indices.push(resolved[0], resolved[i], resolved[i + 1]);
			}
			continue;
		}

		const name = hasObjects
			? line.startsWith("o ")
				? partNameFrom(line)
				: null
			: partNameFrom(line);
		if (name !== null) {
			current = { name: baseName(name), indices: [] };
			records.push(current);
		}
	}

	return { positions, records: records.filter((r) => r.indices.length > 0) };
}
