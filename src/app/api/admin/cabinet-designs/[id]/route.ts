import { NextResponse } from "next/server";
import { z } from "zod";
import { convertDesign } from "@/lib/catalogue/convertDesign";
import { prisma } from "@/lib/catalogue/db";
import {
	deleteMeshFile,
	fetchMeshFile,
	sha256Hex,
} from "@/lib/catalogue/meshBlob";
import { readPublishedPlannerCatalogue } from "@/lib/catalogue/store";

export const runtime = "nodejs";

const patchSchema = z.object({
	blobUrl: z.string().min(1).optional(),
	blobPathname: z.string().min(1).optional(),
	filename: z.string().min(1).optional(),
	name: z.string().min(1).optional(),
	category: z
		.enum([
			"BASE_CABINET",
			"WALL_CABINET",
			"TALL_CABINET",
			"DRAWER_BASE",
			"FRIDGE_HOUSING",
		])
		.optional(),
	rooms: z
		.array(z.enum(["KITCHEN", "LIVING_ROOM", "BEDROOM", "FOYER"]))
		.min(1)
		.optional(),
	widthMm: z.number().int().positive().optional(),
	heightMm: z.number().int().positive().optional(),
	depthMm: z.number().int().positive().optional(),
	priceRm: z.number().min(0).optional(),
	weightKg: z.number().positive().nullable().optional(),
	sku: z.string().min(1).optional(),
	description: z.string().optional(),
	tags: z.string().optional(),
	finishes: z.array(z.string()).optional(),
	status: z.enum(["PUBLISHED", "ARCHIVED"]).optional(),
});

/** Edits are saved straight to the row; nothing reaches customers until the
 * catalogue is published. Archive/restore is PATCH with just `{ status }`. */
export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const existing = await prisma.cabinetDesign.findUnique({ where: { id } });
	if (!existing) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	const body = await request.json();
	const parsed = patchSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const { blobPathname, sku, ...rest } = parsed.data;

	if (sku && sku !== existing.sku) {
		const skuTaken = await prisma.cabinetDesign.findFirst({
			where: { sku, id: { not: id } },
		});
		if (skuTaken) {
			return NextResponse.json({ error: "sku_taken" }, { status: 409 });
		}
	}

	const replacing = !!blobPathname && blobPathname !== existing.blobPathname;
	let sha256: string | undefined;
	let sizeBytes: number | undefined;
	if (replacing) {
		const bytes = await fetchMeshFile(blobPathname);
		sha256 = sha256Hex(bytes);
		sizeBytes = bytes.byteLength;

		const dupe = await prisma.cabinetDesign.findFirst({
			where: { sha256, id: { not: id } },
		});
		if (dupe) {
			await deleteMeshFile(blobPathname);
			return NextResponse.json(
				{ error: "duplicate", designId: dupe.id },
				{ status: 409 },
			);
		}
	}

	const updated = await prisma.cabinetDesign.update({
		where: { id },
		data: {
			...rest,
			...(sku ? { sku } : {}),
			...(replacing ? { blobPathname, sha256, sizeBytes } : {}),
		},
	});

	let meshNote: string | null = null;
	if (replacing) {
		const converted = await convertDesign(updated);
		if ("error" in converted) {
			// Put the old file back rather than leave the row pointing at one that
			// was refused. The old blob is only deleted once the new one is good.
			await prisma.cabinetDesign.update({
				where: { id },
				data: {
					blobUrl: existing.blobUrl,
					blobPathname: existing.blobPathname,
					filename: existing.filename,
					sha256: existing.sha256,
					sizeBytes: existing.sizeBytes,
				},
			});
			await deleteMeshFile(blobPathname);
			return NextResponse.json(
				{ error: converted.error, message: converted.message },
				{ status: converted.status },
			);
		}
		meshNote = converted.meshNote;
		await deleteMeshFile(existing.blobPathname);
	}

	const design = await prisma.cabinetDesign.findUnique({ where: { id } });
	return NextResponse.json({ design, meshNote });
}

/**
 * Removes a design and the file behind it.
 *
 * Archiving is the reversible option; this is for a row that should never have
 * existed. A design customers can still place is refused: its family id is
 * this row's id, and deleting the row would leave a priced cabinet in the live
 * catalogue with nothing behind it — exactly how `Testing123` outlived its
 * design. Archive it and publish first; then it can go.
 *
 * The blob is deleted *after* the row. An orphaned file is a rounding error on
 * the storage bill; a row pointing at a file that is gone breaks every page
 * that renders the design.
 */
export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	const existing = await prisma.cabinetDesign.findUnique({ where: { id } });
	if (!existing) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	const published = await readPublishedPlannerCatalogue();
	if (published.data.families.some((family) => family.id === id)) {
		return NextResponse.json(
			{
				error: "in_planner",
				message: `${existing.name} is live in the planner. Archive it and publish, then delete it.`,
			},
			{ status: 409 },
		);
	}

	await prisma.cabinetDesign.delete({ where: { id } });

	try {
		await deleteMeshFile(existing.blobPathname);
	} catch {
		// The row is already gone, which is what the admin asked for. Losing the
		// blob cleanup is not worth failing the request over.
	}

	return NextResponse.json({ deleted: id });
}
