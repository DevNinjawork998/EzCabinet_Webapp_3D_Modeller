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

/** High, near-overhead, tilted toward the front of the room: a ceiling
 * softbox, not a sun. From the front it would backlight every cabinet on the
 * far walls and throw their shadows into the room. Metres. */
const KEY_OFFSET_M: [number, number, number] = [1.5, 8, 4];

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
// canvases (studio + quote preview) only cost each other a spare redraw; a
// per-canvas store if that ever shows up in a profile.
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

/**
 * Cast and receive on every lit mesh, and nothing on anything else.
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
		const lit = Array.isArray(mesh.material)
			? mesh.material.some(isLit)
			: isLit(mesh.material);
		mesh.castShadow = lit && mesh.userData.shadow !== "receive";
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
