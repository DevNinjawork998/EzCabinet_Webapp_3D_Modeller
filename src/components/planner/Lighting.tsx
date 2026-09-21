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
	const rig = useMemo(
		() => keyLightRig(plan, ceilingHeightMm),
		[plan, ceilingHeightMm],
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
				{/* Two side strips: the edge highlights on doors and handles. */}
				<Lightformer
					form="rect"
					intensity={0.8}
					position={[-5, 2, 1]}
					rotation-y={Math.PI / 2}
					scale={[6, 1.2, 1]}
				/>
				<Lightformer
					form="rect"
					intensity={0.8}
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
		</>
	);
}

/** Tuned by eye against the real finishes — see the plan's Task 2 Step 4. */
const ENVIRONMENT_INTENSITY = 0.8;
const AMBIENT_INTENSITY = 0.3;
const KEY_INTENSITY = 1.6;
/** Tuned against 18 mm panels: acne if too small, a gap under the cabinet
 * ("peter-panning") if too large. */
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 0.02;
/** PCF blur, in texels. */
const SHADOW_RADIUS = 4;
