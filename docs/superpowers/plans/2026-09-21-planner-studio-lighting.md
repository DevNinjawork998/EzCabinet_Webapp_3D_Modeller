# Planner Studio Lighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the planner canvas read as a studio render — environment reflections, neutral tone mapping, soft on-demand shadows, and ambient occlusion on capable devices — with zero change to any functional behaviour.

**Architecture:** Pure helpers in `components/planner/lightingRig.ts` (key-light rig, shadow-dirty counter, shadow flag sync, quality parsing), one `<StudioLighting />` component that owns tone mapping, the Lightformer environment, the lights and the on-demand shadow redraw, and one lazily imported `HighQualityEffects.tsx` for N8AO on the `high` tier. `PlannerScene.tsx` swaps its two light lines for `<StudioLighting />` and threads a `quality` value down.

**Tech Stack:** three 0.185, @react-three/fiber 9.7, @react-three/drei 10.7, @react-three/postprocessing 3.1 (new, Phase 2 only), vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-21-planner-studio-lighting-design.md` — read it first; the "Must not break" table is the acceptance bar.

## Global Constraints

- **No git commits and no push.** The user commits and pushes once development is done. Work stays uncommitted on branch `feature/studio-lighting`. Do not stage or touch the unrelated uncommitted change in `src/lib/analytics.ts`.
- **No functional change.** Every interaction in the spec's "Must not break" table behaves identically to `main`.
- `lib/planner` is not modified.
- No HDR/EXR files; the environment is Lightformers only.
- Phase 1 adds no dependencies. Phase 2 adds only `@react-three/postprocessing` and its peer `postprocessing`, imported only from `HighQualityEffects.tsx`, which is only reached through `React.lazy`.
- `PCFSoftShadowMap` is deprecated in three 0.185 (it warns and falls back). Use `PCFShadowMap` with `shadow.radius`.
- R3F re-applies the Canvas `shadows` prop on every Canvas render (`gl.shadowMap.enabled = !!shadows`), so shadow-map settings go through the `shadows` prop, never set imperatively. Tone mapping is set only once by R3F at creation, so `<StudioLighting />` may set it in a layout effect.
- Gate after every task: `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.
- Tabs for indentation, Biome style; match the surrounding comment density.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/components/planner/lightingRig.ts` | Pure: `keyLightRig`, `markShadowsDirty` / `takeShadowFrame`, `syncShadowFlags`, `qualityFromSearch`, `SHADOW_MAP`, `SHADOW_MAP_SIZE`, `Quality` |
| Create `src/components/planner/__tests__/lightingRig.test.ts` | Tests for the above |
| Create `src/components/planner/Lighting.tsx` | `<StudioLighting />`: tone mapping, environment, lights, shadow redraw |
| Create `src/components/planner/HighQualityEffects.tsx` | N8AO + neutral tone mapping through `EffectComposer` (default export, lazy) |
| Modify `src/components/planner/PlannerScene.tsx` | Use `<StudioLighting />`, `shadows` prop, quality tier, blob-pool switch, delete `WallShadow`, UI `toneMapped={false}`, dirty on drag |
| Modify `src/components/planner/Room.tsx` | Walls/floor tagged receive-only |
| Modify `src/components/planner/Hinge.tsx`, `Slide.tsx` | Mark shadows dirty while animating |
| Modify `src/components/planner/DesignedCabinet.tsx` | Mark shadows dirty when a drafted mesh arrives |
| Modify `src/components/planner/MeasureOverlay.tsx`, `PositionDimensions.tsx`, `Cabinet.tsx` | `toneMapped={false}` on overlay materials |
| Modify `CLAUDE.md` | Replace the "No real-time shadows" rule |

---

# Phase 1 — environment, tone mapping, lights (PR 1)

### Task 1: Baseline capture

The before/after comparison needs a "before". Nothing is changed in this task.

**Files:** none (outputs go to the session scratchpad, not the repo)

- [ ] **Step 1: Start the app**

Run: `pnpm dev` (background). Open `http://localhost:3000/en/planner`.

