import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({ put: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/catalogue/db", () => ({ prisma: {} }));

import { fedexAdapter } from "../adapters/fedex";
import { CARRIER_IDS, KIND, LABEL } from "../carriers";
import { findAdapter } from "../registry";

describe("fedex registration", () => {
	it("is a parcel partner the registry can reach", () => {
		expect(CARRIER_IDS).toContain("fedex");
		expect(LABEL.fedex).toBe("FedEx");
		expect(KIND.fedex).toBe("parcel");
		expect(findAdapter("fedex")).toBe(fedexAdapter);
	});
});
