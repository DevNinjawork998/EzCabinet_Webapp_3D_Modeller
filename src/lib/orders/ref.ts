/**
 * The order number as a customer reads it: `IC-20260826-014`, the format in the
 * client's own Order Confirmation design.
 *
 * The date is the day it was placed in Malaysia — a function on Vercel runs in
 * UTC, and an order placed at 1am in Kuala Lumpur belongs to that day. Distinct
 * from a delivery's `IC-00042`, so the two are never read as the same thing.
 */
const DAY = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Kuala_Lumpur",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

export const orderRef = (number: number, createdAt: Date | string): string =>
	`IC-${DAY.format(new Date(createdAt)).replaceAll("-", "")}-${String(number).padStart(3, "0")}`;
