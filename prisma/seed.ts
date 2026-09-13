import { config } from "dotenv";

config();
config({ path: ".env.local", override: true });

import { prisma } from "@/lib/catalogue/db";
import { PLANNER_CATALOGUE } from "@/lib/planner/catalogue";
import { plannerCatalogueSchema } from "@/lib/planner/catalogueSchema";

/**
 * Seeds the planner catalogue as version 1, PUBLISHED: the settings a catalogue
 * needs before any design exists — door styles, finishes, rooms, rates — and no
 * cabinets. Cabinets come from the design library and are rebuilt into the
 * catalogue on every publish, so a fresh DB opens every room as coming soon
 * rather than on the repo's invented families.
 *
 * Idempotent: safe to re-run against a DB that already has these rows.
 */
async function main() {
	const seededBy = "seed";

	const plannerData = plannerCatalogueSchema.parse({
		...PLANNER_CATALOGUE,
		families: [],
		roomTypes: PLANNER_CATALOGUE.roomTypes.map((room) => ({
			...room,
			familyIds: [],
		})),
	});
	await prisma.catalogueVersion.upsert({
		where: { product_version: { product: "PLANNER", version: 1 } },
		update: {},
		create: {
			product: "PLANNER",
			version: 1,
			status: "PUBLISHED",
			data: plannerData,
			note: "Seeded from lib/planner/catalogue.ts — settings only, no cabinets",
			createdBy: seededBy,
			publishedBy: seededBy,
			publishedAt: new Date(),
		},
	});

	console.log("Seeded PLANNER v1 (PUBLISHED).");
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
