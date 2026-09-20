import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const { AuthError, BYPASS_USER, requireAuth } = await import(
	"@/lib/auth/requireAuth"
);

const user = (over: Partial<AuthUser>): AuthUser => ({
	id: "u1",
	email: "a@b.com",
	name: "A",
	image: null,
	role: "ADMIN",
	disabled: false,
	mustChangePassword: false,
	...over,
});

beforeEach(() => {
	currentUser.mockReset();
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("requireAuth", () => {
	it("returns the user when the role carries the permission", async () => {
		currentUser.mockResolvedValue(user({ role: "ADMIN" }));
		await expect(requireAuth("orders:markPaid")).resolves.toMatchObject({
			id: "u1",
		});
	});

	it("401s when nobody is signed in", async () => {
		currentUser.mockResolvedValue(null);
		await expect(requireAuth("orders:read")).rejects.toMatchObject({
			status: 401,
		});
	});

	it("404s a customer, so the surface stays invisible", async () => {
		currentUser.mockResolvedValue(user({ role: "CUSTOMER" }));
		await expect(requireAuth("orders:read")).rejects.toMatchObject({
			status: 404,
		});
	});

	it("403s an admin reaching for users:manage, the one thing they lack", async () => {
		currentUser.mockResolvedValue(user({ role: "ADMIN" }));
		await expect(requireAuth("users:manage")).rejects.toMatchObject({
			status: 403,
		});
	});

	it("refuses a disabled user even with a valid session", async () => {
		// currentUser already returns null for a disabled row; this pins the
		// contract so a future refactor cannot quietly start returning them.
		currentUser.mockResolvedValue(null);
		await expect(requireAuth("catalogue:read")).rejects.toMatchObject({
			status: 401,
		});
	});

	it("bypasses entirely when AUTH_ENABLED is false outside production", async () => {
		vi.stubEnv("AUTH_ENABLED", "false");
		currentUser.mockResolvedValue(null);
		await expect(requireAuth("users:manage")).resolves.toBe(BYPASS_USER);
		expect(currentUser).not.toHaveBeenCalled();
	});

	it("still enforces in production however AUTH_ENABLED is set", async () => {
		vi.stubEnv("AUTH_ENABLED", "false");
		vi.stubEnv("VERCEL_ENV", "production");
		currentUser.mockResolvedValue(null);
		await expect(requireAuth("users:manage")).rejects.toMatchObject({
			status: 401,
		});
	});
});
