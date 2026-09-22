import { describe, expect, it } from "vitest";
import {
	deliveryKindFor,
	draftFor,
	localeOf,
	type NotifyOrder,
	templatePayload,
	textPayload,
} from "../templates";

const order: NotifyOrder = {
	id: "ord1",
	number: 14,
	createdAt: new Date("2026-08-26T04:00:00Z"),
	publicToken: "tok_order",
	customerName: "Aisyah",
	customerPhone: "+60123456789",
	totalRm: 12345.5,
	locale: "ms",
	whatsappOptIn: true,
};
const delivery = { id: "del1", publicToken: "tok_delivery" };

describe("draftFor", () => {
	it("builds nothing for a customer who did not opt in", () => {
		expect(
			draftFor({
				kind: "ORDER_PLACED",
				order: { ...order, whatsappOptIn: false },
			}),
		).toBeNull();
	});

	it("order placed: name, ref, total; button opens the order", () => {
		expect(draftFor({ kind: "ORDER_PLACED", order })).toEqual({
			orderId: "ord1",
			deliveryId: null,
			kind: "ORDER_PLACED",
			stage: null,
			dedupeKey: "order:ord1:placed",
			to: "+60123456789",
			template: "order_placed",
			locale: "ms",
			vars: {
				body: ["Aisyah", "IC-20260826-014", "12,345.50"],
				button: "tok_order",
			},
		});
	});

	it("payment confirmed", () => {
		const draft = draftFor({ kind: "PAYMENT_CONFIRMED", order });
		expect(draft?.dedupeKey).toBe("order:ord1:paid");
		expect(draft?.template).toBe("payment_confirmed");
		expect(draft?.vars).toEqual({
			body: ["IC-20260826-014"],
			button: "tok_order",
		});
	});

	it("stage: one key per stage, label as given", () => {
		const draft = draftFor({
			kind: "STAGE",
			order,
			stage: "ASSEMBLY",
			stageLabel: "Pemasangan",
		});
		expect(draft?.dedupeKey).toBe("order:ord1:stage:ASSEMBLY");
		expect(draft?.stage).toBe("ASSEMBLY");
		expect(draft?.vars.body).toEqual(["IC-20260826-014", "Pemasangan"]);
	});

	it("delivery booked: carrier label and tracking number; button opens tracking", () => {
		const draft = draftFor({
			kind: "DELIVERY_BOOKED",
			order,
			delivery: { ...delivery, carrierId: "lalamove", carrierOrderId: "LLM-9" },
		});
		expect(draft?.dedupeKey).toBe("delivery:del1:booked");
		expect(draft?.deliveryId).toBe("del1");
		expect(draft?.vars).toEqual({
			body: ["IC-20260826-014", "Lalamove", "LLM-9"],
			button: "tok_delivery",
		});
	});

	it("the same carrier reading twice gives the same key", () => {
		const event = { kind: "DELIVERED" as const, order, delivery };
		expect(draftFor(event)?.dedupeKey).toBe("delivery:del1:DELIVERED");
		expect(draftFor(event)?.dedupeKey).toBe(draftFor(event)?.dedupeKey);
		expect(draftFor(event)?.template).toBe("delivery_delivered");
	});

	it("falls back to English for a locale we do not serve", () => {
		expect(
			draftFor({ kind: "ORDER_PLACED", order: { ...order, locale: "fr" } })
				?.locale,
		).toBe("en");
	});
});

describe("deliveryKindFor", () => {
	it("messages only the three moments a customer acts on", () => {
		expect(deliveryKindFor("PICKED_UP")).toBe("PICKED_UP");
		expect(deliveryKindFor("DELIVERED")).toBe("DELIVERED");
		expect(deliveryKindFor("FAILED")).toBe("DELIVERY_FAILED");
		expect(deliveryKindFor("CANCELLED")).toBe("DELIVERY_FAILED");
		expect(deliveryKindFor("DRIVER_ASSIGNED")).toBeNull();
		expect(deliveryKindFor("IN_TRANSIT")).toBeNull();
		expect(deliveryKindFor("BOOKED")).toBeNull();
	});
});

describe("payloads", () => {
	it("template: Meta's shape, language code mapped, + stripped", () => {
		expect(
			templatePayload("+60123456789", "production_stage", "zh", {
				body: ["IC-1", "组装"],
				button: "tok",
			}),
		).toEqual({
			messaging_product: "whatsapp",
			to: "60123456789",
			type: "template",
			template: {
				name: "production_stage",
				language: { code: "zh_CN" },
				components: [
					{
						type: "body",
						parameters: [
							{ type: "text", text: "IC-1" },
							{ type: "text", text: "组装" },
						],
					},
					{
						type: "button",
						sub_type: "url",
						index: "0",
						parameters: [{ type: "text", text: "tok" }],
					},
				],
			},
		});
	});

	it("text", () => {
		expect(textPayload("+60123456789", "hi")).toEqual({
			messaging_product: "whatsapp",
			to: "60123456789",
			type: "text",
			text: { body: "hi" },
		});
	});

	it("localeOf keeps a served locale", () => {
		expect(localeOf("zh")).toBe("zh");
		expect(localeOf("")).toBe("en");
	});
});
