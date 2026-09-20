import { z } from "zod";

/**
 * The shape of the planner catalogue, split out from `catalogue.ts` so pure
 * functions can take a catalogue as a parameter instead of importing the
 * constants directly. `catalogue.ts` still owns the actual numbers — this
 * file only owns the shape, which is what a future DB-backed catalogue also
 * has to satisfy (see the DB-backed-catalogue plan).
 */

const sizeOptionSchema = z.object({
	widthMm: z.number().positive(),
	priceRm: z.number().min(0),
	/**
	 * What one of these weighs, typed on the design row. Optional because most
	 * carcasses have never been weighed, and a delivery row leaves weight blank
	 * rather than guess — parcel partners price by the kilogram. Placed before
	 * `meshDesignId` so a built size and a parsed one serialise identically.
	 */
	weightKg: z.number().positive().optional(),
	/**
	 * The design this rung is drawn from, if one has been published for it.
	 *
	 * The planner fetches `/api/cabinet-mesh/<id>` and draws the model the
	 * drafter actually made. It hangs off the *rung* rather than the family
	 * because EzCabinet draws one export per width — BC 800, BC 900,
	 * BC 1000 — so a ladder is a set of files, one each.
	 *
	 * Optional, and the planner falls back to procedural geometry without it:
	 * catalogues published before design intake carry none, and a design whose
	 * file will not parse must still be sellable.
	 */
	meshDesignId: z.string().optional(),
});
export type SizeOption = z.infer<typeof sizeOptionSchema>;

/**
 * What a cabinet is made of, as read off the design file it was imported from.
 * This is what lets two families of the same box look different in the scene:
 * a six-shelf tall unit draws six shelves.
 *
 * Optional, for the same reason `construction` is: catalogues published before
 * design intake existed have to keep validating. `Cabinet.tsx` falls back to
 * its own defaults when it is absent.
 */
export const cabinetGeometrySchema = z.object({
	shelves: z.number().int().min(0),
	fixedShelves: z.number().int().min(0),
	doorLeaves: z.number().int().min(0),
	drawers: z.number().int().min(0),
	hasBack: z.boolean(),
	/** Adjustable feet, from the design. Zero draws the plinth the scene has
	 * always drawn. Defaulted rather than required so every catalogue published
	 * before designs could describe their feet still validates — the same
	 * reason `geometry` itself is optional. */
	legs: z.number().int().min(0).default(0),
	legHeightMm: z.number().min(0).default(0),
	/** How wide a foot is, and how far in from the carcass edge it stands.
	 *
	 * Zero means "not recorded", and `parts.ts` falls back to its own constant.
	 * Deliberately not defaulted to those constants here: a real 50mm foot and
	 * an unrecorded one would then be indistinguishable, and `mergeIntoCatalogue`
	 * decides whether to learn a field by whether it has ever been set. */
	legDiameterMm: z.number().min(0).default(0),
	legInsetMm: z.number().min(0).default(0),
});
export type CabinetGeometry = z.infer<typeof cabinetGeometrySchema>;

export const familySchema = z.object({
	id: z.string(),
	label: z.string(),
	kind: z.enum(["base", "wall", "tall"]),
	/** The design library's category, which heads the customer's add-cabinet
	 * menu. Finer than `kind`: a drawer base and a fridge housing place like a
	 * base and a tall unit but are shelved separately. Optional so the seed and
	 * versions published before it keep parsing. */
	category: z
		.enum([
			"BASE_CABINET",
			"WALL_CABINET",
			"TALL_CABINET",
			"DRAWER_BASE",
			"FRIDGE_HOUSING",
			"CORNER_BASE_CABINET",
			"CORNER_WALL_CABINET",
		])
		.optional(),
	depthMm: z.number().positive(),
	heightMm: z.number().positive(),
	floorHeightMm: z.number().min(0),
	sizes: z.array(sizeOptionSchema).min(1),
	drawers: z.number().int().min(0),
	geometry: cabinetGeometrySchema.optional(),
	note: z.string().optional(),
});
export type Family = z.infer<typeof familySchema>;

