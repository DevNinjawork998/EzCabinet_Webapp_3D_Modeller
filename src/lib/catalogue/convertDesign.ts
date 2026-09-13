import "server-only";
import type { CabinetDesign } from "@/generated/prisma/client";
import { objTextFromBytes } from "@/lib/mesh/archive";
import { measureDesign } from "@/lib/mesh/measureDesign";
import {
	buildRenderMesh,
	encodeRenderMesh,
	MAX_TRIANGLES,
	type MeshGroup,
} from "@/lib/mesh/renderMesh";
import { CEILING_LIMITS } from "@/lib/planner/catalogue";
import { type BoxMm, swingOf } from "@/lib/planner/swing";
import { prisma } from "./db";
import {
	fetchMeshFile,
	putRenderMeshFile,
	renderMeshPathname,
	sha256Hex,
} from "./meshBlob";

/**
 * Reads one uploaded design file into what the planner draws from, once, on
 * upload.
 *
 * Writes two things onto the row: `geometry` (what the file holds, for the
 * procedural fallback and the skirting) and the render mesh the customer's
 * browser draws. Price, name, box and rooms are never read from the file —
 * those are what the admin typed, and a parse wrong about a price is a
 * mispriced kitchen.
 *
 * The bytes are re-read from Blob. Trust comes from the file, never from what
 * a client claims about it.
 *
 * A file that is not one cabinet is **refused** and nothing is written. A file
 * that is one cabinet but will not convert to a mesh is **not** refused: the
 * planner draws it procedurally, which is still sellable, and `meshNote` says so.
 */

/** Above this multiple of the recorded width, the file is a run, not a unit.
 *
 * Only bites when a human typed the width. The upload form fills `widthMm`
 * from this very measurement, so on the ordinary path the two numbers are the
 * same number and this can never fire — which is why the absolute height bound
 * below exists rather than a second ratio. */
const MULTI_CABINET_RATIO = 1.5;

export type DesignFailure = {
	designId: string;
	name: string;
	error:
		| "file_unreachable"
		| "parse_failed"
		| "no_geometry"
		| "looks_like_a_run"
		| "taller_than_any_room";
	message: string;
	status: number;
};

export type Converted = { ok: true; meshNote: string | null };

type Convertible = Pick<
	CabinetDesign,
	"id" | "name" | "filename" | "blobPathname" | "widthMm"
>;

