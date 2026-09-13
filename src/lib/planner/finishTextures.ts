/**
 * How wide a stretch of board one supplier decor scan covers.
 *
 * Lives here rather than in `components/planner/grain.ts` because the landing
 * page needs it too and that module imports three.js — a server component has
 * no business pulling a renderer in to size a swatch.
 */
export const PHOTO_SHEET_MM = 1220;

/**
 * How much board a marketing swatch stands for: one door's width.
 *
 * The strip used to show the whole sheet across a 175px chip, so the grain
 * read at half the scale the planner draws it at and the two did not look like
 * the same material. A swatch is a promise about a cabinet; it has to be the
 * same zoom the cabinet gets.
 */
export const SWATCH_WIDTH_MM = 600;

/** `background-size` that crops a scan down to `SWATCH_WIDTH_MM` of board. */
export const SWATCH_ZOOM = `${Math.round((PHOTO_SHEET_MM / SWATCH_WIDTH_MM) * 100)}% auto`;

/**
 * Decor photographs shipped with the repo, keyed by finish id.
 *
 * A finish looks like real board only when the surface *is* real board, so
 * where we have the supplier's decor scan the planner uses it in place of the
 * generated grain. These are the boards EzCabinet actually buys, which
 * is what makes the planner's swatch worth trusting.
 *
 * This is only the default. An admin upload to the `finish:<id>` site-image
 * slot wins, so the client can correct one of these without a deploy — see
 * `app/planner/page.tsx`, which layers the two.
 *
 * Keep them small. CLAUDE.md's rule is one grain texture shared across
 * finishes, and every file here is a deliberate exception to it: a photograph
 * per finish is exactly the per-finish asset that rule exists to limit. Add one
 * only for a woodgrain, and never for a solid colour — a painted door has no
 * figure to photograph, and a scan of one is 200KB saying nothing the hex does
 * not already say.
 *
 * A woodgrain with no entry here and no admin upload is drawn as its flat
 * colour. That is the intended outcome, not a degraded one: the alternative was
 * a generated pattern standing in for a board nobody sells.
 */
export const DEFAULT_FINISH_TEXTURES: Record<string, string> = {
	// Max World MW 13226 UW "Gnocchi Naturale Oak" — pale cream straight-grain.
	"rhone-oak": "/finishes/rhone-oak.jpg",
};
