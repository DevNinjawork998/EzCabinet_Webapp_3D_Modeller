"use client";

import { OrbitControls, Shadow } from "@react-three/drei";
import {
	Canvas,
	type ThreeEvent,
	useFrame,
	useThree,
} from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	Group,
	Object3D,
	PerspectiveCamera,
	Vector3 as Vector3Type,
} from "three";
import {
	Matrix4,
	type Mesh,
	type MeshBasicMaterial,
	Plane,
	type PlaneGeometry,
	Ray,
	Raycaster,
	Vector2,
	Vector3,
} from "three";
import { captureError } from "@/lib/analytics";
import {
	panSpaceFor,
	panTargetMm,
	type RoomBoundsMm,
} from "@/lib/planner/camera";
import {
	CEILING_TRIM_MM,
	type Construction,
	constructionOf,
	doorStyleIn,
	type FinishId,
	WALL_GAP_MM,
	WORKTOP_COLOR,
} from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import {
	type ExposedSides,
	type SideGaps,
	sideGapsMm,
} from "@/lib/planner/exposure";
import {
	type FloorPlan,
	floorPointFromRay,
	frameOf,
	nearestWall,
	toLocalMm,
	toWorldMm,
	transferTarget,
	type WallFrame,
	wallsOf,
} from "@/lib/planner/floorplan";
import {
	canHangAt,
	type HingeSide,
	inRun,
	type PlannerEngine,
	type PlannerLayout,
	type Positioned,
	type Span,
} from "@/lib/planner/layout";
import {
	apertureMm,
	constrainToAxis,
	type MeasureAxis,
	type SnapPoint,
	snapToCabinet,
	type Vec3Mm,
} from "@/lib/planner/measure";
import {
	cornerAt,
	cornerSpans,
	type RoomLayout,
	runView,
	withRun,
} from "@/lib/planner/room";
import { Cabinet } from "./Cabinet";
import { useCatalogue, useEngine, useRoomEngine } from "./CatalogueContext";
import { designPartBoxes, peekDesignMesh } from "./DesignedCabinet";
import { useFrontSurface, useGrain } from "./grain";
import {
	HANDLE_HEAD_R,
	HANDLE_HEAD_TIP,
	handleCentreM,
	PUCK_LIFT,
} from "./handle";
import { MeasureOverlay } from "./MeasureOverlay";
import { PositionDimensions } from "./PositionDimensions";
import { Room } from "./Room";
import { WallLengths, WallNumbers } from "./WallLengths";

const m = (mm: number) => mm / 1000;

/** How far a worktop stands proud of the carcass fronts under it. */
const WORKTOP_OVERHANG_MM = 20;

/**
 * The three ways to look at a run. `3d` is the selling angle; the other two
 * are the drawings a fitter actually works from, which is why the toggle
 * exists — a customer checking whether the run clears a window wants a
 * straight-on elevation, not a perspective view that foreshortens it.
 *
 * They are camera positions only. The geometry is identical in all three, so
 * nothing here can disagree with what gets quoted.
 */
export type PlannerView = "3d" | "elevation" | "plan";

/** Looking into the corner, the angle a kitchen elevation is usually sold at. */
const VIEW_DIRECTION: Record<PlannerView, Vector3> = {
	"3d": new Vector3(0.25, 0.42, 1).normalize(),
	elevation: new Vector3(0, 0, 1),
	// Not exactly straight down: OrbitControls gimbal-locks looking along its
	// own up axis, and a hair of tilt is cheaper than a custom controls rig.
	plan: new Vector3(0, 1, 0.02).normalize(),
};

/**
 * Where this pointer ray crosses the vertical plane the cabinet stands in.
 *
 * `xMm` is along the run from its left end; `yMm` is height above the floor.
 *
 * The plane has to be the cabinet's own, not the floor. A wall unit hangs a
 * metre and a half up against the back wall, and the same ray reaches the
 * floor a long way in front of it — dragging against the floor plane
 * therefore moves the cabinet at a different rate from the cursor, and the
 * further the camera tilts the worse it gets.
 *
 * Read off the ray rather than `e.point`, which is wherever the ray happened
 * to strike a mesh and would offset the grab by the height of the door it hit.
 */
/** A ray this close to parallel with a drag plane (the component of its unit
 * direction along the plane's normal)… */
const GRAZING_DIRECTION = 0.25;
/** …or an eye this close to the plane, in metres, crosses it too unsteadily
 * to drag against. Shared by the cabinet's own plane and the level fallback. */
const GRAZING_DISTANCE_M = 0.3;

function runPointFromRay(
	ray: Ray,
	planeZ: number,
	runWidthMm: number,
	/** Solve against the level plane at this height (m) instead — see
	 * `seenEdgeOn`. `null` for the cabinet's own vertical plane. */
	levelY: number | null,
): { xMm: number; yMm: number } | null {
	const { origin, direction } = ray;
	// No usable crossing — parallel, or behind the eye — keeps the cabinet where
	// it last was rather than throwing it across the room.
	const [along, from, to] =
		levelY === null
			? [direction.z, origin.z, planeZ]
			: [direction.y, origin.y, levelY];
	if (Math.abs(along) < 1e-6) return null;
	// The level plane is only a fallback, and it can be as badly placed as the
	// plane it stands in for: in a flat view the eye sits about at grab
	// height, so a grazing crossing turns a pixel into a metre of run.
	if (
		levelY !== null &&
		(Math.abs(direction.y) < GRAZING_DIRECTION ||
			Math.abs(origin.y - levelY) < GRAZING_DISTANCE_M)
	) {
		return null;
	}
	const t = (to - from) / along;
	if (t <= 0) return null;
	return {
		xMm: (origin.x + direction.x * t) * 1000 + runWidthMm / 2,
		yMm: (levelY ?? origin.y + direction.y * t) * 1000,
	};
}

/**
 * Whether a run's drag plane is seen too nearly edge-on to solve against.
 *
 * The default 3D camera stands a few centimetres from a right-hand side run's
 * plane, and there every crossing collapses onto the eye's own position: the
 * cabinet jumped to the open front of the room. The same happens to any run
 * whose plane the ray grazes. Then the drag reads the level plane through the
 * point grabbed — it loses the lift, which an edge-on view cannot show anyway.
 * Decided once per grab, so a drag never switches planes mid-gesture.
 */
const seenEdgeOn = (ray: Ray, planeZ: number) =>
	Math.abs(ray.origin.z - planeZ) < GRAZING_DISTANCE_M ||
	Math.abs(ray.direction.z) < GRAZING_DIRECTION;

/**
 * The same solve turned on its side: where the pointer's ray crosses a
 * *horizontal* plane, in world millimetres.
 *
 * A rotation is a bearing in plan — how far round the cabinet the finger has
 * gone — and the run's own vertical plane cannot see that. It is the one
 * gesture in the scene that reads the pointer's z.
 */
function planPointFromRay(
	ray: Ray,
	planeY: number,
): { xMm: number; zMm: number } {
	const { origin, direction } = ray;
	// Looking level along the floor there is no crossing to find.
	const t =
		Math.abs(direction.y) < 1e-6 ? 0 : (planeY - origin.y) / direction.y;
	return {
		xMm: (origin.x + direction.x * t) * 1000,
		zMm: (origin.z + direction.z * t) * 1000,
	};
}

/** Scratch for a drag's pointer moves — see `onDragMove` in `Run`. */
const DRAG_RAYCASTER = new Raycaster();
const DRAG_NDC = new Vector2();

/** Scratch for `localRay`: a pointer move must not allocate. */
const LOCAL_RAY = new Ray();
const UNTURN = new Matrix4();
const UNMOVE = new Matrix4();

/**
 * A world ray expressed in a run's own frame: undo the frame's move, then its
 * turn. A rectangle's runs are only turned, and the back wall neither, so that
 * case returns the ray as is. The result is a shared scratch — read it straight
 * away, never keep it.
 */
function localRay(ray: Ray, frame: WallFrame): Ray {
	if (frame.yawRad === 0 && frame.xMm === 0 && frame.zMm === 0) return ray;
	UNTURN.makeRotationY(-frame.yawRad).multiply(
		UNMOVE.makeTranslation(-m(frame.xMm), 0, -m(frame.zMm)),
	);
	return LOCAL_RAY.copy(ray).applyMatrix4(UNTURN);
}

/**
 * The pointer's bearing about a point in plan, in degrees, in the same sense a
 * `rotation.y` turns: a group yawed by θ sends its own +z to (sinθ, 0, cosθ),
 * so the bearing of a direction is `atan2(x, z)`.
 */
const bearingDeg = (dxMm: number, dzMm: number) =>
	(Math.atan2(dxMm, dzMm) * 180) / Math.PI;

