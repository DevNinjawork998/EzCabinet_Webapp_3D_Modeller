import { useEffect, useMemo, useState } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import { captureError } from "@/lib/analytics";
import {
	decodeRenderMesh,
	type MeshGroup,
	type MeshGroupRole,
	splitDoorLeaves,
} from "@/lib/mesh/renderMesh";
import {
	CARCASS_COLOR,
	CARCASS_INTERIOR_COLOR,
	type DoorStyle,
	GLASS_COLOR,
	HARDWARE_COLOR,
} from "@/lib/planner/catalogue";
import type { ExposedSides } from "@/lib/planner/exposure";
import { type SideGaps, UNBOUNDED_GAPS } from "@/lib/planner/exposure";
import type { HingeSide } from "@/lib/planner/layout";
import type { DesignPartBox } from "@/lib/planner/measure";
import { drawerTravelMm } from "@/lib/planner/parts";
import { type BoxMm, swingOf } from "@/lib/planner/swing";
import { useFrontSurface, useGrain } from "./grain";
import { Hinge, hingeOf } from "./Hinge";
import { Slide } from "./Slide";

/**
 * A cabinet drawn from the model the drafter actually made.
 *
 * This is the planner's primary path. `Cabinet.tsx` — six procedural boxes
 * rebuilt from a count of shelves — is the fallback for a family with no
 * published design, which means every catalogue published before design intake
 * and any design whose file would not convert.
 *
 * The geometry arrives as classified groups, not one lump, and that is what
 * keeps the two features that carry the sale:
 *
 * - **The finish picker** works because the `door` and `drawerFront` groups are
 *   known, so the customer's finish is painted onto exactly the surfaces a
 *   sprayer would paint. The drafter's own materials are dropped at intake.
 * - **The doors-open toggle** works because those same groups can be hidden
 *   without touching the carcass.
 *
 * No loader ships to the customer. The bytes are positions and indices, and
 * `BufferGeometry` takes them directly.
 */

const m = (mm: number) => mm / 1000;

/** The mesh carries a bbox as two triples; `swingOf` works in `{x,y,z}`. */
const boxOf = (bbox: MeshGroup["bboxMm"]): BoxMm => ({
	min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] },
	max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] },
});

/**
 * One fetch per design, shared by every placement of it.
 *
 * A run of four identical base units is one request, and the promise is cached
 * rather than the result so four cabinets mounting in the same frame do not
 * each start their own. Same lazy-singleton shape as `grain.ts`, and for the
 * same reason: this module is imported by a client component that Next also
 * renders on the server, where there is no `fetch` worth starting.
 */
const meshes = new Map<string, Promise<MeshGroup[]>>();

/**
 * What has actually arrived, readable without awaiting.
 *
 * The measuring tool needs the drawn geometry from inside a click handler,
 * where it cannot await anything — see `peekDesignMesh`.
 */
const resolved = new Map<string, MeshGroup[]>();

