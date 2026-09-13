import type { HingeSide } from "@/lib/planner/layout";
import type { MeshPart } from "./objRead";

/**
 * What each panel in a design export *is*.
 *
 * This is the only file that knows cabinet semantics. Everything else works in
 * roles, so onboarding a drafter who names panels differently is an edit to
 * `NAMING_RULES` here, not a hunt through the grouper and the extractor.
 *
 * Two ways to reach a role, in order:
 *
 *   1. **The name.** Fast, exact, and the client's exports carry good names
 *      (`G-UEnd_(L)`, `G-Drw_Front`). One ordered table.
 *   2. **The geometry.** A cabinet panel's role is largely determined by which
 *      axis it is thin on and where it sits, so a file with useless names
 *      (`Panel_001`) still reads. Slower to trust, so every geometry-sourced
 *      role is flagged for the human at review.
 */

export type PartRole =
	| "end"
	| "top"
	| "bottom"
	| "back"
	| "door"
	| "drawerFront"
	| "drawerBox"
	| "shelfAdjustable"
	| "shelfFixed"
	| "hardware"
	| "unknown";

export type RoleSource = "name" | "geometry";

export type ClassifiedPart = {
	part: MeshPart;
	role: PartRole;
	source: RoleSource;
};

/**
 * Ordered — first match wins, so put the specific before the general.
 * `Drw_Front` has to beat `Front`, and `Fixed_Shelf` has to beat `Shelf`.
 *
 * Seeded from EzCabinet's SketchUp → Blender export. When a second
 * cabinet maker arrives this becomes a per-source table and `classify` takes
 * it as a parameter; the seam is here and nowhere else.
 */
export const NAMING_RULES: { pattern: RegExp; role: PartRole }[] = [
	{ pattern: /drw[_ ]?front|drawer[_ ]?front/i, role: "drawerFront" },
	{
		pattern: /drw[_ ]?(back|bottom|l[_ ]?side|r[_ ]?side)/i,
		role: "drawerBox",
	},
	{ pattern: /^drawer\b|^g-drawer/i, role: "drawerBox" },
	{ pattern: /fixed[_ ]?shelf/i, role: "shelfFixed" },
	{
		pattern: /adjustable[_ ]?shelf|adj[_ ]?shelf|\bshelf\b/i,
		role: "shelfAdjustable",
	},
	{ pattern: /\bdoor\b/i, role: "door" },
	// `\bend\b` does not match `G-UEnd_(R)` — there is no word boundary between
	// `U` and `End`, nor between `End` and `_`. Match a short prefix and a
	// non-letter after instead, which is how every end panel is actually named:
	// `UEnd`, `FEnd`, `Panelized_End`.
	{ pattern: /(^|[-_ ])[a-z]{0,2}end(?![a-z])|\bside\b|gable/i, role: "end" },
	// Same shape as the end-panel rule, and for the same reason: `G-UBack` has
	// no word boundary before `Back`.
	{ pattern: /(^|[-_ ])[a-z]{0,2}back(?![a-z])|rear[_ ]?panel/i, role: "back" },
	{ pattern: /\bbottom\b|\bbase[_ ]?panel\b/i, role: "bottom" },
	{ pattern: /\btop\b/i, role: "top" },
	{
		pattern: /knob|handle|pull|hinge|leveller|leveler|runner|slide|^c-/i,
		role: "hardware",
	},
];

export function roleFromName(name: string): PartRole | null {
	// Underscores are word separators to a drafter and word *characters* to a
	// regex, so `\bdoor\b` never matches `Door_L_`. Swapping them for spaces
	// once here fixes every rule at once instead of contorting each pattern.
	const probe = name.replace(/_/g, " ");
	for (const rule of NAMING_RULES) {
		if (rule.pattern.test(probe)) return rule.role;
	}
	return null;
}

