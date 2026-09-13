import "server-only";
import type { Product } from "@/generated/prisma/enums";
import { prisma } from "./db";

/**
 * Creating a DRAFT catalogue version, in one place.
 *
 * Two callers need it — the catalogue editor saving reviewed data, and the
 * cabinet-design library pushing one design into the planner — and the version
 * numbering is the kind of thing that goes subtly wrong when it is written
 * twice.
 *
 * Never live. Publishing is a separate, deliberate act
 * (`catalogue/versions/[id]/publish`), because this document is what prices a
 * customer's kitchen.
 */
export async function createDraftVersion({
	product,
	data,
	note,
	importId,
	createdBy = "admin", // ponytail: shared-secret auth has no identity beyond
	// "an admin". Real names land with the Phase 3 inbox's per-user accounts.
}: {
	product: Product;
	/** Already parsed by the product's schema — this does not re-validate. */
	data: unknown;
	note?: string;
	importId?: string;
	createdBy?: string;
}) {
	// Version numbers are assigned at creation, not at publish — a draft that
	// never gets published just leaves a gap, which is fine; what matters is
	// they're monotonic and unique per product, which @@unique([product,
	// version]) backstops. ponytail: read-then-write, not a transaction — a
	// genuine race needs two people creating a draft for the same product in
	// the same instant, and the unique constraint turns that into a clean
	// 500 instead of silent corruption. Wrap in $transaction if this tool
	// ever gets more than a couple of concurrent admins.
	const { _max } = await prisma.catalogueVersion.aggregate({
		where: { product },
		_max: { version: true },
	});

	return prisma.catalogueVersion.create({
		data: {
			product,
			version: (_max.version ?? 0) + 1,
			status: "DRAFT",
			data: data as object,
			note,
			importId,
			createdBy,
		},
	});
}
