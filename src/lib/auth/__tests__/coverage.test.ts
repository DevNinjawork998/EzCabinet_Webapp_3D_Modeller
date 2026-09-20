import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}

/**
 * The realistic breach here is not broken crypto, it is a route somebody adds
 * next month and forgets to gate. `proxy.ts` will not save it: the proxy only
 * checks that *a* session cookie exists, so an unguarded handler is reachable
 * by any signed-in customer.
 */
describe("every admin surface is gated", () => {
	it("calls requireAuth or withAuth in each route handler", async () => {
		const files = (await walk("src/app/api/admin")).filter((f) =>
			f.endsWith("route.ts"),
		);
		expect(files.length).toBeGreaterThan(20);
		const ungated = files.filter((f) => {
			const source = readFileSync(f, "utf8");
			return !source.includes("requireAuth") && !source.includes("withAuth");
		});
		expect(ungated).toEqual([]);
	});

	it("calls requireAuth in each admin page", async () => {
		const files = (await walk("src/app/admin")).filter((f) =>
			f.endsWith("page.tsx"),
		);
		const ungated = files.filter((f) => {
			if (f.includes("login")) return false; // the sign-in page itself
			const source = readFileSync(f, "utf8");
			return !source.includes("requireAuth") && !source.includes("requirePage");
		});
		expect(ungated).toEqual([]);
	});
});
