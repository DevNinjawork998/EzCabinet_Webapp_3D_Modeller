import { z } from "zod";
import type { PriceLine } from "@/lib/planner/pricing";

/** Only the fields a summary renders; a breakdown it cannot read has no lines. */
const breakdownSchema = z.object({
	cabinets: z.array(
		z.object({
			label: z.string(),
			doorLabel: z.string().nullable(),
			amountRm: z.number(),
		}),
	),
});

export type SummaryLine = { name: string; qty: number; amountRm: number };

/**
 * An order's stored breakdown as the lines a person reads: one per cabinet and
 * front, identical ones counted. Shared by the customer's confirmation page and
 * the admin order page so the two never disagree about what was bought.
 */
export function summaryLines(breakdown: unknown): SummaryLine[] {
	const parsed = breakdownSchema.safeParse(breakdown);
	const lines = new Map<string, SummaryLine>();
	for (const cabinet of parsed.success ? parsed.data.cabinets : []) {
		const name = cabinet.doorLabel
			? `${cabinet.label} — ${cabinet.doorLabel}`
			: cabinet.label;
		const line = lines.get(name) ?? { name, qty: 0, amountRm: 0 };
		line.qty += 1;
		line.amountRm += cabinet.amountRm;
		lines.set(name, line);
	}
	return [...lines.values()];
}

/** Carcasses and doors are already in the per-cabinet lines above. */
const EXTRA_IDS = ["worktop", "ceilingTrim", "skirting", "endPanels"] as const;

const extrasSchema = z.object({
	categories: z.array(
		z.object({
			id: z.string(),
			detail: z.object({
				key: z.string(),
				vars: z
					.record(z.string(), z.union([z.string(), z.number()]))
					.optional(),
			}),
			amountRm: z.number(),
		}),
	),
});

/**
 * What the order charged beyond its cabinets — worktop, ceiling trim, kick
 * board, end panels — as the planner's own price lines, so a page labels them
 * with `priceLineLabel` exactly as checkout did. Without these the summary's
 * lines stopped short of the subtotal it printed under them.
 */
export function summaryExtras(breakdown: unknown): PriceLine[] {
	const parsed = extrasSchema.safeParse(breakdown);
	if (!parsed.success) return [];
	return parsed.data.categories.filter(
		(line): line is PriceLine =>
			(EXTRA_IDS as readonly string[]).includes(line.id) && line.amountRm > 0,
	);
}
