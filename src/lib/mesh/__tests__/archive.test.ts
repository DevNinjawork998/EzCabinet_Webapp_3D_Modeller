import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_INFLATED_BYTES, readArchive } from "../archive";

const text = (s: string) => new TextEncoder().encode(s);

describe("readArchive", () => {
	it("reads the .obj and lists texture names without inflating them", () => {
		const zip = zipSync({
			"BC 800/BC 800.obj": text("v 0 0 0\n"),
			"BC 800/Rhone Oak.jpg": new Uint8Array(10),
		});
		expect(readArchive(zip)).toEqual({
			objName: "BC 800.obj",
			objText: "v 0 0 0\n",
			imageNames: ["Rhone Oak.jpg"],
		});
	});

	it("refuses an archive that would inflate past the cap", () => {
		// Zeros compress ~1000:1, so this is a small zip and a huge inflate.
		const zip = zipSync(
			{ "bomb.obj": new Uint8Array(MAX_INFLATED_BYTES + 1) },
			{ level: 9 },
		);
		expect(() => readArchive(zip)).toThrow(/too large/);
	});
});
