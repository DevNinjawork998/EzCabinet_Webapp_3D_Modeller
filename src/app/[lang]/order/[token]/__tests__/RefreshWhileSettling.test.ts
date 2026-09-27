import { describe, expect, it } from "vitest";
import { nextDelay } from "../RefreshWhileSettling";

describe("nextDelay", () => {
	it("backs off by half again each time", () => {
		expect(nextDelay(3_000)).toBe(4_500);
		expect(nextDelay(4_500)).toBe(6_750);
	});

	it("never waits longer than 30 seconds", () => {
		expect(nextDelay(25_000)).toBe(30_000);
		expect(nextDelay(30_000)).toBe(30_000);
	});

	it("reaches the 30-second ceiling within about two minutes", () => {
		let delay = 3_000;
		let elapsed = 0;
		while (delay < 30_000) {
			elapsed += delay;
			delay = nextDelay(delay);
		}
		expect(elapsed).toBeLessThan(120_000);
	});
});
