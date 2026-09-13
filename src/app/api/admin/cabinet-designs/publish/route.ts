import { NextResponse } from "next/server";
import { z } from "zod";
import { buildCatalogue } from "@/lib/catalogue/buildCatalogue";
import {
	convertDesign,
	type DesignFailure,
} from "@/lib/catalogue/convertDesign";
import { prisma } from "@/lib/catalogue/db";
import { summariseCatalogueChanges } from "@/lib/catalogue/diff";
import { blockersOf } from "@/lib/catalogue/health";
import { publishVersion } from "@/lib/catalogue/publishVersion";
import { readPublishedPlannerCatalogue } from "@/lib/catalogue/store";
import { createDraftVersion } from "@/lib/catalogue/versions";
import { plannerCatalogueSchema } from "@/lib/planner/catalogueSchema";

export const runtime = "nodejs";

/**
 * `base` is the published catalogue with the admin's unpublished settings
 * edits applied — door styles, finishes, rates, build standards, room wall
 * widths. Its families are ignored: the cabinets always come from the design
 * rows in Postgres, so a client cannot publish a price it made up.
 */
const bodySchema = z.object({ base: plannerCatalogueSchema });

/**
 * Makes the design library live: rebuild the catalogue from every design row,
 * write it as a version, publish it.
 *
 * One act, not a draft to go and review elsewhere — the admin already saw the
 * change list on the page that sent this. The version row is still written,
 * because it is the price history and what a quote will be stamped against.
 */
export async function POST(request: Request) {
	const parsed = bodySchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	let designs = await prisma.cabinetDesign.findMany();

	// Designs uploaded before conversion moved to upload time have no fit-out
	// yet. Convert them now. One that is refused stays out of the catalogue and
	// is named in the response, so the admin can archive or replace it.
	const failures: DesignFailure[] = [];
	const unconverted = designs.filter((design) => design.geometry === null);
	for (const design of unconverted) {
		const result = await convertDesign(design);
		if ("error" in result) {
			// Archived, not just skipped. Left active and unconverted it would be
			// retried on every publish and counted as an unpublished change the
			// admin could never clear. Restore it after replacing the file.
			await prisma.cabinetDesign.update({
				where: { id: design.id },
				data: { status: "ARCHIVED" },
			});
			failures.push({
				...result,
				message: `${result.message} ${design.name} has been archived.`,
			});
		}
	}
	if (unconverted.length > 0) designs = await prisma.cabinetDesign.findMany();
	const refused = new Set(failures.map((failure) => failure.designId));

	const built = plannerCatalogueSchema.parse(
		buildCatalogue(
			designs.filter((design) => !refused.has(design.id)),
			parsed.data.base,
		),
	);

	const blockers = blockersOf(built);
	if (blockers.length > 0) {
		return NextResponse.json(
			{
				error: "unpriced",
				message: `${blockers.map((b) => b.familyLabel).join(", ")} ${
					blockers.length === 1 ? "has" : "have"
				} no price. Set one before publishing.`,
				failures,
			},
			{ status: 409 },
		);
	}

	const published = await readPublishedPlannerCatalogue();
	const changes = summariseCatalogueChanges(published.data, built);
	if (changes.length === 0) {
		return NextResponse.json({
			status: "unchanged",
			version: published.version,
			changes,
			failures,
		});
	}

	const draft = await createDraftVersion({
		product: "PLANNER",
		data: built,
		note: changes.join("; "),
	});
	const result = await publishVersion(draft.id);
	if (!result.ok) {
		return NextResponse.json(
			{ error: result.error, issues: result.issues, failures },
			{ status: result.status },
		);
	}

	return NextResponse.json({
		status: "published",
		version: result.version,
		changes,
		failures,
	});
}
