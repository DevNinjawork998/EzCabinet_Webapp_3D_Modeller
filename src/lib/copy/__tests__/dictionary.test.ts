import { describe, expect, it } from "vitest";
import { en } from "../en";
import { LOCALES } from "../locales";
import { ms } from "../ms";
import { zh } from "../zh";

/** Every leaf path in a nested dictionary, e.g. "common.back". */
const paths = (value: unknown, prefix = ""): string[] =>
	typeof value === "object" && value !== null
		? Object.entries(value).flatMap(([key, child]) =>
				paths(child, prefix ? `${prefix}.${key}` : key),
			)
		: [prefix];

const at = (dict: unknown, path: string): string =>
	path.split(".").reduce<never>((v, k) => (v as never)[k], dict as never);

/** Strings that are legitimately identical across locales. */
const SHARED = new Set([
	"common.brand",
	"landing.footer.email",
	// Malay borrows the word outright — "Menu" is the Malay for it, not an
	// untranslated string.
	"landing.nav.menu",
	// "Unit" is the Malay word too, and a count of one takes no plural.
	"orders.unitsOne",
]);

describe("dictionaries", () => {
	it("serves exactly the three locales", () => {
		expect(LOCALES).toHaveLength(3);
	});

	// The type gate already makes this a compile error. The test catches it in
	// CI, where a stray `as never` or `@ts-expect-error` cannot hide it.
	it.each([
		["zh", zh],
		["ms", ms],
	])("%s has exactly English's keys", (_name, dict) => {
		expect(paths(dict).sort()).toEqual(paths(en).sort());
	});

	it.each([
		["zh", zh],
		["ms", ms],
	])("%s has no value left in English", (_name, dict) => {
		const untranslated = paths(en).filter(
			(p) => !SHARED.has(p) && at(dict, p) === at(en, p),
		);
		expect(untranslated).toEqual([]);
	});

	it("has no empty strings", () => {
		for (const dict of [en, zh, ms]) {
			for (const path of paths(dict)) {
				expect(at(dict, path).trim()).not.toBe("");
			}
		}
	});
});
