import {
	doorPriceRmIn,
	doorStyleIn,
	type FinishId,
	familyIn,
	type ModuleKind,
	type ResolvedRates,
	ratesOf,
	sizePriceRmIn,
} from "./catalogue";
import type { PlannerCatalogue } from "./catalogueSchema";
import {
	inRun,
	type PlannerLayout,
	type Positioned,
	plannerEngine,
} from "./layout";
import { type RoomLayout, roomEngine } from "./room";

/**
 * Indicative planner pricing.
 *
 * PLACEHOLDER — every figure is invented. They are plausible Malaysian market
 * numbers so the demo produces a believable total, and they are not
 * EzCabinet's. A design file carries geometry, not money, so rates have to come
 * from their price list; replace the tables in `catalogue.ts` in a
 * catalogue-only commit before anyone quotes from this.
 *
 * The model is **per unit**, which is how they sell: each carcass size is its
 * own priced line, each door is priced by the width it covers, and the two are
 * separate because the customer chooses them separately. The worktop is the one
 * thing still charged by the running foot — a worktop genuinely is a length,
 * cut to the run underneath it.
 *
 * ponytail: client-side only, fine while this is a demo with no quote attached.
 * CLAUDE.md's "price is computed server-side" rule bites the moment it feeds a
 * lead — move it behind the API then and keep this as the instant-feedback copy.
 */

export const MM_PER_FT = 304.8;

/** PLACEHOLDER. Kept for the copy on the landing page; the priced figure comes
 * from the catalogue's `rates.worktopRmPerFt` via `ratesOf`. */
export const WORKTOP_RM_PER_FT = 200;

/** One line per cabinet, carcass and door shown separately. `label` and
 * `detail` here are not customer-facing copy — nothing in the UI renders
 * them — so they stay plain English rather than growing the structured
 * shape the category lines need. */
type CabinetPriceLine = {
	id: string;
	label: string;
	detail: string;
	carcassRm: number;
	doorRm: number;
	doorLabel: string | null;
	amountRm: number;
};

/**
 * A category line in the price breakdown, e.g. "Carcasses" or "Worktop".
 *
 * This engine is framework-free and must not import the copy layer (see
 * CLAUDE.md), so it emits a stable `id` and a structured `detail` — a
 * dictionary key plus the values to interpolate into it — rather than an
 * English string. The UI looks up `id` and `detail.key` in the dictionary
 * and fills in `detail.vars` itself.
 */
export type PriceLineId =
	| "carcasses"
	| "doors"
	| "worktop"
	| "ceilingTrim"
	| "skirting"
	| "endPanels";

export type PriceLine = {
	id: PriceLineId;
	detail: { key: string; vars?: Record<string, string | number> };
	amountRm: number;
};

type KitchenPrice = {
	cabinets: CabinetPriceLine[];
	categories: PriceLine[];
	worktopFt: number;
	/** Zero unless the run goes to the ceiling; see `ceilingTrimFt`. */
	ceilingTrimFt: number;
	/** Kick board along the floor run; see `skirtingFt`. */
	skirtingFt: number;
	/** Finished panels over the cabinet sides nothing hides. */
	endPanelCount: number;
	totalRm: number;
};

const ftOf = (mm: number) => mm / MM_PER_FT;

/** Each free **base** cabinet as the run of one it is priced as. A free tall
 * unit has no worktop and, by the spec, no kick board of its own. */
const freeBaseViews = (
	layout: RoomLayout,
	catalogue: PlannerCatalogue,
): PlannerLayout[] => {
	const engine = roomEngine(catalogue);
	return layout.free.flatMap((m) => {
		const view = engine.freeView(layout, m.id);
		return view && familyIn(catalogue, m.familyId)?.kind === "base"
			? [view]
			: [];
	});
};

/** What one placed cabinet costs: its size, plus its door if it has one. */
function cabinetPriceRm(
	placed: Positioned,
	catalogue: PlannerCatalogue,
): {
	carcassRm: number;
	doorRm: number;
} {
	const carcassRm = sizePriceRmIn(catalogue, placed.family.id, placed.widthMm);
	const doorRm = placed.placed.doorStyleId
		? doorPriceRmIn(catalogue, placed.placed.doorStyleId, placed.widthMm)
		: 0;
	return { carcassRm, doorRm };
}

/**
 * Worktop is cut to the cabinets under it, not to the wall — the same rule the
 * 3D uses to decide where the slab stops. Only base units count, because only a
 * base unit has a top to cover, and gaps break it, so the customer is not
 * charged for the breaks.
 *
 * Read off `kind` rather than a per-family flag. The flag was editable, and a
 * wall unit with it ticked was billed a worktop and drawn one 2,380mm up the
 * wall — the only state it could express that `kind` could not.
 */
export function worktopFt(
	layout: RoomLayout,
	catalogue: PlannerCatalogue,
): number {
	const engine = roomEngine(catalogue);
	const mm = layout.runs
		.flatMap((_, run) => engine.positionsOf(layout, "floor", run))
		.filter((position) => position.family.kind === "base")
		// A cabinet lifted off the floor or turned off the wall has left the
		// counter run, and the scene draws no slab over it. The same predicate
		// on both sides is what keeps the drawn slab and the billed slab the
		// same slab — see `inRun`.
		.filter(inRun)
		.reduce((total, position) => total + position.widthMm, 0);
	// A free base unit carries its own top, cut to its width.
	const freeMm = freeBaseViews(layout, catalogue)
		.flatMap((view) => plannerEngine(catalogue).positionsOf(view, "floor"))
		.filter(inRun)
		.reduce((total, position) => total + position.widthMm, 0);
	// Each square where two runs meet is one piece of worktop, counted once.
	const cornersMm = engine
		.cornerWorktops(layout)
		.reduce((total, square) => total + square.sizeMm, 0);
	return ftOf(mm + freeMm + cornersMm);
}

