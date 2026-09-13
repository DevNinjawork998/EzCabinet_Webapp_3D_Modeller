import { useMemo, useSyncExternalStore } from "react";
import {
	NoColorSpace,
	RepeatWrapping,
	SRGBColorSpace,
	type Texture,
	TextureLoader,
} from "three";
import { PHOTO_SHEET_MM } from "@/lib/planner/finishTextures";

/**
 * The one grain texture, shared by every surface in the scene — as *sheen*,
 * never as figure.
 *
 * `public/grain.png` is 53KB and every door, carcass, shelf and worktop is that
 * same file, so a catalogue of twenty finishes still costs one request.
 *
 * **It is a roughness map and nothing else.** It used to double as `map`,
 * multiplying the finish colour, which drew woodgrain onto every finish in the
 * catalogue — including the three that are paint (`dulux-tapestry-beige`,
 * `color-soft-gray`, `color-knoxville-green`, whose ids say so). A generated
 * grain pattern is not a material EzCabinet sells: the admin decides
 * what is on offer, and a customer must never be shown a board that does not
 * exist. So figure now comes only from a real supplier scan, in
 * `useFrontSurface`, and this tile only ever varies how the light catches.
 *
 * Grain direction still matters for the sheen: a door is veneered with the
 * grain running up it and a drawer front with it running across, and getting
 * that backwards looks wrong even to someone who could not say why.
 */

/**
 * How much wall a single tile covers. Real oak grain lines sit 5-30mm apart;
 * the tile has nine lines across it, so 260mm puts them about 29mm apart —
 * coarse enough to read at planner zoom, fine enough not to look like decking.
 */
const TILE_M = 0.26;

/**
 * Loaded on first use rather than at module scope: this file is pulled in by a
 * client component that Next also renders on the server, where there is no
 * `Image` to decode into. Every caller is inside the R3F canvas, so by the time
 * anything asks, we are in a browser.
 */
let source: Texture | null = null;

function grainSource(): Texture {
	if (!source) {
		source = new TextureLoader().load("/grain.png");
		source.wrapS = RepeatWrapping;
		source.wrapT = RepeatWrapping;
	}
	return source;
}

/**
 * Uploaded decor photos, one entry per URL. Same lazy-singleton reasoning as
 * the grain tile, plus a cache: a run of eight cabinets in one finish is one
 * image, not eight.
 */
const photos = new Map<string, Texture>();

/**
 * Each loaded scan's height ÷ width.
 *
 * Kept beside the texture cache and published through `useSyncExternalStore`,
 * because the ratio is not known until the image lands: a door sized before
 * then uses the 1:1 placeholder, and has to re-size once the truth arrives.
 * React has a primitive for external mutable state several components read, so
 * this is that rather than an effect per door.
 */
const aspects = new Map<string, number>();
const aspectListeners = new Set<() => void>();

function subscribeAspects(listener: () => void) {
	aspectListeners.add(listener);
	return () => {
		aspectListeners.delete(listener);
	};
}

function photoSource(url: string): Texture {
	let texture = photos.get(url);
	if (!texture) {
		texture = new TextureLoader().load(url, (loaded) => {
			const image = loaded.image as
				| { width?: number; height?: number }
				| undefined;
			if (!image?.width || !image?.height) return;
			aspects.set(url, image.height / image.width);
			for (const listener of aspectListeners) listener();
		});
		texture.wrapS = RepeatWrapping;
		texture.wrapT = RepeatWrapping;
		photos.set(url, texture);
	}
	return texture;
}

/**
 * How wide a stretch of board one decor scan covers.
 *
 * A supplier scan is a photograph of a real sheet, not a seamless tile: repeat
 * it and the join shows as a hard line straight across the door. So the sheet
 * is treated as its true size — a laminate sheet runs 1220mm wide — and every
 * door is cut *out of* it rather than papered with copies of it. A 900mm door
 * shows about three quarters of the scan and never reaches an edge.
 *
 * **Width only.** The height follows the image's own aspect ratio, because a
 * scan is a photograph and its pixels are square. Max World's swatch for
 * MW 13526 NW (Alorra Palermo Walnut) is 369 × 800, so measuring the vertical
 * against this same constant would show 2.17× too much board down the door and
 * squash the figure by that factor — a stretched photograph, which is the exact
 * artefact a real scan is here to avoid.
 *
 * ponytail: one width for every supplier. Make it a per-finish field if a
 * second supplier's scans ever land at a visibly different scale.
 */
const PHOTO_SHEET_M = PHOTO_SHEET_MM / 1000;

export type GrainDirection = "vertical" | "horizontal";

/**
 * How much of the scan one front wears, as texture repeats.
 *
 * `u` runs across the image — the sheet's width; `v` runs down it — that width
 * times the image's aspect. A horizontal grain is the same photograph turned a
 * quarter turn, so the door's two dimensions swap which axis of the sheet they
 * are measured against.
 *
 * Never above 1: a repeat of 1.5 would show the seam, and a door wider than the
 * sheet is not a door the client can make from one piece anyway.
 */
