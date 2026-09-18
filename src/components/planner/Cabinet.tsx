import { Edges } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { DoubleSide } from "three";
import {
	CARCASS_COLOR,
	CARCASS_INTERIOR_COLOR,
	CONSTRUCTION,
	type Construction,
	type DoorStyle,
	type Family,
	GLASS_COLOR,
	HARDWARE_COLOR,
	isCorner,
} from "@/lib/planner/catalogue";
import type { ExposedSides } from "@/lib/planner/exposure";
import {
	FULLY_EXPOSED,
	type SideGaps,
	UNBOUNDED_GAPS,
} from "@/lib/planner/exposure";
import { depthSpreadMm, type HingeSide } from "@/lib/planner/layout";
import {
	cabinetPartsMm,
	drawerTravelMm,
	FRONT_THICKNESS_MM,
	isInteriorPart,
	type PartBoxMm,
	standOf,
} from "@/lib/planner/parts";
import { type BoxMm, sharedMaxRad, swingOf } from "@/lib/planner/swing";
import { DesignedCabinet, useDesignMesh } from "./DesignedCabinet";
import {
	type GrainDirection,
	sheetOffsetOf,
	useFrontSurface,
	useGrain,
} from "./grain";
import { Hinge, hingeOf } from "./Hinge";
import { Slide } from "./Slide";

/**
 * One cabinet, generated from its family and the size the customer chose.
 *
 * It is drawn in two halves, because that is how it is sold: the **carcass**
 * always, and a **door** only once one has been put on it. A doorless carcass
 * has to read as an open box — dark interior, a back panel and a shelf — or a
 * customer cannot tell the difference between "no door yet" and "a very plain
 * door".
 */

const m = (mm: number) => mm / 1000;

/**
 * A shaker's recessed centre panel needs to read as a step in depth against
 * its own frame — but "same colour, different roughness" is invisible once
 * the finish is dark (Strata Noir), so it has to be an actual colour step.
 * Step toward the *opposite* end of the scale from the finish itself: a dark
 * finish gets a lighter inset, a light finish gets a darker one. Stepping
 * the same direction on every finish would just push a near-black colour
 * closer to black, which stays invisible.
 */
function insetShade(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	const amount = 0.3;
	const move = (c: number) =>
		Math.max(
			0,
			Math.min(
				255,
				Math.round(luminance < 0.5 ? c + (255 - c) * amount : c * (1 - amount)),
			),
		);
	return `#${((move(r) << 16) | (move(g) << 8) | move(b)).toString(16).padStart(6, "0")}`;
}

const EDGE_COLOR = "#3f3b36";
const EDGE_OPACITY = 0.55;
/** The selected cabinet's outline: the panels' accent green, in screen pixels. */
const SELECTION_COLOR = "#1f5138";
const SELECTION_LINE_PX = 3;
/** Metres the outline stands off the cabinet on every axis. */
const SELECTION_PAD = 0.006;

const HANDLE_LENGTH_MM = 128;
const HANDLE_THICKNESS_MM = 14;
/** Width of the stile/rail frame on a shaker or glazed front. */
const FRAME_MM = 60;

