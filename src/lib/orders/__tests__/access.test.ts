import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const redirect = vi.hoisted(() =>
	vi.fn((url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	}),
);
vi.mock("next/navigation", () => ({ redirect }));

const { canViewOrder, viewerOf } = await import("@/lib/orders/access");
const { BYPASS_USER } = await import("@/lib/auth/requireAuth");

const user = (over: Partial<AuthUser>): AuthUser => ({
	id: "u1",
	email: "a@b.com",
	name: "A",
	image: null,
	role: "CUSTOMER",
	disabled: false,
	mustChangePassword: false,
	...over,
});

const order = { userId: "owner" };

describe("canViewOrder", () => {
	it.each([
		["owner", user({ id: "owner" }), true],
		["another customer", user({ id: "stranger" }), false],
		["superadmin", user({ id: "s", role: "SUPERADMIN" }), true],
		["admin", user({ id: "a", role: "ADMIN" }), true],
		["signed out", null, false],
		// Same email, different account: email is never an access key.
		[
			"customer sharing the owner's email",
			user({ id: "other", email: "owner@x.com" }),
			false,
		],
	])("%s → %s", (_, viewer, expected) => {
		expect(canViewOrder(viewer, order)).toBe(expected);
	});
});

describe("viewerOf", () => {
	beforeEach(() => {
		currentUser.mockReset();
		redirect.mockClear();
		vi.stubEnv("VERCEL_ENV", undefined);
		vi.stubEnv("AUTH_ENABLED", "true");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("returns the signed-in user", async () => {
		currentUser.mockResolvedValue(user({ id: "owner" }));
		await expect(viewerOf("en", "/en/order/t1")).resolves.toMatchObject({
			id: "owner",
		});
	});

	it("sends a signed-out visitor to sign-in and back to the same page", async () => {
		currentUser.mockResolvedValue(null);
		await expect(viewerOf("ms", "/ms/order/t 1")).rejects.toThrow(
			"REDIRECT:/ms/sign-in?next=%2Fms%2Forder%2Ft%201",
		);
	});

	it("treats a disabled account (currentUser null) as signed out", async () => {
		// currentUser() already returns null for a disabled row.
		currentUser.mockResolvedValue(null);
		await expect(viewerOf("en", "/en/orders")).rejects.toThrow(/REDIRECT/);
	});

	it("is the bypass superadmin when AUTH_ENABLED is off and nobody is signed in", async () => {
		vi.stubEnv("AUTH_ENABLED", "false");
		currentUser.mockResolvedValue(null);
		await expect(viewerOf("en", "/en/orders")).resolves.toBe(BYPASS_USER);
		expect(redirect).not.toHaveBeenCalled();
	});

	// Checkout always needs a real account, so local orders belong to it. With
	// the bypass winning, local My orders was always empty.
	it("is the signed-in account when AUTH_ENABLED is off and someone is signed in", async () => {
		vi.stubEnv("AUTH_ENABLED", "false");
		currentUser.mockResolvedValue(user({ id: "owner" }));
		await expect(viewerOf("en", "/en/orders")).resolves.toMatchObject({
			id: "owner",
		});
	});
});