/**
 * Which stile a door hangs on, from the drafter's own name for it.
 *
 * The best signal in the file about handedness, and until now it was thrown
 * away: `NAMING_RULES` matches a bare `\bdoor\b`, so `Door_L_` and `Door_R_`
 * classify identically and the side is gone by the time anything draws the
 * cabinet.
 *
 * Read the caveat before trusting it. `Door_L_` most likely names *the
 * left-hand door of a pair* — its position, not its hinge. For a pair that
 * agrees with the outward rule the renderer already applies, so it adds
 * confirmation rather than information; its real value is a lone leaf, where
 * nothing else in the file says which stile. Which of those the client means
 * is a Phase 0 question about drafting conventions, not ours to guess.
 *
 * Null when the panel is not a door, or is a door the drafter did not hand.
 */
export function hingeSideFromName(name: string): HingeSide | null {
	// Same trick `roleFromName` uses, and for the same reason: underscores are
	// word separators to a drafter and word *characters* to a regex, so
	// `\bl\b` would never match `Door_L_`.
	const probe = name.replace(/_/g, " ");
	if (!/\bdoor\b/i.test(probe)) return null;
	if (/\b(l|left)\b/i.test(probe)) return "left";
	if (/\b(r|right)\b/i.test(probe)) return "right";
	return null;
}

/** Which axis a panel is thinnest on: 0 = along the wall, 1 = depth, 2 = height. */
export const thinAxis = (part: MeshPart): 0 | 1 | 2 => {
	const [w, d, h] = part.sizeMm;
	if (w <= d && w <= h) return 0;
	if (d <= w && d <= h) return 1;
	return 2;
};

export type ModelBounds = {
	minMm: [number, number, number];
	maxMm: [number, number, number];
	panelThicknessMm: number;
	/** Which end of the depth axis the customer stands at. See `inferFrontSide`. */
	frontSide: "min" | "max";
};

/** Anything this small on every axis is a fitting, not a panel. */
const HARDWARE_MAX_MM = 80;

/**
 * How far above the lowest point a part can start and still be a foot rather
 * than something mounted on the cabinet. Generous: a leveller is drawn as a
 * couple of stacked pieces and they do not all reach the floor.
 *
 * Lives here rather than in `extract.ts` because two callers need the same
 * line — `geometryOf` to count feet, and `inferFrontSide` to ignore them.
 */
export const LEG_FOOTING_MM = 30;

/**
 * A carcass side is tall and deep; a drawer side is thin along the wall too but
 * only ~150mm tall. Without this gate an unnamed drawer box reads as a pair of
 * end panels and the grouper invents a cabinet inside the cabinet.
 */
const END_MIN_HEIGHT_MM = 300;
const END_MIN_DEPTH_MM = 200;

/**
 * The fallback, for an export whose names tell us nothing.
 *
 * It leans on the one thing every cabinet run shares: it is built against a
 * wall, so depth runs the same way for every cabinet in the file. A panel thin
 * on depth at the rear is a back; the same panel at the front is a door. A
 * panel thin along the wall is a side. A panel thin on height is horizontal,
 * and *which* horizontal it is — top, bottom or shelf — cannot be known until
 * the cabinet it belongs to is known, so it comes back `shelfAdjustable` and
 * `refineHorizontals` promotes it after grouping.
 */
export function roleFromGeometry(part: MeshPart, model: ModelBounds): PartRole {
	if (part.sizeMm.every((d) => d > 0 && d < HARDWARE_MAX_MM)) return "hardware";

	const axis = thinAxis(part);
	if (axis === 0) {
		return part.sizeMm[2] >= END_MIN_HEIGHT_MM &&
			part.sizeMm[1] >= END_MIN_DEPTH_MM
			? "end"
			: "drawerBox";
	}
	if (axis === 2) return "shelfAdjustable";

	// Thin on depth: a door or a back, told apart by which end of the run it
	// sits at. Which end is which is not fixed — the client's own export puts
	// the wall at depth zero — so `inferFrontSide` works it out per file.
	const midDepth = (model.minMm[1] + model.maxMm[1]) / 2;
	const atMaxEnd = part.minMm[1] + part.sizeMm[1] / 2 > midDepth;
	const atFront = model.frontSide === "max" ? atMaxEnd : !atMaxEnd;
	return atFront ? "door" : "back";
}

