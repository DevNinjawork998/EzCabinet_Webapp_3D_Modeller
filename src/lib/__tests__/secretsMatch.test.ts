import { describe, expect, it } from "vitest";

import { secretsMatch } from "../secretsMatch";

describe("secretsMatch", () => {
	it("matches equal secrets", () => {
		expect(secretsMatch("s3cret", "s3cret")).toBe(true);
	});

	it("rejects a different secret, including one of another length", () => {
		expect(secretsMatch("s3creT", "s3cret")).toBe(false);
		expect(secretsMatch("s3cret-longer", "s3cret")).toBe(false);
	});

	it("never matches when the expected secret is unset", () => {
		expect(secretsMatch("", "")).toBe(false);
		expect(secretsMatch("anything", "")).toBe(false);
	});
});