function FitCamera({
	runWidthMm,
	roomDepthMm,
	ceilingHeightMm,
	planWidthMm,
	planDepthMm,
	view,
	frame,
	refitKey,
}: {
	runWidthMm: number;
	roomDepthMm: number;
	ceilingHeightMm: number;
	/** The floor plan's bounding box — what the plan view frames. */
	planWidthMm: number;
	planDepthMm: number;
	view: PlannerView;
	/** The targeted wall's run frame: what 3D and elevation look at. */
	frame: WallFrame;
	/** Bumped to re-frame on demand — what "reset view" does. */
	refitKey: number;
}) {
	const camera = useThree((s) => s.camera) as PerspectiveCamera;
	const controls = useThree((s) => s.controls) as {
		target: Vector3Type;
		update: () => void;
	} | null;
	const aspect = useThree((s) => s.size.width / s.size.height);

	// Read through a ref, deliberately. These change as the customer builds,
	// and refitting on them would throw away a pan the moment another cabinet
	// went in — the framing has an owner now, and it is the customer.
	const framing = useRef({
		runWidthMm,
		roomDepthMm,
		ceilingHeightMm,
		aspect,
		frame,
		planWidthMm,
		planDepthMm,
	});
	framing.current = {
		runWidthMm,
		roomDepthMm,
		ceilingHeightMm,
		aspect,
		frame,
		planWidthMm,
		planDepthMm,
	};

	// Elevation is a drawing of one wall, so tapping another wall redraws it.
	// The 3D view keeps the customer's framing until they ask for a reset.
	const elevationWall =
		view === "elevation" ? `${frame.yawRad}:${frame.xMm}:${frame.zMm}` : "";

	// `refitKey` and `elevationWall` are triggers, not inputs — nothing in here
	// reads them, and that is the point: bumping one is how a refit is asked for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const {
			runWidthMm,
			roomDepthMm,
			ceilingHeightMm,
			aspect,
			frame,
			planWidthMm,
			planDepthMm,
		} = framing.current;
		const width = m(runWidthMm);
		const height = m(ceilingHeightMm);
		const depth = m(roomDepthMm);
		const halfFovV = (camera.fov * Math.PI) / 360;
		const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
		// Only the axes actually facing the camera should decide the zoom.
		// Including all three in the flat views frames a diagonal nothing is
		// on, which reads as the drawing sitting in a corner of a mostly empty
		// canvas.
		let centre: Vector3;
		let direction: Vector3;
		let radius: number;
		if (view === "plan") {
			// The whole floor plan, from above, back wall at the top.
			centre = new Vector3(0, 0, 0);
			direction = VIEW_DIRECTION.plan;
			radius = Math.hypot(m(planWidthMm), m(planDepthMm)) / 2;
		} else {
			// Framed in the target wall's own frame, then carried into the room's.
			const c = toWorldMm({ x: 0, y: ceilingHeightMm / 2.2, z: 0 }, frame);
			centre = new Vector3(m(c.x), m(c.y), m(c.z));
			direction = VIEW_DIRECTION[view]
				.clone()
				.applyAxisAngle(new Vector3(0, 1, 0), frame.yawRad);
			radius =
				view === "elevation"
					? Math.hypot(width, height) / 2
					: Math.hypot(width, height, depth) / 2;
		}
		const distance = (radius / Math.sin(Math.min(halfFovV, halfFovH))) * 0.95;

		camera.position.copy(centre).addScaledVector(direction, distance);
		camera.near = 0.1;
		camera.far = distance * 6;
		camera.updateProjectionMatrix();

		if (controls) {
			controls.target.copy(centre);
			controls.update();
		}
	}, [view, refitKey, camera, controls, elevationWall]);

	return null;
}

/** How fast the camera closes on a released puck. Higher is snappier; this is
 * roughly a quarter-second glide, long enough to read as travel and short
 * enough not to feel like waiting. */
const GLIDE_RATE = 9;

/**
 * Where the puck rests: on the floor, directly under the point the camera is
 * looking at.
 *
 * Elevation is the exception, and has to be. A straight-on drawing shows the
 * floor edge-on as a sliver at the bottom of the frame, so a puck lying on it
 * would be an unusable ellipse — and the pan an elevation needs is up and down
 * the wall, which no point on the floor can express. There it rests on the
 * plane of the run instead.
 */
function panAnchor(target: Vector3Type, view: PlannerView, out: Vector3) {
	return view === "elevation"
		? out.copy(target)
		: out.set(target.x, PUCK_LIFT, target.z);
}

/**
 * Which axes the puck moves the camera in, per view: the two axes of the
 * surface it is sliding on.
 *
 * On the floor that is across the run and into the room — the puck goes
 * anywhere on the floor, which is the whole point of it being a thing lying on
 * the floor. In elevation it is across the wall and up it.
 *
 * The height of a floor drag, and the depth of an elevation drag, are the
 * target's own. That is what keeps a floor drag a drag *across the floor*
 * rather than a camera that dives at it.
 *
 * This was briefly restricted to one axis in 3D, on the theory that depth put
 * the camera behind the run looking at carcass backs. That did happen, but the
 * cause was a stuck drag piling up pans, not the axis: with the target clamped
 * inside the room, panning in depth cannot reach anywhere orbit does not
 * already go, because orbit's azimuth is unrestricted.
 */
const PAN_AXES: Record<PlannerView, { x: boolean; y: boolean; z: boolean }> = {
	"3d": { x: true, y: false, z: true },
	elevation: { x: true, y: true, z: false },
	plan: { x: true, y: false, z: true },
};

/** The surface the puck slides on, which is the same choice again: the floor,
 * or in elevation the plane of the targeted wall's run. */
const panPlane = (target: Vector3Type, view: PlannerView, yawRad: number) => {
	if (view !== "elevation") return new Plane(new Vector3(0, 1, 0), -PUCK_LIFT);
	const normal = new Vector3(Math.sin(yawRad), 0, Math.cos(yawRad));
	return new Plane(normal, -normal.dot(target));
};

/** Scratch vectors for the glide and the drag below. Allocating one per frame
 * is how a scene starts stuttering on the phones this app targets. */
const PUCK_WAS = new Vector3();
const PUCK_ANCHOR = new Vector3();

/**
 * The camera's own handle: a puck on the floor. Drag it somewhere and the view
 * travels there.
 *
 * Orbiting alone is not enough once a run outgrows the frame. You can spin
 * around a four-metre kitchen all day and never get the far end on screen,
 * because rotation moves the eye and never the point it is looking at — which
 * is exactly the complaint this answers.
 *
 * Why a gizmo rather than `enablePan` on OrbitControls: pan there is a
 * right-drag on desktop and a two-finger drag on touch, and neither is
 * discoverable on the mid-range Android this app is built for. A thing you can
 * see and press is.
 *
 * **The camera holds still for the whole drag and only travels on release.**
 * That is what lets the puck be a thing on the floor. Panning live would mean
 * moving the point the camera looks at, and the puck marks that point — so it
 * would be pinned to the centre of the frame and could never slide anywhere,
 * which is precisely what the first cut got wrong. Drag the puck, let go, the
 * view comes to it.
 *
 * Blue, to keep it apart from the green `MoveHandle` that moves a cabinet, and
 * drawn with depth testing off so a carcass standing between it and the camera
 * cannot swallow the only affordance on screen.
 */
function PanGizmo({
	bounds,
	view,
	frame,
	refitKey,
}: {
	bounds: RoomBoundsMm;
	view: PlannerView;
	/** The frame the pan is masked and clamped in — the targeted wall's, or
	 * the plan's own in plan view (see `panSpaceFor`) — and in elevation the
	 * wall the single-sided puck faces. */
	frame: WallFrame;
	/** Same trigger `FitCamera` refits on. Watched here only to abandon a
	 * journey the refit has just overruled. */
	refitKey: number;
}) {
	const camera = useThree((s) => s.camera);
	const gl = useThree((s) => s.gl);
	const controls = useThree((s) => s.controls) as {
		target: Vector3Type;
		enabled: boolean;
		update: () => void;
	} | null;
	const ref = useRef<Group>(null);
	// The surface fixed at grab time, and the offset from the pointer's hit on
	// it to the puck's own centre — so pressing near the puck's edge slides it
	// from where it is rather than snapping it under the cursor.
	const drag = useRef<{ plane: Plane; grip: Vector3 } | null>(null);
	// Where the puck is. Not React state: it changes with every pointer move
	// and every frame of a glide, and re-rendering the scene graph that often
	// is the mobile budget's problem rather than its solution.
	const spot = useRef(new Vector3());
	// Where the camera is heading, while it is heading there.
	const glide = useRef<Vector3 | null>(null);
	const [grabbed, setGrabbed] = useState(false);

	const boundsRef = useRef(bounds);
	boundsRef.current = bounds;
	const frameRef = useRef(frame);
	frameRef.current = frame;

	/** A world point the puck was dragged to, masked to this view's axes and
	 * clamped to the room — both in the target wall's frame, where the axes and
	 * `clampPanTarget`'s box mean something — and carried back out. */
	const panTo = useCallback(
		(point: Vector3Type, anchor: Vector3Type, out: Vector3Type) => {
			const w = panTargetMm(
				{ x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 },
				{ x: anchor.x * 1000, y: anchor.y * 1000, z: anchor.z * 1000 },
				PAN_AXES[view],
				frameRef.current,
				boundsRef.current,
			);
			return out.set(m(w.x), m(w.y), m(w.z));
		},
		[view],
	);

	// `FitCamera` re-frames on exactly these, and a glide still in flight would
	// then drag the camera back off the framing it had just been given — a view
	// switch a moment after letting go of the puck landed an elevation a few
	// degrees off square, which is the one thing an elevation must not be.
	// biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not inputs
	useEffect(() => {
		glide.current = null;
	}, [view, refitKey]);

	useFrame((_, delta) => {
		if (!controls) return;

		const goal = glide.current;
		if (goal) {
			// Exponential ease, framerate-independent. The camera moves by
			// whatever the target actually moved, so the viewing angle and the
			// distance come through the journey untouched.
			PUCK_WAS.copy(controls.target);
			controls.target.lerp(goal, Math.min(1, delta * GLIDE_RATE));
			camera.position.add(controls.target).sub(PUCK_WAS);
			controls.update();
			if (controls.target.distanceToSquared(goal) < 1e-6) {
				controls.target.copy(goal);
				glide.current = null;
			}
		}

		const group = ref.current;
		if (!group) return;
		// The puck owns its position while a drag or a glide is in flight; the
		// rest of the time it is wherever the camera is looking. That is what
		// re-centres it after an orbit or a zoom without any bookkeeping.
		if (!drag.current && !glide.current) {
			panAnchor(controls.target, view, spot.current);
		}
		group.position.copy(spot.current);
		// Scale with distance so it is the same size on screen zoomed in or out.
		group.scale.setScalar(camera.position.distanceTo(spot.current) / 4);
	});

	const release = useCallback(() => {
		if (!drag.current) return;
		drag.current = null;
		setGrabbed(false);
		if (!controls) return;
		controls.enabled = true;
		// Only the axes this view hands over; the target keeps its own value in
		// the rest. That is what makes a floor drag a *sideways* pan rather than
		// a camera that dives at the floor every time it moves.
		glide.current = panTo(spot.current, controls.target, new Vector3());
	}, [controls, panTo]);

	useEffect(() => {
		const el = gl.domElement;
		const raycaster = new Raycaster();
		const ndc = new Vector2();
		const hit = new Vector3();

		const onMove = (event: PointerEvent) => {
			const current = drag.current;
			if (!current) return;
			const rect = el.getBoundingClientRect();
			ndc.set(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1,
			);
			raycaster.setFromCamera(ndc, camera);
			if (!raycaster.ray.intersectPlane(current.plane, hit)) return;
			hit.add(current.grip);
			// Masked and clamped as it slides, not on release: a puck that can be
			// dragged somewhere the camera will not follow is a promise the
			// release breaks.
			if (!controls) return;
			panAnchor(controls.target, view, PUCK_ANCHOR);
			panTo(hit, PUCK_ANCHOR, spot.current);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", release);
		// The belt to that braces: whatever takes the capture away — another
		// element grabbing it, the tab hiding — ends the drag.
		el.addEventListener("lostpointercapture", release);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", release);
			el.removeEventListener("lostpointercapture", release);
			// A gesture can end with this unmounting mid-drag. Orbiting has to
			// come back either way.
			if (controls) controls.enabled = true;
		};
	}, [camera, gl, controls, view, release, panTo]);

	const grab = (e: ThreeEvent<PointerEvent>) => {
		e.stopPropagation();
		if (!controls) return;
		// Capture the pointer, and stop the browser from starting a drag of its
		// own. Without this the press can turn into an HTML5 drag — the palette
		// next to the canvas uses one, so the machinery is right there — and a
		// native drag delivers `dragend`, never `pointerup`. The release below
		// then never runs: orbiting stays switched off, the drag stays open, and
		// every later pointer move anywhere on the page keeps sliding the puck.
		// It looked like elevation "not panning"; it was one lost pointerup.
		e.nativeEvent.preventDefault();
		gl.domElement.setPointerCapture(e.nativeEvent.pointerId);
		// Synchronously, not from an effect: a frame later and OrbitControls has
		// already claimed the pointer, so the camera spins instead of the puck
		// sliding — the same lesson `Run` records for the cabinet drag.
		controls.enabled = false;
		// Grabbing it again mid-journey takes it over rather than fighting it.
		glide.current = null;
		const plane = panPlane(controls.target, view, frameRef.current.yawRad);
		const hit = new Vector3();
		if (!e.ray.intersectPlane(plane, hit)) {
			controls.enabled = true;
			return;
		}
		// Allocated per grab, not per frame — a gesture starts far less often
		// than sixty times a second.
		drag.current = { plane, grip: new Vector3().subVectors(spot.current, hit) };
		setGrabbed(true);
	};

	const colour = grabbed ? "#1b4f9c" : "#2f6fd0";

	/*
	 * Every layer is `transparent` with an explicit `renderOrder`, and both
	 * halves of that matter. With `depthTest` off the local z-offsets below
	 * decide nothing, so order is all there is — and three renders the whole
	 * opaque list before the transparent one, so an opaque arrow can never
	 * land on top of a translucent disc no matter what order it is given. The
	 * first cut had exactly that bug: a white blob with the arrows buried
	 * underneath it.
	 */
	return (
		<group
			ref={ref}
			onPointerDown={grab}
			// Lying on the floor, except in elevation, where it faces the camera
			// from the targeted wall.
			rotation={
				view === "elevation" ? [0, frame.yawRad, 0] : [-Math.PI / 2, 0, 0]
			}
		>
			<mesh renderOrder={20}>
				<circleGeometry args={[0.115, 32]} />
				<meshBasicMaterial
					color="#ffffff"
					transparent
					opacity={0.95}
					depthTest={false}
				/>
			</mesh>
			<mesh position={[0, 0, 0.001]} renderOrder={21}>
				<ringGeometry args={[0.105, 0.115, 32]} />
				<meshBasicMaterial color={colour} transparent depthTest={false} />
			</mesh>
			{/* Both bars and all four heads: unlike the cabinet handle, this one
			    always moves in two axes. */}
			<mesh position={[0, 0, 0.002]} renderOrder={22}>
				<planeGeometry args={[0.13, 0.014]} />
				<meshBasicMaterial color={colour} transparent depthTest={false} />
			</mesh>
			<mesh position={[0, 0, 0.002]} renderOrder={22}>
				<planeGeometry args={[0.014, 0.13]} />
				<meshBasicMaterial color={colour} transparent depthTest={false} />
			</mesh>
			{[0, Math.PI / 2, Math.PI, -Math.PI / 2].map((angle) => (
				<mesh
					key={angle}
					position={[Math.cos(angle) * 0.075, Math.sin(angle) * 0.075, 0.002]}
					rotation={[0, 0, angle - Math.PI / 2]}
					renderOrder={22}
				>
					<circleGeometry args={[0.022, 3]} />
					<meshBasicMaterial color={colour} transparent depthTest={false} />
				</mesh>
			))}
		</group>
	);
}