const doorStyleSchema = z.object({
	id: z.string(),
	label: z.string(),
	look: z.enum(["slab", "shaker", "glass"]),
	/** Keyed by width in mm, as a string — JSON object keys always are. */
	priceRmBySizeMm: z.record(z.string(), z.number().min(0)),
	note: z.string().optional(),
});
export type DoorStyle = z.infer<typeof doorStyleSchema>;

const roomTypeSchema = z.object({
	id: z.enum(["kitchen", "living", "bedroom", "foyer"]),
	label: z.string(),
	/** Empty is a real state: a room no design is filed under yet, which the
	 * start screen shows as coming soon. */
	familyIds: z.array(z.string()),
	defaultWallWidthMm: z.number().positive(),
});
export type RoomType = z.infer<typeof roomTypeSchema>;

const finishSchema = z.object({
	id: z.string(),
	label: z.string(),
	hex: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type Finish = z.infer<typeof finishSchema>;

/** Wall paint is the same three fields as a finish — id, label, hex — so it
 * reuses that schema rather than a twin that would drift from it. */
export type WallColour = Finish;

/** Workshop build standards — board thickness, toe-kick and slab depth are
 * per-maker choices, not universals, so they belong in the catalogue rather
 * than in code. Optional so catalogues published before this existed keep
 * validating; `catalogue.ts`'s `CONSTRUCTION` holds the fallbacks. */
const constructionSchema = z.object({
	panelThicknessMm: z.number().positive(),
	plinthHeightMm: z.number().min(0),
	worktopThicknessMm: z.number().positive(),
	/** Above this carcass width a front is split into two leaves. */
	doorLeavesThresholdMm: z.number().positive(),
});
export type Construction = z.infer<typeof constructionSchema>;

const ratesSchema = z.object({
	worktopRmPerFt: z.number().min(0),
	/** Optional, not required: `rates` itself is optional, so a catalogue
	 * published with a rates object but without this key must keep parsing.
	 * Absent means `catalogue.ts`'s `RATES` fallback stands, the same way
	 * `construction` works. */
	ceilingTrimRmPerFt: z.number().min(0).optional(),
	/** Optional for the same reason as `ceilingTrimRmPerFt`. */
	skirtingRmPerFt: z.number().min(0).optional(),
	/** Per finished end panel, by cabinet kind. Optional like the rest. */
	endPanelBaseRm: z.number().min(0).optional(),
	endPanelWallRm: z.number().min(0).optional(),
	endPanelTallRm: z.number().min(0).optional(),
	/** One flat delivery charge added to an order at checkout. Optional like
	 * the rest. */
	deliveryFlatRm: z.number().min(0).optional(),
});
export type Rates = z.infer<typeof ratesSchema>;

export const plannerCatalogueSchema = z.object({
	/** Rebuilt from the design library on every publish, so a library with no
	 * designs yet is an empty list, not an invalid catalogue. */
	families: z.array(familySchema),
	doorStyles: z.array(doorStyleSchema).min(1),
	/** The width ladder doors are priced against — was a private constant,
	 * now catalogue data so a new door size is actually priceable. */
	doorWidthLadderMm: z.array(z.number().int().positive()).min(1),
	roomTypes: z.array(roomTypeSchema).min(1),
	finishes: z.array(finishSchema).min(1),
	/** Wall paint the customer can try the cabinets against. Optional like
	 * `construction` and `rates`: a catalogue published before paint existed
	 * keeps validating, and `wallColoursOf` fills the gap. Unlike `finishes`
	 * an empty list is legal — an admin who deletes every colour has turned
	 * the feature off, which is a choice the schema must let them make. */
	wallColours: z.array(finishSchema).max(24).optional(),
	construction: constructionSchema.optional(),
	rates: ratesSchema.optional(),
});
export type PlannerCatalogue = z.infer<typeof plannerCatalogueSchema>;