export function photoRepeat(
	direction: GrainDirection,
	width: number,
	height: number,
	/** Image height ÷ width. 1 until the photo has loaded. */
	aspect: number,
): { u: number; v: number } {
	const sheetV = PHOTO_SHEET_M * Math.max(aspect, 0.01);
	const across = Math.max(width, 0.01);
	const along = Math.max(height, 0.01);
	const [u, v] =
		direction === "horizontal"
			? [along / PHOTO_SHEET_M, across / sheetV]
			: [across / PHOTO_SHEET_M, along / sheetV];
	return { u: Math.min(u, 1), v: Math.min(v, 1) };
}

/**
 * Material props to spread onto a `meshStandardMaterial`: the sheen variation,
 * and nothing that touches colour.
 *
 * `width` and `height` are the surface's own size in metres, the unit the rest
 * of the scene works in, so the sheen stays the same physical scale whether it
 * is on a 400 drawer front or a 900 door. Tiling to the mesh instead would
 * stretch it, which is the exact artefact CLAUDE.md rejects baked meshes for.
 */
export function useGrain(
	direction: GrainDirection,
	width: number,
	height: number,
) {
	return useMemo(() => {
		const across = Math.max(width, 0.01) / TILE_M;
		const along = Math.max(height, 0.01) / TILE_M;

		// The tile is drawn with its lines running vertically, so a horizontal
		// grain is the same tile rotated a quarter turn.
		const rotation = direction === "horizontal" ? Math.PI / 2 : 0;
		const repeat: [number, number] =
			direction === "horizontal" ? [along, across] : [across, along];

		// Roughness is data, not colour, so it stays linear — tagging it sRGB
		// would push every surface toward the same sheen.
		const roughnessMap = grainSource().clone();
		roughnessMap.colorSpace = NoColorSpace;
		roughnessMap.rotation = rotation;
		roughnessMap.center.set(0.5, 0.5);
		roughnessMap.repeat.set(repeat[0], repeat[1]);
		roughnessMap.needsUpdate = true;

		return { roughnessMap };
	}, [direction, width, height]);
}

/**
 * Where in the decor sheet a cabinet's fronts are cut from, 0-1.
 *
 * Hashed from the cabinet's id, never its position. It used to be read off
 * where the cabinet stood, which is not stable at all: a drag moves it every
 * frame, so the photograph slid across the door as it went. The board is cut
 * once; moving the cabinet does not re-cut it.
 */
export function sheetOffsetOf(id: string): number {
	// FNV-1a: a spread of values from ids that differ by one character.
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
	}
	return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * The material for a cabinet front.
 *
 * When the client has uploaded a decor photo for this finish, that photograph
 * *is* the surface: the real scan of the board they will actually cut, so the
 * colour comes from the image and the material colour goes white rather than
 * tinting it a second time. The procedural grain stays on as the roughness map,
 * which is what stops a flat photo reading as a printed sticker.
 *
 * With no photo it is the flat finish colour, with the grain tile still
 * varying the sheen so it does not read as plastic. Deliberately *not* a
 * tinted grain pattern: an invented woodgrain is a material the client cannot
 * sell, and the swatch strip, the planner's picker and the door all show the
 * same flat colour for it so nobody is promised a board that does not exist.
 */
export function useFrontSurface(
	photoUrl: string | null,
	direction: GrainDirection,
	width: number,
	height: number,
	finishHex: string,
	/** Stable per-door value, 0-1, deciding where in the sheet this one is cut
	 * from — see `sheetOffsetOf`. */
	offset = 0,
) {
	const figure = useGrain(direction, width, height);
	// 1 until the image lands, then its real ratio — see `aspects`.
	const aspect = useSyncExternalStore(
		subscribeAspects,
		() => (photoUrl ? (aspects.get(photoUrl) ?? 1) : 1),
		() => 1,
	);

	return useMemo(() => {
		if (!photoUrl) return { color: finishHex, ...figure };

		const map = photoSource(photoUrl).clone();
		map.colorSpace = SRGBColorSpace;
		map.center.set(0.5, 0.5);
		map.rotation = direction === "horizontal" ? Math.PI / 2 : 0;

		const { u, v } = photoRepeat(direction, width, height, aspect);
		map.repeat.set(u, v);

		// Each door takes its piece from a different part of the sheet, the way
		// a run really is cut. Without this every door in a row is the same
		// photograph and the repetition is the first thing the eye finds.
		map.offset.set(offset % (1 - u || 1), (offset * 0.618) % (1 - v || 1));
		map.needsUpdate = true;

		return { color: "#ffffff", map, roughnessMap: figure.roughnessMap };
	}, [photoUrl, direction, width, height, offset, finishHex, figure, aspect]);
}
