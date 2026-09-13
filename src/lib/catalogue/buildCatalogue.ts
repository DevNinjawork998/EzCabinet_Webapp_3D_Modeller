import { WALL_CABINET_FLOOR_MM } from "@/lib/planner/catalogue";
import {
	cabinetGeometrySchema,
	type Family,
	type PlannerCatalogue,
} from "@/lib/planner/catalogueSchema";
import {
	CATEGORIES,
	CATEGORY_TO_KIND,
	type Category,
	ROOM_TO_PLANNER,
	type Room,
} from "./cabinetDesignLabels";

/**
 * The planner catalogue, rebuilt from the design library.
 *
 * **One design is one cabinet.** EzCabinet draws one export per width
 * and prices each one, so a design row already *is* the thing a customer
 * places: its name, its all-in price, its box, its drawn model. This replaced
 * an additive merge that folded designs into families by shape — which matched
 * uploads onto the seed's invented `base-cabinet`, kept that family's invented
 * prices and 607×880 box, and left no way to tell which cabinet was real.
 *
 * Rebuilt whole on every publish rather than patched, so there is nothing to
 * drift: a deleted or archived design is simply absent from the next build. The
 * family id *is* the design id, so a layout's `familyId` points at a row that
 * can be looked up.
 *
 * Everything a design file cannot say — door styles and their surcharges,
 * finishes, rates, build standards, room wall widths — comes from `base`, which
 * is the published catalogue with the admin's unpublished settings edits on top.
 *
 * Pure, with no server imports, so the admin page runs the same build to count
 * unpublished changes that the publish route runs to write them.
 */

/** The fields of a `CabinetDesign` row this reads — structural, so the client
 * can pass what the list API returned without importing Prisma. */
export type DesignRow = {
	id: string;
	name: string;
	category: Category;
	rooms: Room[];
	widthMm: number;
	heightMm: number;
	depthMm: number;
	priceRm: number;
	/** Null or absent when nobody has weighed it. */
	weightKg?: number | null;
	status: "PUBLISHED" | "ARCHIVED";
	meshPathname: string | null;
	/** What the file holds, written when the design is converted. Unknown
	 * because it is a JSON column; anything that fails the schema is dropped
	 * and the procedural fallback uses its own defaults. */
	geometry: unknown;
};

export function buildCatalogue(
	designs: DesignRow[],
	base: PlannerCatalogue,
): PlannerCatalogue {
	// Archived is the library's "not for sale". Sorted so the menu reads in
	// category order and two builds of the same rows diff as unchanged.
	const live = designs
		.filter((design) => design.status === "PUBLISHED")
		.sort(
			(a, b) =>
				CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
				a.widthMm - b.widthMm ||
				a.name.localeCompare(b.name),
		);

	const families: Family[] = live.map((design) => {
		const kind = CATEGORY_TO_KIND[design.category];
		const geometry = cabinetGeometrySchema.safeParse(design.geometry);
		return {
			id: design.id,
			label: design.name,
			// Keys in `familySchema` order, so a built family and the same family
			// read back from a published version serialise identically — the admin
			// page tells "live" from "edited" by comparing the two as JSON.
			kind,
			category: design.category,
			depthMm: design.depthMm,
			heightMm: design.heightMm,
			// A wall unit hangs at the room's setting; everything else stands on
			// the floor. Where the drafter happened to draw it is not the product.
			floorHeightMm: kind === "wall" ? WALL_CABINET_FLOOR_MM : 0,
			sizes: [
				{
					widthMm: design.widthMm,
					priceRm: design.priceRm,
					// Logistics pre-fills a delivery row from this; absent stays blank.
					...(design.weightKg != null ? { weightKg: design.weightKg } : {}),
					// A design whose file would not convert has no mesh and is drawn
					// procedurally — still sellable, never pointed at a missing file.
					...(design.meshPathname ? { meshDesignId: design.id } : {}),
				},
			],
			drawers: geometry.success ? geometry.data.drawers : 0,
			...(geometry.success ? { geometry: geometry.data } : {}),
		};
	});

	const roomTypes = base.roomTypes.map((room) => ({
		...room,
		familyIds: live
			.filter((design) =>
				design.rooms.some((r) => ROOM_TO_PLANNER[r] === room.id),
			)
			.map((design) => design.id),
	}));

	return { ...base, families, roomTypes };
}
