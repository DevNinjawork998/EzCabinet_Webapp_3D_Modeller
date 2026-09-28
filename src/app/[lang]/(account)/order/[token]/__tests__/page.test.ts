import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { findUnique } } }));

vi.mock("next/navigation", () => ({
	notFound: (): never => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	},
}));

const { default: OrderPage } = await import(
	"@/app/[lang]/(account)/order/[token]/page"
);

const user = (id: string, role: AuthUser["role"] = "CUSTOMER"): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role,
	disabled: false,
	mustChangePassword: false,
});

const ORDER = {
	userId: "owner",
	number: 14,
	createdAt: new Date("2026-09-27T00:00:00Z"),
	status: "CANCELLED",
	siteAddress: "1 Jalan Test",
	breakdown: { cabinets: [] },
	cabinetsRm: 1000,
	deliveryRm: 85,
	totalRm: 1085,
	productionStage: null,
	deliveries: [],
};

const open = (token = "tok") =>
	OrderPage({
		params: Promise.resolve({ lang: "en", token }),
		searchParams: Promise.resolve({}),
	});

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	findUnique.mockReset();
	findUnique.mockResolvedValue(ORDER);
});

describe("order page access", () => {
	it("sends a signed-out visitor to sign-in, back to this order", async () => {
		currentUser.mockResolvedValue(null);
		await expect(open()).rejects.toThrow(
			"REDIRECT:/en/sign-in?next=%2Fen%2Forder%2Ftok",
		);
	});

	it("renders for the owner", async () => {
		currentUser.mockResolvedValue(user("owner"));
		await expect(open()).resolves.toBeTruthy();
	});

	it("renders for staff", async () => {
		currentUser.mockResolvedValue(user("staff", "ADMIN"));
		await expect(open()).resolves.toBeTruthy();
	});

	it("404s for another customer, exactly like an unknown token", async () => {
		currentUser.mockResolvedValue(user("stranger"));
		await expect(open()).rejects.toThrow("NOT_FOUND");
		findUnique.mockResolvedValue(null);
		await expect(open("nope")).rejects.toThrow("NOT_FOUND");
	});
});
