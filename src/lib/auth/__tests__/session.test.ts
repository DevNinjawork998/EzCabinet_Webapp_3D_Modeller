import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/catalogue/db", () => ({
	prisma: { user: { findUnique } },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { currentUser } = await import("@/lib/auth/session");

const row = {
	id: "u1",
	email: "a@b.com",
	name: "A",
	image: null,
	role: "ADMIN",
	disabled: false,
	mustChangePassword: false,
};

beforeEach(() => {
	getSession.mockReset();
	findUnique.mockReset();
});

describe("currentUser", () => {
	it("returns the row for a live session", async () => {
		getSession.mockResolvedValue({ user: { id: "u1" } });
		findUnique.mockResolvedValue(row);
		await expect(currentUser()).resolves.toEqual(row);
	});

	it("is null when there is no session", async () => {
		getSession.mockResolvedValue(null);
		await expect(currentUser()).resolves.toBeNull();
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("is null when the session names a row that is gone", async () => {
		getSession.mockResolvedValue({ user: { id: "u1" } });
		findUnique.mockResolvedValue(null);
		await expect(currentUser()).resolves.toBeNull();
	});

	it("is null for a disabled user holding a valid session", async () => {
		getSession.mockResolvedValue({ user: { id: "u1" } });
		findUnique.mockResolvedValue({ ...row, disabled: true });
		await expect(currentUser()).resolves.toBeNull();
	});

	it("reads the row on every call, never a cached role", async () => {
		getSession.mockResolvedValue({ user: { id: "u1" } });
		findUnique.mockResolvedValue(row);
		await currentUser();
		await currentUser();
		expect(findUnique).toHaveBeenCalledTimes(2);
	});
});