- [ ] **Step 2: Build the reference scene**

Pick the kitchen. Place a straight run of at least three base units with wall units above, including one glass-door design if the catalogue has one. Note the finish in use.

- [ ] **Step 3: Capture screenshots**

Capture the 3D, elevation and plan views. Then switch the room to L-shaped in the Room panel and capture 3D once more. Save them as `before-3d.png`, `before-elevation.png`, `before-plan.png`, `before-l.png` in the scratchpad directory.

- [ ] **Step 4: Record baseline frame times**

Chrome DevTools → Performance, 4× CPU throttle, mobile viewport (e.g. Pixel 7). Record 5 s of idle orbiting and 5 s of dragging a base unit along the wall. Write the average frame time for each into `baseline.txt` in the scratchpad.

---

### Task 2: `<StudioLighting />` with neutral tone mapping and a Lightformer environment

**Files:**
- Create: `src/components/planner/Lighting.tsx`
- Modify: `src/components/planner/PlannerScene.tsx` (the two light lines after `<color attach="background" …/>`, currently ~line 2547)

**Interfaces:**
- Produces: `export function StudioLighting(): JSX.Element` (Phase 2 adds props in Task 6)

- [ ] **Step 1: Create `Lighting.tsx`**

```tsx
"use client";

import { Environment, Lightformer } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
import { ACESFilmicToneMapping, NeutralToneMapping } from "three";

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
export function StudioLighting() {
	const gl = useThree((state) => state.gl);

	// R3F sets tone mapping once at creation and never again, so this sticks.
	// Unmounting restores R3F's default, which is what makes this component the
	// kill switch the spec asks for.
	useLayoutEffect(() => {
		gl.toneMapping = NeutralToneMapping;
		return () => {
			gl.toneMapping = ACESFilmicToneMapping;
		};
	}, [gl]);

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
			<directionalLight position={[4, 7, 6]} intensity={KEY_INTENSITY} />
		</>
	);
}

/** Tuned by eye against the real finishes — see the plan's Task 2 Step 4. */
const ENVIRONMENT_INTENSITY = 0.8;
const AMBIENT_INTENSITY = 0.2;
const KEY_INTENSITY = 1.6;
```

- [ ] **Step 2: Swap the lights in `PlannerScene.tsx`**

Replace this block (comment plus the two lights):

```tsx
			{/* Was 1.5 + 2.0, which clipped every mid-tone: Rhone Oak rendered
			    near-white and the grain with it. Dropped until the catalogue's
			    own finish colours survive to the screen, since that screenshot is
			    what goes out over WhatsApp. */}
			<ambientLight intensity={0.85} />
			<directionalLight position={[4, 7, 6]} intensity={1.35} />
```

with:

```tsx
			<StudioLighting />
```

and add the import next to the other local imports:

```tsx
import { StudioLighting } from "./Lighting";
```

- [ ] **Step 3: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 4: Tune by eye**

With `pnpm dev` running, rebuild the Task 1 scene. Adjust `ENVIRONMENT_INTENSITY` (range 0.5–1.2), `AMBIENT_INTENSITY` (0–0.4) and `KEY_INTENSITY` (1.0–2.5) until:
- the door finish beside its swatch on the finish picker reads as the same colour,
- white walls are light but not clipped to pure white,
- glass and handles show a visible soft highlight,
- the kick board and cabinet undersides are dark but still show shape.

Record the final values in the constants.

---

### Task 3: Overlay and UI materials keep their exact colours

Tone mapping applies to `meshBasicMaterial` and line materials too. UI geometry has to render its hex exactly, matching the DOM UI in the same brand green.

