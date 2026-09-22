"use client";

import { Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
	ACESFilmicToneMapping,
	type DirectionalLight,
	NeutralToneMapping,
} from "three";
import type { FloorPlan } from "@/lib/planner/floorplan";
import {
	keyLightRig,
	markShadowsDirty,
	type Quality,
	SHADOW_MAP_SIZE,
	syncShadowFlags,
	takeShadowFrame,
} from "./lightingRig";

/**
 * The planner's whole lighting rig, in one place so it can be swapped out in
 * one line.
 *
 * Tone mapping is Khronos PBR Neutral rather than R3F's default ACES. ACES
 * shifts hue and crushes highlights, which is why Rhone Oak once rendered
 * near-white and the lights were turned down to compensate. Neutral is built
 * for product renders: colours below the highlight shoulder come out as the
 * admin typed them, and the finish on screen is the finish being sold.
 *
 * The environment is four Lightformer softboxes rendered once into a 256²
 * cube map — `frames={1}`, so it costs nothing per frame, and no HDR file,
 * since a studio HDR is 1–3 MB on Malaysian mobile data. It is what gives
 * glass, handles and the worktop something to reflect.
 */
export function StudioLighting({
	plan,
	ceilingHeightMm,
	quality,
}: {
	plan: FloorPlan;
	ceilingHeightMm: number;
	quality: Quality;
}) {
	const gl = useThree((state) => state.gl);
	const light = useRef<DirectionalLight>(null);
	const fill = useRef<DirectionalLight>(null);
	const rig = useMemo(
		() => keyLightRig(plan, ceilingHeightMm),
		[plan, ceilingHeightMm],
	);
	const fillPosition = useMemo<[number, number, number]>(
		() => [
			rig.target[0] + FILL_OFFSET_M[0],
			rig.target[1] + FILL_OFFSET_M[1],
			rig.target[2] + FILL_OFFSET_M[2],
		],
		[rig.target],
	);
	const mapSize = SHADOW_MAP_SIZE[quality];

	// R3F sets tone mapping once at creation and never again, so this sticks.
	// Unmounting restores R3F's default, which is what makes this component the
	// kill switch the spec asks for.
	useLayoutEffect(() => {
		gl.toneMapping = NeutralToneMapping;
		return () => {
			gl.toneMapping = ACESFilmicToneMapping;
		};
	}, [gl]);

	// Refit the shadow camera to the room, and resize the map for the tier. A
	// resized map has to be thrown away, or three keeps drawing into the old one.
	useLayoutEffect(() => {
		const key = light.current;
		if (!key) return;
		key.target.position.set(...rig.target);
		key.target.updateMatrixWorld();
		// The fill aims at the same point, but never sizes a shadow camera —
		// it doesn't cast one.
		if (fill.current) {
			fill.current.target.position.set(...rig.target);
			fill.current.target.updateMatrixWorld();
		}
		const camera = key.shadow.camera;
		camera.left = -rig.halfExtent;
		camera.right = rig.halfExtent;
		camera.top = rig.halfExtent;
		camera.bottom = -rig.halfExtent;
		camera.near = rig.near;
		camera.far = rig.far;
		camera.updateProjectionMatrix();
		key.shadow.mapSize.set(mapSize, mapSize);
		key.shadow.map?.dispose();
		key.shadow.map = null;
		markShadowsDirty();
	}, [rig, mapSize]);

	// The only per-frame work, and on almost every frame it is one comparison.
	// Orbiting never lands here: the light is fixed in the world, so a camera
	// move changes nothing the shadow map holds.
	useFrame(({ scene }) => {
		if (!takeShadowFrame()) return;
		syncShadowFlags(scene);
		gl.shadowMap.needsUpdate = true;
	});

	return (
		<>
			<Environment
				resolution={256}
				frames={1}
				environmentIntensity={ENVIRONMENT_INTENSITY}
			>
				{/* Ceiling softbox: large, above and slightly in front, facing down. */}
				<Lightformer
					form="rect"
					intensity={2}
					position={[0, 5, 2]}
					rotation-x={Math.PI / 2}
					scale={[8, 4, 1]}
				/>
				{/* Two side strips: the edge highlights on doors and handles, and —
				    since the key light throws its one visible cast shadow by
				    sitting off to one side (see lightingRig.ts) — the fill that
				    keeps the far side wall off the key light's path from reading
				    dark. */}
				<Lightformer
					form="rect"
					intensity={4.5}
					position={[-5, 2, 1]}
					rotation-y={Math.PI / 2}
					scale={[6, 1.2, 1]}
				/>
				<Lightformer
					form="rect"
					intensity={4.5}
					position={[5, 2, 1]}
					rotation-y={-Math.PI / 2}
					scale={[6, 1.2, 1]}
				/>
				{/* Warm bounce low at the front, so kick boards and undersides are
				    not dead black. */}
				<Lightformer
					form="rect"
					color="#fff1e0"
					intensity={0.4}
					position={[0, 0.3, 6]}
					rotation-y={Math.PI}
					scale={[8, 1, 1]}
				/>
			</Environment>
			{/* The environment is the fill now; ambient is only a floor under the
			    darkest corners. Ambient is the flat grey wash that reads as CG. */}
			<ambientLight intensity={AMBIENT_INTENSITY} />
			<directionalLight
				ref={light}
				castShadow
				position={rig.position}
				intensity={KEY_INTENSITY}
				shadow-bias={SHADOW_BIAS}
				shadow-normalBias={SHADOW_NORMAL_BIAS}
				shadow-radius={SHADOW_RADIUS}
			/>
			{/* Fixes I3: the key sits on -x (see lightingRig.ts), so a cabinet
			    front on that same wall faces +x, into the room — a direction the
			    side Lightformers (tuned for the flat wall, not a sideways-facing
			    front) don't reach well, and it read 20-25% darker than the back
			    wall. This is a second directional light from +x, high, never
			    casting a shadow (no shadow map to size, so it's nearly free): it
			    lights that front without adding a second cast shadow to check for
			    doubling. Kept at z=0 (see FILL_OFFSET_M) rather than "in front"
			    like the key — a z component lit the z-facing reference-scene door
			    front too, which the ±3%-of-Phase-1 target doesn't have room for. */}
			<directionalLight
				ref={fill}
				castShadow={false}
				position={fillPosition}
				intensity={FILL_INTENSITY}
			/>
		</>
	);
}