/**
 * Exposes a screen-to-run-position reading to the HTML around the canvas, so a
 * cabinet dragged out of the palette lands where it was dropped. The palette
 * uses HTML drag events, which never reach the canvas as pointer events — this
 * is the one bridge between the two.
 */
function DropPicker({
	plan,
	pickerRef,
}: {
	plan: FloorPlan;
	pickerRef: React.RefObject<
		| ((
				clientX: number,
				clientY: number,
		  ) => { run: number; xMm: number } | null)
		| null
	>;
}) {
	const camera = useThree((s) => s.camera);
	const gl = useThree((s) => s.gl);

	useEffect(() => {
		pickerRef.current = (clientX, clientY) => {
			const rect = gl.domElement.getBoundingClientRect();
			const point = new Vector3(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1,
				0.5,
			).unproject(camera);
			const direction = point.sub(camera.position).normalize();
			// Read against the floor: only the wall and the position along it
			// matter, and which row the cabinet joins is decided by what was
			// dragged.
			const floor = floorPointFromRay(
				{
					x: camera.position.x * 1000,
					y: camera.position.y * 1000,
					z: camera.position.z * 1000,
				},
				{ x: direction.x * 1000, y: direction.y * 1000, z: direction.z * 1000 },
			);
			return floor && nearestWall(plan, floor);
		};
		return () => {
			pickerRef.current = null;
		};
	}, [camera, gl, plan, pickerRef]);

	return null;
}

/**
 * Answers "which cabinet is under this screen point?" for the HTML layer.
 *
 * Dropping a door needs a real raycast, not the run-position maths `DropPicker`
 * does: a door lands on one specific carcass, and the cabinets are at different
 * depths and heights. Each cabinet group carries its id in `userData`, so the
 * first hit walks up to find whose it was.
 */
function CabinetHitTest({
	hitTestRef,
}: {
	hitTestRef: React.RefObject<
		((clientX: number, clientY: number) => string | null) | null
	>;
}) {
	const camera = useThree((s) => s.camera);
	const gl = useThree((s) => s.gl);
	const scene = useThree((s) => s.scene);

	useEffect(() => {
		const raycaster = new Raycaster();
		const ndc = new Vector2();

		hitTestRef.current = (clientX, clientY) => {
			const rect = gl.domElement.getBoundingClientRect();
			ndc.set(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1,
			);
			raycaster.setFromCamera(ndc, camera);

			for (const hit of raycaster.intersectObjects(scene.children, true)) {
				for (let node: Object3D | null = hit.object; node; node = node.parent) {
					const id = node.userData?.moduleId;
					if (typeof id === "string") return id;
				}
			}
			return null;
		};

		return () => {
			hitTestRef.current = null;
		};
	}, [camera, gl, scene, hitTestRef]);

	return null;
}

/**
 * The run itself, and the dragging of it.
 *
 * Two things here are deliberate and both were learned the hard way in
 * `PlacementControls`:
 *
 * - OrbitControls is disabled **synchronously** in the pointer-down handler.
 *   Doing it from an effect runs a frame too late, by which point the orbit
 *   gesture has already claimed the pointer and the camera swings instead of
 *   the cabinet.
 * - The drag plane is always mounted, and the dragged id lives in a ref.
 *   Mounting the plane in response to a state update puts it on screen a frame
 *   after the pointer went down, so the first moves land on nothing.
 */
