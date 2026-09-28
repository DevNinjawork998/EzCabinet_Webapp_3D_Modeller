import type { ProductionStage } from "@/generated/prisma/enums";
import { summaryLines } from "./summary";

type CardInput = {
	status: "AWAITING_PAYMENT" | "PAID" | "CANCELLED";
	productionStage: ProductionStage | null;
	hasDelivery: boolean;
};

export type OrderCard = {
	badge: "paid" | "awaiting" | "cancelled";
	stage:
		| { kind: "notStarted" }
		| { kind: "paid" }
		| { kind: "stage"; stage: ProductionStage }
		| { kind: "delivery" };
	canPay: boolean;
	canTrack: boolean;
};

/**
 * What an order's card on My orders says and offers. Pure, so the list and
 * the detail page agree. A booked delivery is the furthest thing a customer
 * can follow, so it wins over the production stage.
 */
export function orderCard(order: CardInput): OrderCard {
	const paid = order.status === "PAID";
	return {
		badge: paid
			? "paid"
			: order.status === "CANCELLED"
				? "cancelled"
				: "awaiting",
		stage: !paid
			? { kind: "notStarted" }
			: order.hasDelivery
				? { kind: "delivery" }
				: order.productionStage
					? { kind: "stage", stage: order.productionStage }
					: { kind: "paid" },
		canPay: order.status === "AWAITING_PAYMENT",
		canTrack: order.hasDelivery,
	};
}

/** Cabinets in the stored breakdown; zero when it cannot be read. */
export const unitCount = (breakdown: unknown): number =>
	summaryLines(breakdown).reduce((sum, line) => sum + line.qty, 0);
