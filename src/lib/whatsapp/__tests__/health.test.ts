import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHealth, reportHealth } from "../health";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const phoneOk = () =>
	json({ id: "123", display_phone_number: "+60 3-1234 5678" });
const templates = (...rows: { language: string; status: string }[]) =>
	json({ data: rows.map((row) => ({ name: "order_placed", ...row })) });
const allApproved = () =>
	templates(
		{ language: "en", status: "APPROVED" },
		{ language: "zh_CN", status: "APPROVED" },
		{ language: "ms", status: "APPROVED" },
	);

/** Answer the phone-number read, then the template read, in that order. */
function metaAnswers(...responses: Response[]) {
	const fetchMock = vi.fn();
	for (const response of responses) fetchMock.mockResolvedValueOnce(response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	process.env.WHATSAPP_TOKEN = "t0ken";
	process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
	process.env.WHATSAPP_WABA_ID = "999";
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.WHATSAPP_TOKEN;
	delete process.env.WHATSAPP_PHONE_NUMBER_ID;
	delete process.env.WHATSAPP_WABA_ID;
});

describe("checkHealth", () => {
	it("is healthy when the token works and order_placed is approved in every language", async () => {
		const fetchMock = metaAnswers(phoneOk(), allApproved());
		expect(await checkHealth()).toEqual({ ok: true });
		expect(String(fetchMock.mock.calls[1][0])).toContain(
			"/999/message_templates",
		);
	});

	it("reports a dead token before looking at templates", async () => {
		const fetchMock = metaAnswers(
			json({ error: { code: 190, message: "Session has expired" } }, 401),
		);
		const result = await checkHealth();
		expect(result).toEqual({
			ok: false,
			reason: expect.stringContaining("190"),
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports a language whose template is not approved", async () => {
		metaAnswers(
			phoneOk(),
			templates(
				{ language: "en", status: "APPROVED" },
				{ language: "zh_CN", status: "REJECTED" },
				{ language: "ms", status: "APPROVED" },
			),
		);
		expect(await checkHealth()).toEqual({
			ok: false,
			reason: "order_placed (zh_CN) is REJECTED",
		});
	});

	it("reports a language with no template at all", async () => {
		metaAnswers(phoneOk(), templates({ language: "en", status: "APPROVED" }));
		expect(await checkHealth()).toEqual({
			ok: false,
			reason: "order_placed (zh_CN) is missing",
		});
	});

	it("says so when the account id is not set, rather than passing", async () => {
		delete process.env.WHATSAPP_WABA_ID;
		metaAnswers(phoneOk());
		expect(await checkHealth()).toEqual({
			ok: false,
			reason: "WHATSAPP_WABA_ID is not set",
		});
	});
});

describe("reportHealth", () => {
	const onTheHour = new Date("2026-09-26T09:03:00Z");
	const halfPast = new Date("2026-09-26T09:33:00Z");
	let errorSpy: ReturnType<typeof vi.spyOn>;
	const logged = () =>
		errorSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
		delete process.env.VERCEL_ENV;
	});

	it("alerts when the check fails", async () => {
		metaAnswers(json({ error: { code: 190, message: "expired" } }, 401));
		await reportHealth(onTheHour);
		expect(logged()).toEqual([
			{ type: "WHATSAPP_UNHEALTHY", reason: expect.stringContaining("190") },
		]);
	});

	it("stays quiet when healthy", async () => {
		metaAnswers(phoneOk(), allApproved());
		await reportHealth(onTheHour);
		expect(logged()).toEqual([]);
	});

	it("asks Meta once an hour, not on every ten-minute run", async () => {
		const fetchMock = metaAnswers();
		await reportHealth(halfPast);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("alerts when production has no token at all", async () => {
		delete process.env.WHATSAPP_TOKEN;
		process.env.VERCEL_ENV = "production";
		await reportHealth(onTheHour);
		expect(logged()).toEqual([{ type: "WHATSAPP_UNCONFIGURED" }]);
	});

	it("says nothing about a missing token outside production", async () => {
		delete process.env.WHATSAPP_TOKEN;
		process.env.VERCEL_ENV = "preview";
		await reportHealth(onTheHour);
		expect(logged()).toEqual([]);
	});
});
