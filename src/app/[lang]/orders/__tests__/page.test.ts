import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { findMany } } }));

vi.mock("next/navigation", () => ({
	notFound: (): never => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	},
}));

const { default: OrdersPage } = await import("@/app/[lang]/orders/page");

const as = (id: string, role: AuthUser["role"]): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role,
	disabled: false,
	mustChangePassword: false,
});

const open = () => OrdersPage({ params: Promise.resolve({ lang: "en" }) });

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	findMany.mockReset();
	findMany.mockResolvedValue([]);
});

describe("my orders page", () => {
	it("sends a signed-out visitor to sign-in, back to the list", async () => {
		currentUser.mockResolvedValue(null);
		await expect(open()).rejects.toThrow(
			"REDIRECT:/en/sign-in?next=%2Fen%2Forders",
		);
		expect(findMany).not.toHaveBeenCalled();
	});

	it.each([
		["customer", "CUSTOMER"],
		// Staff see their own orders here too; all orders live at /admin/orders.
		["staff", "SUPERADMIN"],
	] as const)("lists only the %s's own orders", async (id, role) => {
		currentUser.mockResolvedValue(as(id, role));
		await open();
		expect(findMany).toHaveBeenCalledTimes(1);
		expect(findMany.mock.calls[0][0].where).toEqual({ userId: id });
	});
});
