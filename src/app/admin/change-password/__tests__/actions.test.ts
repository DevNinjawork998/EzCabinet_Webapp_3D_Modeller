import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.hoisted(() => vi.fn());
const changePassword = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ currentUser }));
vi.mock("@/lib/auth", () => ({ auth: { api: { changePassword } } }));
vi.mock("@/lib/catalogue/db", () => ({ prisma: { user: { update } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { changeOwnPassword } = await import("../actions");

const user = {
	id: "u1",
	email: "a@b.com",
	name: "A",
	image: null,
	role: "ADMIN" as const,
	disabled: false,
	mustChangePassword: true,
};

describe("changeOwnPassword", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns not_signed_in and never touches the password or the flag when there is no session", async () => {
		currentUser.mockResolvedValue(null);
		await expect(changeOwnPassword("old", "new-password-123")).resolves.toEqual(
			{ ok: false, error: "not_signed_in" },
		);
		expect(changePassword).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("clears mustChangePassword only after Better Auth accepts the change", async () => {
		currentUser.mockResolvedValue(user);
		changePassword.mockResolvedValue({ token: "t", user });
		await expect(
			changeOwnPassword("current-pw", "new-password-123"),
		).resolves.toEqual({ ok: true });
		expect(changePassword).toHaveBeenCalledWith({
			body: {
				currentPassword: "current-pw",
				newPassword: "new-password-123",
				revokeOtherSessions: true,
			},
			headers: expect.anything(),
		});
		expect(update).toHaveBeenCalledWith({
			where: { id: "u1" },
			data: { mustChangePassword: false },
		});
	});

	/**
	 * The entire point of this round: a rejected current password must not
	 * clear the flag. If the two operations are ever pulled apart again —
	 * clearing on a timer, on the client's say-so, in a separate call — this
	 * is the test that catches it.
	 */
	it("does not clear mustChangePassword when Better Auth rejects the current password", async () => {
		currentUser.mockResolvedValue(user);
		const { APIError } = await import("better-auth");
		changePassword.mockRejectedValue(
			new APIError("BAD_REQUEST", {
				code: "INVALID_PASSWORD",
				message: "Invalid password",
			}),
		);

		await expect(
			changeOwnPassword("wrong-pw", "new-password-123"),
		).resolves.toEqual({ ok: false, error: "INVALID_PASSWORD" });
		expect(update).not.toHaveBeenCalled();
	});

	it("returns a generic error and does not clear the flag on an unexpected throw", async () => {
		currentUser.mockResolvedValue(user);
		changePassword.mockRejectedValue(new Error("network exploded"));
		await expect(
			changeOwnPassword("current-pw", "new-password-123"),
		).resolves.toEqual({ ok: false, error: "unknown" });
		expect(update).not.toHaveBeenCalled();
	});
});
