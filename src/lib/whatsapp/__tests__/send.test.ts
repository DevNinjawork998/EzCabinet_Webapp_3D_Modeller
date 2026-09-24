import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify, nextState, sendMessage } from "../send";

const metaError = (code: number, message = "boom") =>
	JSON.stringify({ error: { code, message } });

function stubFetch(status: number, body: string) {
	const fetchMock = vi.fn(async () => new Response(body, { status }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	process.env.WHATSAPP_TOKEN = "t0ken";
	process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
});
afterEach(() => {
	vi.unstubAllGlobals();
	process.env.WHATSAPP_TOKEN = undefined;
	process.env.WHATSAPP_PHONE_NUMBER_ID = undefined;
});

describe("classify", () => {
	it("retries Meta's own trouble", () => {
		expect(classify(500, "").retryable).toBe(true);
		expect(classify(429, "").retryable).toBe(true);
	});

	it("retries rate limits Meta reports as 400", () => {
		expect(classify(400, metaError(131056)).retryable).toBe(true);
		expect(classify(400, metaError(130429)).retryable).toBe(true);
	});

	it("never retries a refusal that will be refused again", () => {
		const result = classify(400, metaError(132001, "Template does not exist"));
		expect(result).toEqual({
			retryable: false,
			error: "132001: Template does not exist",
		});
	});

	it("keeps an unparseable body as the error", () => {
		expect(classify(400, "nope")).toEqual({
			retryable: false,
			error: "400: nope",
		});
	});
});

describe("sendMessage", () => {
	it("posts to the phone number's messages edge with the bearer token", async () => {
		const fetchMock = stubFetch(
			200,
			JSON.stringify({ messages: [{ id: "wamid.1" }] }),
		);
		expect(await sendMessage({ hello: 1 })).toEqual({
			ok: true,
			messageId: "wamid.1",
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toMatch(/graph\.facebook\.com\/v[\d.]+\/123\/messages$/);
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer t0ken",
		);
	});

	it("is never retried by the HTTP helper — a resend is a duplicate message", async () => {
		const fetchMock = stubFetch(503, "");
		const result = await sendMessage({});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ ok: false, retryable: true });
	});

	it("treats a dropped connection as retryable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		expect(await sendMessage({})).toEqual({
			ok: false,
			retryable: true,
			error: "fetch failed",
		});
	});
});

describe("nextState", () => {
	const now = new Date("2026-09-22T00:00:00Z");

	it("sent", () => {
		expect(nextState({ ok: true, messageId: "w" }, 1, now)).toEqual({
			status: "SENT",
			metaMessageId: "w",
			sentAt: now,
			lastError: null,
		});
	});

	it("retryable stays pending until the fifth attempt", () => {
		const fail = { ok: false as const, retryable: true, error: "503" };
		expect(nextState(fail, 4, now)).toEqual({ lastError: "503" });
		expect(nextState(fail, 5, now)).toEqual({
			status: "FAILED",
			lastError: "503",
		});
	});

	it("permanent fails at once", () => {
		expect(
			nextState({ ok: false, retryable: false, error: "x" }, 1, now),
		).toEqual({ status: "FAILED", lastError: "x" });
	});
});
