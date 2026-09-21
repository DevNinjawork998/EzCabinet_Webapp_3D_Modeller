import { describe, expect, it } from "vitest";
import { PLANNER_CATALOGUE } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { summariseCatalogueChanges } from "../diff";

/** Deep clone so a test can mutate without touching the live constant. */
const clone = (c: PlannerCatalogue): PlannerCatalogue =>
	JSON.parse(JSON.stringify(c));

describe("summariseCatalogueChanges", () => {
	it("reports nothing when nothing changed", () => {
		expect(
			summariseCatalogueChanges(PLANNER_CATALOGUE, clone(PLANNER_CATALOGUE)),
		).toEqual([]);
	});

	it("counts a changed carcass price", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].sizes[0].priceRm += 50;

		expect(summariseCatalogueChanges(PLANNER_CATALOGUE, next)).toEqual([
			"1 cabinet price changed",
		]);
	});

	it("counts several price changes as one pluralised line", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].sizes[0].priceRm += 10;
		next.families[0].sizes[1].priceRm += 10;

		expect(summariseCatalogueChanges(PLANNER_CATALOGUE, next)).toEqual([
			"2 cabinet prices changed",
		]);
	});

	it("names an added and a removed family", () => {
		const next = clone(PLANNER_CATALOGUE);
		const removed = next.families.shift();
		next.families.push({
			...PLANNER_CATALOGUE.families[0],
			id: "test-new",
			label: "Test cabinet",
		});

		const lines = summariseCatalogueChanges(PLANNER_CATALOGUE, next);
		expect(lines).toContain("Cabinet added: Test cabinet");
		expect(lines).toContain(`Cabinet removed: ${removed?.label}`);
	});

	it("flags a dimension change separately from a price change", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].depthMm += 20;

		expect(summariseCatalogueChanges(PLANNER_CATALOGUE, next)).toEqual([
			`Dimensions changed: ${PLANNER_CATALOGUE.families[0].label}`,
		]);
	});

	it("counts an added size option separately from a repriced one", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].sizes.push({ widthMm: 1000, priceRm: 900 });

		expect(summariseCatalogueChanges(PLANNER_CATALOGUE, next)).toEqual([
			"1 size option added or removed",
		]);
	});

	it("counts a weight-only change, so publishing it is not a no-op", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.families[0].sizes[0].weightKg = 42;

		expect(summariseCatalogueChanges(PLANNER_CATALOGUE, next)).toEqual([
			"1 cabinet weight changed",
		]);
	});

	it("notices finishes, rates and construction changes", () => {
		const next = clone(PLANNER_CATALOGUE);
		next.finishes.push({ id: "test", label: "Test", hex: "#123456" });
		next.rates = { worktopRmPerFt: 250 };
		next.construction = {
			panelThicknessMm: 18,
			plinthHeightMm: 100,
			worktopThicknessMm: 40,
			doorLeavesThresholdMm: 650,
		};

		const lines = summariseCatalogueChanges(PLANNER_CATALOGUE, next);
		expect(lines).toContain("Finishes changed");
		expect(lines).toContain("Rates changed");
		expect(lines).toContain("Construction standards changed");
	});

	it("notices a wall colour edit", () => {
		// Without this line publish sees nothing to publish and tells the admin
		// their palette edit was a no-op.
		const next = clone(PLANNER_CATALOGUE);
		next.wallColours = [{ id: "wall-test", label: "Test", hex: "#123456" }];

		const lines = summariseCatalogueChanges(PLANNER_CATALOGUE, next);
		expect(lines).toContain("Wall colours changed");
	});

	it("says nothing about a palette neither side ever set", () => {
		const lines = summariseCatalogueChanges(
			PLANNER_CATALOGUE,
			clone(PLANNER_CATALOGUE),
		);
		expect(lines).not.toContain("Wall colours changed");
	});
});
