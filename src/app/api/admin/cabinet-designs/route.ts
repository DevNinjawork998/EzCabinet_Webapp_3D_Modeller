import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { convertDesign } from "@/lib/catalogue/convertDesign";
import { prisma } from "@/lib/catalogue/db";
import {
	deleteMeshFile,
	fetchMeshFile,
	MESH_PATHNAME,
	sha256Hex,
} from "@/lib/catalogue/meshBlob";
import { readPublishedPlannerCatalogue } from "@/lib/catalogue/store";

export const runtime = "nodejs";

const createSchema = z.object({
	blobUrl: z.string().min(1),
	// Only a path the upload token could have issued. This route reads and
	// deletes whatever it is given, so any other private blob is out of bounds.
	blobPathname: z.string().regex(MESH_PATHNAME),
	filename: z.string().min(1),
	name: z.string().min(1),
	category: z.enum([
		"BASE_CABINET",
		"WALL_CABINET",
		"TALL_CABINET",
		"DRAWER_BASE",
		"FRIDGE_HOUSING",
		"CORNER_BASE_CABINET",
		"CORNER_WALL_CABINET",
	]),
	rooms: z.array(z.enum(["KITCHEN", "LIVING_ROOM", "BEDROOM", "FOYER"])).min(1),
	widthMm: z.number().int().positive(),
	heightMm: z.number().int().positive(),
	depthMm: z.number().int().positive(),
	priceRm: z.number().min(0),
	weightKg: z.number().positive().nullable().default(null),
	sku: z.string().min(1),
	description: z.string().optional(),
	tags: z.string().optional(),
	finishes: z.array(z.string()).default([]),
	status: z.enum(["PUBLISHED", "ARCHIVED"]).default("PUBLISHED"),
});

/**
 * The library, plus the catalogue customers see today.
 *
 * The page rebuilds the catalogue from these rows itself to count what is not
 * live yet, so it needs the published document to compare against — read
 * uncached, because it is usually asked right after a publish.
 */
export const GET = withAuth("catalogue:read", async () => {
	const [designs, published] = await Promise.all([
		prisma.cabinetDesign.findMany({ orderBy: { updatedAt: "desc" } }),
		readPublishedPlannerCatalogue(),
	]);
	return NextResponse.json({
		designs,
		published: { version: published.version, data: published.data },
	});
});

/**
 * Saves a design and converts its file in the same request.
 *
 * Converting here rather than at publish means a file that is not one cabinet
 * is refused while the admin is still looking at it, instead of surfacing later
 * as a publish failure nobody connects to the upload.
 */
export const POST = withAuth("catalogue:write", async (request) => {
	const body = await request.json();
	const parsed = createSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const { blobPathname, ...data } = parsed.data;

	const bytes = await fetchMeshFile(blobPathname);
	const sha256 = sha256Hex(bytes);

	const existing = await prisma.cabinetDesign.findUnique({ where: { sha256 } });
	if (existing) {
		await deleteMeshFile(blobPathname);
		return NextResponse.json(
			{ error: "duplicate", designId: existing.id },
			{ status: 409 },
		);
	}

	const skuTaken = await prisma.cabinetDesign.findUnique({
		where: { sku: data.sku },
	});
	if (skuTaken) {
		await deleteMeshFile(blobPathname);
		return NextResponse.json({ error: "sku_taken" }, { status: 409 });
	}

	const uploadedBy = "admin"; // ponytail: shared-secret auth, no per-user identity yet

	const created = await prisma.cabinetDesign.create({
		data: {
			...data,
			blobPathname,
			sizeBytes: bytes.byteLength,
			sha256,
			uploadedBy,
		},
	});

	const converted = await convertDesign(created);
	if ("error" in converted) {
		// A refused file is not a design. Keeping the row would leave a cabinet
		// in the library that the next publish puts in front of customers.
		await prisma.cabinetDesign.delete({ where: { id: created.id } });
		await deleteMeshFile(blobPathname);
		return NextResponse.json(
			{ error: converted.error, message: converted.message },
			{ status: converted.status },
		);
	}

	const design = await prisma.cabinetDesign.findUnique({
		where: { id: created.id },
	});
	return NextResponse.json({ design, meshNote: converted.meshNote });
});