/**
 * Which end of the depth axis the customer stands at.
 *
 * There is no convention for this — the client's own export draws the wall at
 * depth zero, so "the far side is the back" would get every door and every
 * back the wrong way round. Two signals, best first:
 *
 *  1. **Handles.** A knob is always on a door and never on a back. If the file
 *     has any, whichever end of the run they sit at is the front.
 *  2. **Backs line up and fronts do not.** Cabinets hang by their backs, so a
 *     390mm-deep wall unit and a 600mm-deep base unit share a back plane while
 *     their fronts sit 210mm apart. The tighter-clustered end is the wall.
 *
 * **Feet are not handles.** They are hardware by every test this file applies —
 * small on all three axes, and named `leveller` — but a levelling foot sits
 * under the middle of the carcass and says nothing about which way it faces.
 * The client's `BC 800mm.obj` has four of them and no knobs, so averaging them
 * in gave a number either side of the midpoint at random and flipped the whole
 * cabinet back to front. Anything standing on the floor is excluded.
 */
export function inferFrontSide(
	parts: MeshPart[],
	depthMin: number,
	depthMax: number,
): "min" | "max" {
	const centre = (part: MeshPart) => part.minMm[1] + part.sizeMm[1] / 2;
	const mid = (depthMin + depthMax) / 2;

	const floorMm = Math.min(...parts.map((part) => part.minMm[2]));
	const hardware = parts.filter(
		(part) =>
			(roleFromName(part.name) === "hardware" ||
				part.sizeMm.every((d) => d > 0 && d < HARDWARE_MAX_MM)) &&
			part.minMm[2] > floorMm + LEG_FOOTING_MM,
	);
	if (hardware.length > 0) {
		const avg =
			hardware.reduce((sum, part) => sum + centre(part), 0) / hardware.length;
		return avg > mid ? "max" : "min";
	}

	const nearMin = parts.filter((p) => centre(p) <= mid).map(centre);
	const nearMax = parts.filter((p) => centre(p) > mid).map(centre);
	if (nearMin.length === 0) return "min";
	if (nearMax.length === 0) return "max";
	// The tighter side is the wall, so the front is the other one.
	return spread(nearMin) <= spread(nearMax) ? "max" : "min";
}

const spread = (values: number[]) => {
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return Math.sqrt(
		values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length,
	);
};

export function boundsOf(
	parts: MeshPart[],
	panelThicknessMm: number,
): ModelBounds {
	const axes = [0, 1, 2] as const;
	const minMm = axes.map((i) => Math.min(...parts.map((p) => p.minMm[i]))) as [
		number,
		number,
		number,
	];
	const maxMm = axes.map((i) =>
		Math.max(...parts.map((p) => p.minMm[i] + p.sizeMm[i])),
	) as [number, number, number];

	return {
		minMm,
		maxMm,
		panelThicknessMm,
		frontSide: inferFrontSide(parts, minMm[1], maxMm[1]),
	};
}

export function classify(
	parts: MeshPart[],
	model: ModelBounds,
): ClassifiedPart[] {
	return parts.map((part) => {
		const named = roleFromName(part.name);
		return named
			? { part, role: named, source: "name" as const }
			: {
					part,
					role: roleFromGeometry(part, model),
					source: "geometry" as const,
				};
	});
}

/**
 * Once a cabinet is known, its horizontal panels can be told apart: the one at
 * the underside is the bottom, the one at the top is the top, the rest are
 * shelves. Only applies to roles the *geometry* guessed — a panel the drafter
 * explicitly called `G-Fixed_Shelf` is a fixed shelf even if it sits at the top.
 */
export function refineHorizontals(
	parts: ClassifiedPart[],
	floorHeightMm: number,
	topHeightMm: number,
): ClassifiedPart[] {
	const near = (a: number, b: number) => Math.abs(a - b) <= 30;

	return parts.map((entry) => {
		if (entry.source === "name") return entry;
		if (entry.role !== "shelfAdjustable") return entry;

		const bottom = entry.part.minMm[2];
		const top = bottom + entry.part.sizeMm[2];
		if (near(bottom, floorHeightMm)) return { ...entry, role: "bottom" };
		if (near(top, topHeightMm)) return { ...entry, role: "top" };
		return entry;
	});
}

/** Roles that are part of the carcass shell rather than something inside it. */
export const SHELL_ROLES: ReadonlySet<PartRole> = new Set<PartRole>([
	"end",
	"top",
	"bottom",
	"back",
]);