**Files:**
- Modify: `src/components/planner/PlannerScene.tsx` — every `<meshBasicMaterial` that draws visible UI: the pan gizmo (~lines 664–693) and `MoveHandle` (~lines 1864–1913). Not the invisible `opacity={0}` deselect plane (~line 1604).
- Modify: `src/components/planner/MeasureOverlay.tsx` — the glyph `<meshBasicMaterial` (~line 103) and the `<Line` (~line 167)
- Modify: `src/components/planner/PositionDimensions.tsx` — the three `<Line` (~lines 179–181)
- Modify: `src/components/planner/Cabinet.tsx` — the selection `<Edges color={SELECTION_COLOR} …/>` (~line 437) only; the door-edge `<Edges` at ~line 527 is part of the cabinet and stays tone-mapped

- [ ] **Step 1: Add `toneMapped={false}` to each listed material**

Example, `MoveHandle`:

```tsx
				<meshBasicMaterial color="#1f5138" toneMapped={false} />
```

Example, `MeasureOverlay` glyph:

```tsx
			<meshBasicMaterial
				color={color}
				transparent={opacity < 1}
				opacity={opacity}
				depthTest={false}
				toneMapped={false}
			/>
```

Example, lines and edges (drei passes material props through):

```tsx
			<Line points={[start, end]} color={LINE_COLOR} lineWidth={2} toneMapped={false} />
```

```tsx
					<Edges
						color={SELECTION_COLOR}
						lineWidth={SELECTION_LINE_PX}
						toneMapped={false}
					/>
```

Find every one with: `grep -n "meshBasicMaterial\|<Line\|<Edges" src/components/planner/*.tsx`

- [ ] **Step 2: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. If `typecheck` rejects `toneMapped` on `Line` or `Edges`, read drei's `LineProps` / `EdgesProps` in `node_modules/@react-three/drei/core/` for how that version passes material props, apply `toneMapped: false` that way, and note which component needed it.

- [ ] **Step 3: Check colours by eye**

Select a cabinet, open the measure tool, show the position dimensions. The selection outline, move handle, pan puck and dimension lines match the green `#1f5138` of the DOM labels beside them.

---

### Task 4: Phase 1 verification

**Files:** none

- [ ] **Step 1: After screenshots**

Repeat Task 1 Steps 2–3 and save `after1-*.png` beside the baselines. Compare in pairs: finishes truer to swatch, glass/handle highlights present, no clipped whites.

- [ ] **Step 2: Functional regression pass (spec "Must not break")**

On `pnpm dev`, each must behave exactly as on `main`: select, multi-select, drag along a wall, drag to another wall, drop free-standing, rotate a free cabinet, resize, measure (snap points land on the same edges), doors open, doors hidden, wall paint, room shape rect ↔ L, wall length edit, 3D / elevation / plan views, quote screen preview.

- [ ] **Step 3: Performance**

Repeat Task 1 Step 4. Pass: idle and drag frame times within noise of `baseline.txt` (Phase 1 adds no per-frame work).

- [ ] **Step 4: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. Report to the user: Phase 1 ready for their commit as PR 1.

---

# Phase 2 — shadows and quality tiers (PR 2)

### Task 5: Pure lighting helpers

**Files:**
- Create: `src/components/planner/lightingRig.ts`
- Test: `src/components/planner/__tests__/lightingRig.test.ts`

**Interfaces:**
- Produces:
  - `type Quality = "low" | "high"`
  - `const SHADOW_MAP: { enabled: true; type: typeof PCFShadowMap; autoUpdate: false }`
  - `const SHADOW_MAP_SIZE: Record<Quality, number>` — `{ low: 1024, high: 2048 }`
  - `type KeyLightRig = { target: [number, number, number]; position: [number, number, number]; halfExtent: number; near: number; far: number }`
  - `function keyLightRig(plan: FloorPlan, ceilingHeightMm: number): KeyLightRig`
  - `function markShadowsDirty(frames?: number): void` (default 2)
  - `function takeShadowFrame(): boolean`
  - `function syncShadowFlags(root: Object3D): void`
  - `function qualityFromSearch(search: string, dev: boolean): Quality | null`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
	BoxGeometry,
	Group,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
} from "three";
import {
	keyLightRig,
	markShadowsDirty,
	qualityFromSearch,
	syncShadowFlags,
	takeShadowFrame,
} from "../lightingRig";

