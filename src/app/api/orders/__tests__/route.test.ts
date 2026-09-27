import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ currentUser }));
vi.mock("botid/server", () => ({
	checkBotId: async () => ({ isBot: false }),
}));
// The 401 must come before any database work; an empty prisma proves it.
vi.mock("@/lib/catalogue/db", () => ({ prisma: {} }));

const { POST } = await import("@/app/api/orders/route");

const post = () =>
	POST(
		new Request("http://localhost/api/orders", {
			method: "POST",
			body: "{}",
		}),
	);

beforeEach(() => {
	currentUser.mockReset();
	currentUser.mockResolvedValue(null);
	vi.stubEnv("VERCEL_ENV", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/orders without a signed-in user", () => {
	it.each(["true", "false"])("401s with AUTH_ENABLED=%s", async (flag) => {
		vi.stubEnv("AUTH_ENABLED", flag);
		const response = await post();
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "sign_in_required" });
	});
});
