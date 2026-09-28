import { z } from "zod";

/**
 * The tutorial vocabulary, in one place.
 *
 * The admin form, the API's payload schema and the public page's filters all
 * read these lists. They used to live inline in `app/tutorials/page.tsx`, which
 * was fine while the page was the only thing that knew about tutorials —
 * same reasoning as `siteImages.ts`: two lists kept in step by hand will drift,
 * and here the drift would be a tutorial the admin can file under a category
 * the public page cannot filter to.
 */

export const CATEGORIES = [
	{ id: "base", label: "Base cabinet" },
	{ id: "wall", label: "Wall cabinet" },
	{ id: "tall", label: "Tall cabinet" },
	{ id: "drawer", label: "Drawer base" },
	{ id: "fridge", label: "Fridge housing" },
	{ id: "tv", label: "TV cabinet" },
	{ id: "wardrobe", label: "Wardrobe" },
	{ id: "shoe", label: "Shoe cabinet" },
] as const;

export const LEVELS = [
	{ id: "beginner", label: "Beginner" },
	{ id: "intermediate", label: "Intermediate" },
	{ id: "advanced", label: "Advanced" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];
export type LevelId = (typeof LEVELS)[number]["id"];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [
	CategoryId,
	...CategoryId[],
];
export const LEVEL_IDS = LEVELS.map((l) => l.id) as [LevelId, ...LevelId[]];

/** `{ base: "Base cabinets", beginner: "Beginner", … }` for rendering a chip. */
export const LABEL: Record<string, string> = Object.fromEntries(
	[...CATEGORIES, ...LEVELS].map((option) => [option.id, option.label]),
);

/**
 * What the public page needs to render one card. Deliberately not the Prisma
 * row: `muxUploadId`, `muxAssetId` and `uploadedBy` are admin bookkeeping and
 * have no business being serialised into a public page's props.
 */
export type PublicTutorial = {
	id: string;
	title: string;
	description: string;
	category: string;
	level: string;
	playbackId: string | null;
	durationSec: number | null;
};

/** The metadata half of the admin form — the video arrives separately. */
export const tutorialInputSchema = z.object({
	title: z.string().trim().min(1).max(200),
	// Optional on purpose: the design gates publishing on a video and a title
	// only, so a tutorial can go up before anyone writes the blurb.
	description: z.string().trim().max(1000).default(""),
	category: z.enum(CATEGORY_IDS),
	level: z.enum(LEVEL_IDS),
	sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const tutorialCreateSchema = tutorialInputSchema.extend({
	muxUploadId: z.string().trim().min(1).max(200),
});

export type TutorialInput = z.infer<typeof tutorialInputSchema>;

/** `487` → `"8 min"`. Rounds up, because a 30-second clip is not "0 min". */
export function durationLabel(seconds: number | null): string | null {
	if (seconds === null || seconds <= 0) return null;
	return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/**
 * How far into a video to take the poster from, as a fraction of its length.
 *
 * Not frame zero, which is what Mux gives you by default and what this used to
 * ask for. A DIY tutorial is shot on a phone, and frame zero is whatever the
 * camera happened to be pointing at while the person reached for the record
 * button — on the client's first upload, a floor tile and half a toilet. A few
 * seconds in, it is pointing at the cabinet.
 */
const POSTER_AT = 0.1;

/** Fallback for a video whose duration Mux has not reported yet. */
const POSTER_FALLBACK_SEC = 3;

/**
 * Mux renders a poster frame from the playback id, so a card needs no separate
 * thumbnail upload and no image in Blob.
 *
 * **`fit_mode=smartcrop` needs both a width and a height.** Given only a width
 * it does not crop to an aspect ratio — it returns the frame at the source's
 * own, and for a portrait phone video that is a tall strip which the card's
 * `object-cover` then slices a meaningless band out of. Worse, at 640 wide Mux
 * rejects it outright with `crop width cannot be larger than the source video`
 * and the public page renders a broken image. Both are what this looked like
 * before: an admin thumbnail of flat grey, and no poster at all on /tutorials.
 *
 * So the caller passes the box it is filling, and Mux returns exactly that.
 */
export function posterUrl(
	playbackId: string,
	{
		width = 640,
		height = 360,
		durationSec,
	}: { width?: number; height?: number; durationSec?: number | null } = {},
): string {
	const time = Math.max(
		1,
		Math.round(
			durationSec && durationSec > 0
				? durationSec * POSTER_AT
				: POSTER_FALLBACK_SEC,
		),
	);
	return `https://image.mux.com/${playbackId}/thumbnail.webp?width=${width}&height=${height}&fit_mode=smartcrop&time=${time}`;
}
