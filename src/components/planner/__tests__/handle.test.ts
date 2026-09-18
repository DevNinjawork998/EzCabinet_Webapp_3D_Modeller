import { describe, expect, it } from "vitest";
import { HANDLE_DROP, HANDLE_REACH, handleCentreM, PUCK_LIFT } from "../handle";

/**
 * One property: an upright handle never reaches below the floor.
 *
 * Only upright ones — a cabinet on the floor lays its handle flat, so that
 * reach is horizontal and says nothing about height.
 */
const clearsFloor = (floorHeightMm: number) =>
	handleCentreM(floorHeightMm) - HANDLE_REACH >= PUCK_LIFT;

/** The lift at which there is finally room to hang the handle properly. */
const THRESHOLD_MM = (HANDLE_DROP + HANDLE_REACH + PUCK_LIFT) * 1000;

describe("handleCentreM", () => {
	it("lays a resting cabinet's handle a hair above the floor", () => {
		expect(handleCentreM(0)).toBe(PUCK_LIFT);
	});

	it("keeps a lifted cabinet's handle out of the floor at every height", () => {
		// The bug this covers: a 1mm nudge dropped the handle to −139mm and the
		// floor cut the ring in half. 346 is the last millimetre of the clamp.
		for (const liftMm of [1, 4, 40, 100, 200, 300, 346]) {
			expect(clearsFloor(liftMm)).toBe(true);
		}
	});

	it("parks at one height until there is room, then tracks the underside", () => {
		expect(THRESHOLD_MM).toBeCloseTo(347, 6);
		// Below it, every lift gives the same parked height.
		expect(handleCentreM(40)).toBe(handleCentreM(300));
		// Above it, the handle hangs its full drop below the underside.
		expect(handleCentreM(600)).toBeCloseTo(0.6 - HANDLE_DROP, 10);
		expect(handleCentreM(1500)).toBeCloseTo(1.5 - HANDLE_DROP, 10);
		expect(clearsFloor(1500)).toBe(true);
	});

	it("never drops as the cabinet rises", () => {
		// A handle that dipped on the way up would read as coming loose.
		let previous = handleCentreM(0);
		for (let liftMm = 0; liftMm <= 2400; liftMm += 13) {
			const y = handleCentreM(liftMm);
			expect(y).toBeGreaterThanOrEqual(previous);
			previous = y;
		}
	});
});
