import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { findUnique } } }));

const startPayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/payments/start", () => ({ startPayment }));

const { POST } = await import("@/app/api/orders/[token]/pay/route");

const customer = (id: string): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role: "CUSTOMER",
	disabled: false,
	mustChangePassword: false,
});

const pay = () =>
	POST(new Request("http://localhost/api/orders/tok/pay", { method: "POST" }), {
		params: Promise.resolve({ token: "tok" }),
	});

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	currentUser.mockReset();
	findUnique.mockReset();
	findUnique.mockResolvedValue({ userId: "owner" });
	startPayment.mockReset();
	startPayment.mockResolvedValue({
		ok: true,
		start: { ref: "pi_1", kind: "stripe-elements" },
	});
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/orders/[token]/pay access", () => {
	it("starts the payment for the owner", async () => {
		currentUser.mockResolvedValue(customer("owner"));
		const response = await pay();
		expect(response.status).toBe(200);
		expect(startPayment).toHaveBeenCalledWith("tok", "http://localhost");
	});

	it.each([
		["another customer", () => customer("stranger")],
		["a signed-out visitor", () => null],
	])("404s for %s without starting a payment", async (_, who) => {
		currentUser.mockResolvedValue(who());
		const response = await pay();
		expect(response.status).toBe(404);
		expect(startPayment).not.toHaveBeenCalled();
	});

	it("404s an unknown token the same way", async () => {
		currentUser.mockResolvedValue(customer("owner"));
		findUnique.mockResolvedValue(null);
		expect((await pay()).status).toBe(404);
		expect(startPayment).not.toHaveBeenCalled();
	});
});
