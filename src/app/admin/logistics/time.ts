import type { DeliveryEventRow } from "./form";

/**
 * Times as the delivery screens say them — "Sep 5, 4:12 pm" — pinned to
 * Malaysian time.
 *
 * Pinned rather than read from the browser because the detail page is
 * server-rendered now: a Vercel function formats in UTC, the admin's browser in
 * MYT, and the two strings disagree on hydration. The workshop, the drivers and
 * every admin are in Klang Valley, so one zone is also the honest answer.
 */
const ZONE = "Asia/Kuala_Lumpur";

const DAY = new Intl.DateTimeFormat("en-US", {
	timeZone: ZONE,
	month: "short",
	day: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-US", {
	timeZone: ZONE,
	hour: "numeric",
	minute: "2-digit",
});

/** "Sep 5" */
export const dayLabel = (iso: string) => DAY.format(new Date(iso));

/** "4:12 pm" — ICU puts a narrow no-break space before the meridiem. */
export const timeLabel = (iso: string) =>
	TIME.format(new Date(iso))
		.replace(/\s/g, " ")
		.replace("AM", "am")
		.replace("PM", "pm");

/** "Sep 5, 4:12 pm" */
export const shortTime = (iso: string) => `${dayLabel(iso)}, ${timeLabel(iso)}`;

/**
 * Events under a heading per day, newest first as they arrive.
 *
 * Consecutive runs only: events come ordered by time, so a day never reappears
 * further down, and grouping by run keeps that order without sorting again.
 */
export function activityGroups<E extends Pick<DeliveryEventRow, "at">>(
	events: readonly E[],
): { day: string; events: E[] }[] {
	const groups: { day: string; events: E[] }[] = [];
	for (const event of events) {
		const day = dayLabel(event.at);
		const last = groups.at(-1);
		if (last?.day === day) last.events.push(event);
		else groups.push({ day, events: [event] });
	}
	return groups;
}