function loadMesh(designId: string): Promise<MeshGroup[]> {
	let pending = meshes.get(designId);
	if (!pending) {
		pending = fetch(`/api/cabinet-mesh/${designId}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`mesh ${designId}: ${res.status}`);
				return decodeRenderMesh(new Uint8Array(await res.arrayBuffer()));
			})
			.then((mesh) => {
				resolved.set(designId, mesh.groups);
				return mesh.groups;
			})
			// The cabinet still renders — procedurally — so this failure is
			// invisible on screen. Reported here, once per design, rather than
			// in each placement's hook.
			.catch((error: unknown) => {
				captureError(error, { designId });
				throw error;
			});
		meshes.set(designId, pending);
	}
	return pending;
}

/**
 * The loaded mesh, or null if it has not arrived — never a promise.
 *
 * For the measuring tool, which snaps inside a pointer handler and cannot wait.
 * Null is not a race to paper over: if the bytes are not here the scene is
 * drawing procedural boxes, so `measure.ts` snapping to procedural boxes is the
 * *correct* answer at that instant. By the time a customer can see a cabinet
 * well enough to measure it, this returns.
 */
export function peekDesignMesh(
	designId: string | undefined,
): MeshGroup[] | null {
	return designId ? (resolved.get(designId) ?? null) : null;
}

/** The drafted group boxes in the shape `lib/planner/measure.ts` takes — plain
 * numbers, so the pure engine keeps no dependency on this folder or on three. */
export function designPartBoxes(
	groups: MeshGroup[] | null,
): DesignPartBox[] | null {
	if (!groups) return null;
	return groups.map((group) => ({
		role: group.role,
		minMm: {
			x: group.bboxMm.min[0],
			y: group.bboxMm.min[1],
			z: group.bboxMm.min[2],
		},
		maxMm: {
			x: group.bboxMm.max[0],
			y: group.bboxMm.max[1],
			z: group.bboxMm.max[2],
		},
	}));
}

/**
 * Null until the bytes land, and null forever if they do not.
 *
 * A failed fetch is not an error state the customer should see — it is a
 * cabinet that falls back to procedural geometry, which is a cabinet that still
 * looks like a cabinet and can still be bought.
 */
export function useDesignMesh(
	designId: string | undefined,
): MeshGroup[] | null {
	const [groups, setGroups] = useState<MeshGroup[] | null>(null);

	useEffect(() => {
		if (!designId) {
			setGroups(null);
			return;
		}
		let cancelled = false;
		loadMesh(designId)
			.then((loaded) => {
				if (!cancelled) setGroups(loaded);
			})
			.catch(() => {
				if (!cancelled) setGroups(null);
			});
		return () => {
			cancelled = true;
		};
	}, [designId]);

	return groups;
}

/** Millimetres in, metres out — the scene's unit — with normals and texture
 * coordinates computed here because the format carries neither. Without
 * `computeVertexNormals` every surface renders unlit black; without UVs, see
 * below. */
function geometryOf(group: MeshGroup): BufferGeometry {
	const geometry = new BufferGeometry();
	const scaled = new Float32Array(group.positions.length);
	for (let i = 0; i < group.positions.length; i++) {
		scaled[i] = group.positions[i] / 1000;
	}
	geometry.setAttribute("position", new BufferAttribute(scaled, 3));
	geometry.setAttribute("uv", new BufferAttribute(planarUv(scaled), 2));
	geometry.setIndex(new BufferAttribute(group.indices, 1));
	geometry.computeVertexNormals();
	return geometry;
}

/**
 * Texture coordinates, planar-projected onto the group's own face.
 *
 * `ICBMESH1` carries positions and indices and nothing else, so a drafted
 * group had no coordinates to sample a texture at. Three.js then reads uv
 * (0, 0) for every fragment and the whole door comes out a single flat colour
 * — the scan's corner pixel. That is why a drafted cabinet showed no woodgrain
 * while the procedural one beside it did: `boxGeometry` ships UVs and this did
 * not.
 *
 * Projecting onto the two widest axes is exact for the flat panels this draws
 * — a door, a drawer front, a shelf — and those are the only groups a decor
 * scan ever reaches. Hardware gets nonsense coordinates and does not care: it
 * is a solid colour with no map. The thin axis is the one dropped, so a door
 * is measured across its width and up its height, which is what
 * `useFrontSurface` then scales against the sheet.
 *
 * Done here rather than at intake so every mesh already in the Blob store is
 * fixed by this deploy — regenerating them all would be a migration for
 * something the browser can derive in a single pass.
 */
function planarUv(scaled: Float32Array): Float32Array {
	const count = scaled.length / 3;
	const min = [
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
	];
	const max = [
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];
	for (let i = 0; i < count; i++) {
		for (let axis = 0; axis < 3; axis++) {
			const v = scaled[i * 3 + axis];
			if (v < min[axis]) min[axis] = v;
			if (v > max[axis]) max[axis] = v;
		}
	}
	const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	// The thinnest axis is the panel's thickness — project along it.
	const thin = span.indexOf(Math.min(...span));
	const [u, v] = [0, 1, 2].filter((axis) => axis !== thin);
	const uv = new Float32Array(count * 2);
	for (let i = 0; i < count; i++) {
		uv[i * 2] = span[u] === 0 ? 0 : (scaled[i * 3 + u] - min[u]) / span[u];
		uv[i * 2 + 1] = span[v] === 0 ? 0 : (scaled[i * 3 + v] - min[v]) / span[v];
	}
	return uv;
}

const isFront = (role: MeshGroupRole) =>
	role === "door" || role === "drawerFront";

function Group({
	group,
	geometry,
	door,
	finishHex,
	finishPhoto,
	sheetOffset,
	emissive,
	emphasis,
}: {
	group: MeshGroup;
	geometry: BufferGeometry;
	door: DoorStyle | null;
	finishHex: string;
	finishPhoto: string | null;
	sheetOffset: number;
	emissive: string;
	emphasis: number;
}) {
	const sizeMm = {
		x: group.bboxMm.max[0] - group.bboxMm.min[0],
		y: group.bboxMm.max[1] - group.bboxMm.min[1],
	};

	// Grain runs up a door and across a drawer front, which is how they are
	// really veneered, and getting it backwards looks wrong to someone who
	// could not say why.
	const front = useFrontSurface(
		finishPhoto,
		group.role === "drawerFront" ? "horizontal" : "vertical",
		m(sizeMm.x),
		m(sizeMm.y),
		finishHex,
		sheetOffset,
	);
	// Melamine board takes the grain as sheen only. With the figure on, a
	// carcass reads as timber, which is exactly the wrong answer.
	const carcass = useGrain("vertical", m(sizeMm.x), m(sizeMm.y));

	// A glazed front on a drafted cabinet used to differ from a solid one only
	// by roughness, which meant the drafter's glass door rendered as a solid
	// panel — the one door style whose whole point is that you see past it. The
	// procedural path has always drawn a pane; this is the same treatment
	// applied to the mesh the drafter actually made, including `depthWrite` off
	// so the shelves behind it survive being drawn after it.
	const material =
		isFront(group.role) && door
			? door.look === "glass"
				? {
						color: GLASS_COLOR,
						roughness: 0.1,
						transparent: true,
						opacity: 0.15,
						depthWrite: false,
					}
				: { ...front, roughness: 0.45 }
			: group.role === "hardware"
				? { color: HARDWARE_COLOR, roughness: 0.5, metalness: 0.35 }
				: group.role === "shelf"
					? { color: CARCASS_INTERIOR_COLOR, roughness: 0.85, ...carcass }
					: group.role === "other"
						? { color: CARCASS_INTERIOR_COLOR, roughness: 0.8 }
						: { color: CARCASS_COLOR, roughness: 0.8, ...carcass };

	return (
		<mesh geometry={geometry}>
			<meshStandardMaterial
				{...material}
				emissive={emissive}
				emissiveIntensity={emphasis}
			/>
		</mesh>
	);
}

/**
 * The veneered skin over a drafted cabinet's exposed end.
 *
 * `exposure.ts` answers which outer sides have nothing against them, and the
 * procedural path has always veneered those — it is the one carcass panel
 * anyone sees, and in the default 3/4 view it faces the camera. The drafted
 * path never did: `Cabinet.tsx` renders `DesignedCabinet` *instead of*
 * `Carcass`, and `Carcass` is where `isVeneered` lives, so a run whose base
 * units are drafted showed a grey melamine end beside a veneered wall unit in
 * the same finish.
 *
 * Sized off the carcass group's own bounding box rather than `parts.ts`, so it
 * lines up with the geometry actually on screen instead of the idealised
 * cabinet — the same reason `snapToCabinet` prefers the drawn mesh.
 *
 * ponytail: a skin, not a modelled 16mm board. A real end panel is screwed
 * over the carcass side and would make the run wider than the layout says it
 * is; a thin overlay reads identically at planner distance and moves nothing.
 * Split the carcass role at intake if a drafter ever needs the true board.
 */
function EndPanel({
	carcassMm,
	side,
	finishHex,
	finishPhoto,
	sheetOffset,
	emissive,
	emphasis,
}: {
	carcassMm: BoxMm;
	side: "left" | "right";
	finishHex: string;
	finishPhoto: string | null;
	sheetOffset: number;
	emissive: string;
	emphasis: number;
}) {
	const depth = carcassMm.max.z - carcassMm.min.z;
	const height = carcassMm.max.y - carcassMm.min.y;
	// Seen across its depth and up its height, so those are the dimensions the
	// sheet is cut to — not the cabinet's width.
	const surface = useFrontSurface(
		finishPhoto,
		"vertical",
		m(depth),
		m(height),
		finishHex,
		sheetOffset,
	);

	const x = side === "left" ? carcassMm.min.x : carcassMm.max.x;
	return (
		<mesh
			position={[
				m(x) + (side === "left" ? -SKIN_M / 2 : SKIN_M / 2),
				m((carcassMm.min.y + carcassMm.max.y) / 2),
				m((carcassMm.min.z + carcassMm.max.z) / 2),
			]}
		>
			<boxGeometry args={[SKIN_M, m(height), m(depth)]} />
			<meshStandardMaterial
				roughness={0.45}
				{...surface}
				emissive={emissive}
				emissiveIntensity={emphasis}
			/>
		</mesh>
	);
}

/** Thin enough to add no measurable width to the run, thick enough not to
 * z-fight with the carcass side it sits on. */
const SKIN_M = 0.002;

export function DesignedCabinet({
	groups,
	door,
	hinge,
	gaps = UNBOUNDED_GAPS,
	doorsHidden = false,
	open,
	finishHex,
	finishPhoto,
	sheetOffset,
	selected,
	highlighted,
	exposed,
}: {
	groups: MeshGroup[];
	/** `null` while it is still a bare carcass — the fronts are not drawn. */
	door: DoorStyle | null;
	/** Which stile a lone leaf hangs on. */
	hinge: HingeSide;
	/** Clear space each side. A leaf hangs on the cabinet's outer stile, so
	 * this is what decides how far it may swing before it reaches the
	 * neighbour. */
	gaps?: SideGaps;
	/** Draw no fronts at all, so the interior is unobstructed. */
	doorsHidden?: boolean;
	/** Swing the doors open. */
	open: boolean;
	finishHex: string;
	finishPhoto: string | null;
	/** Where in the decor sheet this cabinet's fronts are cut from, so two
	 * neighbours are not the same photograph twice. */
	sheetOffset: number;
	selected: boolean;
	highlighted?: boolean;
	/** Which outer sides have nothing against them. Omitted means neither — a
	 * cabinet mid-run — which is the safe default: veneer nobody asked for is
	 * a charge on the quote for a face nobody can see. */
	exposed?: ExposedSides;
}) {
	// The doors arrive as one merged group — triangles are bucketed by role at
	// intake — so a pair has to be cut back into leaves before either of them can
	// swing on its own. Left to right, so leaf 0 is the left-hand door.
	//
	// ponytail: handles classified `hardware` sit in their own group and stay put
	// while the door moves. Invisible on the client's own export, whose only
	// hardware is four levellers. If a design lands with handles on it, move this
	// split up into `buildRenderMesh`, where the drafter's own names
	// (`Door_L_`, `G-Door(R)`) are still there to group against.
	const drawn = useMemo(
		() =>
			groups.flatMap((group) =>
				group.role === "door" ? splitDoorLeaves(group) : [group],
			),
		[groups],
	);

	// Keyed on the array identity, which is stable per design because the
	// loader caches the promise — so placing a fifth copy of a cabinet uploads
	// nothing new to the GPU.
	const geometries = useMemo(() => drawn.map(geometryOf), [drawn]);

	const leaves = drawn.filter((group) => group.role === "door").length;

	// The box the doors hang on. `swingOf` compares a leaf's back face against
	// this front face to tell an overlay door from an inset one; without a
	// carcass group there is nothing to compare against, so fall back to
	// treating the leaf as an overlay — which is what every design the client
	// has sent so far actually is.
	const carcassMm = useMemo((): BoxMm | null => {
		const carcass = groups.find((group) => group.role === "carcass");
		return carcass ? boxOf(carcass.bboxMm) : null;
	}, [groups]);

	const emphasis = highlighted ? 0.6 : selected ? 0.35 : 0;
	// See `Cabinet.tsx`: both tones are green now, and the hover has to stay
	// the lighter of the two.
	const emissive = highlighted ? "#2f7d54" : "#1f5138";

	let leafIndex = 0;

	return (
		<>
			{/* The exposed ends, veneered to match the doors. Drawn before the
			    groups so a selection highlight reads over them the same way. */}
			{carcassMm !== null &&
				(["left", "right"] as const).map((side) =>
					exposed?.[side] ? (
						<EndPanel
							key={`end-${side}`}
							carcassMm={carcassMm}
							side={side}
							finishHex={finishHex}
							finishPhoto={finishPhoto}
							sheetOffset={sheetOffset}
							emissive={emissive}
							emphasis={emphasis}
						/>
					) : null,
				)}

			{drawn.map((group, i) => {
				// A doorless carcass is a real state — the customer has placed a
				// unit but not chosen a front — and it has to read as an open box.
				if (isFront(group.role) && (!door || doorsHidden)) return null;

				// Role plus left edge, because `door` now repeats: two leaves of one
				// pair are the same role and only their position tells them apart.
				const key = `${group.role}-${Math.round(group.bboxMm.min[0])}`;

				const rendered = (
					<Group
						key={key}
						group={group}
						geometry={geometries[i]}
						door={door}
						finishHex={finishHex}
						finishPhoto={finishPhoto}
						sheetOffset={sheetOffset}
						emissive={emissive}
						emphasis={emphasis}
					/>
				);
				// A drafted drawer runs out on the same toggle that swings the doors.
				// Without this a design's drawer bank sits frozen beside its own
				// opening doors, which is what reads as broken.
				if (group.role === "drawerFront") {
					const depthMm = carcassMm
						? carcassMm.max.z - carcassMm.min.z
						: group.bboxMm.max[2] - group.bboxMm.min[2];
					return (
						<Slide
							key={key}
							travel={drawerTravelMm(depthMm) / 1000}
							open={open}
						>
							{rendered}
						</Slide>
					);
				}

				if (group.role !== "door") return rendered;

				const side = hingeOf(leafIndex++, leaves, hinge);
				const leafMm = boxOf(group.bboxMm);
				// No carcass to measure against means no way to tell overlay from
				// inset, so assume the leaf sits proud of a front at its own back
				// face — the overlay case, and the only one drawn so far.
				const spec = swingOf(
					leafMm,
					carcassMm ?? { ...leafMm, max: { ...leafMm.max, z: leafMm.min.z } },
					side,
					gaps[side],
				);
				return (
					<Hinge key={key} spec={spec} open={open}>
						{rendered}
					</Hinge>
				);
			})}
		</>
	);
}