function Run({
	layout,
	frame,
	plan,
	runIndex,
	corners,
	filledSpans,
	exposure,
	shutSides,
	cornerWorktop,
	catalogue,
	engine,
	finishHex,
	finishPhoto,
	selectedIds,
	openIds,
	doorsHidden,
	doorTargetId,
	measureMode,
	measureAxis,
	measureAnchor,
	onLayoutChange,
	onSelect,
	onMeasurePick,
	onMeasureHover,
	onDragPreview,
	onTransfer,
	construction,
}: {
	layout: PlannerLayout;
	/** Where this run's group stands — see `localRay`. */
	frame: WallFrame;
	/** The whole room's outline — what a cross-room drag is read against. */
	plan: FloorPlan;
	/** This run's own wall, so a drop on it is never read as a transfer. */
	runIndex: number;
	/** Corner units at this run's start. Selectable, never dragged. */
	corners: Positioned[];
	/** The corner squares along this run that hold a unit, per row. A filled
	 * square is a neighbour a door beside it must not swing into. */
	filledSpans: Record<"floor" | "wall", Span[]>;
	/** The room's answer, not this run's: a corner unit covers the end beside it. */
	exposure: Map<string, ExposedSides>;
	/** Which cabinets have a leaf that cannot open, and on which side, because
	 * the other run hinges a leaf into the same corner. The room's answer too —
	 * a run cannot see the wall it meets. */
	shutSides: Map<string, HingeSide>;
	/** The worktop square at this run's start corner, if it has one. */
	cornerWorktop: { sizeMm: number; topMm: number } | null;
	/** The published catalogue, resolved outside the canvas: `Run` renders
	 * inside `<Canvas>`, a separate reconciler root the outer React context
	 * does not reach. */
	catalogue: PlannerCatalogue;
	/** Likewise the engine built from it. */
	engine: PlannerEngine;
	finishHex: string;
	/** The uploaded decor photo for this finish, if the client has supplied one. */
	finishPhoto: string | null;
	selectedIds: ReadonlySet<string>;
	/** The cabinets whose doors are swung open. */
	openIds: ReadonlySet<string>;
	/** Take the fronts off entirely — the whole-run interior view. */
	doorsHidden: boolean;
	/** The carcass a door is currently being dragged over, if any. */
	doorTargetId: string | null;
	/** While true, clicking a cabinet picks a measurement point instead of
	 * selecting or dragging it. */
	measureMode: boolean;
	/** Which axis the second pick is constrained to. */
	measureAxis: MeasureAxis;
	/** The first picked point, once there is one — what the lock measures from.
	 * `null` while the first point is still being placed, since there is
	 * nothing to constrain against yet. */
	measureAnchor: Vec3Mm | null;
	onLayoutChange: (next: PlannerLayout) => void;
	/** `additive` comes from shift/ctrl/cmd: add to the selection rather than
	 * replace it. `null` clears. */
	onSelect: (id: string | null, additive: boolean) => void;
	onMeasurePick: (snap: SnapPoint) => void;
	/** What the measuring tool would pick right now, so the overlay can show it
	 * before the click commits. `null` once the pointer leaves. */
	onMeasureHover: (snap: SnapPoint | null) => void;
	/** The wall a cabinet mid-drag would land on if released now, or `null` —
	 * for the preview tint. Fires only when the candidate changes. */
	onDragPreview: (run: number | null) => void;
	/** A `move` drag was released nearer another wall than its own: hand it
	 * over instead of settling it on this one. */
	onTransfer: (id: string, run: number, xMm: number) => void;
	/** Resolved outside the canvas and passed in: `Run` renders inside
	 * `<Canvas>`, which is its own reconciler root. */
	construction: Construction;
}) {
	const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
	const camera = useThree((s) => s.camera);
	const gl = useThree((s) => s.gl);
	const viewportHeightPx = useThree((s) => s.size.height);
	const {
		allPositions,
		dragModule,
		dropModule,
		floorHeightMmOf,
		overhangingIds,
		positionsOf,
		setRotation,
	} = engine;

	/**
	 * The snap under this pointer event.
	 *
	 * `e.point` is already in the scene's outer world space — the same space the
	 * picked points are stored and rendered in — so no group-offset math is
	 * needed, only a millimetre conversion.
	 *
	 * The tolerance comes from `e.distance`, the camera's own distance to what
	 * the ray hit, so the aperture is a constant number of *pixels* rather than
	 * a constant number of millimetres. A fixed world tolerance is the reason
	 * picks used to land in odd places: too small to catch anything when the
	 * camera is pulled back over a full run, too coarse when zoomed into one
	 * carcass.
	 */
	const snapAt = (
		e: ThreeEvent<PointerEvent>,
		position: Positioned,
	): SnapPoint => {
		// Snapped in the run's own frame, where the part boxes are, and handed
		// back in the world's, where the picked points are drawn.
		const hitMm: Vec3Mm = toLocalMm(
			{ x: e.point.x * 1000, y: e.point.y * 1000, z: e.point.z * 1000 },
			frame,
		);
		const fov = (camera as PerspectiveCamera).fov ?? 45;
		// A turned cabinet gets no snap targets at all — the point follows the
		// pointer instead. `cabinetBoundsMm` and every part box behind the snap
		// describe an axis-aligned box, and a rotated cabinet is not one; landing
		// a dimension line on that unrotated ghost would put a wrong number in
		// front of a customer, which is worse than making them aim by hand.
		//
		// ponytail: rotate the corners in `worldPartBoxes` if measuring turned
		// cabinets is ever asked for.
		if (position.placed.rotationDeg) {
			// "Face", "carcass": the ray did hit the cabinet, we simply cannot say
			// which board — the same report an unsnapped surface point makes.
			const free: SnapPoint = {
				point: toWorldMm(hitMm, frame),
				kind: "surface",
				role: "carcass",
			};
			return measureAnchor
				? {
						...free,
						point: constrainToAxis(measureAnchor, free.point, measureAxis),
					}
				: free;
		}
		// Snap against the drafted mesh when the scene is drawing one, so a
		// dimension line lands on the real shelf and the real door edge rather
		// than an idealised box behind them. Read synchronously — a handler
		// cannot await, and a mesh that has not arrived means procedural boxes
		// are what is on screen and therefore what should be snapped to.
		const design = designPartBoxes(
			peekDesignMesh(
				position.family.sizes.find((size) => size.widthMm === position.widthMm)
					?.meshDesignId,
			),
		);

		const snap = snapToCabinet(
			hitMm,
			position,
			layout,
			engine,
			apertureMm(e.distance, fov, viewportHeightPx),
			design,
			construction,
		);
		const worldSnap = { ...snap, point: toWorldMm(snap.point, frame) };

		// The lock is applied after the snap, not instead of it: you snap to the
		// corner you meant, then the constraint slides that point onto the axis
		// you are measuring along. Same order as picking a point with ORTHO on.
		return measureAnchor
			? {
					...worldSnap,
					point: constrainToAxis(measureAnchor, worldSnap.point, measureAxis),
				}
			: worldSnap;
	};
	/**
	 * The live drag: which cabinet, and where on it the pointer took hold.
	 *
	 * The grab offset is what stops the cabinet snapping its left edge to the
	 * cursor the moment you touch it. It is re-anchored on every settled move
	 * for this reason: push a cabinet into its neighbour and keep dragging,
	 * and without re-anchoring the pointer
	 * has to retrace every millimetre of that overshoot before the cabinet moves
	 * again, which reads as the cabinet sticking.
	 */
	const dragRef = useRef<
		| {
				/** Sliding and lifting: the pointer moves the cabinet. */
				mode: "move";
				id: string;
				grabMm: number;
				/**
				 * How far above the cabinet's underside the pointer took hold. The
				 * vertical twin of `grabMm`, and it exists for the same reason: without
				 * it a wall unit snaps its underside to the cursor the instant you
				 * touch it.
				 */
				grabYMm: number;
				/**
				 * Whether this grab may move the cabinet vertically. Decided once, at
				 * the grab, because it is a property of the affordance taken hold of:
				 * the handle offers both axes, the carcass only slides. Without it a
				 * sideways nudge on a wall unit's door re-hangs it by whatever the
				 * pointer wobbled.
				 */
				vertical: boolean;
				/** Run-frame z of the plane this cabinet lives in — see runPointFromRay. */
				planeZ: number;
				/** The level plane's height when the wall plane is seen edge-on, else
				 * `null` — see `seenEdgeOn`. */
				levelY: number | null;
		  }
		| {
				/** Turning: the pointer's bearing round the cabinet is the angle. */
				mode: "rotate";
				id: string;
				/** The cabinet's own centre in plan, world mm — what it turns about. */
				centreXMm: number;
				centreZMm: number;
				/** World height of the plane the bearing is read on, in metres. */
				planeY: number;
				/**
				 * Pointer bearing at the grab, minus the cabinet's angle at the grab.
				 * The same trick as `grabMm` one dimension over: without it the
				 * cabinet snaps its front round to the finger the instant you touch
				 * the ring.
				 */
				grabDeg: number;
		  }
		| null
	>(null);
	const [dragging, setDragging] = useState(false);
	/** The wall a `move` drag would transfer to if released now — read by
	 * `endDrag`, and mirrored to `onDragPreview` only when it changes, so a
	 * pointer move that lands on the same candidate wall costs no re-render. */
	const crossWallRef = useRef<{ run: number; xMm: number } | null>(null);
	/** The last run reported to `onDragPreview`, so a pointer move that lands
	 * on the same wall never calls it again. */
	const lastPreviewRunRef = useRef<number | null>(null);
	// Which cabinet the measuring tool is over right now, so it can glow the
	// same way a door-drag target does — the user needs to see which surface
	// a click is about to measure before committing to it.
	const [measureHoverId, setMeasureHoverId] = useState<string | null>(null);
	// Pointer moves outpace re-renders, so the handler reads the live layout
	// through a ref rather than a closed-over prop.
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const runWidthMm = layout.wallWidthMm;

	/** Take hold of a cabinet. The grab offset is what stops it snapping its
	 *  left edge to the pointer — see `dragRef`. */
	const beginDrag = (
		e: ThreeEvent<PointerEvent>,
		position: Positioned,
		planeZ: number,
		vertical = false,
	) => {
		const ray = localRay(e.ray, frame);
		const levelY = seenEdgeOn(ray, planeZ) ? e.point.y : null;
		// No crossing at all: the point the press landed on is the grab.
		const hit = toLocalMm(
			{ x: e.point.x * 1000, y: e.point.y * 1000, z: e.point.z * 1000 },
			frame,
		);
		const pointer = runPointFromRay(ray, planeZ, runWidthMm, levelY) ?? {
			xMm: hit.x + runWidthMm / 2,
			yMm: hit.y,
		};
		dragRef.current = {
			mode: "move",
			id: position.placed.id,
			grabMm: pointer.xMm - position.xMm,
			grabYMm: pointer.yMm - floorHeightMmOf(position, layout),
			vertical,
			planeZ,
			levelY,
		};
		crossWallRef.current = null;
		lastPreviewRunRef.current = null;
		setDragging(true);
		if (controls) controls.enabled = false;
	};

	/** Take hold of the rotate ring. Its own gesture, so grabbing it never
	 *  slides the cabinet and grabbing the disc never turns it. */
	const beginRotate = (
		e: ThreeEvent<PointerEvent>,
		position: Positioned,
		planeY: number,
	) => {
		// The handle's own group is drawn inside the run group and lies flat, so
		// its local frame is not the world's. The bearing has to be read against
		// the cabinet's world centre or the cabinet turns the wrong way from
		// half the camera angles.
		const centreXMm = position.xMm + position.widthMm / 2 - runWidthMm / 2;
		const centreZMm =
			-layout.roomDepthMm / 2 + WALL_GAP_MM + position.family.depthMm / 2;

		const pointer = planPointFromRay(localRay(e.ray, frame), planeY);
		dragRef.current = {
			mode: "rotate",
			id: position.placed.id,
			centreXMm,
			centreZMm,
			planeY,
			grabDeg:
				bearingDeg(pointer.xMm - centreXMm, pointer.zMm - centreZMm) -
				(position.placed.rotationDeg ?? 0),
		};
		setDragging(true);
		if (controls) controls.enabled = false;
	};

	const endDrag = useCallback(() => {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = null;
		setDragging(false);
		if (controls) controls.enabled = true;
		onDragPreview(null);
		// A turn has nothing to settle: `setRotation` already landed it on the
		// nearest eighth, and running the placement snap here would slide a
		// cabinet the gesture never touched.
		if (drag.mode === "rotate") return;
		// Dropped nearer another wall: hand it over instead of settling it here.
		const crossWall = crossWallRef.current;
		crossWallRef.current = null;
		if (crossWall) {
			onTransfer(drag.id, crossWall.run, crossWall.xMm);
			return;
		}
		// Settle it: flush against a neighbour, a wall end, or the cabinet below.
		const current = [
			...layoutRef.current.floor,
			...layoutRef.current.wall,
		].find((placed) => placed.id === drag.id);
		if (!current) return;
		// Both axes: whichever edge is nearest something worth lining up with
		// lands on it. `dropModule` drops the height if this one cannot hang.
		const next = dropModule(
			layoutRef.current,
			drag.id,
			current.xMm,
			drag.vertical ? current.hangAtMm : undefined,
		);
		if (next !== layoutRef.current) onLayoutChange(next);
	}, [controls, onLayoutChange, dropModule, onDragPreview, onTransfer]);

	// A drag can end anywhere — off the plane, outside the canvas, or with this
	// unmounting mid-gesture. All of them have to give orbiting back.
	// Read through a ref: `onLayoutChange` is a fresh arrow per render (one per
	// run), and re-running this effect on it gave orbiting back mid-drag — the
	// press that selected a cabinet re-rendered, and the camera swung round
	// while the cabinet slid.
	const endDragRef = useRef(endDrag);
	endDragRef.current = endDrag;
	useEffect(() => {
		const end = () => endDragRef.current();
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		return () => {
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			if (controls) controls.enabled = true;
		};
	}, [controls]);

	/**
	 * A drag's pointer moves, read off the window and cast from the camera.
	 *
	 * They used to arrive through a catch mesh standing in the run's wall plane,
	 * which a side run seen edge-on shows as a line: the moves missed it and
	 * the drag stalled. The window sees every move wherever the pointer is.
	 * Assigned each render and read through a ref, so the listener below is
	 * attached once rather than on every re-render a drag causes.
	 */
	const onDragMove = useRef<(event: PointerEvent) => void>(() => {});
	onDragMove.current = (event) => {
		const drag = dragRef.current;
		if (!drag) return;
		const rect = gl.domElement.getBoundingClientRect();
		DRAG_NDC.set(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1,
		);
		// Off the canvas — over the sidebar, say — the ray means nothing on
		// screen, so the cabinet stays where the pointer last left the scene.
		if (Math.abs(DRAG_NDC.x) > 1 || Math.abs(DRAG_NDC.y) > 1) return;
		DRAG_RAYCASTER.setFromCamera(DRAG_NDC, camera);
		const ray = localRay(DRAG_RAYCASTER.ray, frame);

		// A slide or a lift, never a turn, can hand the cabinet to another wall.
		// Read against the world ray, before `localRay` turns it into this run's
		// own frame — the same `floorPointFromRay` `DropPicker` calls for a
		// palette drop.
		if (drag.mode === "move" && !drag.vertical) {
			const origin = DRAG_RAYCASTER.ray.origin;
			const direction = DRAG_RAYCASTER.ray.direction;
			const floor = floorPointFromRay(
				{ x: origin.x * 1000, y: origin.y * 1000, z: origin.z * 1000 },
				{ x: direction.x * 1000, y: direction.y * 1000, z: direction.z * 1000 },
			);
			const candidate = floor ? transferTarget(plan, runIndex, floor) : null;
			crossWallRef.current = candidate;
			const previewRun = candidate?.run ?? null;
			if (lastPreviewRunRef.current !== previewRun) {
				lastPreviewRunRef.current = previewRun;
				onDragPreview(previewRun);
			}
		}

		if (drag.mode === "rotate") {
			const plan = planPointFromRay(ray, drag.planeY);
			const turned = setRotation(
				layoutRef.current,
				drag.id,
				bearingDeg(plan.xMm - drag.centreXMm, plan.zMm - drag.centreZMm) -
					drag.grabDeg,
				// Dragged, so let it land on square when it is near it.
				true,
			);
			if (turned !== layoutRef.current) onLayoutChange(turned);
			return;
		}

		const pointer = runPointFromRay(ray, drag.planeZ, runWidthMm, drag.levelY);
		if (!pointer) return;
		const next = dragModule(layoutRef.current, drag.id, {
			xMm: pointer.xMm - drag.grabMm,
			hangAtMm: drag.vertical ? pointer.yMm - drag.grabYMm : undefined,
		});
		if (next === layoutRef.current) return;

		// Re-anchor to where the cabinet actually ended up, so one held
		// against its neighbour starts moving the instant you reverse.
		const settled = [...next.floor, ...next.wall].find(
			(placed) => placed.id === drag.id,
		);
		if (settled) drag.grabMm = pointer.xMm - settled.xMm;
		onLayoutChange(next);
	};

	useEffect(() => {
		const move = (event: PointerEvent) => onDragMove.current(event);
		window.addEventListener("pointermove", move);
		return () => window.removeEventListener("pointermove", move);
	}, []);

	useEffect(() => {
		document.body.style.cursor = dragging ? "grabbing" : "auto";
		return () => {
			document.body.style.cursor = "auto";
		};
	}, [dragging]);

	useEffect(() => {
		if (measureMode) return;
		setMeasureHoverId(null);
		onMeasureHover(null);
	}, [measureMode, onMeasureHover]);

	const overhanging = useMemo(
		() => overhangingIds(layout),
		[layout, overhangingIds],
	);

	const sideGaps = useMemo(() => {
		// A return wall buries an end as surely as a neighbour does, so a run
		// built into an alcove must not veneer the two faces inside the walls.
		const walls = {
			wallWidthMm: layout.wallWidthMm,
			left: layout.endWalls?.left ?? layout.wallToWall,
			right: layout.endWalls?.right ?? layout.wallToWall,
		};
		// The distance as well as the yes/no: an end panel only needs to know
		// whether a side is buried, but a door needs to know how far away the
		// neighbour is before it can decide how far to swing. Per row, as before.
		const gaps = new Map<string, SideGaps>();
		for (const row of ["floor", "wall"] as const) {
			// The corner units at this run's start stand in it, so they are its
			// neighbours and get gaps of their own.
			const positions = [
				...positionsOf(layout, row),
				...corners.filter(
					(corner) => (corner.family.kind === "wall") === (row === "wall"),
				),
			];
			positions.forEach((position, i) => {
				const own = sideGapsMm(positions, i, walls);
				const end = position.xMm + position.widthMm;
				let { left, right } = own;
				// A corner unit drawn with the other run still stands its square
				// against the cabinet beside it.
				for (const span of filledSpans[row]) {
					if (span.endMm <= position.xMm + 1)
						left = Math.min(left, position.xMm - span.endMm);
					if (span.startMm >= end - 1)
						right = Math.min(right, Math.max(0, span.startMm - end));
				}
				gaps.set(position.placed.id, { left, right });
			});
		}
		return gaps;
	}, [layout, positionsOf, corners, filledSpans]);

	// The group sits on the wall plane itself: everything in the run is placed
	// by its back face from here, with a scribe gap so the carcasses do not
	// z-fight with the wall they stand against.
	return (
		<group position={[0, 0, -m(layout.roomDepthMm) / 2 + m(WALL_GAP_MM)]}>
			{/* A press on bare wall clears the selection. The moves of a drag are
			    read off the window instead — see `onDragMove`. */}
			<mesh
				position={[0, m(layout.ceilingHeightMm) / 2, 0]}
				onPointerDown={() => onSelect(null, false)}
			>
				<planeGeometry
					args={[m(runWidthMm) * 4, m(layout.ceilingHeightMm) * 3]}
				/>
				<meshBasicMaterial transparent opacity={0} depthWrite={false} />
			</mesh>

			<ContactShadows layout={layout} runWidthMm={runWidthMm} engine={engine} />
			<Worktop
				layout={layout}
				runWidthMm={runWidthMm}
				construction={construction}
				engine={engine}
			/>
			{/* The corner square is filled flush — square, no overhang of its own.
			    Both its open sides are bounded by the runs, whose slabs already
			    carry the front lip, so an overhang here is a ledge standing proud
			    of them and a strip overlapping the other run's slab at the same
			    height. */}
			{cornerWorktop && (
				<mesh
					position={[
						m(cornerWorktop.sizeMm / 2 - runWidthMm / 2),
						m(cornerWorktop.topMm + construction.worktopThicknessMm / 2),
						m(cornerWorktop.sizeMm / 2),
					]}
				>
					<boxGeometry
						args={[
							m(cornerWorktop.sizeMm),
							m(construction.worktopThicknessMm),
							m(cornerWorktop.sizeMm),
						]}
					/>
					<WorktopMaterial
						width={m(cornerWorktop.sizeMm)}
						depth={m(cornerWorktop.sizeMm)}
					/>
				</mesh>
			)}
			<CeilingTrim
				layout={layout}
				corners={corners}
				runWidthMm={runWidthMm}
				finishHex={finishHex}
				finishPhoto={finishPhoto}
				engine={engine}
			/>
			<Skirting layout={layout} runWidthMm={runWidthMm} engine={engine} />

			{/* Corner units are drawn for the left-hand corner, and every corner
			    is the left-hand corner of the run after it, so they stand at this
			    run's start unturned. */}
			{[...allPositions(layout), ...corners].map((position) => (
				<Cabinet
					key={position.placed.id}
					moduleId={position.placed.id}
					family={position.family}
					widthMm={position.widthMm}
					construction={construction}
					exposed={exposure.get(position.placed.id)}
					gaps={sideGaps.get(position.placed.id)}
					shutSide={shutSides.get(position.placed.id) ?? null}
					overhanging={overhanging.has(position.placed.id)}
					door={
						position.placed.doorStyleId
							? (doorStyleIn(catalogue, position.placed.doorStyleId) ?? null)
							: null
					}
					hinge={position.placed.hinge}
					doorsOpen={openIds.has(position.placed.id)}
					doorsHidden={doorsHidden}
					xMm={position.xMm}
					runWidthMm={runWidthMm}
					floorHeightMm={floorHeightMmOf(position, layout)}
					rotationDeg={position.placed.rotationDeg}
					finishHex={finishHex}
					finishPhoto={finishPhoto}
					selected={selectedIds.has(position.placed.id)}
					highlighted={
						position.placed.id === doorTargetId ||
						(measureMode && measureHoverId === position.placed.id)
					}
					onPointerMove={
						measureMode
							? (e) => {
									e.stopPropagation();
									setMeasureHoverId(position.placed.id);
									onMeasureHover(snapAt(e, position));
								}
							: undefined
					}
					onPointerOut={
						measureMode
							? () => {
									setMeasureHoverId((current) =>
										current === position.placed.id ? null : current,
									);
									onMeasureHover(null);
								}
							: undefined
					}
					onPointerDown={(e) => {
						e.stopPropagation();

						if (measureMode) {
							onMeasurePick(snapAt(e, position));
							return;
						}

						const additive = e.shiftKey || e.metaKey || e.ctrlKey;
						// Pressing one that is already selected keeps the selection, so a
						// group stays picked while its members are still draggable.
						if (additive || !selectedIds.has(position.placed.id)) {
							onSelect(position.placed.id, additive);
						}
						// The group is on the wall plane, so the cabinet's own centre
						// plane is half its depth in front of it. A corner unit is
						// selected and never dragged: its place is the corner.
						if (!corners.includes(position)) {
							beginDrag(
								e,
								position,
								-m(layout.roomDepthMm) / 2 +
									m(WALL_GAP_MM) +
									m(position.family.depthMm) / 2,
							);
						}
					}}
				/>
			))}

			{/* Only for a lone selection: four handles over a multi-selection
			    would each claim to move "the" cabinet. */}
			{selectedIds.size === 1 &&
				allPositions(layout)
					.filter((position) => selectedIds.has(position.placed.id))
					.map((position) => (
						<MoveHandle
							key={position.placed.id}
							position={position}
							runWidthMm={runWidthMm}
							roomDepthMm={layout.roomDepthMm}
							floorHeightMm={floorHeightMmOf(position, layout)}
							vertical={canHangAt(layout, position.placed.id)}
							onGrab={(e, planeZ, vertical) => {
								e.stopPropagation();
								if (measureMode) return;
								beginDrag(e, position, planeZ, vertical);
							}}
							onRotate={(e, planeY) => {
								e.stopPropagation();
								if (measureMode) return;
								beginRotate(e, position, planeY);
							}}
						/>
					))}
		</group>
	);
}

