import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const count = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { count } } }));

const { default: AccountLayout } = await import(
	"@/app/[lang]/(account)/layout"
);

const open = () =>
	AccountLayout({ children: null, params: Promise.resolve({ lang: "en" }) });

beforeEach(() => {
	count.mockReset();
	count.mockResolvedValue(2);
});

describe("account layout", () => {
	it("counts only the signed-in account's orders for the side nav", async () => {
		currentUser.mockResolvedValue({
			id: "staff-1",
			email: "s@x.com",
			name: "S",
			image: null,
			role: "ADMIN",
			disabled: false,
			mustChangePassword: false,
		});
		await open();
		expect(count).toHaveBeenCalledWith({ where: { userId: "staff-1" } });
	});

	it("does not query when nobody is signed in (the page redirects)", async () => {
		currentUser.mockResolvedValue(null);
		await open();
		expect(count).not.toHaveBeenCalled();
	});
});
