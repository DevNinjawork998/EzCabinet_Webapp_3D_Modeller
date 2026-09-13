import type { DeliveryItem } from "@/lib/logistics/types";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { type PlannerLayout, plannerEngine } from "@/lib/planner/layout";

/**
 * What goes on the lorry for an order, as the delivery form's item rows.
 *
 * One row per cabinet, identical cabinets counted rather than repeated. The box
 * is the cabinet's own: width as placed, height and depth from its design. The
 * weight is whatever the design row was given, and blank otherwise — a guessed
 * kilogram would be quoted against by a parcel partner and invoiced differently.
 *
 * Worktops, end panels and skirting are not rows here; they cross cabinets and
 * no design describes them, so the admin adds them by hand.
 */
export function deliveryItemsFor(
	layout: PlannerLayout,
	catalogue: PlannerCatalogue,
): DeliveryItem[] {
	const rows = new Map<string, DeliveryItem>();
	for (const { family, widthMm } of plannerEngine(catalogue).allPositions(
		layout,
	)) {
		const key = `${family.id}:${widthMm}`;
		const row = rows.get(key);
		if (row) {
			row.qty += 1;
			continue;
		}
		const size = family.sizes.find((s) => s.widthMm === widthMm);
		// A one-size family is one design, whose name already says its width.
		const label =
			family.sizes.length > 1 ? `${family.label} ${widthMm} mm` : family.label;
		rows.set(key, {
			label: label.slice(0, 120),
			qty: 1,
			widthMm: Math.round(widthMm),
			heightMm: Math.round(family.heightMm),
			depthMm: Math.round(family.depthMm),
			weightKg: size?.weightKg ?? null,
		});
	}
	return [...rows.values()];
}