/**
 * The move handle on the floor under the selected cabinet.
 *
 * Dragging the cabinet itself already works, but nothing on screen says so —
 * this is the affordance, sitting in front of the carcass where it cannot be
 * confused with the door you are about to open. Pressing it starts exactly
 * the same drag the carcass starts, so it inherits the live movement, the
 * neighbour clamping and the snap on release for free.
 *
 * Drawn as geometry rather than a DOM overlay on purpose: an HTML element
 * would capture the pointer and the scene would stop receiving the moves that
 * drive the drag.
 */
function MoveHandle({
	position,
	runWidthMm,
	roomDepthMm,
	floorHeightMm,
	vertical,
	onGrab,
	onRotate,
}: {
	position: Positioned;
	runWidthMm: number;
	roomDepthMm: number;
	/** The underside of this cabinet, from the floor. */
	floorHeightMm: number;
	/** Whether this one can be dragged up and down as well as along. */
	vertical: boolean;
	onGrab: (
		e: ThreeEvent<PointerEvent>,
		planeZ: number,
		vertical: boolean,
	) => void;
	/** Take hold of the ring instead: the world height its bearing is read on. */
	onRotate: (e: ThreeEvent<PointerEvent>, planeY: number) => void;
}) {
	const centreX = m(position.xMm + position.widthMm / 2 - runWidthMm / 2);
	// Two different frames, and mixing them is the bug this comment exists to
	// stop: the handle is drawn inside the run's group, which already sits on
	// the wall plane, so its own position is measured from there — but the
	// drag reads a world ray, so the plane it solves against is a world z.
	const planeZ =
		-m(roomDepthMm) / 2 + m(WALL_GAP_MM) + m(position.family.depthMm) / 2;
	const localZ = m(position.family.depthMm) + 0.16;
	// How high it actually sits, not what kind it is. A base unit the customer
	// has lifted needs the hung cabinet's treatment — a handle left on the floor
	// under a cabinet two feet above it belongs to neither.
	const hangs = floorHeightMm > 0;
	// A cabinet on the floor gets its handle on the floor in front of it; one
	// off the floor gets it below its own underside, where it reads as belonging
	// to that cabinet rather than to whatever stands beneath it — clamped clear
	// of the floor, which is what a small lift used to bury it under. See
	// `handleCentreM`.
	const y = handleCentreM(floorHeightMm);
	// The plane the ring's bearing is solved against. The handle's own y in
	// world terms — the group is only ever translated, never lifted by a parent.
	const planeY = y;

	return (
		<group
			position={[centreX, y, hangs ? localZ - 0.1 : localZ]}
			// Flat on the floor for a cabinet that stands on it; facing the room
			// for one that hangs.
			rotation={hangs ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}
			onPointerDown={(e) => onGrab(e, planeZ, vertical)}
		>
			{/* The rotate ring, outside the move disc so the two gestures never
			    share a pixel. Drawn first and pressed on its own, so taking hold
			    of it turns the cabinet and never slides it. */}
			<mesh
				position={[0, 0, -0.001]}
				onPointerDown={(e) => onRotate(e, planeY)}
			>
				<ringGeometry args={[0.145, 0.185, 40]} />
				<meshBasicMaterial color="#1f5138" transparent opacity={0.5} />
			</mesh>
			{/* Two heads chasing each other round it: the ↻ that says "turn me". */}
			{[Math.PI / 2, -Math.PI / 2].map((angle) => (
				<mesh
					key={angle}
					position={[
						Math.cos(angle) * HANDLE_HEAD_R,
						Math.sin(angle) * HANDLE_HEAD_R,
						0.001,
					]}
					rotation={[0, 0, angle]}
					onPointerDown={(e) => onRotate(e, planeY)}
				>
					{/* Turned to face radially outward, so its tip lands
					    `HANDLE_HEAD_TIP` past the orbit — that sum is `HANDLE_REACH`,
					    and it is what has to clear the floor. */}
					<circleGeometry args={[HANDLE_HEAD_TIP, 3]} />
					<meshBasicMaterial color="#1f5138" />
				</mesh>
			))}

			<mesh>
				<circleGeometry args={[0.115, 32]} />
				<meshBasicMaterial color="#ffffff" transparent opacity={0.95} />
			</mesh>
			<mesh position={[0, 0, 0.001]}>
				<ringGeometry args={[0.105, 0.115, 32]} />
				<meshBasicMaterial color="#1f5138" />
			</mesh>
			{/* Two bars and four heads: the ✥ that says "drag me along". */}
			<mesh position={[0, 0, 0.002]}>
				<planeGeometry args={[0.13, 0.014]} />
				<meshBasicMaterial color="#1f5138" />
			</mesh>
			{vertical && (
				<mesh position={[0, 0, 0.002]}>
					<planeGeometry args={[0.014, 0.13]} />
					<meshBasicMaterial color="#1f5138" />
				</mesh>
			)}
			{(vertical ? [0, Math.PI / 2, Math.PI, -Math.PI / 2] : [0, Math.PI]).map(
				(angle) => (
					<mesh
						key={angle}
						position={[Math.cos(angle) * 0.075, Math.sin(angle) * 0.075, 0.002]}
						rotation={[0, 0, angle - Math.PI / 2]}
					>
						<circleGeometry args={[0.022, 3]} />
						<meshBasicMaterial color="#1f5138" />
					</mesh>
				),
			)}
		</group>
	);
}

