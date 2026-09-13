import { type FinishId, ratesOf } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import type { PlannerLayout } from "@/lib/planner/layout";
import { computePlannerPrice } from "@/lib/planner/pricing";

const sen = (rm: number) => Math.round(rm * 100) / 100;

/**
 * What an order is charged: the planner's own price for the design, plus the
 * catalogue's flat delivery fee. The same function the quote screen shows, run
 * again on the server against the published catalogue — the client never sends
 * a figure.
 */
export function priceOrder(
	layout: PlannerLayout,
	finishId: string,
	catalogue: PlannerCatalogue,
) {
	const price = computePlannerPrice(layout, finishId as FinishId, catalogue);
	const cabinetsRm = sen(price.totalRm);
	const deliveryRm = sen(ratesOf(catalogue).deliveryFlatRm);
	return {
		/** Stored on the order so its figures survive the catalogue moving on. */
		breakdown: { cabinets: price.cabinets, categories: price.categories },
		cabinetsRm,
		deliveryRm,
		totalRm: sen(cabinetsRm + deliveryRm),
	};
}

export type OrderPrice = ReturnType<typeof priceOrder>;
