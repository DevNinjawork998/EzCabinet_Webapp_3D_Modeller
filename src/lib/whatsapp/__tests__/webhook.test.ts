import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	parseWebhook,
	signatureValid,
	statusAdvances,
	statusesBefore,
} from "../webhook";

const sign = (raw: string, secret: string) =>
	`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

describe("signatureValid", () => {
	const raw = '{"entry":[]}';

	it("accepts Meta's HMAC of the raw body", () => {
		expect(signatureValid(raw, sign(raw, "s3cret"), "s3cret")).toBe(true);
	});

	it("rejects a wrong secret, a changed body and a missing header", () => {
		expect(signatureValid(raw, sign(raw, "other"), "s3cret")).toBe(false);
		expect(signatureValid(`${raw} `, sign(raw, "s3cret"), "s3cret")).toBe(
			false,
		);
		expect(signatureValid(raw, null, "s3cret")).toBe(false);
	});

	it("rejects everything when the secret is unset", () => {
		expect(signatureValid(raw, sign(raw, ""), "")).toBe(false);
	});
});

describe("parseWebhook", () => {
	const body = {
		object: "whatsapp_business_account",
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							statuses: [
								{ id: "wamid.1", status: "delivered" },
								{
									id: "wamid.2",
									status: "failed",
									errors: [{ code: 131026, title: "Message undeliverable" }],
								},
								{ id: "wamid.3", status: "deleted" },
							],
							messages: [
								{ from: "60123456789", type: "text" },
								{ from: "60123456789", type: "image" },
							],
						},
					},
				],
			},
		],
	};

	it("reads statuses, ignoring ones we do not track", () => {
		expect(parseWebhook(body).statuses).toEqual([
			{ messageId: "wamid.1", status: "DELIVERED", error: null },
			{
				messageId: "wamid.2",
				status: "FAILED",
				error: "131026: Message undeliverable",
			},
		]);
	});

	it("reads each sender once, as E.164", () => {
		expect(parseWebhook(body).senders).toEqual(["+60123456789"]);
	});

	it("returns nothing for a shape it does not know", () => {
		expect(parseWebhook({ hello: 1 })).toEqual({ statuses: [], senders: [] });
	});
});

describe("statusAdvances", () => {
	it("moves forward only", () => {
		expect(statusAdvances("SENT", "DELIVERED")).toBe(true);
		expect(statusAdvances("DELIVERED", "READ")).toBe(true);
		expect(statusAdvances("READ", "DELIVERED")).toBe(false);
		expect(statusAdvances("SENT", "SENT")).toBe(false);
	});

	it("fails a sent message, but never one already delivered or read", () => {
		expect(statusAdvances("SENT", "FAILED")).toBe(true);
		expect(statusAdvances("DELIVERED", "FAILED")).toBe(false);
		expect(statusAdvances("FAILED", "READ")).toBe(false);
	});
});

describe("statusesBefore", () => {
	it("lists every status DELIVERED can advance from", () => {
		expect(statusesBefore("DELIVERED")).toEqual(["PENDING", "SENT"]);
	});

	it("lists every status READ can advance from", () => {
		expect(statusesBefore("READ")).toEqual(["PENDING", "SENT", "DELIVERED"]);
	});

	it("lists every status FAILED can land on", () => {
		expect(statusesBefore("FAILED")).toEqual(["PENDING", "SENT"]);
	});
});
