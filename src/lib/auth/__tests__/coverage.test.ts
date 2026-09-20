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

const HTTP_METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
];
const METHOD_GROUP = HTTP_METHODS.join("|");

/** Every exported handler in a route file, however it is declared. */
const HANDLER_RE = new RegExp(
	`export (?:const (${METHOD_GROUP})\\s*=|async function (${METHOD_GROUP})\\s*\\()`,
	"g",
);

/** The one shape that counts as gated: `export const METHOD = withAuth(...)`. */
const GATED_RE = new RegExp(
	`export const (${METHOD_GROUP})\\s*=\\s*withAuth\\s*[<(]`,
	"g",
);

/**
 * Route files that are exempt, named by path — not by any string the file
 * happens to contain. A file earns a place here only with a reason, in a
 * comment on the file itself.
 */
const ALLOWED_UNGATED = [
	// EasyParcel redirects the admin's own browser back here with an OAuth
	// code; the `state` cookie match is the check that matters, and a
	// permission failure would cost them the connection attempt.
	"logistics/easyparcel/callback/route.ts",
];

/**
 * The realistic breach here is not broken crypto, it is a route somebody adds
 * next month and forgets to gate. `proxy.ts` will not save it: the proxy only
 * checks that *a* session cookie exists, so an unguarded handler is reachable
 * by any signed-in customer.
 *
 * This checks every exported HTTP method individually, not just whether the
 * file contains the string "withAuth" anywhere — a file with three methods
 * where only one calls `withAuth` must still fail, and a new file that only
 * copies the callback route's comment and `void requireAuth;` line must not
 * pass by accident.
 */
describe("every admin surface is gated", () => {
	it("gates every exported HTTP method handler with withAuth", async () => {
		const files = (await walk("src/app/api/admin")).filter((f) =>
			f.endsWith("route.ts"),
		);
		expect(files.length).toBeGreaterThan(20);

		const ungated: string[] = [];
		for (const file of files) {
			const relative = file.replace(/^src\/app\/api\/admin\//, "");
			if (ALLOWED_UNGATED.includes(relative)) continue;

			const source = readFileSync(file, "utf8");
			const declared = new Set(
				[...source.matchAll(HANDLER_RE)].map((m) => m[1] ?? m[2]),
			);
			const gated = new Set([...source.matchAll(GATED_RE)].map((m) => m[1]));
			for (const method of declared) {
				if (!gated.has(method)) ungated.push(`${file} (${method})`);
			}
		}
		expect(ungated).toEqual([]);
	});

	it("never gates a handler through a re-export", async () => {
		// This test only understands `export const METHOD = withAuth(...)`.
		// `const GET = withAuth(...); export { GET };` would gate the handler
		// but pass HANDLER_RE/GATED_RE undetected — so ban the re-export shape
		// outright rather than teach the regex a third syntax nobody uses.
		const files = (await walk("src/app/api/admin")).filter((f) =>
			f.endsWith("route.ts"),
		);

		const reExporting = files.filter((f) =>
			readFileSync(f, "utf8").includes("export {"),
		);
		expect(
			reExporting,
			"a re-export (`export { GET }`) would not be checked by the coverage test above — use `export const METHOD = withAuth(...)` instead",
		).toEqual([]);
	});

	it("calls requireAuth in each admin page", async () => {
		const files = (await walk("src/app/admin")).filter((f) =>
			f.endsWith("page.tsx"),
		);
		expect(files.length).toBeGreaterThan(0);

		const ungated = files.filter((f) => {
			if (f === "src/app/admin/login/page.tsx") return false; // the sign-in page itself
			// Calls `currentUser()` directly instead: `requirePage` now redirects
			// a user with `mustChangePassword` set straight back to this page,
			// which would loop forever.
			if (f === "src/app/admin/change-password/page.tsx") return false;
			const source = readFileSync(f, "utf8");
			return !source.includes("requireAuth") && !source.includes("requirePage");
		});
		expect(ungated).toEqual([]);
	});
});
