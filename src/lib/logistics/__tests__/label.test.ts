import { describe, expect, it } from "vitest";
import { LABEL_FALLBACK, labelPathname } from "../label";

describe("labelPathname", () => {
	it("keeps GDEX's existing path, so no stored label moves", () => {
		expect(labelPathname("gdex", "MY1700012345")).toBe(
			"logistics/gdex/MY1700012345.pdf",
		);
	});

	it("files each carrier under its own folder", () => {
		expect(labelPathname("fedex", "794953535000")).toBe(
			"logistics/fedex/794953535000.pdf",
		);
	});
});

describe("LABEL_FALLBACK", () => {
	it("names the carriers whose label we capture, and only those", () => {
		expect(Object.keys(LABEL_FALLBACK).sort()).toEqual(["fedex", "gdex"]);
	});
});