/**
 * A wall unit's contact patch, faded out as the camera swings off-axis.
 *
 * The patch is painted on the wall and is deliberately larger than the cabinet
 * hanging in front of it, so head-on only its soft fringe shows and it reads as
 * shadow. Those two facts are what break it from the side: the cabinet sits
 * forward of the wall by the wall gap plus its own depth, so parallax slides it
 * off the patch, and what is left is a grey smudge on bare wall with nothing
 * casting it. The planner's camera orbits, so that view is one drag away.
 *
 * Fading on the viewing angle keeps the cue where it works and removes it where
 * it lies. `useFrame` writes the material directly rather than going through
 * React state — this runs every frame, and re-rendering the scene graph sixty
 * times a second to animate one float is exactly the mobile budget's problem.
 */
function WallShadow({
	position,
	scale,
	opacity,
}: {
	position: [number, number, number];
	scale: [number, number, number];
	opacity: number;
}) {
	const ref = useRef<Mesh<PlaneGeometry, MeshBasicMaterial>>(null);

	useFrame(({ camera }) => {
		const mesh = ref.current;
		if (!mesh) return;
		// The wall faces +z, so the z component of the direction from patch to
		// camera is how square-on the view is: 1 looking straight at the wall,
		// 0 grazing it, negative from behind.
		const facing = SHADOW_VIEW.subVectors(
			camera.position,
			mesh.position,
		).normalize().z;
		// Full strength until the view is already fairly oblique, then off by the
		// time the wall is edge-on. Squared so it leaves rather than lingers.
		const fade = Math.max(0, Math.min(1, (facing - 0.15) / 0.35));
		mesh.material.opacity = opacity * fade * fade;
	});

	return <Shadow ref={ref} position={position} scale={scale} color="#151311" />;
}

/** Scratch vector for the fade above — allocating one per frame per wall unit
 * is how a scene starts stuttering on the phones this app is built for. */
const SHADOW_VIEW = new Vector3();

/**
 * Fake contact shadows. No shadow maps — the mobile budget in CLAUDE.md rules
 * those out, and a cabinet only really needs to look *attached* to what it
 * meets.
 *
 * The pool is deliberately wider and deeper than the cabinet standing on it: a
 * blob the same size as the footprint is hidden underneath the very thing it is
 * meant to ground, which is worth less than nothing.
 */
function ContactShadows({
	layout,
	runWidthMm,
	engine,
}: {
	layout: PlannerLayout;
	runWidthMm: number;
	engine: PlannerEngine;
}) {
	const { positionsOf, floorHeightMmOf } = engine;
	return (
		<>
			{/* Only for a cabinet that is actually standing on the floor. A pool
			    under one the customer has lifted grounds nothing — it is a shadow
			    with no contact to fake. */}
			{positionsOf(layout, "floor")
				.filter((position) => position.placed.hangAtMm === undefined)
				.map((position) => (
					<Shadow
						key={position.placed.id}
						position={[
							m(position.xMm + position.widthMm / 2 - runWidthMm / 2),
							0.004,
							m(position.family.depthMm * 0.62),
						]}
						rotation={[-Math.PI / 2, 0, 0]}
						scale={[
							m(position.widthMm) * 1.15,
							m(position.family.depthMm) * 1.7,
							1,
						]}
						opacity={0.5}
						color="#151311"
					/>
				))}

			{/* Wall units get a soft patch on the wall itself, offset down so it
			    peeks out below the carcass — the cue that says "hung on that wall"
			    rather than "floating in front of it". */}
			{positionsOf(layout, "wall").map((position) => (
				<WallShadow
					key={position.placed.id}
					position={[
						m(position.xMm + position.widthMm / 2 - runWidthMm / 2),
						m(
							floorHeightMmOf(position, layout) + position.family.heightMm / 2,
						) - 0.06,
						0.002,
					]}
					scale={[
						m(position.widthMm) * 1.2,
						m(position.family.heightMm) * 1.15,
						1,
					]}
					opacity={0.28}
				/>
			))}
		</>
	);
}

