import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/catalogue/db";
import {
	deleteMeshFile,
	fetchMeshFile,
	sha256Hex,
} from "@/lib/catalogue/meshBlob";
import { publishVersion } from "@/lib/catalogue/publishVersion";
import { removeDesign } from "@/lib/catalogue/removeDesign";
import { getPublishedPlannerCatalogue } from "@/lib/catalogue/store";
import {
	createDraftVersion,
	latestDraftVersion,
	mergeBase,
} from "@/lib/catalogue/versions";
import { plannerCatalogueSchema } from "@/lib/planner/catalogueSchema";

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
	room: z.enum(["KITCHEN", "LIVING_ROOM", "BEDROOM", "FOYER"]).optional(),
	widthMm: z.number().int().positive().optional(),
	heightMm: z.number().int().positive().optional(),
	depthMm: z.number().int().positive().optional(),
	priceRm: z.number().min(0).optional(),
	sku: z.string().min(1).optional(),
	description: z.string().optional(),
	tags: z.string().optional(),
	finishes: z.array(z.string()).optional(),
	status: z.enum(["PUBLISHED", "ARCHIVED"]).optional(),
});

/** No immutability/versioning here — unlike CatalogueVersion, edits are
 * always allowed regardless of current status. This is also how the
 * Archive/Publish toggle works: PATCH with just { status }. */
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

	let sha256: string | undefined;
	let sizeBytes: number | undefined;
	if (blobPathname && blobPathname !== existing.blobPathname) {
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
		// Replacing the file — the old blob is no longer referenced by any row.
		await deleteMeshFile(existing.blobPathname);
	}

	const updated = await prisma.cabinetDesign.update({
		where: { id },
		data: {
			...rest,
			...(sku ? { sku } : {}),
			...(blobPathname ? { blobPathname, sha256, sizeBytes } : {}),
		},
	});

	return NextResponse.json({ design: updated });
}

/**
 * Removes a design and the file behind it.
 *
 * Archiving is the reversible option and stays the default the UI leads with;
 * this is for a row that should never have existed — a wrong file, a
 * duplicate, a test upload. Both the row and the blob go, because a blob no
 * row points at is unreachable: nothing else in the app can find it again, so
 * leaving it behind is a bill and not a backup.
 *
 * The blob is deleted *after* the row, deliberately. If the delete fails
 * partway, an orphaned file is a rounding error on the storage bill, whereas a
 * row pointing at a file that is already gone breaks every page that renders
 * the design.
 *
 * **A design that is in the planner is not deleted silently.** Families live
 * inside a `CatalogueVersion`'s JSON, not in a table, so Postgres cannot
 * enforce this with a foreign key — deleting the row alone would leave a family
 * in the catalogue that nothing points at, priced and visible to customers,
 * with no way left to find where it came from. That is exactly how the
 * "Testing123" family outlived its design.
 *
 * So the caller says which it means. Without `?fromPlanner=1` this refuses with
 * the family it found, which is what the admin page turns into a confirm
 * dialog; with it, the cabinet comes out of the catalogue, that version is
 * published, and only then is the row deleted. It used to send the admin to
 * `/admin/catalogue` to do the first two by hand, which is two page hops for
 * what is one intent.
 */
export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const fromPlanner =
		new URL(request.url).searchParams.get("fromPlanner") === "1";

	const existing = await prisma.cabinetDesign.findUnique({ where: { id } });
	if (!existing) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	if (existing.familyId) {
		// The same base a design *push* would build on: the open draft when it is
		// newer than live, otherwise the published catalogue. Checking only the
		// published one would let a design be deleted out from under a family
		// sitting in a draft — which publishes the orphan rather than preventing
		// it.
		const published = await getPublishedPlannerCatalogue();
		const openDraft = await latestDraftVersion("PLANNER");
		const chosen = mergeBase(
			{ id: published.id, version: published.version },
			openDraft && { id: openDraft.id, version: openDraft.version },
		);
		const onDraft = openDraft && chosen.id === openDraft.id ? openDraft : null;
		const base = onDraft
			? plannerCatalogueSchema.parse(onDraft.data)
			: published.data;

		const family = base.families.find((f) => f.id === existing.familyId);
		if (family) {
			if (!fromPlanner) {
				const rung = family.sizes.length > 1 ? ` ${existing.widthMm}mm` : "";
				return NextResponse.json(
					{
						error: "in_planner",
						familyId: family.id,
						familyLabel: family.label,
						live: onDraft === null,
						message: `This design is in the planner as "${family.label}"${rung}. Deleting it removes that cabinet from the catalogue and publishes the change.`,
					},
					{ status: 409 },
				);
			}

			const removal = removeDesign(base, {
				familyId: existing.familyId,
				widthMm: existing.widthMm,
			});
			if (!removal.ok) {
				return NextResponse.json(
					{ error: "cannot_remove", message: removal.message },
					{ status: 409 },
				);
			}
			if (removal.changed) {
				const draft = await createDraftVersion({
					product: "PLANNER",
					data: removal.catalogue,
					note: `${existing.name} (${existing.sku}) removed from the design library`,
				});
				const result = await publishVersion(draft.id);
				if (!result.ok) {
					// The row still exists and still points at the family, so the
					// catalogue and the library agree — nothing is orphaned, and
					// retrying is safe.
					return NextResponse.json(
						{
							error: result.error,
							message:
								"Could not publish the catalogue without this cabinet, so the design was kept.",
						},
						{ status: result.status },
					);
				}
			}
		}
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
