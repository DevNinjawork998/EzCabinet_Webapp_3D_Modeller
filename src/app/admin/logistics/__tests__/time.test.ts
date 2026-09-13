import { describe, expect, it } from "vitest";
import { activityGroups, shortTime } from "../time";

describe("shortTime", () => {
	it("says the time in Malaysia, whatever zone the server runs in", () => {
		// 08:12 UTC is 4:12 pm in Kuala Lumpur.
		expect(shortTime("2026-09-05T08:12:00.000Z")).toBe("Sep 5, 4:12 pm");
	});
});

describe("activityGroups", () => {
	it("groups by the Malaysian day, not the UTC one", () => {
		const events = [
			// 17:30 UTC on the 5th is 1:30 am on the 6th in Kuala Lumpur.
			{ at: "2026-09-05T17:30:00.000Z", message: "delivered" },
			{ at: "2026-09-05T09:00:00.000Z", message: "picked up" },
			{ at: "2026-09-05T02:00:00.000Z", message: "booked" },
		];

		const groups = activityGroups(events);

		expect(groups.map((g) => g.day)).toEqual(["Sep 6", "Sep 5"]);
		expect(groups[1].events.map((e) => e.message)).toEqual([
			"picked up",
			"booked",
		]);
	});

	it("has nothing to group when nothing has happened", () => {
		expect(activityGroups([])).toEqual([]);
	});
});
