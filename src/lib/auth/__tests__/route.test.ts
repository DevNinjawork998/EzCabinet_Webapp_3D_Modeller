import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const requireAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/requireAuth", async () => {
	const actual = await vi.importActual<typeof import("@/lib/auth/requireAuth")>(
		"@/lib/auth/requireAuth",
	);
	return { ...actual, requireAuth };
});

const { withAuth } = await import("@/lib/auth/route");
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

describe("withAuth", () => {
	it("runs the handler and returns its response untouched when permission is granted", async () => {
		requireAuth.mockResolvedValue(user);
		const handler = vi.fn(async (_req: Request, _ctx: unknown, u: AuthUser) =>
			NextResponse.json({ id: u.id }),
		);
		const wrapped = withAuth("catalogue:read", handler);
		const response = await wrapped(new Request("http://x"), { params: 1 });
		expect(handler).toHaveBeenCalledWith(
			expect.anything(),
			{ params: 1 },
			user,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ id: "u1" });
	});

	it("passes the second argument through unchanged", async () => {
		requireAuth.mockResolvedValue(user);
		const handler = vi.fn(async () => NextResponse.json({}));
		const context = { params: Promise.resolve({ id: "abc" }) };
		const wrapped = withAuth("catalogue:read", handler);
		await wrapped(new Request("http://x"), context);
		expect(handler).toHaveBeenCalledWith(expect.anything(), context, user);
	});

	it("401s and never calls the handler", async () => {
		requireAuth.mockRejectedValue(new AuthError(401));
		const handler = vi.fn();
		const wrapped = withAuth("catalogue:read", handler);
		const response = await wrapped(new Request("http://x"), {});
		expect(response.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it("403s and never calls the handler", async () => {
		requireAuth.mockRejectedValue(new AuthError(403));
		const handler = vi.fn();
		const wrapped = withAuth("catalogue:read", handler);
		const response = await wrapped(new Request("http://x"), {});
		expect(response.status).toBe(403);
		expect(handler).not.toHaveBeenCalled();
	});

	it("404s and never calls the handler", async () => {
		requireAuth.mockRejectedValue(new AuthError(404));
		const handler = vi.fn();
		const wrapped = withAuth("catalogue:read", handler);
		const response = await wrapped(new Request("http://x"), {});
		expect(response.status).toBe(404);
		expect(handler).not.toHaveBeenCalled();
	});

	it("rethrows a non-AuthError rather than swallowing it into a 500 body", async () => {
		requireAuth.mockRejectedValue(new Error("boom"));
		const handler = vi.fn();
		const wrapped = withAuth("catalogue:read", handler);
		await expect(wrapped(new Request("http://x"), {})).rejects.toThrow("boom");
		expect(handler).not.toHaveBeenCalled();
	});
});
