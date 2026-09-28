import { describe, expect, it } from "vitest";
import { initialsOf } from "../initials";

describe("initialsOf", () => {
	it("takes the first and last word of the name", () => {
		expect(initialsOf("Nur Aisyah binti Kamal", "a@x.com")).toBe("NK");
	});
	it("takes one letter from a one-word name", () => {
		expect(initialsOf("aisyah", "a@x.com")).toBe("A");
	});
	it("falls back to the email when there is no name", () => {
		expect(initialsOf("", "zed@x.com")).toBe("Z");
		expect(initialsOf(null, "zed@x.com")).toBe("Z");
	});
});