export function Cabinet({
	moduleId,
	family,
	widthMm,
	construction = CONSTRUCTION,
	door,
	hinge,
	doorsOpen = false,
	doorsHidden = false,
	xMm,
	runWidthMm,
	floorHeightMm,
	rotationDeg = 0,
	finishHex,
	finishPhoto,
	selected,
	highlighted,
	overhanging = false,
	exposed = FULLY_EXPOSED,
	gaps = UNBOUNDED_GAPS,
	shutSide = null,
	onPointerDown,
	onPointerMove,
	onPointerOut,
}: {
	/** Stamped onto the group so a raycast can name what it hit — that is how a
	 * door dropped from the HTML palette finds its carcass. */
	moduleId: string;
	family: Family;
	/** The chosen size — off the placed cabinet, not the family. */
	widthMm: number;
	/** Passed down from `PlannerScene`, resolved outside the canvas — this
	 * component renders inside `<Canvas>` and must not call `useCatalogue()`
	 * itself. Defaults to the seed for callers with no live catalogue. */
	construction?: Construction;
	/** `null` while it is still a bare carcass. */
	door: DoorStyle | null;
	/** Which stile a lone leaf hangs on. A pair ignores it and hinges outward
	 * from the middle, which is the only way a pair is hung. */
	hinge: HingeSide;
	/** Swing the doors open so the customer can see inside. View state, not
	 * something on the layout — see `StudioScreen`. */
	doorsOpen?: boolean;
	/** Draw no fronts at all, so the interior is unobstructed. */
	doorsHidden?: boolean;
	/** Left edge along the run. */
	xMm: number;
	runWidthMm: number;
	/** Underside above the floor, so a whole wall row can be raised together. */
	floorHeightMm: number;
	/** Turned on the spot, in degrees. Zero — square to the wall — for every
	 * cabinet that has not been deliberately spun. */
	rotationDeg?: number;
	finishHex: string;
	/** The uploaded decor photo for this finish. When present it *is* the
	 * front's surface — the real scan of the board — and `finishHex` only
	 * still drives the shaker inset. */
	finishPhoto: string | null;
	selected: boolean;
	/** A door is being dragged over this one right now, or the measuring tool
	 * is hovering it. */
	highlighted?: boolean;
	/** Crossing the end of the wall — a design that cannot be built as drawn. */
	overhanging?: boolean;
	/** Which of this cabinet's outer sides nothing sits against, so the end of
	 * a run can be veneered the way a fitter really finishes it. Defaults to
	 * both, which is what a cabinet drawn on its own wears. */
	exposed?: ExposedSides;
	/** Clear space each side, so a door knows how far it may swing. */
	gaps?: SideGaps;
	/** A side whose leaf must not open at all, because the other run's leaf
	 * swings through the same space — see `cornerShutSides` in `room.ts`. A
	 * clearance cannot say this: `swingOf` floors every leaf at a right angle,
	 * and at a right angle these two still cross. */
	shutSide?: HingeSide | null;
	onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
	onPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
	onPointerOut?: (e: ThreeEvent<PointerEvent>) => void;
}) {
	// The run is centred on the origin, so a cabinet's world x is its centre
	// measured from the middle of the wall.
	const centreX = m(xMm + widthMm / 2 - runWidthMm / 2);
	// Cabinets hang by their backs. The parent group sits on the wall plane and
	// each steps forward by half its own depth, so a 397-deep wall unit and a
	// 607-deep base unit share a back rather than a centre line.
	//
	// A turned one steps further. It spins about this very point, so half of
	// whatever depth the turn gives it lands behind the wall — and `clampToWall`
	// could not catch that, being written in x, where the cabinet was still
	// inside. Adding the spread slides it forward until its turned corner just
	// clears the plane, which is where a real one ends up: you cannot push a
	// corner into brick. Both rows, because both spin about their own centres.
	const backToCentre =
		m(family.depthMm) / 2 +
		m(depthSpreadMm(widthMm, family.depthMm, rotationDeg));

	const w = m(widthMm);
	const d = m(family.depthMm);
	const h = m(family.heightMm);
	const stand = standOf(family, construction);
	// What the carcass sits on: recorded feet, or the plinth height. Read off
	// `standOf` rather than assuming the plinth, so a legged family scales its
	// grain against the box that is actually drawn.
	const carcassH = h - m(stand.heightMm);
	const base = m(floorHeightMm);

	// Every box this cabinet is drawn from, in millimetres. The same call the
	// measuring tool makes, so a dimension line can never disagree with the
	// cabinet it is drawn against — see `lib/planner/parts.ts`.
	const parts = cabinetPartsMm(family, widthMm, door !== null, construction);
	const carcassParts = parts.filter(
		(part) =>
			part.role !== "doorLeaf" &&
			part.role !== "drawerFront" &&
			// A drawer box rides in its front's `Slide`, so it must not also be
			// drawn here — it would leave a second, stationary copy behind.
			part.role !== "drawerBox" &&
			part.role !== "leg",
	);

	// The box the doors hang on, unioned from the carcass's own parts rather
	// than from `family.depthMm`. `swingOf` compares a leaf's back face against
	// this front face to tell an overlay door from an inset one, so it has to be
	// the same geometry the scene actually draws — the drafted path unions the
	// carcass mesh group the same way.
	const carcassMm: BoxMm = carcassParts.length
		? carcassParts.reduce<BoxMm>(
				(box, part) => {
					const b = boxOf(part);
					return {
						min: {
							x: Math.min(box.min.x, b.min.x),
							y: Math.min(box.min.y, b.min.y),
							z: Math.min(box.min.z, b.min.z),
						},
						max: {
							x: Math.max(box.max.x, b.max.x),
							y: Math.max(box.max.y, b.max.y),
							z: Math.max(box.max.z, b.max.z),
						},
					};
				},
				{
					min: {
						x: Number.POSITIVE_INFINITY,
						y: Number.POSITIVE_INFINITY,
						z: Number.POSITIVE_INFINITY,
					},
					max: {
						x: Number.NEGATIVE_INFINITY,
						y: Number.NEGATIVE_INFINITY,
						z: Number.NEGATIVE_INFINITY,
					},
				},
			)
		: {
				min: { x: -widthMm / 2, y: 0, z: -family.depthMm / 2 },
				max: {
					x: widthMm / 2,
					y: family.heightMm,
					z: family.depthMm / 2,
				},
			};
	// Feet are for standing on the floor. A cabinet dragged up off it is being
	// shown floating — legs dangling under it read as a cabinet on stilts rather
	// than one the customer has lifted. Its own stated height against its
	// family's is the whole test; no new prop needed.
	//
	// This reaches the procedural fallback only. A drafted mesh keeps the feet
	// the drafter drew, because they cannot be picked out at render time: the
	// converter buckets by role, and `roles.ts` puts feet and handles in the
	// same `hardware` bucket — it tells them apart by what stands on the floor,
	// which is a fact about the source file, not about the merged group. Losing
	// the handles to hide the feet is the worse trade on a page that has to
	// sell. Splitting feet into their own role at intake is the real fix, and it
	// means re-converting and re-publishing every design.
	// ponytail: fallback only; needs a `foot` role in lib/mesh to cover drafted
	// meshes.
	const lifted = floorHeightMm > family.floorHeightMm;
	const legParts = lifted ? [] : parts.filter((part) => part.role === "leg");
	const leaves = parts.filter((part) => part.role === "doorLeaf");
	const drawerFronts = parts.filter((part) => part.role === "drawerFront");
	const drawerBoxes = parts.filter((part) => part.role === "drawerBox");

	// Overhanging wins over both: a cabinet past the end of the wall is a
	// problem to fix, and that outranks showing it as hovered or picked. Amber
	// is the colour the sidebar warning already uses, so the two read as one
	// message rather than two unrelated signals.
	const emphasis = overhanging ? 0.55 : highlighted ? 0.6 : selected ? 0.35 : 0;
	// Green, matching the panels' accent. The highlighted tone has to stay
	// clearly lighter than the selected one now that both are green, or the
	// measure hover becomes invisible on an already-selected cabinet.
	const emissive = overhanging
		? "#b45309"
		: highlighted
			? "#2f7d54"
			: "#1f5138";

	// Where in the decor sheet this cabinet is cut from, so two neighbours are not
	// the same photograph twice. Off the id, not the position, or the photograph
	// slides across the door while the cabinet is dragged.
	const sheetOffset = sheetOffsetOf(moduleId);

	// The model the drafter drew, if this rung has one published. It hangs off
	// the size rather than the family because the client draws one export per
	// width — BC 800, BC 900, BC 1000 — so the ladder is a set of files.
	//
	// Null covers three cases, all of which fall through to the procedural
	// boxes below: a catalogue published before design intake, a design whose
	// file would not convert, and the frame or two before the bytes land.
	const designGroups = useDesignMesh(
		family.sizes.find((size) => size.widthMm === widthMm)?.meshDesignId,
	);

	// A corner unit is turned for the right-hand corner because its drawing is
	// L-shaped. The fallback is a plain box with its doors on +z, which turned
	// would face its doors into the neighbour's side — and a square box needs
	// no turn to fill the corner.
	const turnDeg = designGroups || !isCorner(family) ? rotationDeg : 0;

	return (
		<group
			position={[centreX, base, backToCentre]}
			// The group's origin is already the cabinet's own centre in x and z —
			// that is what `backToCentre` buys — so a yaw here spins it on the spot
			// with no pivot correction. Everything below is drawn in the cabinet's
			// own frame, the drafted mesh included, so it all turns together.
			rotation={[0, (turnDeg * Math.PI) / 180, 0]}
			userData={{ moduleId }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerOut={onPointerOut}
		>
			{designGroups ? (
				<DesignedCabinet
					groups={designGroups}
					door={door}
					hinge={hinge}
					gaps={gaps}
					shutSide={shutSide}
					open={doorsOpen}
					doorsHidden={doorsHidden}
					finishHex={finishHex}
					finishPhoto={finishPhoto}
					sheetOffset={sheetOffset}
					selected={selected}
					highlighted={highlighted}
					exposed={exposed}
				/>
			) : (
				<>
					{/* No plinth here any more: the kick board spans the whole run and
			    is drawn once by `Skirting` in `PlannerScene`, which also covers
			    the drafted-mesh path this fallback never reached. */}

					{/* The feet the design was drawn with. Cylinders, because a leveller
			    is round and a box here reads as a stubby plinth leg. */}
					{legParts.map((leg) => (
						<mesh
							key={`leg-${leg.index}`}
							position={[
								m(leg.centreMm.x),
								m(leg.centreMm.y),
								m(leg.centreMm.z),
							]}
						>
							<cylinderGeometry
								args={[
									m(leg.sizeMm.x) / 2,
									m(leg.sizeMm.x) / 2,
									m(leg.sizeMm.y),
									12,
								]}
							/>
							<meshStandardMaterial
								color={HARDWARE_COLOR}
								roughness={0.5}
								metalness={0.35}
							/>
						</mesh>
					))}

					{/* Carcass: separate panels rather than one box, so the inside is
			    visible when there is no door on it yet. */}
					<Carcass
						parts={carcassParts}
						width={w}
						depth={d}
						height={carcassH}
						exposed={exposed}
						finishHex={finishHex}
						finishPhoto={finishPhoto}
						sheetOffset={sheetOffset}
						emissive={emissive}
						emphasis={emphasis}
					/>

					{door &&
						!doorsHidden &&
						(drawerFronts.length > 0 ? (
							<Drawers
								parts={drawerFronts}
								boxes={drawerBoxes}
								open={doorsOpen}
								travel={m(drawerTravelMm(carcassMm.max.z - carcassMm.min.z))}
								finishPhoto={finishPhoto}
								door={door}
								finishHex={finishHex}
								emissive={emissive}
								emphasis={emphasis}
							/>
						) : (
							<Doors
								parts={leaves}
								carcassMm={carcassMm}
								gaps={gaps}
								shutSide={shutSide}
								finishPhoto={finishPhoto}
								door={door}
								hinge={hinge}
								// A corner box's doors stay shut: the side run stands in
								// front of half its front, so any swing is through it.
								open={doorsOpen && !isCorner(family)}
								finishHex={finishHex}
								emissive={emissive}
								emphasis={emphasis}
							/>
						))}
				</>
			)}

			{/* The selection, as a thick line round the whole cabinet. The emissive
			    tint alone all but vanished on a light finish — a state carried by a
			    faint colour shift is one a low-vision customer cannot see. Drawn
			    on the wrapper so the drafted mesh and the fallback both get it,
			    a hair oversize so it never z-fights the carcass's own edges, and
			    unpickable so a click or a measuring snap still lands on the
			    cabinet underneath. */}
			{selected && (
				<mesh position={[0, h / 2, 0]} raycast={() => null}>
					<boxGeometry
						args={[w + SELECTION_PAD, h + SELECTION_PAD, d + SELECTION_PAD]}
					/>
					<meshBasicMaterial colorWrite={false} depthWrite={false} />
					<Edges color={SELECTION_COLOR} lineWidth={SELECTION_LINE_PX} />
				</mesh>
			)}
		</group>
	);
}

/**
 * Sides, top, bottom, a back and however many shelves the design has — an open
 * box you can see into.
 *
 * The shelf count is the cheapest thing that makes two imported designs read as
 * different products: a tall unit with six shelves and a base unit with one are
 * the same six boxes otherwise.
 */
function Carcass({
	parts,
	width,
	depth,
	height,
	exposed,
	finishHex,
	finishPhoto,
	sheetOffset,
	emissive,
	emphasis,
}: {
	parts: PartBoxMm[];
	/** Only the grain needs these — the panels carry their own sizes. */
	width: number;
	depth: number;
	height: number;
	/** Which outer sides nothing sits against, from `exposedSides`. */
	exposed: ExposedSides;
	finishHex: string;
	finishPhoto: string | null;
	/** Where in the decor sheet this cabinet's end panel is cut from. */
	sheetOffset: number;
	emissive: string;
	emphasis: number;
}) {
	// Melamine board takes the grain as sheen only. With the figure on, the
	// inside of an open carcass reads as slatted timber, which is both wrong and
	// louder than the doors it sits behind.
	const figure = useGrain("vertical", width, height);

	// The end of a run is veneered to match the doors — it is the one carcass
	// panel anyone ever sees, and in the default 3/4 view it faces the camera.
	// The panel is seen across its depth and up its height, so those are the
	// dimensions the sheet is cut to, not the carcass width.
	const veneer = useFrontSurface(
		finishPhoto,
		"vertical",
		depth,
		height,
		finishHex,
		sheetOffset,
	);

	/** A side panel with nothing against it, on a finish we have a board for.
	 * Without a photo there is nothing to veneer with, and the melamine look
	 * is what the scene has always had. */
	const isVeneered = (part: PartBoxMm) =>
		finishPhoto !== null &&
		part.role === "side" &&
		(part.index === 0 ? exposed.left : exposed.right);

	return (
		<>
			{parts.map((part) => (
				<mesh
					key={`${part.role}-${part.index}`}
					position={[
						m(part.centreMm.x),
						m(part.centreMm.y),
						m(part.centreMm.z),
					]}
				>
					<boxGeometry
						args={[m(part.sizeMm.x), m(part.sizeMm.y), m(part.sizeMm.z)]}
					/>
					<meshStandardMaterial
						color={
							isInteriorPart(part.role) ? CARCASS_INTERIOR_COLOR : CARCASS_COLOR
						}
						roughness={0.85}
						{...(isVeneered(part) ? veneer : figure)}
						emissive={emissive}
						emissiveIntensity={emphasis}
					/>
					<Edges
						threshold={15}
						color={EDGE_COLOR}
						transparent
						opacity={EDGE_OPACITY}
					/>
				</mesh>
			))}
		</>
	);
}

function Front({
	door,
	width,
	height,
	position,
	finishHex,
	finishPhoto,
	grain,
	emissive,
	emphasis,
}: {
	door: DoorStyle;
	width: number;
	height: number;
	position: [number, number, number];
	finishHex: string;
	finishPhoto: string | null;
	/** Up a door, across a drawer front — the way the veneer is actually cut. */
	grain: GrainDirection;
	emissive: string;
	emphasis: number;
}) {
	const surface = useFrontSurface(
		finishPhoto,
		grain,
		width,
		height,
		finishHex,
		// Fractional part of the door's own x, so two doors side by side are cut
		// from different parts of the sheet and a run stops looking cloned.
		Math.abs(position[0] * 1.37) % 1,
	);
	const frame = m(FRAME_MM);
	const panelW = Math.max(width - frame * 2, width * 0.2);
	const panelH = Math.max(height - frame * 2, height * 0.2);
	const thickness = m(FRONT_THICKNESS_MM);

	// A glazed door is a frame around a hole, and what sells it as glass is the
	// carcass seen through that hole. Drawing a full slab and laying a
	// translucent pane over it — which is what this did — gives a solid door
	// with a milky rectangle painted on its face however clear the pane is
	// made, because there is nothing behind the pane but board.
	//
	// Stiles run the full height and the rails span between them, so the
	// corners belong to the stiles instead of being drawn twice. `[x, y, w, h]`
	// each, in the door's own frame.
	const glazed = door.look === "glass";
	const railW = Math.max(width - frame * 2, 0);
	const frameParts: [number, number, number, number][] = [
		[-(width - frame) / 2, 0, frame, height],
		[(width - frame) / 2, 0, frame, height],
		[0, (height - frame) / 2, railW, frame],
		[0, -(height - frame) / 2, railW, frame],
	];

	return (
		<group position={position}>
			{glazed ? (
				frameParts.map(([x, y, w, h]) => (
					<mesh key={`${x}-${y}`} position={[x, y, 0]}>
						<boxGeometry args={[w, h, thickness]} />
						<meshStandardMaterial
							roughness={0.5}
							{...surface}
							emissive={emissive}
							emissiveIntensity={emphasis}
						/>
						<Edges
							threshold={15}
							color={EDGE_COLOR}
							transparent
							opacity={EDGE_OPACITY}
						/>
					</mesh>
				))
			) : (
				<mesh>
					<boxGeometry args={[width, height, thickness]} />
					<meshStandardMaterial
						roughness={0.5}
						{...surface}
						emissive={emissive}
						emissiveIntensity={emphasis}
					/>
					<Edges
						threshold={15}
						color={EDGE_COLOR}
						transparent
						opacity={EDGE_OPACITY}
					/>
				</mesh>
			)}

			{/* A shaker's recessed centre panel: a real inset box, because it is a
			    real piece of board with thickness. */}
			{door.look === "shaker" && (
				<mesh position={[0, 0, m(FRONT_THICKNESS_MM) / 2]}>
					<boxGeometry args={[panelW, panelH, m(4)]} />
					<meshStandardMaterial
						color={insetShade(finishHex)}
						roughness={0.6}
						roughnessMap={surface.roughnessMap}
					/>
					<Edges
						threshold={15}
						color={EDGE_COLOR}
						transparent
						opacity={EDGE_OPACITY}
					/>
				</mesh>
			)}

			{/* A glazed door's pane, sitting in the opening the frame leaves.

			    A single plane, not a box: as a box the camera looks through both
			    its front and back faces, and two coats of the same alpha compound
			    — 0.55 twice reads as 0.80. It is deliberately faint. A photograph
			    of a real glazed cabinet shows why: the glass is close to
			    invisible, and the stiles, the rails and the shelves behind them
			    are what say "there is glass here".

			    `depthWrite` off because a transparent surface that writes depth
			    culls whatever is drawn behind it afterwards — the shelves this
			    door exists to show. `DoubleSide` because the elevation view and
			    the doors-open toggle both look at a door from behind, and a plane
			    has no back. */}
			{glazed && (
				// Set back into the frame, the way glass sits in a rebate rather
				// than proud of the stiles.
				<mesh position={[0, 0, -thickness / 4]}>
					<planeGeometry args={[panelW, panelH]} />
					<meshStandardMaterial
						color={GLASS_COLOR}
						roughness={0.1}
						transparent
						opacity={0.15}
						depthWrite={false}
						side={DoubleSide}
					/>
					<Edges
						threshold={15}
						color={EDGE_COLOR}
						transparent
						opacity={EDGE_OPACITY}
					/>
				</mesh>
			)}
		</group>
	);
}

function Handle({
	position,
	vertical,
}: {
	position: [number, number, number];
	vertical: boolean;
}) {
	const length = m(HANDLE_LENGTH_MM);
	const thickness = m(HANDLE_THICKNESS_MM);
	return (
		<mesh position={position}>
			<boxGeometry
				args={
					vertical
						? [thickness, length, thickness]
						: [length, thickness, thickness]
				}
			/>
			<meshStandardMaterial
				color={HARDWARE_COLOR}
				roughness={0.3}
				metalness={0.6}
			/>
		</mesh>
	);
}

/** A part's box in the cabinet's own frame — the frame `swingOf` works in. */
const boxOf = (part: PartBoxMm): BoxMm => ({
	min: {
		x: part.centreMm.x - part.sizeMm.x / 2,
		y: part.centreMm.y - part.sizeMm.y / 2,
		z: part.centreMm.z - part.sizeMm.z / 2,
	},
	max: {
		x: part.centreMm.x + part.sizeMm.x / 2,
		y: part.centreMm.y + part.sizeMm.y / 2,
		z: part.centreMm.z + part.sizeMm.z / 2,
	},
});

function Doors({
	parts,
	carcassMm,
	gaps,
	shutSide,
	door,
	hinge,
	open,
	finishHex,
	finishPhoto,
	emissive,
	emphasis,
}: {
	parts: PartBoxMm[];
	/** The box the leaves hang on, so `swingOf` can tell an overlay door from
	 * an inset one and pivot on the right edge. */
	carcassMm: BoxMm;
	/** Clear space beside the cabinet — decides how far a leaf may open before
	 * it would reach into the neighbour. */
	gaps: SideGaps;
	/** The side whose leaf cannot open, or null. */
	shutSide: HingeSide | null;
	door: DoorStyle;
	hinge: HingeSide;
	open: boolean;
	finishHex: string;
	finishPhoto: string | null;
	emissive: string;
	emphasis: number;
}) {
	// Worked out for every leaf first, because the answer is a property of the
	// cabinet and not of one leaf. A pair whose left side is a run end and whose
	// right side touches a neighbour would otherwise open 110° and 90° — two
	// halves of one door front at visibly different angles, which is worse than
	// either angle on its own. The tightest limit wins for all of them.
	const specs = parts.map((leaf) =>
		swingOf(
			boxOf(leaf),
			carcassMm,
			hingeOf(leaf.index, parts.length, hinge),
			// A leaf hangs on the cabinet's outer stile, so the room it has is
			// the room on that side — measured by `sideGapsMm`, not guessed from
			// whether a neighbour happens to be touching.
			gaps[hingeOf(leaf.index, parts.length, hinge)],
		),
	);
	const maxRad = sharedMaxRad(specs);

	return (
		<>
			{parts.map((leaf, i) => {
				const side = hingeOf(leaf.index, parts.length, hinge);
				// The handle goes on the free edge, opposite the hinge, and travels
				// with the leaf because it is inside the same pivot.
				const handleSide = side === "left" ? 1 : -1;
				const x = m(leaf.centreMm.x);
				const y = m(leaf.centreMm.y);
				const z = m(leaf.centreMm.z);
				const leafW = m(leaf.sizeMm.x);
				// A leaf facing an L's inner corner is drawn shut the same way a
				// suspected flap is: there is no angle it can reach that the other
				// run's leaf is not already in.
				const spec =
					side === shutSide
						? { ...specs[i], maxRad, suspectFlap: true }
						: { ...specs[i], maxRad };

				return (
					<Hinge key={leaf.index} spec={spec} open={open}>
						<Front
							door={door}
							width={leafW}
							height={m(leaf.sizeMm.y)}
							position={[x, y, z]}
							finishHex={finishHex}
							finishPhoto={finishPhoto}
							grain="vertical"
							emissive={emissive}
							emphasis={emphasis}
						/>
						<Handle
							position={[
								x + handleSide * (leafW / 2 - m(45)),
								y,
								z + m(FRONT_THICKNESS_MM),
							]}
							vertical
						/>
					</Hinge>
				);
			})}
		</>
	);
}

function Drawers({
	parts,
	boxes,
	open,
	travel,
	door,
	finishHex,
	finishPhoto,
	emissive,
	emphasis,
}: {
	parts: PartBoxMm[];
	/** The box panels behind the fronts, `index` matching their drawer. */
	boxes: PartBoxMm[];
	/** Runs the drawers out, the same toggle that swings the doors. */
	open: boolean;
	/** How far out, in metres. */
	travel: number;
	door: DoorStyle;
	finishHex: string;
	finishPhoto: string | null;
	emissive: string;
	emphasis: number;
}) {
	return (
		<>
			{parts.map((front) => {
				const x = m(front.centreMm.x);
				const y = m(front.centreMm.y);
				const z = m(front.centreMm.z);

				return (
					<Slide key={front.index} travel={travel} open={open}>
						{boxes
							.filter((panel) => panel.index === front.index)
							.map((panel) => (
								<mesh
									// Two sides differ in x, the bottom in y, the back in
									// z — the centre is unique within one drawer.
									key={`${panel.centreMm.x}-${panel.centreMm.y}-${panel.centreMm.z}`}
									position={[
										m(panel.centreMm.x),
										m(panel.centreMm.y),
										m(panel.centreMm.z),
									]}
								>
									<boxGeometry
										args={[
											m(panel.sizeMm.x),
											m(panel.sizeMm.y),
											m(panel.sizeMm.z),
										]}
									/>
									<meshStandardMaterial
										color={CARCASS_INTERIOR_COLOR}
										roughness={0.85}
										emissive={emissive}
										emissiveIntensity={emphasis}
									/>
								</mesh>
							))}
						<Front
							door={door}
							width={m(front.sizeMm.x)}
							height={m(front.sizeMm.y)}
							position={[x, y, z]}
							finishHex={finishHex}
							finishPhoto={finishPhoto}
							grain="horizontal"
							emissive={emissive}
							emphasis={emphasis}
						/>
						<Handle
							position={[x, y, z + m(FRONT_THICKNESS_MM)]}
							vertical={false}
						/>
					</Slide>
				);
			})}
		</>
	);
}
