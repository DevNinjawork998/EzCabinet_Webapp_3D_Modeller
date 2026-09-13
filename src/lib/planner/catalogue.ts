import type {
	Construction,
	DoorStyle,
	Family,
	Finish,
	PlannerCatalogue,
	Rates,
	RoomType,
	SizeOption,
} from "./catalogueSchema";

/**
 * The room planner's product catalogue.
 *
 * A **family** is what the customer picks — "base cabinet", "shoe cabinet" —
 * and a **size** is a priced option on it. Width therefore belongs to the
 * cabinet the customer placed, not to the product, which is what lets them
 * drop one in and then change its size.
 *
 * PROVENANCE, and it matters:
 * - **Kitchen dimensions are real.** 16mm board, 880mm base carcasses on 607mm
 *   depth, wall units 397mm deep hung at 1500mm, 2380mm tall units — all read
 *   out of EzCabinet's own design export by `lib/mesh`.
 * - **Living room, bedroom and foyer dimensions are invented.** Plausible, but
 *   ours. Get a design export for each from the client and `lib/mesh` turns
 *   them into real numbers in minutes.
 * - **Every price here is invented.** A design file contains geometry, not money.
 *   Phase 0 has not closed; these come from their price list, in a
 *   catalogue-only commit.
 */

/** Decides which row a cabinet stands in, and how it is drawn. */
export type ModuleKind = "base" | "wall" | "tall";

export type RoomTypeId = "kitchen" | "living" | "bedroom" | "foyer";

/**
 * The catalogue's shapes are owned by `catalogueSchema.ts` and inferred from
 * its Zod schemas — re-exported here so the many consumers that already
 * import from this file don't all have to change. Declaring them a second
 * time by hand is what CLAUDE.md's "Zod is the single source of truth for
 * types" rule exists to prevent: the copies drift, and the schema is the one
 * that actually validates.
 */
export type {
	Construction,
	DoorStyle,
	Family,
	Finish,
	Rates,
	RoomType,
	SizeOption,
};

/**
 * Workshop constants — board thickness, toe-kick height and slab thickness
 * are per-maker choices, not universals. The fallback `constructionOf` fills
 * in for whatever a published catalogue omits.
 */
export const CONSTRUCTION = {
	panelThicknessMm: 16,
	plinthHeightMm: 100,
	worktopThicknessMm: 40,
	/** Above this carcass width a front is split into two leaves. */
	doorLeavesThresholdMm: 650,
};

/** The fallback `ratesOf` fills in for whatever a published catalogue omits. */
export const RATES = {
	/** PLACEHOLDER — RM per running foot of worktop. */
	worktopRmPerFt: 200,
	/** PLACEHOLDER — RM per running foot of the strip that caps a
	 * floor-to-ceiling wall run. A ceiling is never level, so this is a
	 * scribed piece: real board and real fitting time. */
	ceilingTrimRmPerFt: 60,
	/** PLACEHOLDER — RM per running foot of skirting. Board plus the fitting
	 * time to scribe it to a floor that is never flat. */
	skirtingRmPerFt: 42,
	/** PLACEHOLDER — RM per finished end panel, one rate per kind because a
	 * tall unit's panel is several times the board of a wall unit's. */
	endPanelBaseRm: 150,
	endPanelWallRm: 90,
	endPanelTallRm: 330,
	/** PLACEHOLDER — the flat delivery charge on an order, taken from the
	 * client's Order Confirmation design. Confirm with EzCabinet. */
	deliveryFlatRm: 85,
};
/** Underside of the wall cabinets — the sample job's own hanging height. */
export const WALL_CABINET_FLOOR_MM = 1500;
/** How far the hang slider lets the customer move that underside. */
export const WALL_HANG_LIMITS = { minMm: 1200, maxMm: 1800 } as const;
/** Scribe gap between the carcass backs and the wall, as a real fit has.
 * Shared by the scene (`PlannerScene.tsx`) and the measuring tool
 * (`measure.ts`) — both need to agree on exactly where a cabinet's back
 * face sits, so this lives here rather than duplicated in either. */
export const WALL_GAP_MM = 5;

/**
 * The strip that caps a floor-to-ceiling wall run. The cabinets stop this far
 * below the ceiling and the strip fills the rest, which is how the run is
 * actually built — a ceiling is out of level by more than a carcass can hide,
 * so the last piece is scribed to it rather than being part of the cabinet.
 */
export const CEILING_TRIM_MM = 40;

/**
 * Front-to-back room depth is the room's, not the catalogue's — see the
 * design rule in CLAUDE.md. This is only the starting figure a fresh layout
 * opens with; `setRoomDepth` is what lets the customer measure their own.
 */
