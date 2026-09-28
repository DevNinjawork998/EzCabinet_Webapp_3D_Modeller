import { describe, expect, it } from "vitest";
import { orderCard, unitCount } from "../card";

describe("orderCard", () => {
	it("awaiting payment: pay, nothing in production, no tracking", () => {
		expect(
			orderCard({
				status: "AWAITING_PAYMENT",
				productionStage: null,
				hasDelivery: false,
			}),
		).toEqual({
			badge: "awaiting",
			stage: { kind: "notStarted" },
			canPay: true,
			canTrack: false,
		});
	});

	it("cancelled: no pay, not started", () => {
		expect(
			orderCard({
				status: "CANCELLED",
				productionStage: null,
				hasDelivery: false,
			}),
		).toEqual({
			badge: "cancelled",
			stage: { kind: "notStarted" },
			canPay: false,
			canTrack: false,
		});
	});

	it("paid, not started: payment received", () => {
		expect(
			orderCard({ status: "PAID", productionStage: null, hasDelivery: false })
				.stage,
		).toEqual({ kind: "paid" });
	});

	it("paid mid-production: the stage", () => {
		expect(
			orderCard({
				status: "PAID",
				productionStage: "CUTTING",
				hasDelivery: false,
			}),
		).toEqual({
			badge: "paid",
			stage: { kind: "stage", stage: "CUTTING" },
			canPay: false,
			canTrack: false,
		});
	});

	it("a delivery wins over the stage and can be tracked", () => {
		expect(
			orderCard({
				status: "PAID",
				productionStage: "READY",
				hasDelivery: true,
			}),
		).toEqual({
			badge: "paid",
			stage: { kind: "delivery" },
			canPay: false,
			canTrack: true,
		});
	});
});

describe("unitCount", () => {
	it("counts every cabinet line", () => {
		const breakdown = {
			cabinets: [
				{ label: "BC 600", doorLabel: "Slab", amountRm: 500 },
				{ label: "BC 600", doorLabel: "Slab", amountRm: 500 },
				{ label: "BC 800", doorLabel: null, amountRm: 700 },
			],
		};
		expect(unitCount(breakdown)).toBe(3);
	});

	it("is zero for a breakdown it cannot read", () => {
		expect(unitCount(null)).toBe(0);
		expect(unitCount({ nope: true })).toBe(0);
	});
});
