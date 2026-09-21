import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import {
	emptyLayout,
	type PlannerLayout,
	plannerEngine,
} from "@/lib/planner/layout";
import { computePlannerPrice } from "@/lib/planner/pricing";
import { asRoom, emptyRoom, roomEngine } from "@/lib/planner/room";
import { deliveryItemsFor } from "../items";
import {
	orderDesignSchema,
	plannerLayoutSchema,
	roomLayoutSchema,
} from "../layoutSchema";
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
	validateOrder(asRoom(layout), "kitchen", finishId, cat);

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
		expect(
			validateOrder(asRoom(layout), "garage", finishId, catalogue),
		).toMatchObject({
			problem: "unknown_room",
		});
		expect(
			validateOrder(asRoom(layout), "kitchen", "neon", catalogue),
		).toMatchObject({
			problem: "unknown_finish",
		});
	});
});

describe("priceOrder", () => {
	it("charges the planner's price plus the flat delivery fee", () => {
		const layout = twoCabinets();
		const planner = computePlannerPrice(asRoom(layout), finishId, catalogue);
		const withFee = {
			...catalogue,
			rates: { worktopRmPerFt: 200, deliveryFlatRm: 60 },
		};

		const order = priceOrder(asRoom(layout), finishId, withFee);

		expect(order.deliveryRm).toBe(60);
		expect(order.cabinetsRm).toBeCloseTo(
			computePlannerPrice(asRoom(layout), finishId, withFee).totalRm,
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

		expect(deliveryItemsFor(asRoom(layout), catalogue)).toEqual([
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

		expect(deliveryItemsFor(asRoom(layout), weighed)[0].weightKg).toBe(41.5);
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

describe("an L-shaped order", () => {
	const rooms = roomEngine(catalogue);
	const lKitchen = () => {
		const width = inKitchen.sizes[0].widthMm;
		let room = rooms.addModule(emptyRoom(4200), inKitchen.id, 0, "m", width);
		room = rooms.addModule(room, inKitchen.id, 3600, "s", width, 3);
		return rooms.addModule(room, "corner-base", 0, "c");
	};
	const checkRoom = (room: ReturnType<typeof lKitchen>) =>
		validateOrder(room, "kitchen", finishId, catalogue);

	it("accepts an L the planner built", () => {
		expect(checkRoom(lKitchen())).toEqual({ ok: true });
	});

	it("refuses a corner unit standing in a run", () => {
		const room = structuredClone(lKitchen());
		const unit = room.corners[0].floor;
		if (!unit) throw new Error("fixture lost its corner");
		room.corners = [];
		room.runs[0].floor.push({ ...unit, xMm: 2000 });
		expect(checkRoom(room)).toMatchObject({
			problem: "does_not_fit",
			moduleId: "c",
		});
	});

	it("refuses an ordinary cabinet in the corner slot", () => {
		const room = structuredClone(lKitchen());
		const unit = room.corners[0].floor;
		if (!unit) throw new Error("fixture lost its corner");
		room.corners[0].floor = {
			...unit,
			familyId: inKitchen.id,
			widthMm: inKitchen.sizes[0].widthMm,
		};
		expect(checkRoom(room)).toMatchObject({
			problem: "does_not_fit",
			moduleId: "c",
		});
	});

	it("refuses a turned cabinet whose footprint reaches into the corner", () => {
		const room = structuredClone(lKitchen());
		room.runs[0].floor[0].rotationDeg = 45;
		expect(rooms.widthOptionsFor(room, "m")[0]?.fits).toBe(true);
		expect(checkRoom(room)).toEqual({ ok: false, problem: "does_not_fit" });
	});

	it("refuses a cabinet pushed into the corner square", () => {
		const room = structuredClone(lKitchen());
		room.runs[0].floor[0].xMm = 0;
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit" });
	});

	it("refuses a room outside its template's limits", () => {
		const room = structuredClone(lKitchen());
		room.plan = { template: "rect", widthMm: 50_000, depthMm: 3600 };
		expect(checkRoom(room)).toMatchObject({ problem: "out_of_range" });
	});
});

describe("roomLayoutSchema", () => {
	const l = {
		...emptyRoom(5500),
		plan: {
			template: "l" as const,
			widthMm: 5500,
			depthMm: 5075,
			notchWidthMm: 1500,
			notchDepthMm: 3000,
			mirror: false,
		},
		runs: Array.from({ length: 6 }, () => ({ floor: [], wall: [] })),
	};

	it("accepts a room the planner made", () => {
		expect(roomLayoutSchema.safeParse(emptyRoom(4200)).success).toBe(true);
		expect(roomLayoutSchema.safeParse(l).success).toBe(true);
	});

	it("refuses a run count that is not the wall count", () => {
		const straight = emptyRoom(4200);
		expect(
			roomLayoutSchema.safeParse({
				...straight,
				runs: straight.runs.slice(0, 2),
			}).success,
		).toBe(false);
	});

	it("refuses a corner unit at an outside corner, and two at one corner", () => {
		const slot = { floor: null, wall: null };
		expect(
			roomLayoutSchema.safeParse({ ...l, corners: [{ vertex: 2, ...slot }] })
				.success,
		).toBe(false);
		expect(
			roomLayoutSchema.safeParse({
				...l,
				corners: [
					{ vertex: 3, ...slot },
					{ vertex: 3, ...slot },
				],
			}).success,
		).toBe(false);
	});

	it("refuses a notch that leaves no room", () => {
		expect(
			roomLayoutSchema.safeParse({
				...l,
				plan: { ...l.plan, notchWidthMm: 5400 },
			}).success,
		).toBe(false);
	});
});

describe("orderDesignSchema", () => {
	it("reads an order placed before L-shapes as a rectangle's back wall", () => {
		const layout = twoCabinets();
		const parsed = orderDesignSchema.parse({ schemaVersion: 1, layout });
		expect(parsed.schemaVersion).toBe(3);
		expect(parsed.layout.plan).toEqual({
			template: "rect",
			widthMm: 4200,
			depthMm: 3600,
		});
		expect(parsed.layout.runs[0]).toEqual({
			floor: layout.floor,
			wall: layout.wall,
		});
		expect(parsed.layout.corners).toEqual([]);
	});

	it("reads a version-2 L onto the same walls", () => {
		const layout = twoCabinets();
		const side = [{ ...layout.floor[0], id: "s", xMm: 1000 }];
		const unit = {
			...layout.floor[0],
			id: "c",
			familyId: "corner-base",
			xMm: 55,
			rotationDeg: 270,
		};
		const v2 = (sideOf: "left" | "right") => ({
			schemaVersion: 2,
			layout: {
				...layout,
				runs: [
					{ floor: layout.floor, wall: [] },
					{ floor: side, wall: [] },
				],
				corner: { side: sideOf, floor: unit, wall: null },
			},
		});

		const left = orderDesignSchema.parse(v2("left")).layout;
		expect(left.runs[3].floor).toEqual(side);
		expect(left.corners).toEqual([
			{
				vertex: 3,
				floor: expect.not.objectContaining({ rotationDeg: 270 }),
				wall: null,
			},
		]);

		const right = orderDesignSchema.parse(v2("right")).layout;
		expect(right.runs[1].floor).toEqual(side);
		expect(right.corners[0].vertex).toBe(0);
		expect("wallToWall" in right).toBe(false);
	});
});

describe("a free-standing order", () => {
	const rooms = roomEngine(catalogue);
	const width = inKitchen.sizes[0].widthMm;
	const island = () => {
		const room = rooms.addModule(emptyRoom(4200), inKitchen.id, 0, "f", width);
		return rooms.placeFree(room, "f", { xMm: 0, zMm: 0 });
	};
	const checkRoom = (room: ReturnType<typeof island>) =>
		validateOrder(room, "kitchen", finishId, catalogue);
	const wallFamily = catalogue.families.find(
		(f) => f.kind === "wall" && kitchen.familyIds.includes(f.id),
	);

	it("reads a v3 design saved before free cabinets as none", () => {
		const { free: _none, ...saved } = emptyRoom(4200);
		const parsed = roomLayoutSchema.parse(saved);
		expect(parsed.free).toEqual([]);
	});

	it("reads a design saved before wall paint as unpainted", () => {
		const { wallColours: _none, ...saved } = emptyRoom(4200);
		const parsed = roomLayoutSchema.parse(saved);
		expect(parsed.wallColours).toEqual([]);
	});

	it("keeps wall paint through the schema", () => {
		const painted = {
			...emptyRoom(4200),
			wallColours: ["wall-sage-mist", null, "#a8b3a0"],
		};
		expect(roomLayoutSchema.parse(painted).wallColours).toEqual([
			"wall-sage-mist",
			null,
			"#a8b3a0",
		]);
	});

	it("refuses more wall colours than any plan has walls", () => {
		const tooMany = { ...emptyRoom(4200), wallColours: Array(7).fill("x") };
		expect(roomLayoutSchema.safeParse(tooMany).success).toBe(false);
	});

	it("refuses a wall colour longer than any id or hex", () => {
		const bloated = { ...emptyRoom(4200), wallColours: ["x".repeat(65)] };
		expect(roomLayoutSchema.safeParse(bloated).success).toBe(false);
	});

	it("accepts a colour the catalogue does not know", () => {
		// Deliberate: paint is priced at nothing and manufactured never, so an
		// unknown value buys no discount and cannot be tampering worth refusing
		// a sale over. It renders unpainted. Do not "fix" this into a refusal —
		// it would turn a paying customer away because an admin retired a swatch.
		const room = { ...emptyRoom(4200), wallColours: ["wall-retired"] };
		expect(roomLayoutSchema.safeParse(room).success).toBe(true);
	});

	it("keeps a free cabinet's centre through the schema", () => {
		const parsed = roomLayoutSchema.parse(island());
		expect(parsed.free).toHaveLength(1);
		expect(parsed.free[0]).toMatchObject({ id: "f", xMm: 0, zMm: 0 });
	});

	it("accepts a free cabinet the planner placed", () => {
		expect(island().free).toHaveLength(1);
		expect(checkRoom(island())).toEqual({ ok: true });
	});

	it("refuses a free wall unit", () => {
		if (!wallFamily) throw new Error("seed kitchen lost its wall unit");
		const room = structuredClone(island());
		room.free[0] = {
			...room.free[0],
			familyId: wallFamily.id,
			widthMm: wallFamily.sizes[0].widthMm,
		};
		expect(checkRoom(room)).toMatchObject({
			problem: "does_not_fit",
			moduleId: "f",
		});
	});

	it("refuses a free cabinet outside the room", () => {
		const room = structuredClone(island());
		room.free[0].xMm = 5000;
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit" });
	});

	it("refuses overlapping free cabinets", () => {
		const room = structuredClone(island());
		room.free.push({ ...room.free[0], id: "g", xMm: 100 });
		expect(checkRoom(room)).toMatchObject({ problem: "does_not_fit" });
	});

	it("refuses a stale free cabinet whose family is gone", () => {
		const room = structuredClone(island());
		room.free[0].familyId = "gone";
		expect(checkRoom(room)).toMatchObject({ ok: false });
	});

	it("refuses a free row carrying hangAtMm rather than repricing it", () => {
		const room = structuredClone(island());
		const tampered = {
			...room,
			free: room.free.map((m) => ({ ...m, hangAtMm: 400 })),
		};
		expect(roomLayoutSchema.safeParse(tampered).success).toBe(false);
		expect(roomLayoutSchema.safeParse(room).success).toBe(true);
	});
});

describe("a v2 order after migration", () => {
	// Priced by the v2 engine at 9a3fcac, the branch's merge base, on these
	// exact fixtures. Neither run reaches a wall end, so v3's walls all round
	// (which bury a flush end v2 would have panelled) change nothing here.
	const cabinet = {
		familyId: "base-cabinet",
		widthMm: 600,
		doorStyleId: null,
		hinge: "left" as const,
	};
	const settings = {
		wallWidthMm: 4200,
		roomDepthMm: 3600,
		wallToWall: false,
		ceilingHeightMm: 2400,
		hangingHeightMm: 1450,
		wallToCeiling: false,
		baseSkirting: true,
	};
	const priceOf = (design: unknown) =>
		computePlannerPrice(
			orderDesignSchema.parse(design).layout,
			finishId,
			catalogue,
		);

	it("prices a straight room as v2 did", () => {
		const price = priceOf({
			schemaVersion: 2,
			layout: {
				...settings,
				runs: [
					{
						floor: [
							{ ...cabinet, id: "a", xMm: 1200 },
							{ ...cabinet, id: "b", xMm: 1800 },
						],
						wall: [],
					},
				],
				corner: null,
			},
		});
		expect(price.totalRm).toBeCloseTo(2292.755905511811, 6);
		expect(price.endPanelCount).toBe(2);
	});

	it("prices an L with a corner unit as v2 did", () => {
		const price = priceOf({
			schemaVersion: 2,
			layout: {
				...settings,
				runs: [
					{
						floor: [
							{ ...cabinet, id: "a", xMm: 607 },
							{ ...cabinet, id: "b", xMm: 1207 },
						],
						wall: [],
					},
					{ floor: [{ ...cabinet, id: "s", xMm: 2393 }], wall: [] },
				],
				corner: {
					side: "left",
					floor: {
						...cabinet,
						id: "c",
						familyId: "corner-base",
						widthMm: 900,
						xMm: 0,
					},
					wall: null,
				},
			},
		});
		expect(price.totalRm).toBeCloseTo(5329.685039370079, 6);
		expect(price.endPanelCount).toBe(4);
		expect(price.cabinets).toHaveLength(4);
	});
});