describe("keyLightRig", () => {
	const plan = { template: "rect", widthMm: 4000, depthMm: 3000 } as const;
	const rig = keyLightRig(plan, 2600);

	it("aims at the middle of the room, half way up", () => {
		expect(rig.target).toEqual([0, 1.3, 0]);
	});

	it("sits high above the room, tilted toward the front", () => {
		expect(rig.position[1]).toBeGreaterThan(rig.target[1] + 5);
		expect(rig.position[2]).toBeGreaterThan(0);
	});

	it("covers the whole room box from any light direction", () => {
		// Half the room box's diagonal: 4 × 3 × 2.6 m.
		expect(rig.halfExtent).toBeCloseTo(Math.hypot(4, 3, 2.6) / 2, 6);
		const distance = Math.hypot(
			rig.position[0] - rig.target[0],
			rig.position[1] - rig.target[1],
			rig.position[2] - rig.target[2],
		);
		expect(rig.near).toBeLessThanOrEqual(distance - rig.halfExtent);
		expect(rig.near).toBeGreaterThan(0);
		expect(rig.far).toBeGreaterThanOrEqual(distance + rig.halfExtent);
	});

	it("an L room is bounded by its own width and depth", () => {
		const l = keyLightRig(
			{
				template: "l",
				widthMm: 4000,
				depthMm: 3000,
				notchWidthMm: 1500,
				notchDepthMm: 1000,
				mirror: false,
			},
			2600,
		);
		expect(l.halfExtent).toBeCloseTo(rig.halfExtent, 6);
	});
});

describe("shadow dirty counter", () => {
	it("hands out exactly as many frames as were asked for", () => {
		while (takeShadowFrame()) {}
		markShadowsDirty(3);
		expect([takeShadowFrame(), takeShadowFrame(), takeShadowFrame()]).toEqual([
			true,
			true,
			true,
		]);
		expect(takeShadowFrame()).toBe(false);
	});

	it("never shortens a longer pending request", () => {
		while (takeShadowFrame()) {}
		markShadowsDirty(5);
		markShadowsDirty(1);
		let taken = 0;
		while (takeShadowFrame()) taken++;
		expect(taken).toBe(5);
	});

	it("defaults to two frames", () => {
		while (takeShadowFrame()) {}
		markShadowsDirty();
		let taken = 0;
		while (takeShadowFrame()) taken++;
		expect(taken).toBe(2);
	});
});

describe("syncShadowFlags", () => {
	const box = new BoxGeometry();

	it("lit meshes cast and receive", () => {
		const lit = new Mesh(box, new MeshStandardMaterial());
		const glass = new Mesh(box, new MeshPhysicalMaterial());
		const root = new Group().add(lit, glass);
		syncShadowFlags(root);
		expect([lit.castShadow, lit.receiveShadow]).toEqual([true, true]);
		expect([glass.castShadow, glass.receiveShadow]).toEqual([true, true]);
	});

	it("UI and fake-shadow meshes do neither", () => {
		const ui = new Mesh(box, new MeshBasicMaterial());
		syncShadowFlags(new Group().add(ui));
		expect([ui.castShadow, ui.receiveShadow]).toEqual([false, false]);
	});

	it("receive-only meshes never cast", () => {
		const wall = new Mesh(box, new MeshStandardMaterial());
		wall.userData.shadow = "receive";
		syncShadowFlags(new Group().add(wall));
		expect([wall.castShadow, wall.receiveShadow]).toEqual([false, true]);
	});

	it("looks inside nested groups", () => {
		const deep = new Mesh(box, new MeshStandardMaterial());
		syncShadowFlags(new Group().add(new Group().add(deep)));
		expect(deep.castShadow).toBe(true);
	});
});

