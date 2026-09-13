import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import {
	emptyLayout,
	type PlannerLayout,
	plannerEngine,
} from "@/lib/planner/layout";
import { computePlannerPrice } from "@/lib/planner/pricing";
import { deliveryItemsFor } from "../items";
import { plannerLayoutSchema } from "../layoutSchema";
import { priceOrder } from "../price";
import { orderRef } from "../ref";
import { validateOrder } from "../validate";

const catalogue = PLANNER_CATALOGUE;
const engine = plannerEngine(catalogue);
const kitchen = catalogue.roomTypes.find((r) => r.id === "kitchen");
const finishId = catalogue.finishes[0].id;

/** A family the kitchen offers, and one it does not. */
const inKitchen = catalogue.families.find(
	(f) => f.kind === "base" && kitchen?.familyIds.includes(f.id),
);
const notInKitchen = catalogue.families.find(
	(f) => !kitchen?.familyIds.includes(f.id),
);
if (!kitchen || !inKitchen || !notInKitchen) {
	throw new Error("seed catalogue no longer has the fixtures these tests need");
}

/** Two of the same base cabinet side by side, built by the engine itself. */
const twoCabinets = (): PlannerLayout => {
	const width = inKitchen.sizes[0].widthMm;
	const one = engine.addModule(emptyLayout(4200), inKitchen.id, 0);
	return engine.addModule(one, inKitchen.id, width);
};

const clone = (layout: PlannerLayout): PlannerLayout =>
	JSON.parse(JSON.stringify(layout));

const check = (layout: PlannerLayout, cat: PlannerCatalogue = catalogue) =>
	validateOrder(layout, "kitchen", finishId, cat);

describe("validateOrder", () => {
	it("accepts a layout the planner itself built", () => {
		const layout = twoCabinets();
		expect(layout.floor).toHaveLength(2);
		expect(check(layout)).toEqual({ ok: true });
	});

	it("refuses an empty wall", () => {
		expect(check(emptyLayout(4200))).toMatchObject({ problem: "empty" });
	});

	it("refuses a width that is not one of the cabinet's sizes", () => {
		const layout = clone(twoCabinets());
		layout.floor[0].widthMm = 777;
		expect(check(layout)).toMatchObject({ problem: "off_ladder" });
	});

	it("refuses a cabinet the catalogue does not know", () => {
		const layout = clone(twoCabinets());
		layout.floor[0].familyId = "made-up";
		expect(check(layout)).toMatchObject({ problem: "unknown_cabinet" });
	});

	it("refuses a cabinet this room does not offer", () => {
		const layout = clone(twoCabinets());
		layout.floor[0].familyId = notInKitchen.id;
		layout.floor[0].widthMm = notInKitchen.sizes[0].widthMm;
		expect(check(layout)).toMatchObject({ problem: "not_in_room" });
	});

	it("refuses two cabinets in the same place", () => {
		const layout = clone(twoCabinets());
		layout.floor[1].xMm = layout.floor[0].xMm;
		expect(check(layout)).toMatchObject({ problem: "does_not_fit" });
	});

	it("refuses a repeated cabinet id", () => {
		const layout = clone(twoCabinets());
		layout.floor[1].id = layout.floor[0].id;
		expect(check(layout)).toMatchObject({ problem: "duplicate_id" });
	});

	it("refuses an unknown room or finish", () => {
		const layout = twoCabinets();
		expect(validateOrder(layout, "garage", finishId, catalogue)).toMatchObject({
			problem: "unknown_room",
		});
		expect(validateOrder(layout, "kitchen", "neon", catalogue)).toMatchObject({
			problem: "unknown_finish",
		});
	});
});

describe("priceOrder", () => {
	it("charges the planner's price plus the flat delivery fee", () => {
		const layout = twoCabinets();
		const planner = computePlannerPrice(layout, finishId, catalogue);
		const withFee = {
			...catalogue,
			rates: { worktopRmPerFt: 200, deliveryFlatRm: 60 },
		};

		const order = priceOrder(layout, finishId, withFee);

		expect(order.deliveryRm).toBe(60);
		expect(order.cabinetsRm).toBeCloseTo(
			computePlannerPrice(layout, finishId, withFee).totalRm,
			2,
		);
		expect(order.totalRm).toBeCloseTo(order.cabinetsRm + 60, 2);
		expect(order.breakdown.cabinets).toHaveLength(planner.cabinets.length);
	});
});

describe("deliveryItemsFor", () => {
	it("counts identical cabinets on one row with the design's box", () => {
		const layout = twoCabinets();
		// `addModule` places a family's middle size, so read the width back.
		const widthMm = layout.floor[0].widthMm;

		expect(deliveryItemsFor(layout, catalogue)).toEqual([
			{
				label: expect.stringContaining(inKitchen.label),
				qty: 2,
				widthMm,
				heightMm: inKitchen.heightMm,
				depthMm: inKitchen.depthMm,
				weightKg: null,
			},
		]);
	});

	it("takes the weight from the size when the design has one", () => {
		const layout = twoCabinets();
		const weighed: PlannerCatalogue = JSON.parse(JSON.stringify(catalogue));
		const size = weighed.families
			.find((f) => f.id === inKitchen.id)
			?.sizes.find((s) => s.widthMm === layout.floor[0].widthMm);
		if (!size) throw new Error("fixture");
		size.weightKg = 41.5;

		expect(deliveryItemsFor(layout, weighed)[0].weightKg).toBe(41.5);
	});
});

describe("plannerLayoutSchema", () => {
	it("strips anything the planner does not store", () => {
		const layout = { ...twoCabinets(), priceRm: 1 };
		expect(plannerLayoutSchema.parse(layout)).not.toHaveProperty("priceRm");
	});

	it("refuses a hinge side that does not exist", () => {
		const layout = clone(twoCabinets());
		(layout.floor[0] as { hinge: string }).hinge = "top";
		expect(plannerLayoutSchema.safeParse(layout).success).toBe(false);
	});
});

describe("orderRef", () => {
	it("formats the number under the Malaysian date it was placed", () => {
		expect(orderRef(14, "2026-08-26T07:12:00Z")).toBe("IC-20260826-014");
		// 17:30 UTC is already the next day in Kuala Lumpur.
		expect(orderRef(14, "2026-08-26T17:30:00Z")).toBe("IC-20260827-014");
	});
});
