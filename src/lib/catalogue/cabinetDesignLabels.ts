import type { RoomType } from "@/lib/planner/catalogueSchema";

/** One vocabulary for the `CabinetDesign` table's enums, so the admin upload
 * form and its table read the same labels rather than each spelling them
 * out. */

type RoomTypeId = RoomType["id"];

export type Category =
	| "BASE_CABINET"
	| "WALL_CABINET"
	| "TALL_CABINET"
	| "DRAWER_BASE"
	| "FRIDGE_HOUSING"
	| "CORNER_BASE_CABINET"
	| "CORNER_WALL_CABINET";

export type Room = "KITCHEN" | "LIVING_ROOM" | "BEDROOM" | "FOYER";

export const CATEGORIES: Category[] = [
	"BASE_CABINET",
	"WALL_CABINET",
	"TALL_CABINET",
	"DRAWER_BASE",
	"FRIDGE_HOUSING",
	"CORNER_BASE_CABINET",
	"CORNER_WALL_CABINET",
];

export const CATEGORY_LABELS: Record<Category, string> = {
	BASE_CABINET: "Base cabinet",
	WALL_CABINET: "Wall cabinet",
	TALL_CABINET: "Tall cabinet",
	DRAWER_BASE: "Drawer base",
	FRIDGE_HOUSING: "Fridge housing",
	CORNER_BASE_CABINET: "Corner base cabinet (draw for the left corner)",
	CORNER_WALL_CABINET: "Corner wall cabinet (draw for the left corner)",
};

/** The gallery card's placeholder art. The design *is* parsed — the upload
 * form reads its dimensions and `/admin/cabinet-designs/[id]/publish` reads its
 * fit-out — but neither produces a picture, and booting a WebGL context per
 * card to make one would cost more than the card is worth. */
export const CATEGORY_SWATCH: Record<Category, string> = {
	BASE_CABINET: "#c9c2b5",
	WALL_CABINET: "#a1abb4",
	TALL_CABINET: "#b7ab9e",
	DRAWER_BASE: "#d1af81",
	FRIDGE_HOUSING: "#8a8580",
	CORNER_BASE_CABINET: "#bfb6a6",
	CORNER_WALL_CABINET: "#98a3ad",
};

export const ROOMS: Room[] = ["KITCHEN", "LIVING_ROOM", "BEDROOM", "FOYER"];

export const ROOM_LABELS: Record<Room, string> = {
	KITCHEN: "Kitchen",
	LIVING_ROOM: "Living room",
	BEDROOM: "Bedroom",
	FOYER: "Foyer",
};

/**
 * This table's room enum → the planner catalogue's room id.
 *
 * Two vocabularies for the same four rooms, because the library is a Postgres
 * enum and the catalogue is a JSON document with its own schema. Mapping them
 * here is what lets a design the admin filed under Kitchen land in the Kitchen
 * palette and nowhere else — without it, `mergeIntoCatalogue` spreads a new
 * family into every room that already carries its `kind`, which for a base
 * cabinet is three of the four.
 */
export const ROOM_TO_PLANNER: Record<Room, RoomTypeId> = {
	KITCHEN: "kitchen",
	LIVING_ROOM: "living",
	BEDROOM: "bedroom",
	FOYER: "foyer",
};

/**
 * What each library category means to the planner.
 *
 * `category` is the one shape question the admin answers explicitly in the
 * upload form, which makes it a better source than anything inferred from the
 * file. Deriving `kind` from a parse instead produced contradictions — a design
 * whose row said 870mm tall coming out as a `tall` unit, because the export
 * happened to contain a whole 2400mm run.
 *
 * The library's vocabulary is finer than the planner's: it separates a drawer
 * base from a base, and a fridge housing from a tall unit, where the planner
 * only cares how a cabinet is placed.
 */
export const CATEGORY_TO_KIND: Record<Category, "base" | "wall" | "tall"> = {
	BASE_CABINET: "base",
	WALL_CABINET: "wall",
	TALL_CABINET: "tall",
	DRAWER_BASE: "base",
	FRIDGE_HOUSING: "tall",
	CORNER_BASE_CABINET: "base",
	CORNER_WALL_CABINET: "wall",
};