describe("qualityFromSearch", () => {
	it("reads a forced tier in development", () => {
		expect(qualityFromSearch("?quality=high", true)).toBe("high");
		expect(qualityFromSearch("?x=1&quality=low", true)).toBe("low");
	});

	it("ignores anything else", () => {
		expect(qualityFromSearch("?quality=ultra", true)).toBeNull();
		expect(qualityFromSearch("", true)).toBeNull();
	});

	it("is ignored in production", () => {
		expect(qualityFromSearch("?quality=high", false)).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/planner/__tests__/lightingRig.test.ts`
Expected: FAIL — cannot resolve `../lightingRig`.

- [ ] **Step 3: Write `lightingRig.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/components/planner/__tests__/lightingRig.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

---

### Task 6: On-demand shadow map

**Files:**
- Modify: `src/components/planner/Lighting.tsx`
- Modify: `src/components/planner/PlannerScene.tsx` (Canvas props; `<StudioLighting />` call; a dirty effect; `onDragMove` in `Run`)
- Modify: `src/components/planner/Room.tsx` (floor and wall meshes)
- Modify: `src/components/planner/Hinge.tsx`, `src/components/planner/Slide.tsx`
- Modify: `src/components/planner/DesignedCabinet.tsx` (`useDesignMesh`)

**Interfaces:**
- Consumes: everything from Task 5
- Produces: `StudioLighting({ plan, ceilingHeightMm, quality }: { plan: FloorPlan; ceilingHeightMm: number; quality: Quality })`

- [ ] **Step 1: Shadow-casting key light in `Lighting.tsx`**

Change the signature and add the rig, the redraw loop and the shadow props. Full component after the change:

```tsx
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

// (keep the Task 2 doc comment here)
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
			{/* (the Task 2 <Environment> block, unchanged) */}
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

// (keep the Task 2 intensity constants)
/** Tuned against 18 mm panels: acne if too small, a gap under the cabinet
 * ("peter-panning") if too large. */
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 0.02;
/** PCF blur, in texels. */
const SHADOW_RADIUS = 4;
```

- [ ] **Step 2: Wire it into `PlannerScene.tsx`**

In the `<Canvas>` props, add:

```tsx
			// Redrawn on demand, never per frame — see `SHADOW_MAP`.
			shadows={SHADOW_MAP}
```

Replace `<StudioLighting />` with:

```tsx
			<StudioLighting
				plan={layout.plan}
				ceilingHeightMm={layout.ceilingHeightMm}
				quality={quality}
			/>
```

Until Task 8, declare `quality` as a constant above the `return` of `PlannerScene`:

```tsx
	const quality: Quality = "low";
```

Add a dirty effect beside the other hooks in `PlannerScene` (after `freeRuns` is fine):

```tsx
	// Anything that moves, adds or removes a cabinet changes what casts. The
	// door animation and a drag mark their own frames as they run.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the triggers, not inputs
	useEffect(() => {
		markShadowsDirty();
	}, [layout, openIds, doorsHidden, finish]);
```

Imports: `import { markShadowsDirty, type Quality, SHADOW_MAP } from "./lightingRig";`

- [ ] **Step 3: Mark dirty during a drag**

In `Run`, in `onDragMove.current = (event) => { … }`, right after `if (!drag) return;`:

```tsx
		// The cabinet is moved imperatively below, not through a re-render.
		markShadowsDirty();
```

- [ ] **Step 4: Mark dirty while doors animate**

`Hinge.tsx`, in `useFrame`, after the `group.position.x = …` line that follows the `MathUtils.damp` call:

```tsx
		markShadowsDirty();
```

and inside the settle branch, after landing on the target (inside `if (current !== target) { … }`):

```tsx
				markShadowsDirty();
```

`Slide.tsx`, same two places: after `group.position.z = MathUtils.damp(…)`, and inside `if (current !== target)` (turn the one-liner into a block):

```tsx
			if (current !== target) {
				group.position.z = target;
				markShadowsDirty();
			}
```

Both files: `import { markShadowsDirty } from "./lightingRig";`

- [ ] **Step 5: Mark dirty when a drafted mesh arrives**

`DesignedCabinet.tsx`, in `useDesignMesh`, after the existing `useEffect`:

```tsx
	// The drafted mesh lands a frame or more after the layout that asked for
	// it, with no layout change to redraw the shadows.
	useEffect(() => {
		if (groups) markShadowsDirty();
	}, [groups]);
```

Import: `import { markShadowsDirty } from "./lightingRig";`

- [ ] **Step 6: Walls and floor receive only**

`Room.tsx`: add `userData={RECEIVE_ONLY}` to the floor `<mesh rotation={[-Math.PI / 2, 0, 0]}>` and to each wall `<mesh …>`, and define once near the colour constants:

```tsx
/** Walls and floor take shadows but never cast them — one wall casting would
 * black out half the room. Read by `syncShadowFlags`. Module-level so the
 * object keeps its identity between renders. */
const RECEIVE_ONLY = { shadow: "receive" };
```

- [ ] **Step 7: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 8: Check by eye, and tune**

`pnpm dev`, the Task 1 scene:
- a soft shadow under wall units on the worktop, a shadow line where base units meet the floor, a hint on the wall behind;
- no striping on cabinet faces (acne → make `SHADOW_BIAS` more negative, e.g. −0.001);
- no light gap between a cabinet's foot and its shadow (peter-panning → reduce `SHADOW_NORMAL_BIAS`);
- open doors: the shadow follows the swing and settles with it; hide doors: the door shadows go;
- drag a cabinet: its shadow follows live and stays where it's dropped;
- orbit: shadows stay put and nothing flickers;
- a room with cabinets on all four walls: every wall's cabinets get the same treatment;
- the console shows no `PCFSoftShadowMap has been deprecated` warning.

---

### Task 7: Retire the wall patch, soften the floor pools

**Files:**
- Modify: `src/components/planner/PlannerScene.tsx` (`WallShadow`, `SHADOW_VIEW`, `ContactShadows`, `Run` props and its two `<ContactShadows>`, the two `<Run>` call sites)

**Interfaces:**
- Produces: `Run` gains `blobShadows: boolean`

- [ ] **Step 1: Delete `WallShadow`**

Delete the `WallShadow` function with its doc comment, the `SHADOW_VIEW` constant with its comment, and the whole wall-unit branch at the end of `ContactShadows` (the comment "Wall units get a soft patch on the wall itself…" and the `positionsOf(layout, "wall").map(…<WallShadow …/>)` block). Remove imports left unused (`MeshBasicMaterial`, `PlaneGeometry`, and `useFrame` / `Vector3` only if nothing else uses them — `pnpm lint` reports unused imports).

- [ ] **Step 2: Fainter floor pools**

In `ContactShadows`, change the floor `<Shadow>`'s `opacity={0.5}` to `opacity={0.35}`, and update its doc comment's first line to:

```tsx
/**
 * Fake contact shadows under floor units — a cheap contact darkening on top
 * of the real shadow map, off on the `high` tier where ambient occlusion does
 * the same job properly.
```

(keep the rest of that comment about the pool being wider than the cabinet).

- [ ] **Step 3: A switch for the pools**

Add `blobShadows: boolean` to `Run`'s props (destructure it beside `freeStanding`), and wrap both `<ContactShadows …/>` in `Run`:

```tsx
			{blobShadows && (
				<ContactShadows
					layout={stayLayout}
					runWidthMm={runWidthMm}
					engine={engine}
				/>
			)}
```

(and the same for the `floatLayout` one). At both `<Run` call sites in `PlannerScene`:

```tsx
						blobShadows={quality === "low"}
```

- [ ] **Step 4: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 5: Check by eye**

Wall units: the real shadow shows below them on the wall; from a side angle no grey smudge floats on bare wall. Floor units: the pool still grounds them, lighter than before.

---

### Task 8: Quality tiers

**Files:**
- Modify: `src/components/planner/PlannerScene.tsx`

**Interfaces:**
- Consumes: `qualityFromSearch`, `Quality` (Task 5); `StudioLighting` `quality` prop (Task 6); `Run` `blobShadows` (Task 7)

- [ ] **Step 1: Replace the constant with state**

Replace `const quality: Quality = "low";` with:

```tsx
	// Every device starts on `low` and earns `high` by measured frame rate —
	// no user-agent guessing, so a strong phone gets it and a weak laptop does
	// not. View state: never on the layout, never stored.
	const [forced] = useState(() =>
		typeof window === "undefined"
			? null
			: qualityFromSearch(
					window.location.search,
					process.env.NODE_ENV !== "production",
				),
	);
	const [measured, setMeasured] = useState<Quality>("low");
	const quality = forced ?? measured;
```

- [ ] **Step 2: Mount the monitor**

Inside `<Canvas>`, right after `<StudioLighting …/>`:

```tsx
			{/* Flip-flopping means the device sits on the line: settle on `low`
			    for the session rather than swapping AO in and out. */}
			<PerformanceMonitor
				flipflops={3}
				onIncline={() => setMeasured("high")}
				onDecline={() => setMeasured("low")}
				onFallback={() => setMeasured("low")}
			/>
```

Add `PerformanceMonitor` to the existing `@react-three/drei` import, and `qualityFromSearch` to the `./lightingRig` import.

Note — redraw on tier change needs nothing extra: `StudioLighting`'s refit effect depends on `mapSize`, which changes with the tier, and it calls `markShadowsDirty()`.

- [ ] **Step 3: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 4: Check the tiers**

`/en/planner?quality=high`: shadows sharper (2048²), floor pools gone. `?quality=low`: 1024², pools present. No param on a desktop: starts `low`, moves to `high` within a few seconds (confirm by the pools vanishing).

---

### Task 9: Ambient occlusion on the `high` tier

**Files:**
- Modify: `package.json` / `pnpm-lock.yaml` (via pnpm)
- Create: `src/components/planner/HighQualityEffects.tsx`
- Modify: `src/components/planner/PlannerScene.tsx`

- [ ] **Step 1: Install**

Run: `pnpm add @react-three/postprocessing postprocessing`
Expected: `@react-three/postprocessing` 3.x and `postprocessing` 6.36+ in `dependencies`; no peer warnings about `three` or `@react-three/fiber`.

- [ ] **Step 2: Create `HighQualityEffects.tsx`**

```tsx
"use client";

import { EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

/**
 * Ambient occlusion for devices that measured fast enough — the dark creases
 * where a cabinet meets the wall, the floor and its neighbour, which is most of
 * what makes a render read as a photograph.
 *
 * Default export and imported only through `React.lazy`, so the postprocessing
 * code is its own chunk and a phone on the `low` tier never downloads it.
 *
 * The composer renders the scene into an offscreen target, and three only tone
 * maps when drawing to the screen, so tone mapping is re-applied here as the
 * last effect — the same Neutral curve `StudioLighting` sets, or the `high`
 * tier's colours would not match `low`'s.
 */
export default function HighQualityEffects() {
	return (
		<EffectComposer multisampling={4}>
			<N8AO halfRes aoRadius={0.4} distanceFalloff={1} intensity={2} />
			<ToneMapping mode={ToneMappingMode.NEUTRAL} />
		</EffectComposer>
	);
}
```

- [ ] **Step 3: Load it lazily on `high`**

In `PlannerScene.tsx`, at module level after the imports:

```tsx
/** Only the `high` tier downloads this — see `HighQualityEffects`. */
const HighQualityEffects = lazy(() => import("./HighQualityEffects"));
```

Add `lazy` and `Suspense` to the `react` import. Inside `<Canvas>`, after `<PerformanceMonitor …/>`:

```tsx
			{quality === "high" && (
				<Suspense fallback={null}>
					<HighQualityEffects />
				</Suspense>
			)}
```

- [ ] **Step 4: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass. In the `pnpm build` output, confirm `postprocessing` is not in the planner route's first-load JS (it lands in a separate async chunk).

- [ ] **Step 5: Check by eye and on the network tab**

- `?quality=high`: soft darkening in the creases (cabinet/wall, cabinet/floor, between neighbours, under wall units). The network tab shows the postprocessing chunk load.
- `?quality=low`: no postprocessing chunk requested.
- Colours on `high` match `low` side by side. If `high` looks washed out or double-contrasted, tone mapping is applied twice: remove the `<ToneMapping>` effect and re-check.
- Overlays on `high` (selection outline, move handle, measure glyphs and lines, pan puck) are not darkened or haloed. If they are, add `depthWrite={false}` to the affected overlay material and re-check; record which ones in the final report.
- Tune `aoRadius` (0.2–0.6) and `intensity` (1–3) until the creases are visible but not dirty.

---

### Task 10: CLAUDE.md rule change

**Files:**
- Modify: `CLAUDE.md` (the "Mobile performance rules" list)

- [ ] **Step 1: Replace the rule**

Replace the line:

```markdown
- No real-time shadows. One directional light, one ambient, one soft blurred plane beneath the unit
```

with:

```markdown
- **Lighting is `components/planner/Lighting.tsx`, and nothing else adds a light.** One shadow-casting key light, near-overhead so every wall's cabinets are lit alike; an environment from drei `Lightformer`s rendered once (`frames={1}`) — never an HDR file; Khronos PBR Neutral tone mapping, so a finish renders as the colour the admin typed. UI and overlay materials set `toneMapped={false}`.
- **The shadow map is redrawn on change, never per frame.** `SHADOW_MAP` has `autoUpdate: false`; anything that moves a caster calls `markShadowsDirty()` (`lightingRig.ts`) — layout edits, a drag, a door animating, a drafted mesh arriving. Orbiting needs nothing, since the light is fixed in the world. Set shadow-map options through the Canvas `shadows` prop only: R3F re-applies it on every Canvas render.
- **Two quality tiers, `low` and `high`, chosen by measured frame rate** (`PerformanceMonitor`, never user-agent). `high` adds a 2048² shadow map and N8AO ambient occlusion from `HighQualityEffects.tsx`, which is lazy-loaded so a `low` device never downloads postprocessing. `?quality=high|low` forces a tier in development.
- **A captured screenshot renders at `high`** regardless of the device's tier — it is the image that goes out over WhatsApp. (Capture is not built yet; whoever builds it owns this.)
```

- [ ] **Step 2: Gate**

Run: `pnpm lint`
Expected: pass.

---

### Task 11: Phase 2 verification

**Files:** none

- [ ] **Step 1: After screenshots**

Repeat Task 1 Steps 2–3 at `?quality=low` and `?quality=high`, saving `after2-low-*.png` and `after2-high-*.png`. Compare with the baselines and with `after1-*`.

- [ ] **Step 2: Functional regression pass**

Repeat Task 4 Step 2 in full, on both tiers. Also: in elevation and plan views, check whether shadows or AO clutter the technical drawing. If they do, report it to the user with screenshots rather than deciding alone — the spec allows switching them off in those views, but it is a visible change.

- [ ] **Step 3: Performance**

Repeat Task 1 Step 4 at `?quality=low`. Pass: idle orbit within noise of `baseline.txt`; drag at ≥ ~30 fps (≤ 33 ms/frame). Record the numbers for the PR description.

- [ ] **Step 4: Gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass.

- [ ] **Step 5: Hand back**

Report to the user: what changed, the tuned constants, the frame-time numbers, the screenshot paths, any overlay needing `depthWrite={false}`, and the elevation/plan call if one arose. The user commits and pushes.