/**
 * The strip capping a floor-to-ceiling run is charged like the worktop: it is
 * a length, cut to the cabinets under it. Nothing to charge when the run
 * hangs, because then there is no strip.
 */
export function ceilingTrimFt(
	layout: RoomLayout,
	catalogue: PlannerCatalogue,
): number {
	if (!layout.wallToCeiling) return 0;
	const engine = roomEngine(catalogue);
	const mm = [
		...layout.runs.flatMap((_, run) => engine.positionsOf(layout, "wall", run)),
		...engine.cornerPositions(layout).filter((p) => p.family.kind === "wall"),
	].reduce((total, position) => total + position.widthMm, 0);
	return ftOf(mm);
}

/**
 * The kick board is charged by the spans it is actually cut into, not by the
 * cabinets' total width — a gap in the run breaks the board, and charging
 * across the gap would bill for a piece nobody fits. Same rule as the worktop.
 */
export function skirtingFt(
	layout: RoomLayout,
	catalogue: PlannerCatalogue,
): number {
	const engine = roomEngine(catalogue);
	const oneWall = plannerEngine(catalogue);
	const mm = [
		...layout.runs.flatMap((_, run) => engine.skirtingSpans(layout, run)),
		...freeBaseViews(layout, catalogue).flatMap((view) =>
			oneWall.skirtingSpans(view),
		),
	].reduce((total, span) => total + (span.endMm - span.startMm), 0);
	return ftOf(mm);
}

const END_PANEL_RM: Record<ModuleKind, keyof ResolvedRates> = {
	base: "endPanelBaseRm",
	wall: "endPanelWallRm",
	tall: "endPanelTallRm",
};

/**
 * The finished panels, counted and priced by what they clad. Charged per piece
 * — a panel is one board cut, edged and fixed — but a tall unit's is several
 * times the board of a wall unit's, so the rate is per kind rather than flat.
 */
export function endPanelPriceRm(
	layout: RoomLayout,
	catalogue: PlannerCatalogue,
): {
	count: number;
	amountRm: number;
} {
	const rates = ratesOf(catalogue);
	const panels = roomEngine(catalogue).endPanels(layout);
	return {
		count: panels.length,
		amountRm: panels.reduce(
			(total, panel) => total + rates[END_PANEL_RM[panel.kind]],
			0,
		),
	};
}

export function computePlannerPrice(
	layout: RoomLayout,
	_finish: FinishId,
	catalogue: PlannerCatalogue,
): KitchenPrice {
	const rates = ratesOf(catalogue);
	const engine = roomEngine(catalogue);
	const placed: Positioned[] = engine.allPositions(layout);

	const cabinets = placed.map((position) => {
		const { carcassRm, doorRm } = cabinetPriceRm(position, catalogue);
		const door = position.placed.doorStyleId
			? doorStyleIn(catalogue, position.placed.doorStyleId)
			: undefined;
		return {
			id: position.placed.id,
			label: `${position.family.label} ${position.widthMm}`,
			detail: door ? `carcass + ${door.label} door` : "carcass only",
			carcassRm,
			doorRm,
			doorLabel: door?.label ?? null,
			amountRm: carcassRm + doorRm,
		};
	});

	const carcassTotal = cabinets.reduce((sum, line) => sum + line.carcassRm, 0);
	const doorTotal = cabinets.reduce((sum, line) => sum + line.doorRm, 0);
	const doorCount = cabinets.filter((line) => line.doorRm > 0).length;
	const tops = worktopFt(layout, catalogue);
	const trim = ceilingTrimFt(layout, catalogue);
	const skirting = skirtingFt(layout, catalogue);
	const panels = endPanelPriceRm(layout, catalogue);

	const categories: PriceLine[] = [
		{
			id: "carcasses",
			detail: {
				key: cabinets.length === 1 ? "unitCountOne" : "unitCountOther",
				vars: { count: cabinets.length },
			},
			amountRm: carcassTotal,
		},
		{
			id: "doors",
			detail:
				doorCount === 0
					? { key: "noDoors" }
					: {
							key: doorCount === 1 ? "doorCountOne" : "doorCountOther",
							vars: { count: doorCount },
						},
			amountRm: doorTotal,
		},
		{
			id: "worktop",
			detail: {
				key: "lengthRate",
				vars: { ft: tops.toFixed(2), rate: rates.worktopRmPerFt },
			},
			amountRm: tops * rates.worktopRmPerFt,
		},
	];

	// Only when there is one — an empty line reads as a charge the customer
	// cannot see the reason for.
	if (trim > 0) {
		categories.push({
			id: "ceilingTrim",
			detail: {
				key: "lengthRate",
				vars: { ft: trim.toFixed(2), rate: rates.ceilingTrimRmPerFt },
			},
			amountRm: trim * rates.ceilingTrimRmPerFt,
		});
	}

	if (skirting > 0) {
		categories.push({
			id: "skirting",
			detail: {
				key: "lengthRate",
				vars: { ft: skirting.toFixed(2), rate: rates.skirtingRmPerFt },
			},
			amountRm: skirting * rates.skirtingRmPerFt,
		});
	}

	if (panels.count > 0) {
		categories.push({
			id: "endPanels",
			detail: {
				key: panels.count === 1 ? "endPanelsOne" : "endPanelsOther",
				vars: { count: panels.count },
			},
			amountRm: panels.amountRm,
		});
	}

	return {
		cabinets,
		categories,
		worktopFt: tops,
		ceilingTrimFt: trim,
		skirtingFt: skirting,
		endPanelCount: panels.count,
		totalRm: categories.reduce((total, line) => total + line.amountRm, 0),
	};
}
