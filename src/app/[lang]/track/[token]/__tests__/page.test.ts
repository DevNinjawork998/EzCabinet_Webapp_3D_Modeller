import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { delivery: { findUnique } } }));

vi.mock("next/navigation", () => ({
	notFound: (): never => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	},
}));

const { default: TrackPage } = await import("@/app/[lang]/track/[token]/page");

const customer = (id: string): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role: "CUSTOMER",
	disabled: false,
	mustChangePassword: false,
});

const delivery = (order: { userId: string } | null) => ({
	number: 3,
	siteAddress: "1 Jalan Test",
	scheduledAt: null,
	status: "DRAFT",
	carrierId: null,
	carrierOrderId: null,
	items: [],
	createdAt: new Date("2026-09-27T00:00:00Z"),
	events: [],
	order,
});

const open = () =>
	TrackPage({ params: Promise.resolve({ lang: "en", token: "d1" }) });

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	currentUser.mockReset();
	findUnique.mockReset();
});

describe("track page access", () => {
	it("keeps a standalone delivery open to the link holder, signed out", async () => {
		currentUser.mockResolvedValue(null);
		findUnique.mockResolvedValue(delivery(null));
		await expect(open()).resolves.toBeTruthy();
	});

	it("sends a signed-out visitor of an order's delivery to sign-in", async () => {
		currentUser.mockResolvedValue(null);
		findUnique.mockResolvedValue(delivery({ userId: "owner" }));
		await expect(open()).rejects.toThrow(
			"REDIRECT:/en/sign-in?next=%2Fen%2Ftrack%2Fd1",
		);
	});

	it("renders an order's delivery for its owner", async () => {
		currentUser.mockResolvedValue(customer("owner"));
		findUnique.mockResolvedValue(delivery({ userId: "owner" }));
		await expect(open()).resolves.toBeTruthy();
	});

	it("404s an order's delivery for another customer", async () => {
		currentUser.mockResolvedValue(customer("stranger"));
		findUnique.mockResolvedValue(delivery({ userId: "owner" }));
		await expect(open()).rejects.toThrow("NOT_FOUND");
	});
});
