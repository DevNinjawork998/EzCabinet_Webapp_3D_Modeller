import { afterEach, describe, expect, it, vi } from "vitest";
import { authEnabled } from "@/lib/auth/enabled";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("authEnabled", () => {
	it("is on when nothing is set", () => {
		vi.stubEnv("AUTH_ENABLED", undefined);
		vi.stubEnv("VERCEL_ENV", undefined);
		expect(authEnabled()).toBe(true);
	});

	it("is off locally when AUTH_ENABLED is the string false", () => {
		vi.stubEnv("AUTH_ENABLED", "false");
		vi.stubEnv("VERCEL_ENV", undefined);
		expect(authEnabled()).toBe(false);
	});

	it("STAYS ON on a preview deployment however the flag is set", () => {
		// A preview is a public URL with real carrier credentials behind it.
		vi.stubEnv("AUTH_ENABLED", "false");
		vi.stubEnv("VERCEL_ENV", "preview");
		expect(authEnabled()).toBe(true);
	});

	it("STAYS ON in production however the flag is set", () => {
		vi.stubEnv("VERCEL_ENV", "production");
		for (const value of ["false", "0", "off", ""]) {
			vi.stubEnv("AUTH_ENABLED", value);
			expect(authEnabled()).toBe(true);
		}
	});

	it("ignores any value other than the exact string false", () => {
		vi.stubEnv("VERCEL_ENV", undefined);
		for (const value of ["0", "no", "FALSE", "true", ""]) {
			vi.stubEnv("AUTH_ENABLED", value);
			expect(authEnabled()).toBe(true);
		}
	});
});
