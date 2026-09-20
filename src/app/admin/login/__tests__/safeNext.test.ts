import { describe, expect, it } from "vitest";
import { safeNext } from "@/app/admin/login/safeNext";

const origin = "https://planner.example.com";

describe("safeNext", () => {
	it("keeps a same-origin absolute path", () => {
		expect(safeNext("/admin/orders", origin)).toBe("/admin/orders");
	});

	it("keeps path, search and hash together", () => {
		expect(safeNext("/admin/orders?x=1#y", origin)).toBe("/admin/orders?x=1#y");
	});

	it("blocks a protocol-relative URL", () => {
		expect(safeNext("//evil.com", origin)).toBe("/admin/cabinet-designs");
	});

	it("blocks an absolute cross-origin URL", () => {
		expect(safeNext("https://evil.com", origin)).toBe("/admin/cabinet-designs");
	});

	it("blocks a backslash path that the URL parser normalises off-origin", () => {
		expect(safeNext("/\\evil.com", origin)).toBe("/admin/cabinet-designs");
	});

	it("blocks a double-backslash variant the same way", () => {
		expect(safeNext("/\\\\evil.com", origin)).toBe("/admin/cabinet-designs");
	});

	it("falls back on an empty string", () => {
		expect(safeNext("", origin)).toBe("/admin/cabinet-designs");
	});

	it("falls back on null", () => {
		expect(safeNext(null, origin)).toBe("/admin/cabinet-designs");
	});
});
