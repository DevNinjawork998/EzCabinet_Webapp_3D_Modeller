import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const requireAuth = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("redirect");
	}),
);
const notFound = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("notFound");
	}),
);

vi.mock("@/lib/auth/requireAuth", async () => {
	const actual = await vi.importActual<typeof import("@/lib/auth/requireAuth")>(
		"@/lib/auth/requireAuth",
	);
	return { ...actual, requireAuth };
});
vi.mock("next/navigation", () => ({ redirect, notFound }));

const { requirePage } = await import("@/lib/auth/page");
const { AuthError } = await import("@/lib/auth/requireAuth");

const user: AuthUser = {
	id: "u1",
	email: "a@b.com",
	name: "A",
	image: null,
	role: "ADMIN",
	disabled: false,
	mustChangePassword: false,
};

describe("requirePage", () => {
	it("returns the user when permission is granted", async () => {
		requireAuth.mockResolvedValue(user);
		await expect(requirePage("catalogue:read")).resolves.toBe(user);
		expect(redirect).not.toHaveBeenCalled();
		expect(notFound).not.toHaveBeenCalled();
	});

	it("redirects to /admin/login on a 401", async () => {
		requireAuth.mockRejectedValue(new AuthError(401));
		await expect(requirePage("catalogue:read")).rejects.toThrow("redirect");
		expect(redirect).toHaveBeenCalledWith("/admin/login");
	});

	it("calls notFound on a 403", async () => {
		requireAuth.mockRejectedValue(new AuthError(403));
		await expect(requirePage("catalogue:read")).rejects.toThrow("notFound");
		expect(notFound).toHaveBeenCalled();
	});

	it("calls notFound on a 404", async () => {
		requireAuth.mockRejectedValue(new AuthError(404));
		await expect(requirePage("catalogue:read")).rejects.toThrow("notFound");
		expect(notFound).toHaveBeenCalled();
	});
});
