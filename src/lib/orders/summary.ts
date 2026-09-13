import { z } from "zod";

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