export const DEFAULT_ROOM_DEPTH_MM = 3600;
export const ROOM_DEPTH_LIMITS = { minMm: 2000, maxMm: 8000 } as const;

/**
 * Ceiling height, same reasoning as room depth: it is the customer's room,
 * not a catalogue figure. It was a hardcoded 2700 inside the 3D scene until
 * the planner redesign asked for it on the panel — which is right, because a
 * tall unit against a 2.4m ceiling and the same unit against a 3.2m one are
 * visibly different rooms, and that difference is the thing the customer is
 * trying to picture.
 */
export const DEFAULT_CEILING_MM = 2700;
export const CEILING_LIMITS = { minMm: 2200, maxMm: 3200 } as const;

// ---------------------------------------------------------------- kitchen --
// Real dimensions, invented prices.

const BASE: Pick<Family, "kind" | "depthMm" | "heightMm" | "floorHeightMm"> = {
	kind: "base",
	depthMm: 607,
	heightMm: 880,
	floorHeightMm: 0,
};

const WALL: Pick<Family, "kind" | "depthMm" | "heightMm" | "floorHeightMm"> = {
	kind: "wall",
	depthMm: 397,
	heightMm: 880,
	floorHeightMm: WALL_CABINET_FLOOR_MM,
};

export const FAMILIES: Family[] = [
	{
		...BASE,
		id: "base-cabinet",
		label: "Base cabinet",
		drawers: 0,
		note: "Standard 880mm carcass, 600mm deep",
		sizes: [
			{ widthMm: 300, priceRm: 320 },
			{ widthMm: 400, priceRm: 380 },
			{ widthMm: 600, priceRm: 520 },
			{ widthMm: 800, priceRm: 660 },
			{ widthMm: 900, priceRm: 720 },
		],
	},
	{
		...BASE,
		id: "base-drawers",
		label: "Drawer base",
		drawers: 3,
		note: "Three drawers",
		sizes: [
			{ widthMm: 400, priceRm: 620 },
			{ widthMm: 600, priceRm: 820 },
			{ widthMm: 800, priceRm: 980 },
		],
	},
	{
		...WALL,
		id: "wall-cabinet",
		label: "Wall cabinet",
		drawers: 0,
		note: "Hung at 1500mm, 397mm deep",
		sizes: [
			{ widthMm: 400, priceRm: 300 },
			{ widthMm: 600, priceRm: 420 },
			{ widthMm: 800, priceRm: 540 },
			{ widthMm: 900, priceRm: 600 },
		],
	},
	{
		id: "tall-cabinet",
		label: "Tall cabinet",
		kind: "tall",
		depthMm: 607,
		heightMm: 2380,
		floorHeightMm: 0,
		drawers: 0,
		note: "Full height, 2380mm",
		sizes: [
			{ widthMm: 600, priceRm: 1450 },
			{ widthMm: 800, priceRm: 1780 },
		],
	},
	{
		id: "fridge-housing",
		label: "Fridge housing",
		kind: "tall",
		// PLACEHOLDER — not in the client's design export. Deeper than a base run so
		// the fridge door clears the worktop; carcass only, no front sold on it.
		depthMm: 650,
		heightMm: 2380,
		floorHeightMm: 0,
		drawers: 0,
		note: "Houses the fridge — carcass only, dimensions not yet from a job file",
		sizes: [
			{ widthMm: 600, priceRm: 980 },
			{ widthMm: 900, priceRm: 1240 },
		],
	},

	// ------------------------------------------------------- other rooms --
	// PLACEHOLDER dimensions — no design export for these yet.
	{
		id: "tv-ledge",
		label: "TV ledge",
		kind: "base",
		depthMm: 400,
		heightMm: 400,
		floorHeightMm: 0,
		drawers: 2,
		note: "Low media unit — dimensions not yet from a job file",
		sizes: [
			{ widthMm: 900, priceRm: 680 },
			{ widthMm: 1200, priceRm: 860 },
			{ widthMm: 1500, priceRm: 1040 },
			{ widthMm: 1800, priceRm: 1220 },
		],
	},
	{
		id: "tv-tall",
		label: "Display cabinet",
		kind: "tall",
		depthMm: 400,
		heightMm: 2100,
		floorHeightMm: 0,
		drawers: 0,
		note: "Dimensions not yet from a job file",
		sizes: [
			{ widthMm: 600, priceRm: 1180 },
			{ widthMm: 800, priceRm: 1420 },
		],
	},
	{
		id: "wardrobe",
		label: "Wardrobe",
		kind: "tall",
		depthMm: 600,
		heightMm: 2400,
		floorHeightMm: 0,
		drawers: 0,
		note: "Simple box — no interior fit-out yet",
		sizes: [
			{ widthMm: 600, priceRm: 1350 },
			{ widthMm: 900, priceRm: 1850 },
			{ widthMm: 1200, priceRm: 2350 },
		],
	},
	{
		id: "shoe-cabinet",
		label: "Shoe cabinet",
		kind: "base",
		depthMm: 350,
		heightMm: 1000,
		floorHeightMm: 0,
		drawers: 0,
		note: "Dimensions not yet from a job file",
		sizes: [
			{ widthMm: 600, priceRm: 520 },
			{ widthMm: 800, priceRm: 640 },
			{ widthMm: 900, priceRm: 700 },
		],
	},
	{
		id: "shoe-bench",
		label: "Shoe bench",
		kind: "base",
		depthMm: 350,
		heightMm: 450,
		floorHeightMm: 0,
		drawers: 1,
		note: "Seat height, dimensions not yet from a job file",
		sizes: [
			{ widthMm: 600, priceRm: 380 },
			{ widthMm: 900, priceRm: 480 },
		],
	},
];

