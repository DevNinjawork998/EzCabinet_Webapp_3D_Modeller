import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cornerObj } from "../src/lib/mesh/__tests__/cornerMock";

/**
 * Writes two mock corner designs to upload at /admin/cabinet-designs:
 *   pnpm tsx scripts/generate-corner-mock.ts [outDir]
 * File them as "Corner base cabinet" and "Corner wall cabinet", Kitchen.
 */
const outDir = process.argv[2] ?? "corner-mocks";
mkdirSync(outDir, { recursive: true });
writeFileSync(
	join(outDir, "CB 900mm.obj"),
	cornerObj({ sizeMm: 900, heightMm: 870, armMm: 600, legMm: 100 }),
);
writeFileSync(
	join(outDir, "CW 600mm.obj"),
	cornerObj({ sizeMm: 600, heightMm: 720, armMm: 350, legMm: 0 }),
);
console.log(`wrote ${outDir}/CB 900mm.obj and ${outDir}/CW 600mm.obj`);
