import "server-only";
import type {
	NotificationKind,
	ProductionStage,
} from "@/generated/prisma/enums";
import { isLocale, type Locale } from "@/lib/copy/locales";
import { LABEL as CARRIER_LABEL } from "@/lib/logistics/carriers";
import type { DeliveryStatusName } from "@/lib/logistics/types";
import { orderRef } from "@/lib/orders/ref";

/**
 * Which event becomes which WhatsApp message.
 *
 * Every business-initiated message is a template Meta approved in advance, so
 * all this decides is the template name, the positional variables and the link
 * suffix. The wording lives in `docs/ops/whatsapp-ezcabinet-setup.md` — the
 * copy EzCabinet submits — and the variable order here must match it.
 */

/** The order fields a message needs. Select exactly these wherever one is built. */
export const NOTIFY_ORDER_SELECT = {
	id: true,
	number: true,
	createdAt: true,
	publicToken: true,
	customerName: true,
	customerPhone: true,
	totalRm: true,
	locale: true,
	whatsappOptIn: true,
} as const;

export type NotifyOrder = {
	id: string;
	number: number;
	createdAt: Date;
	publicToken: string;
	customerName: string;
	customerPhone: string;
	totalRm: number;
	locale: string;
	whatsappOptIn: boolean;
};

type DeliveryRef = { id: string; publicToken: string };

export type NotifyEvent =
	| { kind: "ORDER_PLACED" | "PAYMENT_CONFIRMED"; order: NotifyOrder }
	| {
			kind: "STAGE";
			order: NotifyOrder;
			stage: ProductionStage;
			/** Already translated into the order's locale — the site dictionary's word. */
			stageLabel: string;
	  }
	| {
			kind: "DELIVERY_BOOKED";
			order: NotifyOrder;
			delivery: DeliveryRef & { carrierId: string; carrierOrderId: string };
	  }
	| {
			kind: "PICKED_UP" | "DELIVERED" | "DELIVERY_FAILED";
			order: NotifyOrder;
			delivery: DeliveryRef;
	  };

/** Body variables in template order, and the URL button's dynamic suffix. */
export type TemplateVars = { body: string[]; button: string };

export type NotificationDraft = {
	orderId: string;
	deliveryId: string | null;
	kind: NotificationKind;
	stage: ProductionStage | null;
	dedupeKey: string;
	to: string;
	template: string;
	locale: Locale;
	vars: TemplateVars;
};

const TEMPLATE: Record<NotificationKind, string> = {
	ORDER_PLACED: "order_placed",
	PAYMENT_CONFIRMED: "payment_confirmed",
	STAGE: "production_stage",
	DELIVERY_BOOKED: "delivery_booked",
	PICKED_UP: "delivery_picked_up",
	DELIVERED: "delivery_delivered",
	DELIVERY_FAILED: "delivery_failed",
};

/** Meta's language codes for the locales we serve. */
const LANGUAGE: Record<Locale, string> = { en: "en", zh: "zh_CN", ms: "ms" };

export const localeOf = (value: string): Locale =>
	isLocale(value) ? value : "en";

/**
 * The delivery statuses a customer hears about. Assigned-driver and in-transit
 * pings are noise; picked up, delivered and failed are what they act on.
 */
export function deliveryKindFor(
	status: DeliveryStatusName,
): "PICKED_UP" | "DELIVERED" | "DELIVERY_FAILED" | null {
	if (status === "PICKED_UP" || status === "DELIVERED") return status;
	if (status === "FAILED" || status === "CANCELLED") return "DELIVERY_FAILED";
	return null;
}

const money = (amount: number) =>
	amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});

/** The row to enqueue for an event, or null when the customer did not opt in. */
export function draftFor(event: NotifyEvent): NotificationDraft | null {
	const { order } = event;
	if (!order.whatsappOptIn) return null;
	const ref = orderRef(order.number, order.createdAt);
	const base = {
		orderId: order.id,
		deliveryId: null,
		kind: event.kind,
		stage: null,
		to: order.customerPhone,
		template: TEMPLATE[event.kind],
		locale: localeOf(order.locale),
	};

	switch (event.kind) {
		case "ORDER_PLACED":
			return {
				...base,
				dedupeKey: `order:${order.id}:placed`,
				vars: {
					body: [order.customerName, ref, money(order.totalRm)],
					button: order.publicToken,
				},
			};
		case "PAYMENT_CONFIRMED":
			return {
				...base,
				dedupeKey: `order:${order.id}:paid`,
				vars: { body: [ref], button: order.publicToken },
			};
		case "STAGE":
			return {
				...base,
				stage: event.stage,
				dedupeKey: `order:${order.id}:stage:${event.stage}`,
				vars: { body: [ref, event.stageLabel], button: order.publicToken },
			};
		case "DELIVERY_BOOKED":
			return {
				...base,
				deliveryId: event.delivery.id,
				dedupeKey: `delivery:${event.delivery.id}:booked`,
				vars: {
					body: [
						ref,
						CARRIER_LABEL[event.delivery.carrierId] ?? event.delivery.carrierId,
						event.delivery.carrierOrderId,
					],
					button: event.delivery.publicToken,
				},
			};
		default:
			return {
				...base,
				deliveryId: event.delivery.id,
				dedupeKey: `delivery:${event.delivery.id}:${event.kind}`,
				vars: { body: [ref], button: event.delivery.publicToken },
			};
	}
}

const recipient = (to: string) => to.replace(/^\+/, "");

export function templatePayload(
	to: string,
	template: string,
	locale: Locale,
	vars: TemplateVars,
) {
	return {
		messaging_product: "whatsapp",
		to: recipient(to),
		type: "template",
		template: {
			name: template,
			language: { code: LANGUAGE[locale] },
			components: [
				{
					type: "body",
					parameters: vars.body.map((text) => ({ type: "text", text })),
				},
				{
					type: "button",
					sub_type: "url",
					index: "0",
					parameters: [{ type: "text", text: vars.button }],
				},
			],
		},
	};
}

/** Free-form text — only allowed inside the 24 h after the customer wrote to us. */
export const textPayload = (to: string, body: string) => ({
	messaging_product: "whatsapp",
	to: recipient(to),
	type: "text",
	text: { body },
});