function Worktop({
	layout,
	runWidthMm,
	construction,
	engine,
}: {
	layout: PlannerLayout;
	runWidthMm: number;
	construction: Construction;
	engine: PlannerEngine;
}) {
	const { positionsOf } = engine;
	// One slab per unbroken stretch of base units — a worktop is cut to the
	// cabinets under it, not to the wall, so a unit of another kind, a unit of a
	// different height, or a deliberate gap splits it. Contiguity is decided by
	// where the cabinets actually are, not by their order in the list, and
	// `kind === "base"` is the same test pricing charges against, which is what
	// keeps the drawn slab and the billed one the same slab.
	const spans: Array<{
		startMm: number;
		endMm: number;
		depthMm: number;
		topMm: number;
	}> = [];
	for (const position of positionsOf(layout, "floor")) {
		if (position.family.kind !== "base") continue;
		// A cabinet lifted off the floor or turned off the wall has left the
		// counter run — see `inRun`. Skipping it also breaks the span either side,
		// which is right: a slab does not bridge over a hole in the run.
		if (!inRun(position)) continue;
		const topMm = position.family.floorHeightMm + position.family.heightMm;
		const previous = spans[spans.length - 1];
		if (
			previous &&
			previous.topMm === topMm &&
			Math.abs(previous.endMm - position.xMm) < 1
		) {
			previous.endMm = position.xMm + position.widthMm;
			previous.depthMm = Math.max(previous.depthMm, position.family.depthMm);
		} else {
			spans.push({
				startMm: position.xMm,
				endMm: position.xMm + position.widthMm,
				depthMm: position.family.depthMm,
				topMm,
			});
		}
	}

	return (
		<>
			{spans.map((span) => {
				const widthMm = span.endMm - span.startMm;
				return (
					<mesh
						key={span.startMm}
						position={[
							m(span.startMm + widthMm / 2 - runWidthMm / 2),
							m(span.topMm + construction.worktopThicknessMm / 2),
							m((span.depthMm + WORKTOP_OVERHANG_MM) / 2),
						]}
					>
						<boxGeometry
							args={[
								m(widthMm),
								m(construction.worktopThicknessMm),
								m(span.depthMm + WORKTOP_OVERHANG_MM),
							]}
						/>
						<WorktopMaterial
							width={m(widthMm)}
							depth={m(span.depthMm + WORKTOP_OVERHANG_MM)}
						/>
					</mesh>
				);
			})}
		</>
	);
}

/**
 * The kick board across the front of a floor run, hiding the legs.
 *
 * One board per unbroken stretch, from `skirtingSpans` — the engine decides
 * where the boards start and stop so the price and the geometry cannot drift
 * apart. It used to be one box per cabinet inside `Cabinet.tsx`, which showed
 * a seam at every junction and, worse, was drawn only by the procedural
 * fallback: a cabinet with a drafted mesh stood on bare legs.
 *
 * Left flat and dark rather than wearing the door finish. A kick board is
 * meant to recede into the shadow under the run — the opposite of what the
 * capping strip is doing at the top.
 */
function Skirting({
	layout,
	runWidthMm,
	engine,
}: {
	layout: PlannerLayout;
	runWidthMm: number;
	engine: PlannerEngine;
}) {
	return (
		<>
			{engine.skirtingSpans(layout).map((span) => {
				const widthMm = span.endMm - span.startMm;
				// From the wall out to just short of the carcass front. The span
				// carries the recess because only the engine knows how far in the
				// feet under this stretch stand.
				const depthMm = span.depthMm - span.recessMm;

				return (
					<mesh
						key={span.startMm}
						position={[
							m(span.startMm + widthMm / 2 - runWidthMm / 2),
							m(span.heightMm / 2),
							m(depthMm / 2),
						]}
					>
						<boxGeometry args={[m(widthMm), m(span.heightMm), m(depthMm)]} />
						<meshStandardMaterial color="#3a3835" roughness={0.9} />
					</mesh>
				);
			})}
		</>
	);
}

/**
 * The strip that caps a floor-to-ceiling run.
 *
 * One piece per unbroken stretch of wall units, the same rule the worktop
 * follows: it is scribed to the cabinets under it, so a gap in the run breaks
 * it rather than being paid for. It carries the door finish, because on a
 * flushed kitchen this is the topmost thing the eye reads as cabinetry — a
 * carcass-coloured band up there is the first thing that looks wrong.
 *
 * Drawn only in ceiling mode: a hanging run has no strip.
 */
function CeilingTrim({
	layout,
	corners,
	runWidthMm,
	finishHex,
	finishPhoto,
	engine,
}: {
	layout: PlannerLayout;
	/** A corner wall unit is billed a strip like any wall unit, so it is drawn
	 * one: its own square piece, never merged into the run's shallower one. */
	corners: Positioned[];
	runWidthMm: number;
	finishHex: string;
	finishPhoto: string | null;
	engine: PlannerEngine;
}) {
	const spans: Array<{ startMm: number; endMm: number; depthMm: number }> = [];
	if (layout.wallToCeiling) {
		for (const position of engine.positionsOf(layout, "wall")) {
			const previous = spans[spans.length - 1];
			if (previous && Math.abs(previous.endMm - position.xMm) < 1) {
				previous.endMm = position.xMm + position.widthMm;
				previous.depthMm = Math.max(previous.depthMm, position.family.depthMm);
			} else {
				spans.push({
					startMm: position.xMm,
					endMm: position.xMm + position.widthMm,
					depthMm: position.family.depthMm,
				});
			}
		}
		for (const corner of corners) {
			if (corner.family.kind !== "wall") continue;
			spans.push({
				startMm: corner.xMm,
				endMm: corner.xMm + corner.widthMm,
				depthMm: corner.family.depthMm,
			});
		}
	}

	return (
		<>
			{spans.map((span) => (
				<TrimPiece
					key={span.startMm}
					widthMm={span.endMm - span.startMm}
					depthMm={span.depthMm}
					centreXMm={
						span.startMm + (span.endMm - span.startMm) / 2 - runWidthMm / 2
					}
					ceilingHeightMm={layout.ceilingHeightMm}
					finishHex={finishHex}
					finishPhoto={finishPhoto}
				/>
			))}
		</>
	);
}

/** Split out so the finish hook is called once per piece rather than in a
 *  loop, which the rules of hooks do not allow. */
function TrimPiece({
	widthMm,
	depthMm,
	centreXMm,
	ceilingHeightMm,
	finishHex,
	finishPhoto,
}: {
	widthMm: number;
	depthMm: number;
	centreXMm: number;
	ceilingHeightMm: number;
	finishHex: string;
	finishPhoto: string | null;
}) {
	const surface = useFrontSurface(
		finishPhoto,
		"horizontal",
		m(widthMm),
		m(CEILING_TRIM_MM),
		finishHex,
	);

	return (
		<mesh
			position={[
				m(centreXMm),
				m(ceilingHeightMm - CEILING_TRIM_MM / 2),
				m(depthMm / 2),
			]}
		>
			<boxGeometry args={[m(widthMm), m(CEILING_TRIM_MM), m(depthMm)]} />
			<meshStandardMaterial roughness={0.55} {...surface} />
		</mesh>
	);
}

/**
 * The slab's own surface. Same tile as everything else, but as sheen only —
 * with the figure on, a dark worktop reads as decking. What is left is an
 * uneven catch of light along the run, which is what honed stone does.
 */
function WorktopMaterial({ width, depth }: { width: number; depth: number }) {
	const figure = useGrain("horizontal", width, depth);
	return (
		<meshStandardMaterial color={WORKTOP_COLOR} roughness={0.4} {...figure} />
	);
}