// ------------------------------------------------------------------ doors --

/** The width ladder doors are priced against — the union of the families'. */
const DOOR_WIDTHS = [300, 400, 600, 800, 900, 1200, 1500, 1800];

const doorPrices = (rmPer100Mm: number): Record<string, number> =>
	Object.fromEntries(
		DOOR_WIDTHS.map((mm) => [String(mm), Math.round((mm / 100) * rmPer100Mm)]),
	);

const SEED_DOOR_STYLES: DoorStyle[] = [
	{
		id: "slab",
		label: "Slab",
		look: "slab",
		note: "Flat front",
		priceRmBySizeMm: doorPrices(22),
	},
	{
		id: "shaker",
		label: "Shaker",
		look: "shaker",
		note: "Framed front",
		priceRmBySizeMm: doorPrices(34),
	},
	{
		id: "glass",
		label: "Glass",
		look: "glass",
		note: "Glazed frame",
		priceRmBySizeMm: doorPrices(46),
	},
];

/** How many door leaves a carcass of this width carries. */
export const doorLeavesFor = (
	widthMm: number,
	thresholdMm: number = CONSTRUCTION.doorLeavesThresholdMm,
) => (widthMm > thresholdMm ? 2 : 1);

// ------------------------------------------------- explicit-catalogue reads --

/**
 * Every planner read takes its catalogue as a parameter — `pricing.ts`,
 * `layout.ts`, the client tree via `CatalogueContext`. Nothing reads a module
 * global; see CLAUDE.md's Known issues 1–3 for why that used to be true.
 *
 * Linear scans, not indexed: a catalogue holds tens of families and door
 * styles, and building a Map per call costs more than the scan it saves.
 */
export function sizePriceRmIn(
	catalogue: PlannerCatalogue,
	familyId: string,
	widthMm: number,
): number {
	const found = catalogue.families.find((f) => f.id === familyId);
	return found?.sizes.find((size) => size.widthMm === widthMm)?.priceRm ?? 0;
}

export function doorStyleIn(
	catalogue: PlannerCatalogue,
	doorStyleId: string,
): PlannerCatalogue["doorStyles"][number] | undefined {
	return catalogue.doorStyles.find((d) => d.id === doorStyleId);
}

/**
 * What a door costs on a carcass of this width. Widths between rungs are
 * charged at the next rung up — you cannot buy half a door.
 *
 * Prices arrive string-keyed here (JSON object keys always are), unlike the
 * number-keyed in-memory shape `doorPriceRm` reads.
 */
export function doorPriceRmIn(
	catalogue: PlannerCatalogue,
	doorStyleId: string,
	widthMm: number,
): number {
	const style = doorStyleIn(catalogue, doorStyleId);
	if (!style) return 0;
	const exact = style.priceRmBySizeMm[String(widthMm)];
	if (exact !== undefined) return exact;

	const ladder = catalogue.doorWidthLadderMm;
	const rung = ladder.find((mm) => mm >= widthMm) ?? ladder.at(-1);
	return rung === undefined ? 0 : (style.priceRmBySizeMm[String(rung)] ?? 0);
}

/** Every rate resolved — the catalogue's where it sets one, the seed's where
 * it does not. `Rates` has one required key and five optional, so a published
 * catalogue routinely carries only some. */
export type ResolvedRates = Required<Rates>;

