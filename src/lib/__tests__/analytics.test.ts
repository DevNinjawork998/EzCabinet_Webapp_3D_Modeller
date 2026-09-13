import { afterEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
	init: vi.fn(),
	capture: vi.fn(),
	captureException: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

/** A fresh module each time — the client promise is a module-level singleton. */
async function fresh() {
	vi.resetModules();
	return import("../analytics");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("analytics", () => {
	it("stays inert on the server, where the planner is also rendered", async () => {
		vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_test");
		const { captureError, consentStatus, track } = await fresh();

		track("planner_started", { room: "kitchen" });
		captureError(new Error("boom"));

		expect(await consentStatus()).toBeNull();
		expect(posthog.init).not.toHaveBeenCalled();
	});

	it("stays inert without a token, so local dev sends nothing", async () => {
		vi.stubGlobal("window", {});
		const { consentStatus, track } = await fresh();

		track("planner_started", { room: "kitchen" });

		expect(await consentStatus()).toBeNull();
		expect(posthog.init).not.toHaveBeenCalled();
	});

	it("initialises once, cookieless until consent, and forwards events in order", async () => {
		vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_test");
		vi.stubGlobal("window", {});
		const { track } = await fresh();

		track("planner_started", { room: "kitchen" });
		track("quote_viewed", { cabinets: 3 });

		await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));
		expect(posthog.init).toHaveBeenCalledTimes(1);
		// The PDPA default: without opt-out-by-default, "pending" sets cookies.
		expect(posthog.init.mock.calls[0][1]).toMatchObject({
			api_host: "/api/ph",
			cookieless_mode: "on_reject",
			opt_out_capturing_by_default: true,
			autocapture: false,
		});
		expect(posthog.capture).toHaveBeenNthCalledWith(1, "planner_started", {
			room: "kitchen",
		});
	});
});
