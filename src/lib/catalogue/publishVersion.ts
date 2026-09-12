import "server-only";
import { revalidateTag } from "next/cache";
import { prisma } from "./db";
import { catalogueSchemaByProduct } from "./schemaByProduct";
import { CATALOGUE_CACHE_TAG } from "./store";

/**
 * Flipping a DRAFT live, in one place.
 *
 * Was the whole body of `catalogue/versions/[id]/publish/route.ts` until the
 * design library needed to do the same thing — a delete that takes a cabinet
 * out of the planner has to publish the version it just built, or the cabinet
 * is still there. Two copies of a transaction that supersedes the live pricing
 * document is not a place to let drift happen.
 *
 * The partial unique index (`CatalogueVersion_one_published_per_product`)
 * backstops the transaction at the DB level: a second concurrent publish fails
 * there, not here.
 */
export type PublishOutcome =
	| { ok: true; id: string; product: string; version: number }
	| {
			ok: false;
			error:
				| "not_found"
				| "not_a_draft"
				| "invalid_catalogue"
				| "publish_conflict";
			status: number;
			issues?: unknown;
	  };

export async function publishVersion(
	id: string,
	publishedBy = "admin", // ponytail: see imports/route.ts
): Promise<PublishOutcome> {
	const draft = await prisma.catalogueVersion.findUnique({ where: { id } });
	if (!draft) return { ok: false, error: "not_found", status: 404 };
	if (draft.status !== "DRAFT") {
		return { ok: false, error: "not_a_draft", status: 409 };
	}

	// Re-validate on the way out — the row was written by whatever code existed
	// when it was saved, and this is the last check before it feeds live pricing.
	const parsed = catalogueSchemaByProduct[draft.product].safeParse(draft.data);
	if (!parsed.success) {
		return {
			ok: false,
			error: "invalid_catalogue",
			status: 400,
			issues: parsed.error.issues,
		};
	}

	try {
		await prisma.$transaction([
			prisma.catalogueVersion.updateMany({
				where: { product: draft.product, status: "PUBLISHED" },
				data: { status: "SUPERSEDED" },
			}),
			prisma.catalogueVersion.update({
				where: { id },
				data: { status: "PUBLISHED", publishedBy, publishedAt: new Date() },
			}),
		]);
	} catch {
		// The partial unique index rejecting a genuine race.
		return { ok: false, error: "publish_conflict", status: 409 };
	}

	// Next 16's revalidateTag wants a cache-life profile; { expire: 0 } is the
	// immediate-purge equivalent of the old single-arg call.
	revalidateTag(CATALOGUE_CACHE_TAG, { expire: 0 });

	return { ok: true, id, product: draft.product, version: draft.version };
}
