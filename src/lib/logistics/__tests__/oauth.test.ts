import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	easyparcelAppConfigured,
	easyparcelLoginUrl,
	easyparcelRedirectUri,
	requestToken,
	tokenResponseSchema,
	willExpireSoon,
} from "../oauth";
import { tokenReply } from "./fixtures/easyparcel";

/** Queue one JSON response per call, in order. Same helper as lalamove.test.ts. */
function stubResponses(...bodies: unknown[]) {
	const fetchMock = vi.fn(async (..._args: unknown[]) => {
		const next = bodies.shift() ?? {};
		return new Response(JSON.stringify(next), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.stubEnv("EASYPARCEL_CLIENT_ID", "cid");
	vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "csecret");
	vi.stubEnv("APP_URL", "https://planner.example.com");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("easyparcelAppConfigured", () => {
	it("is false when either half of the app credentials is missing", () => {
		vi.stubEnv("EASYPARCEL_CLIENT_SECRET", "");
		expect(easyparcelAppConfigured()).toBe(false);
	});

	it("is true with both", () => {
		expect(easyparcelAppConfigured()).toBe(true);
	});
});

describe("easyparcelLoginUrl", () => {
	it("sends the client id, the redirect uri and the CSRF state", () => {
		const url = new URL(easyparcelLoginUrl("nonce-1"));
		expect(url.origin + url.pathname).toBe(
			"https://api.easyparcel.com/oauth/login",
		);
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("state")).toBe("nonce-1");
		expect(url.searchParams.get("redirect_uri")).toBe(easyparcelRedirectUri());
	});

	it("builds the redirect uri off APP_URL, because it must match what is registered", () => {
		expect(easyparcelRedirectUri()).toBe(
			"https://planner.example.com/api/admin/logistics/easyparcel/callback",
		);
	});

	it("strips a trailing slash, which would otherwise be a byte mismatch", () => {
		// EasyParcel compares the string, not the URL. `https://x.com//api/...`
		// and `https://x.com/api/...` address the same route and are two
		// different registrations, and the error names neither.
		vi.stubEnv("APP_URL", "https://planner.example.com/");
		expect(easyparcelRedirectUri()).toBe(
			"https://planner.example.com/api/admin/logistics/easyparcel/callback",
		);
	});

	it("falls back to localhost only in development", () => {
		vi.stubEnv("APP_URL", "");
		vi.stubEnv("NODE_ENV", "development");
		expect(easyparcelRedirectUri()).toBe(
			"http://localhost:3000/api/admin/logistics/easyparcel/callback",
		);
	});

	it("refuses to guess localhost on a deployment, and names APP_URL", () => {
		// Silently sending a localhost redirect from a deployed server produces
		// "redirect_uri does not match client value" at EasyParcel — an error
		// that names their client, not our missing variable, and sends whoever
		// reads it to the wrong place entirely.
		vi.stubEnv("APP_URL", "");
		vi.stubEnv("NODE_ENV", "production");
		expect(() => easyparcelRedirectUri()).toThrow(/APP_URL/);
	});
});

describe("requestToken", () => {
	it("posts form-encoded parameters, not JSON", async () => {
		const fetchMock = stubResponses(tokenReply);

		await requestToken({ grant_type: "authorization_code", code: "abc" });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toBe("https://api.easyparcel.com/oauth/token");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
		const sent = new URLSearchParams(init.body as string);
		expect(sent.get("grant_type")).toBe("authorization_code");
		expect(sent.get("code")).toBe("abc");
	});

	it("authenticates the app with Basic base64(id:secret)", async () => {
		const fetchMock = stubResponses(tokenReply);

		await requestToken({ grant_type: "refresh_token", refresh_token: "rt" });

		const headers = (fetchMock.mock.calls[0][1] as RequestInit)
			.headers as Record<string, string>;
		expect(headers.authorization).toBe(
			`Basic ${Buffer.from("cid:csecret").toString("base64")}`,
		);
	});

	it("returns their documented token reply, parsed", async () => {
		stubResponses(tokenReply);

		const token = await requestToken({ grant_type: "refresh_token" });

		expect(token.access_token).toBe("at_sandbox");
		expect(token.refresh_token).toBe("rt_sandbox");
		expect(token.expires_in).toBe(36000);
	});

	it("says it could not read the reply, without the payload", async () => {
		stubResponses({ status_code: 401, message: "Unauthorized access" });

		await expect(requestToken({ grant_type: "refresh_token" })).rejects.toThrow(
			/could not be read/,
		);
	});
});

describe("tokenResponseSchema", () => {
	it("survives a reply that omits the optional app block", () => {
		const parsed = tokenResponseSchema.parse({
			access_token: "at",
			refresh_token: "rt",
			expires_in: 36000,
			refresh_token_expires_in: 31557600,
		});
		expect(parsed.expires_in).toBe(36000);
	});

	it("refuses a reply with no access token", () => {
		expect(() => tokenResponseSchema.parse({ token_type: "Bearer" })).toThrow();
	});
});

describe("willExpireSoon", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
	});

	it("is false for a token with hours left", () => {
		expect(willExpireSoon(new Date("2026-09-06T09:00:00Z"))).toBe(false);
	});

	it("is true inside the safety margin, so a call never races the expiry", () => {
		expect(willExpireSoon(new Date("2026-09-06T00:00:30Z"))).toBe(true);
	});

	it("is true for a token that already expired", () => {
		expect(willExpireSoon(new Date("2026-09-05T23:00:00Z"))).toBe(true);
	});
});
