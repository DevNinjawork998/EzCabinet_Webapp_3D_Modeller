import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";

/**
 * A plain-English summary of what an edited catalogue changes against the one
 * that's live. The review step exists so a human can catch a wrong price
 * before it reaches a customer — that only works if they can see what moved,
 * which a raw JSON textarea never showed them.
 */
export function summariseCatalogueChanges(
	live: PlannerCatalogue,
	next: PlannerCatalogue,
): string[] {
	const lines: string[] = [];

	const liveFamilies = new Map(live.families.map((f) => [f.id, f]));
	const nextFamilies = new Map(next.families.map((f) => [f.id, f]));

	const addedFamilies = next.families.filter((f) => !liveFamilies.has(f.id));
	const removedFamilies = live.families.filter((f) => !nextFamilies.has(f.id));
	for (const f of addedFamilies) lines.push(`Cabinet added: ${f.label}`);
	for (const f of removedFamilies) lines.push(`Cabinet removed: ${f.label}`);

	let priceChanges = 0;
	let sizeChanges = 0;
	let weightChanges = 0;
	const dimensionChanges: string[] = [];

	for (const [id, nextFamily] of nextFamilies) {
		const liveFamily = liveFamilies.get(id);
		if (!liveFamily) continue;

		if (
			liveFamily.depthMm !== nextFamily.depthMm ||
			liveFamily.heightMm !== nextFamily.heightMm ||
			liveFamily.floorHeightMm !== nextFamily.floorHeightMm
		) {
			dimensionChanges.push(nextFamily.label);
		}

		const livePrices = new Map(
			liveFamily.sizes.map((s) => [s.widthMm, s.priceRm]),
		);
		const nextPrices = new Map(
			nextFamily.sizes.map((s) => [s.widthMm, s.priceRm]),
		);
		for (const [widthMm, priceRm] of nextPrices) {
			const before = livePrices.get(widthMm);
			if (before === undefined) sizeChanges++;
			else if (before !== priceRm) priceChanges++;
		}
		for (const widthMm of livePrices.keys()) {
			if (!nextPrices.has(widthMm)) sizeChanges++;
		}

		// A weight never reaches a customer, but logistics pre-fills delivery rows
		// from it — and publish treats "no change lines" as nothing to publish.
		const liveWeights = new Map(
			liveFamily.sizes.map((s) => [s.widthMm, s.weightKg]),
		);
		for (const size of nextFamily.sizes) {
			if (
				liveWeights.has(size.widthMm) &&
				liveWeights.get(size.widthMm) !== size.weightKg
			) {
				weightChanges++;
			}
		}
	}

	if (weightChanges > 0) {
		lines.push(
			`${weightChanges} cabinet ${weightChanges === 1 ? "weight" : "weights"} changed`,
		);
	}

	if (priceChanges > 0) {
		lines.push(
			`${priceChanges} cabinet ${priceChanges === 1 ? "price" : "prices"} changed`,
		);
	}
	if (sizeChanges > 0) {
		lines.push(
			`${sizeChanges} size ${sizeChanges === 1 ? "option" : "options"} added or removed`,
		);
	}
	for (const label of dimensionChanges) {
		lines.push(`Dimensions changed: ${label}`);
	}

	if (JSON.stringify(live.doorStyles) !== JSON.stringify(next.doorStyles)) {
		lines.push("Door styles or door prices changed");
	}
	if (JSON.stringify(live.finishes) !== JSON.stringify(next.finishes)) {
		lines.push("Finishes changed");
	}
	if (JSON.stringify(live.wallColours) !== JSON.stringify(next.wallColours)) {
		lines.push("Wall colours changed");
	}
	if (
		JSON.stringify(live.doorWidthLadderMm) !==
		JSON.stringify(next.doorWidthLadderMm)
	) {
		lines.push("Door width ladder changed");
	}
	if (JSON.stringify(live.roomTypes) !== JSON.stringify(next.roomTypes)) {
		lines.push("Rooms or the cabinets they offer changed");
	}
	if (JSON.stringify(live.rates) !== JSON.stringify(next.rates)) {
		lines.push("Rates changed");
	}
	if (JSON.stringify(live.construction) !== JSON.stringify(next.construction)) {
		lines.push("Construction standards changed");
	}

	return lines;
}