export async function convertDesign(
	design: Convertible,
): Promise<Converted | DesignFailure> {
	const fail = (
		error: DesignFailure["error"],
		message: string,
		status: number,
	): DesignFailure => ({
		designId: design.id,
		name: design.name,
		error,
		message,
		status,
	});

	let measured: ReturnType<typeof measureDesign>;
	let objText = "";
	try {
		const bytes = await fetchMeshFile(design.blobPathname);
		objText = objTextFromBytes(bytes);
		measured = measureDesign(objText);
	} catch (error) {
		// Two very different failures land here: the file could not be fetched
		// from Blob (wrong or expired token, most often a local env that has not
		// run `vercel env pull`), or it fetched and would not parse. Say which,
		// because the fixes are nothing alike.
		const message = (error as Error).message;
		const unreachable = /blob|403|401|forbidden|denied/i.test(message);
		return unreachable
			? fail(
					"file_unreachable",
					`Could not read ${design.filename} from storage (${message}). This is blob access, so check BLOB_READ_WRITE_TOKEN.`,
					502,
				)
			: fail(
					"parse_failed",
					`Could not parse ${design.filename}: ${message}`,
					422,
				);
	}

	if (!measured) {
		return fail(
			"no_geometry",
			`No geometry could be read from ${design.filename}, so there is nothing to draw.`,
			422,
		);
	}

	// A design file that measures far wider than the row claims is not this
	// cabinet — it is the whole run the cabinet came out of.
	if (measured.widthMm > design.widthMm * MULTI_CABINET_RATIO) {
		return fail(
			"looks_like_a_run",
			`${design.filename} measures ${measured.widthMm}mm wide but this design is recorded as ${design.widthMm}mm. That file looks like a whole run rather than one cabinet — attach the single-cabinet export.`,
			409,
		);
	}

	// The check that actually catches a file which is not one cabinet. A
	// 2400 x 3848 flat-pack panel layout once walked into the live catalogue as a
	// "tall cabinet" at RM 8,000. A customer cannot set a ceiling above
	// `CEILING_LIMITS.maxMm`, so a cabinet taller than that fits in no room.
	if (measured.heightMm > CEILING_LIMITS.maxMm) {
		return fail(
			"taller_than_any_room",
			`${design.filename} measures ${measured.heightMm}mm tall, past the ${CEILING_LIMITS.maxMm}mm ceiling a customer can plan against — so it fits in no room. That file is a run or a flat-pack panel layout rather than one assembled cabinet. Attach the single-cabinet export.`,
			409,
		);
	}

	let meshNote: string | null = null;
	// Cleared on every conversion that does not produce a mesh, so a replaced
	// file can never keep drawing the model of the one it replaced.
	let mesh: {
		meshPathname: string | null;
		meshBytes: number | null;
		meshGroups?: object[];
	} = { meshPathname: null, meshBytes: null };
	try {
		const built = buildRenderMesh(objText);
		if (!built) {
			meshNote = `No drawable geometry in ${design.filename} — the planner will draw this cabinet procedurally.`;
		} else if (built.triangleCount > MAX_TRIANGLES) {
			meshNote = `${design.filename} holds ${built.triangleCount.toLocaleString()} triangles, past the ${MAX_TRIANGLES.toLocaleString()} a customer on mobile data should download. Drawing this one procedurally instead.`;
		} else {
			const bytes = encodeRenderMesh(built);
			// Hashed on the mesh, not on the source: the URL is immutable for a
			// year, so it has to move when a `lib/mesh` fix rewrites the geometry
			// out of an unchanged source file.
			const pathname = renderMeshPathname(design.id, sha256Hex(bytes));
			await putRenderMeshFile(pathname, bytes);
			mesh = {
				meshPathname: pathname,
				meshBytes: bytes.length,
				meshGroups: built.groups.map((group) => ({
					role: group.role,
					triangles: group.indices.length / 3,
					// How this door will actually behave when a customer opens it,
					// recorded so a wrong reading is visible in the admin table
					// before it is in front of a customer.
					...(group.role === "door"
						? {
								hingeSide: group.hingeSide ?? null,
								fit: swingOf(
									boxOf(group.bboxMm),
									carcassBox(built.groups, group),
									group.hingeSide ?? "left",
								).fit,
							}
						: {}),
				})),
			};
		}
	} catch (error) {
		meshNote = `Could not build a render mesh from ${design.filename} (${(error as Error).message}). The planner will draw this cabinet procedurally.`;
	}

	await prisma.cabinetDesign.update({
		where: { id: design.id },
		data: { geometry: measured.geometry, ...mesh },
	});

	return { ok: true, meshNote };
}

/** The mesh carries a bbox as two triples; `swingOf` works in `{x,y,z}`. */
const boxOf = (bbox: MeshGroup["bboxMm"]): BoxMm => ({
	min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] },
	max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] },
});

/**
 * The box a design's doors hang on.
 *
 * Without a carcass group there is nothing to compare a leaf's back face
 * against, so fall back to a front plane sitting exactly on that back face —
 * the overlay reading, and what every design the client has sent so far
 * actually is.
 */
function carcassBox(groups: MeshGroup[], door: MeshGroup): BoxMm {
	const carcass = groups.find((group) => group.role === "carcass");
	if (carcass) return boxOf(carcass.bboxMm);
	const leaf = boxOf(door.bboxMm);
	return { ...leaf, max: { ...leaf.max, z: leaf.min.z } };
}