/** Module-level so the default never changes identity between renders. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export default function PlannerScene({
	layout,
	finish,
	finishTextures = {},
	selectedIds,
	openIds = EMPTY_IDS,
	doorsHidden = false,
	doorTargetId,
	measureMode = false,
	measurePoints = [],
	measureAxis = "auto",
	positionMode = false,
	view = "3d",
	refitKey = 0,
	targetRun,
	showWallNumbers = false,
	showPanPuck = true,
	onLayoutChangeAction,
	onSelectAction,
	onMeasurePickAction,
	onWallPickAction,
	onWallLengthAction,
	pickerRef,
	hitTestRef,
}: {
	layout: RoomLayout;
	finish: FinishId;
	/** Finish id → uploaded decor photo, for the finishes that have one.
	 *
	 * Optional and defaulted: a finish with no photo already falls back to the
	 * generated grain, so an absent map should mean "nobody has photographed
	 * these yet" and never a thrown render. This is a public page where a dead
	 * canvas is a lost lead — and it does go missing in practice, when HMR
	 * swaps this module into a tab whose parents are still the previous build.
	 */
	finishTextures?: Record<string, string>;
	selectedIds: ReadonlySet<string>;
	/** The cabinets whose doors are swung open. Optional and empty by default:
	 * the quote screen's preview draws the same scene with no controls on it,
	 * and a shut door is what a customer expects to be quoted. */
	openIds?: ReadonlySet<string>;
	doorsHidden?: boolean;
	doorTargetId: string | null;
	/** While true, clicking a cabinet picks a measurement point instead of
	 * selecting or dragging it. */
	measureMode?: boolean;
	/** Which of the three camera set-ups to frame with. Defaults to `3d` so
	 * the quote screen's little preview keeps the selling angle without
	 * having to know the toggle exists. */
	view?: PlannerView;
	/** Bump to re-frame the run. A pan otherwise survives everything short of
	 * a view switch, so without this there is no way back from one. */
	refitKey?: number;
	/** The points picked so far — 0, 1, or 2 of them. */
	measurePoints?: SnapPoint[];
	/** Which axis the second pick is constrained to. Defaults to `auto`, which
	 * is what makes a roughly-vertical pick read as a clean height. */
	measureAxis?: MeasureAxis;
	/** Whether the Position verb is open. The offset callouts are that panel's
	 * readout, so they come up with it and not on plain selection. */
	positionMode?: boolean;
	/** The wall the add menu builds on: tinted, and what 3D and elevation
	 * frame. */
	targetRun: number;
	/** Numbered floor badges at the foot of every wall — on while the Room
	 * panel is open, so a customer can match "wall 3" in the field list to a
	 * wall in the room. Off by default: the badges are clutter once the room's
	 * shape is settled. */
	showWallNumbers?: boolean;
	/** The pan gizmo, hidden while the Room panel is open so it doesn't sit on
	 * top of the wall-length labels. Orbit and zoom stay on regardless. */
	showPanPuck?: boolean;
	onLayoutChangeAction: (next: RoomLayout) => void;
	onSelectAction: (id: string | null, additive: boolean) => void;
	onMeasurePickAction?: (snap: SnapPoint) => void;
	/** A wall was tapped, in the scene or on the plan's length labels. */
	onWallPickAction?: (run: number) => void;
	/** A wall's length was typed on the plan. Absent, the plan shows none. */
	onWallLengthAction?: (wall: number, mm: number) => void;
	/** Filled in by the scene: which wall a screen point drops onto, and how
	 * far along it. */
	pickerRef: React.RefObject<
		| ((
				clientX: number,
				clientY: number,
		  ) => { run: number; xMm: number } | null)
		| null
	>;
	/** Filled in by the scene: which cabinet is under this screen point. */
	hitTestRef: React.RefObject<
		((clientX: number, clientY: number) => string | null) | null
	>;
}) {
	const catalogue = useCatalogue();
	const engine = useEngine();
	const rooms = useRoomEngine();
	const construction = constructionOf(catalogue);
	// Edits land on the latest room, never one closed over at render.
	const roomRef = useRef(layout);
	roomRef.current = layout;
	const exposure = useMemo(() => rooms.exposureOf(layout), [rooms, layout]);
	const walls = useMemo(() => wallsOf(layout.plan), [layout.plan]);
	const runs = useMemo(
		() =>
			layout.runs.map((_, i) => ({
				view: runView(layout, i),
				frame: frameOf(walls[i]),
			})),
		[layout, walls],
	);
	const count = layout.runs.length;
	const cornersByRun = useMemo(
		() => layout.runs.map((_, i) => rooms.cornerPositionsOf(layout, i)),
		[rooms, layout],
	);
	const filledByRun = useMemo(
		() =>
			layout.runs.map((_, i) => ({
				floor: cornerSpans(layout, i, "floor")
					.filter((c) => cornerAt(layout, c.vertex)?.floor)
					.map((c) => c.span),
				wall: cornerSpans(layout, i, "wall")
					.filter((c) => cornerAt(layout, c.vertex)?.wall)
					.map((c) => c.span),
			})),
		[layout],
	);
	const worktops = useMemo(() => rooms.cornerWorktops(layout), [rooms, layout]);
	const target = runs[Math.min(targetRun, count - 1)];
	const runWidthMm = target.view.wallWidthMm;
	const shutSides = useMemo(
		() => rooms.cornerShutSides(layout),
		[rooms, layout],
	);
	const panSpace = panSpaceFor(
		view,
		{
			frame: target.frame,
			bounds: {
				runWidthMm: Math.max(runWidthMm, engine.rowEndMm(target.view, "floor")),
				roomDepthMm: target.view.roomDepthMm,
				ceilingHeightMm: layout.ceilingHeightMm,
				// The floor units only. A wall unit hangs over floor a person
				// can stand on, and so can the puck.
				runDepthMm: engine
					.positionsOf(target.view, "floor")
					.reduce((deepest, p) => Math.max(deepest, p.family.depthMm), 0),
			},
		},
		layout.plan,
	);
	const finishHex =
		catalogue.finishes.find((f) => f.id === finish)?.hex ??
		catalogue.finishes[0].hex;
	const finishPhoto = finishTextures[finish] ?? null;
	const [hoverPoint, setHoverPoint] = useState<SnapPoint | null>(null);
	// The wall a cabinet mid-drag would transfer to, for the preview tint.
	// `Run` already dedupes before calling this, so every call here is a real
	// change and a plain `useState` re-render is the right cost.
	const [previewWall, setPreviewWall] = useState<number | null>(null);
	const onTransfer = useCallback(
		(id: string, run: number, xMm: number) => {
			onLayoutChangeAction(rooms.moveToRun(roomRef.current, id, run, xMm));
			onWallPickAction?.(run);
		},
		[rooms, onLayoutChangeAction, onWallPickAction],
	);
	// Only the first point anchors the lock; with two down the next click starts
	// a fresh measurement, which has nothing to constrain against.
	const measureAnchor =
		measurePoints.length === 1 ? measurePoints[0].point : null;

	// Where the one selected cabinet sits. Only ever one: two selected cabinets
	// have two sets of gaps and the lines would cross each other's labels, and
	// the measuring tool owns the screen while it is up.
	const lonelyId =
		positionMode && selectedIds.size === 1 && !measureMode
			? [...selectedIds][0]
			: null;
	const lonelyRun = lonelyId
		? runs.findIndex(({ view }) =>
				[...view.floor, ...view.wall].some((placed) => placed.id === lonelyId),
			)
		: -1;
	const lonelyView = lonelyRun >= 0 ? runs[lonelyRun].view : null;
	const positioned =
		lonelyId && lonelyView
			? engine.allPositions(lonelyView).find((p) => p.placed.id === lonelyId)
			: undefined;
	const offsets =
		lonelyId && lonelyView ? engine.offsetsOf(lonelyView, lonelyId) : null;

	return (
		<Canvas
			dpr={[1, 2]}
			// Required to read the canvas back as an image for the quote screenshot.
			gl={{ preserveDrawingBuffer: true }}
			camera={{ fov: 45 }}
			// Without this, dragging a cabinet scrolls the page on Android.
			style={{ touchAction: "none" }}
			onPointerMissed={() => onSelectAction(null, false)}
			// The mid-range-Android failure mode: the GPU drops the context and the
			// scene goes blank without throwing, so nothing else would report it.
			onCreated={({ gl }) =>
				gl.domElement.addEventListener("webglcontextlost", () =>
					captureError(new Error("webgl context lost")),
				)
			}
		>
			<color attach="background" args={["#f4f2ee"]} />
			{/* Was 1.5 + 2.0, which clipped every mid-tone: Rhone Oak rendered
			    near-white and the grain with it. Dropped until the catalogue's
			    own finish colours survive to the screen, since that screenshot is
			    what goes out over WhatsApp. */}
			<ambientLight intensity={0.85} />
			<directionalLight position={[4, 7, 6]} intensity={1.35} />

			<Room
				plan={layout.plan}
				height={m(layout.ceilingHeightMm)}
				targetWall={targetRun}
				dragPreviewWall={previewWall}
				onWallPick={measureMode ? undefined : onWallPickAction}
			/>

			{runs.map(({ view: runLayout, frame }, i) => (
				<group
					// Index keys: a run's place in `layout.runs` is its wall.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					key={i}
					position={[m(frame.xMm), 0, m(frame.zMm)]}
					rotation={[0, frame.yawRad, 0]}
				>
					<Run
						layout={runLayout}
						frame={frame}
						plan={layout.plan}
						runIndex={i}
						corners={cornersByRun[i]}
						filledSpans={filledByRun[i]}
						exposure={exposure}
						shutSides={shutSides}
						cornerWorktop={
							worktops.find((w) => (w.vertex + 1) % count === i) ?? null
						}
						catalogue={catalogue}
						engine={engine}
						finishHex={finishHex}
						finishPhoto={finishPhoto}
						selectedIds={selectedIds}
						openIds={openIds}
						doorsHidden={doorsHidden}
						doorTargetId={doorTargetId}
						measureMode={measureMode}
						measureAxis={measureAxis}
						measureAnchor={measureAnchor}
						onLayoutChange={(next) =>
							onLayoutChangeAction(withRun(roomRef.current, i, next))
						}
						onSelect={onSelectAction}
						onMeasurePick={onMeasurePickAction ?? (() => {})}
						onMeasureHover={setHoverPoint}
						onDragPreview={setPreviewWall}
						onTransfer={onTransfer}
						construction={construction}
					/>
					{i === lonelyRun && positioned && offsets && (
						<PositionDimensions
							onLayoutChange={(next) =>
								onLayoutChangeAction(withRun(roomRef.current, i, next))
							}
							position={positioned}
							offsets={offsets}
							layout={runLayout}
							engine={engine}
						/>
					)}
				</group>
			))}
			{view === "plan" && onWallLengthAction && (
				<WallLengths
					plan={layout.plan}
					onPickAction={onWallPickAction}
					onLengthAction={onWallLengthAction}
				/>
			)}
			{showWallNumbers && view !== "plan" && (
				<WallNumbers
					plan={layout.plan}
					targetWall={targetRun}
					onPickAction={onWallPickAction}
				/>
			)}
			<MeasureOverlay
				points={measurePoints}
				previewPoint={measureMode ? hoverPoint : null}
			/>

			<DropPicker plan={layout.plan} pickerRef={pickerRef} />
			<CabinetHitTest hitTestRef={hitTestRef} />
			{/* `makeDefault` is what lets Run reach these through useThree and
			    switch orbiting off for the duration of a cabinet drag. */}
			{/* Orbiting is off in the flat views: the whole point of asking for
			    an elevation is that it stays square, and one stray drag that
			    left it at a slight angle would make it useless for eyeballing
			    whether a run clears a window. Zoom stays on. */}
			{/* Damping off. drei turns it on by default — three's own default is
			    off — and nobody here chose it. It keeps the camera coasting after
			    the finger has gone, which fights a gizmo whose whole promise is
			    "travel to exactly where I put this", lets a zoom drift an
			    elevation off square, and spends frames after every gesture on a
			    phone that has none to spare. */}
			<OrbitControls
				makeDefault
				enableDamping={false}
				enablePan={false}
				enableRotate={view === "3d"}
				maxPolarAngle={Math.PI / 2 - 0.05}
			/>
			{showPanPuck && (
				<PanGizmo {...panSpace} view={view} refitKey={refitKey} />
			)}
			<FitCamera
				runWidthMm={Math.max(runWidthMm, engine.rowEndMm(target.view, "floor"))}
				roomDepthMm={target.view.roomDepthMm}
				ceilingHeightMm={layout.ceilingHeightMm}
				planWidthMm={layout.plan.widthMm}
				planDepthMm={layout.plan.depthMm}
				view={view}
				frame={target.frame}
				refitKey={refitKey}
			/>
		</Canvas>
	);
}