/** Tuned by eye against the real finishes — see the plan's Task 2 Step 4.
 * Re-tuned in Task 12 against `KEY_OFFSET_M`'s off-to-one-side key (see
 * lightingRig.ts): the side Lightformers now carry most of the far wall's
 * brightness (the key light itself lights almost none of it, by design — see
 * below), so they went up a lot; `KEY_INTENSITY` came back down to keep the
 * door front matching Phase 1 once that fill was added. */
const ENVIRONMENT_INTENSITY = 0.8;
const AMBIENT_INTENSITY = 0.3;
const KEY_INTENSITY = 1.3;
/** Metres, relative to the room's centre-height target — see `fillPosition`
 * above. Mostly a mirror of `KEY_OFFSET_M` (lightingRig.ts) onto +x, so it
 * lights the wall the key doesn't reach without landing on top of it — but
 * z is 0, not mirrored to +3: a nonzero z lit the reference scene's z-facing
 * door front too (N·L stops being ~0 for that face), which blew past the
 * ±3%-of-Phase-1 target long before the key-side wall got close to 10%. */
const FILL_OFFSET_M: [number, number, number] = [6, 4, 0];
/** Task 13: a non-shadow fill for cabinet fronts on the key's own wall (see
 * the comment on the second `directionalLight` below). Measured on the L
 * room (base units on wall 1 and the key-side wall 6, dev catalogue's only
 * base cabinets): key-side fronts went from ~20-25% darker than the back
 * wall to ~6% (avg rgb ~155 vs ~145 across three sample points each). Checked
 * against the reference scene (scene.md) at the same time: door front
 * unchanged (rgb ~166 vs Phase 1's 167,155,140, since it doesn't face +x) and
 * side wall ~146→~157, a ~7-8% rise, the top of the "~8%" budget but not over
 * it. 0.5 got the key-side wall closer to parity but pushed the reference
 * side wall to ~+12-13%, so this is the lower of the two values that still
 * clears the L-room target. */
const FILL_INTENSITY = 0.35;
/** Tuned against 18 mm panels: acne if too small, a gap under the cabinet
 * ("peter-panning") if too large. */
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 0.02;
/** PCF blur, in texels. */
const SHADOW_RADIUS = 4;