export function familyIn(
	catalogue: PlannerCatalogue,
	familyId: string,
): Family | undefined {
	return catalogue.families.find((f) => f.id === familyId);
}

export function roomTypeIn(
	catalogue: PlannerCatalogue,
	roomId: RoomTypeId,
): RoomType {
	const found = catalogue.roomTypes.find((room) => room.id === roomId);
	if (!found) throw new Error(`unknown room type ${roomId}`);
	return found;
}

/** The size a freshly placed cabinet takes: the middle of its ladder. */
export function defaultWidthMmIn(
	catalogue: PlannerCatalogue,
	familyId: string,
): number {
	const sizes = familyIn(catalogue, familyId)?.sizes ?? [];
	return sizes[Math.floor(sizes.length / 2)]?.widthMm ?? 600;
}

/** Workshop constants for this catalogue, the seed filling anything it omits.
 * A fresh object every call — never a reference to the seed, which callers
 * would then be able to mutate. */
export function constructionOf(catalogue: PlannerCatalogue): Construction {
	return { ...CONSTRUCTION, ...catalogue.construction };
}

/** Rates for this catalogue, the seed filling anything it omits. Zod drops
 * absent optional keys rather than setting them to `undefined`, so the spread
 * cannot clobber a fallback with a hole. */
export function ratesOf(catalogue: PlannerCatalogue): ResolvedRates {
	return { ...RATES, ...catalogue.rates };
}

// ------------------------------------------------------------------ rooms --

export const ROOM_TYPES: RoomType[] = [
	{
		id: "kitchen",
		label: "Kitchen",
		familyIds: [
			"base-cabinet",
			"base-drawers",
			"wall-cabinet",
			"tall-cabinet",
			"fridge-housing",
		],
		defaultWallWidthMm: 4200,
	},
	{
		id: "living",
		label: "Living room",
		familyIds: ["tv-ledge", "tv-tall", "wall-cabinet"],
		defaultWallWidthMm: 4800,
	},
	{
		id: "bedroom",
		label: "Bedroom",
		familyIds: ["wardrobe"],
		defaultWallWidthMm: 3600,
	},
	{
		id: "foyer",
		label: "Foyer",
		familyIds: ["shoe-cabinet", "shoe-bench"],
		defaultWallWidthMm: 2400,
	},
];

// --------------------------------------------------------------- finishes --

/**
 * Door finishes, with the colours read out of the client's own job file — the
 * names their sales team already says out loud. One colour applies to the
 * whole room, which is how they sell it.
 */
export const FINISHES: Finish[] = [
	{ id: "strata-noir", label: "Strata Noir", hex: "#393939" },
	{ id: "rhone-oak", label: "Rhone Oak", hex: "#d1af81" },
	{ id: "white", label: "White", hex: "#ffffff" },
	{ id: "dulux-tapestry-beige", label: "Tapestry Beige", hex: "#b7ab9e" },
	{ id: "color-soft-gray", label: "Soft Gray", hex: "#a1abb4" },
	{ id: "color-knoxville-green", label: "Knoxville Green", hex: "#606d6c" },
];

/** A published catalogue can define finishes this file has never seen, so this
 * is the id as data rather than a union of today's constants. */
export type FinishId = string;

/** Deliberately a few shades off the room's wall (#edebe7): the 16mm carcass
 * reveal around a light door is the only thing separating it from the wall
 * behind, and any closer the two read as one surface. */
export const CARCASS_COLOR = "#d5cec2";
/** Inside a doorless carcass — darker, so an open box reads as open. */
export const CARCASS_INTERIOR_COLOR = "#b3aa9c";
export const WORKTOP_COLOR = "#4a4744";
export const HARDWARE_COLOR = "#9aa0a6";
export const GLASS_COLOR = "#dfe9ec";

// -------------------------------------------------------- bundled shape --

/**
 * The catalogue this repo ships: the seed the DB is loaded from, and the
 * disaster-recovery copy. It is **not** the live catalogue — the live one
 * comes from the published `CatalogueVersion` and is passed explicitly, to
 * `plannerEngine`, `computePlannerPrice` and `CatalogueProvider`.
 *
 * Frozen because a mutable version of this object is what Known issues 1–3
 * were: a palette swapped in place, half of it by reference and half by copy,
 * so which values a caller saw depended on when it read them.
 */
export const PLANNER_CATALOGUE: PlannerCatalogue = Object.freeze({
	families: FAMILIES,
	doorStyles: SEED_DOOR_STYLES,
	doorWidthLadderMm: DOOR_WIDTHS,
	roomTypes: ROOM_TYPES,
	finishes: FINISHES,
});
