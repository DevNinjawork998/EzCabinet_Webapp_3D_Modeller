import { type Mesh, type Object3D, PCFShadowMap } from "three";
import type { FloorPlan } from "@/lib/planner/floorplan";

/**
 * The numbers behind the planner's lighting, kept free of React so they can be
 * tested. `Lighting.tsx` is the component that uses them.
 */

export type Quality = "low" | "high";

/**
 * Passed as the Canvas `shadows` prop. It has to go through the prop: R3F
 * re-applies it on every Canvas render (`enabled = !!shadows`), so anything set
 * on `gl.shadowMap` directly is undone by the next re-render.
 *
 * `autoUpdate: false` is the whole mobile budget: the scene is static nearly
 * all the time, so the shadow map is redrawn only when `markShadowsDirty` says
 * something moved. PCF, not PCFSoft — three 0.185 deprecates PCFSoft and
 * softens PCF through `shadow.radius` instead.
 */
export const SHADOW_MAP = {
	enabled: true,
	type: PCFShadowMap,
	autoUpdate: false,
} as const;

export const SHADOW_MAP_SIZE: Record<Quality, number> = {
	low: 1024,
	high: 2048,
};

/** High and well in front of the room (y and z well above/ahead of target),
 * angled enough to light door fronts brightly instead of near-overhead. The
 * x sign is what makes the shadow visible rather than tuning: a cabinet run
 * sits flush against its wall, so a shadow with any z-throw lands almost on
 * top of the cabinet's own silhouette on that wall — the only place it
 * reads as a *separate* shadow is thrown sideways, past the run's open end,
 * which only happens toward the side the key light is *not* on. Task 1's
 * reference run is flush with the room's -x wall and open toward +x, so the
 * key sits at -x to throw its shadow into that open floor. (A run built the
 * other way round would want +x instead — this is a property of the
 * reference scene's layout, not a rule about which side is "correct".) The
 * cost: the wall on the key's own side gets none of its direct light, so
 * Lighting.tsx's side Lightformers carry that wall's brightness instead —
 * see the comment there.
 *
 * Measured (I3, an L room with base units on both the back wall and the
 * key's own -x wall, dev catalogue only — no wall or tall units to check):
 * cabinet *fronts* on the key's own wall read ~20–25% darker than the back
 * wall's fronts, whatever x is tried in -5..-2. The side Lightformers' fill
 * lights the flat room wall it was tuned against (see above), but a front on
 * that wall faces sideways into the room, a different angle the same fill
 * does not reach as well — so nudging x less negative barely moves that
 * number, and at -3/-2 it also loses the reference run's cast shadow. -5 is
 * kept for that reason.
 *
 * Task 13 fixed the key-side-front gap without touching this value: a second,
 * non-shadow-casting `directionalLight` in Lighting.tsx (`FILL_INTENSITY`,
 * `FILL_OFFSET_M`), aimed from +x at fronts specifically rather than the flat
 * wall. Measured on the same L room: key-side fronts down to ~6% darker than
 * the back wall (from ~20-25%), with the Task 12 reference scene still within
 * budget (door front unchanged, side wall +7-8%, cast shadow still visible —
 * see the fill's own comment in Lighting.tsx for the numbers). Metres. */
const KEY_OFFSET_M: [number, number, number] = [-5, 5.5, 5];

export type KeyLightRig = {
	target: [number, number, number];
	position: [number, number, number];
	/** Half-size of the orthographic shadow camera, each way. */
	halfExtent: number;
	near: number;
	far: number;
};

/**
 * The key light and its shadow camera, fitted to the room.
 *
 * A plan is centred on the origin — `outlineOf` spans ±width/2 by ±depth/2
 * for every template, an L's notch included — so the room box is known from
 * the plan's two numbers. The shadow camera is sized to the box's bounding
 * sphere, which covers it from any light direction, so every shadow texel
 * lands inside the room and 1024² is sharp enough on a phone.
 */
export function keyLightRig(
	plan: FloorPlan,
	ceilingHeightMm: number,
): KeyLightRig {
	const w = plan.widthMm / 1000;
	const d = plan.depthMm / 1000;
	const h = ceilingHeightMm / 1000;
	const target: [number, number, number] = [0, h / 2, 0];
	const position: [number, number, number] = [
		target[0] + KEY_OFFSET_M[0],
		target[1] + KEY_OFFSET_M[1],
		target[2] + KEY_OFFSET_M[2],
	];
	const halfExtent = Math.hypot(w, d, h) / 2;
	const distance = Math.hypot(...KEY_OFFSET_M);
	return {
		target,
		position,
		halfExtent,
		near: Math.max(0.1, distance - halfExtent),
		far: distance + halfExtent,
	};
}

// ponytail: module-level counter shared by every canvas on the page. Two live
// canvases would split the pending frames between them — each only sees one
// of the frames a single canvas would have gotten, so a redraw can land one
// frame before the moved geometry did and read as briefly stale. Today the
// studio and the quote screen never render at once, so this never happens;
// a per-canvas store if that ever changes.
let dirtyFrames = 0;

/**
 * Ask for the shadow map to be redrawn for the next `frames` frames. Two by
 * default: the frame that moved something may run its `useFrame` after the
 * shadow pass has already read the old pose.
 */
export function markShadowsDirty(frames = 2): void {
	dirtyFrames = Math.max(dirtyFrames, frames);
}

/** Consume one pending redraw; false when nothing is pending. */
export function takeShadowFrame(): boolean {
	if (dirtyFrames <= 0) return false;
	dirtyFrames--;
	return true;
}

const isLit = (material: unknown): boolean =>
	(material as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial ===
	true;

const isTransparent = (material: unknown): boolean =>
	(material as { transparent?: boolean }).transparent === true;

/**
 * Cast and receive on every lit mesh, and nothing on anything else — except a
 * transparent one (a glass door front), which still receives but never
 * casts. A shadow map has no idea a material is see-through: it would throw
 * the same solid silhouette a slab door does, which reads as a glass door
 * blocking light it should let through.
 *
 * "Lit" is the test because it already separates the scene the right way:
 * cabinets, worktops, kick boards, trim and the room are `meshStandardMaterial`
 * (or physical, which extends it); every piece of UI — selection outlines,
 * measuring glyphs, the move handle, invisible hit planes, the fake blob
 * shadows — is basic or line material. A mesh tagged
 * `userData.shadow = "receive"` (the walls and floor) never casts: one wall
 * casting would black out half the room.
 */
export function syncShadowFlags(root: Object3D): void {
	root.traverse((object) => {
		const mesh = object as Mesh;
		if (!mesh.isMesh) return;
		const materials = Array.isArray(mesh.material)
			? mesh.material
			: [mesh.material];
		const lit = materials.some(isLit);
		const transparent = materials.some(isTransparent);
		mesh.castShadow = lit && !transparent && mesh.userData.shadow !== "receive";
		mesh.receiveShadow = lit;
	});
}

/** A tier forced from the URL, for testing: `?quality=high|low`. Development
 * only — a customer never gets to pick. */
export function qualityFromSearch(
	search: string,
	dev: boolean,
): Quality | null {
	if (!dev) return null;
	const value = new URLSearchParams(search).get("quality");
	return value === "high" || value === "low" ? value : null;
}
