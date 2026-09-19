"use client";

import { useMemo } from "react";
import {
	RepeatWrapping,
	Shape,
	SRGBColorSpace,
	type Texture,
	TextureLoader,
	Vector2,
} from "three";
import { WALL_GAP_MM } from "@/lib/planner/catalogue";
import { type FloorPlan, outlineOf } from "@/lib/planner/floorplan";

const m = (mm: number) => mm / 1000;
const WALL_COLOR = "#e8e6e1";
/** The wall the add menu builds on: tinted just enough to find. */
const TARGET_WALL_COLOR = "#dde7e0";

/**
 * The SPC plank tile `pnpm generate:grain` draws to `public/floor.png`: two
 * 1220mm planks long by six 180mm planks wide. Change both together.
 */
const FLOOR_TILE_M = { x: 2.44, z: 1.08 };

/** Light natural oak, multiplied onto the greyscale tile. Matte, as SPC's UV
 * coat is. */
const FLOOR_COLOR = "#e3cba8";

/** Lazy for the same reason as `grainSource` in `grain.ts`: no `Image` on the
 * server. */
let floorSource: Texture | null = null;

function floorTexture(): Texture {
	if (!floorSource) {
		floorSource = new TextureLoader().load("/floor.png");
		floorSource.wrapS = RepeatWrapping;
		floorSource.wrapT = RepeatWrapping;
		floorSource.colorSpace = SRGBColorSpace;
		// The floor is seen at a grazing angle; without this the planks smear
		// into a blur a metre from the wall. three clamps it to the GPU's max.
		floorSource.anisotropy = 8;
	}
	return floorSource;
}

/*
 * The scribe gap, held off **every** wall and not only the one behind a run.
 *
 * A run is clamped to `[0, wallWidthMm]`, and the neighbouring walls stand at
 * exactly those two figures — so a cabinet pushed to either end put its side
 * panel on the very plane of the wall. Two coplanar surfaces do not read as
 * "flush"; they read as one eating the other, flickering between them as the
 * camera moves, and from outside the room the single-sided wall vanishes and
 * leaves the carcass hanging through where the wall was.
 *
 * The wall behind a run never had this problem because the run is already held
 * off it by `WALL_GAP_MM` — which is a real allowance, not a rendering trick: no
 * fitter pushes a carcass hard against plaster. The end walls get the same by
 * pushing the whole outline out by `WALL_GAP_MM`, rather than by insetting the
 * run, so `wallWidthMm` stays the length the customer measured and a run built
 * wall to wall still reaches both ends.
 */

/**
 * Cutaway room: the floor plan's floor, and one single-sided plane per wall
 * facing into the room. A wall seen from behind simply vanishes, so whichever
 * walls stand between the camera and the room drop out on their own — the
 * whole cutaway effect, for any outline, with no clipping planes.
 *
 * Drawn on the outline pushed out by the scribe gap, so a carcass pushed hard
 * into a corner never shares a plane with the wall behind it.
 */
export function Room({
	plan,
	height,
	targetWall,
	onWallPick,
}: {
	plan: FloorPlan;
	height: number;
	targetWall: number;
	/** Absent while measuring: a tap then picks a point, not a wall. */
	onWallPick?: (wall: number) => void;
}) {
	const outline = useMemo(() => outlineOf(plan, WALL_GAP_MM), [plan]);
	// The floor lies in the shape's XY plane, turned down onto XZ: plan z is
	// shape −y. UVs are the shape's own coordinates, in metres.
	const floorShape = useMemo(
		() => new Shape(outline.map((p) => new Vector2(m(p.xMm), -m(p.zMm)))),
		[outline],
	);
	const floorMap = useMemo(() => {
		const map = floorTexture().clone();
		// Planks run along the back wall, the way SPC is laid parallel to the
		// longest one.
		map.repeat.set(1 / FLOOR_TILE_M.x, 1 / FLOOR_TILE_M.z);
		map.needsUpdate = true;
		return map;
	}, []);

	return (
		<group>
			<mesh rotation={[-Math.PI / 2, 0, 0]}>
				<shapeGeometry args={[floorShape]} />
				<meshStandardMaterial
					map={floorMap}
					color={FLOOR_COLOR}
					roughness={0.7}
				/>
			</mesh>
			{outline.map((start, i) => {
				const end = outline[(i + 1) % outline.length];
				const dx = end.xMm - start.xMm;
				const dz = end.zMm - start.zMm;
				return (
					// A three.js mesh, not a DOM element: there is no role to give it.
					// biome-ignore lint/a11y/noStaticElementInteractions: see above
					<mesh
						// A wall's place in the outline is its identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						key={i}
						position={[
							m((start.xMm + end.xMm) / 2),
							height / 2,
							m((start.zMm + end.zMm) / 2),
						]}
						rotation={[0, Math.atan2(dz === 0 ? 0 : -dz, dx), 0]}
						onClick={
							onWallPick &&
							((e) => {
								// A drag that ended here was an orbit, not a tap.
								if (e.delta > 4) return;
								e.stopPropagation();
								onWallPick(i);
							})
						}
					>
						<planeGeometry args={[m(Math.hypot(dx, dz)), height]} />
						<meshStandardMaterial
							color={i === targetWall ? TARGET_WALL_COLOR : WALL_COLOR}
							roughness={0.95}
						/>
					</mesh>
				);
			})}
		</group>
	);
}
