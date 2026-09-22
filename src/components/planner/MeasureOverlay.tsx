import { Line } from "@react-three/drei";
import {
	AXIS_COLOR,
	isAxisSignificant,
	type SnapKind,
	type SnapPoint,
	type Vec3Mm,
} from "@/lib/planner/measure";

const m = (mm: number) => mm / 1000;

const MARKER_COLOR = "#1f5138";
const PREVIEW_COLOR = "#d97706";

/**
 * The picked point(s) for the measuring tool: a marker at each point picked
 * so far, a ghost marker at wherever the pointer would land right now, and
 * once there are two committed points, a dimension line between them.
 *
 * The dimension line is drawn as three axis-aligned segments (an "L" or
 * staircase path — a → same-x-and-z-as-b → same-x-and-y-as-b → b) rather
 * than one straight 3D line between the two points. A single diagonal line
 * cuts through cabinet interiors at whatever angle the two points happen to
 * imply and reads as "bent" once the perspective camera and the carcasses it
 * passes behind fight for the eye — three segments, each moving along only
 * one axis, is the standard CAD dimension-chain convention and stays
 * legible from any camera angle.
 *
 * Each leg is colour-coded (`AXIS_COLOR`) rather than carrying its own
 * floating number: a measurement that's mostly along one axis leaves the
 * other two legs only a few millimetres long on screen, and a text label
 * pinned to a leg that short reads as disconnected from any line at all —
 * worse than no label. The numbers live in the fixed 2D readout panel
 * instead (`StudioScreen`), colour-matched to the same `AXIS_COLOR` so a
 * number and its line are still visually paired, just never distorted by
 * perspective or foreshortening.
 *
 * Each marker's **shape** says what it snapped to, the way AutoCAD's OSNAP
 * glyphs do: a cube for a corner, an octahedron for an edge midpoint, a sphere
 * for a bare point on a face. Without it a corner snap and a surface point
 * 12mm off that corner look identical, and the user only finds out which they
 * got by reading a number that is quietly 12mm wrong. The shape is deliberately
 * the signal rather than the colour — colour is already carrying the axis.
 *
 * Rendered as a sibling of `Run`, not a child — the points passed in are
 * already in the scene's outer world space (see `Run`'s `onMeasurePick`),
 * so no group offset belongs here.
 */
export function MeasureOverlay({
	points,
	previewPoint,
}: {
	points: SnapPoint[];
	/** What the next click would land on, so the user sees the target before
	 * committing to it. `null` when the pointer isn't over a cabinet. */
	previewPoint?: SnapPoint | null;
}) {
	const [a, b] = points;

	return (
		<>
			{points.map((snap, i) => (
				<Marker
					// biome-ignore lint/suspicious/noArrayIndexKey: points are only appended/cleared, never reordered
					key={i}
					snap={snap}
					color={MARKER_COLOR}
					size={0.012}
				/>
			))}

			{previewPoint && (
				<Marker
					snap={previewPoint}
					color={PREVIEW_COLOR}
					size={0.017}
					opacity={0.6}
				/>
			)}

			{a && b && <DimensionChain a={a.point} b={b.point} />}
		</>
	);
}

/** One glyph per snap kind. `depthTest={false}` throughout so a marker on the
 * far side of a carcass is still visible — a measurement you cannot see one end
 * of is worse than no measurement. */
function Marker({
	snap,
	color,
	size,
	opacity = 1,
}: {
	snap: SnapPoint;
	color: string;
	size: number;
	opacity?: number;
}) {
	return (
		<mesh position={[m(snap.point.x), m(snap.point.y), m(snap.point.z)]}>
			<Glyph kind={snap.kind} size={size} />
			<meshBasicMaterial
				color={color}
				transparent={opacity < 1}
				opacity={opacity}
				depthTest={false}
				toneMapped={false}
			/>
		</mesh>
	);
}

function Glyph({ kind, size }: { kind: SnapKind; size: number }) {
	if (kind === "corner") {
		// A cube reads as a square from any angle, which is AutoCAD's endpoint
		// marker and the strongest "you are exactly on a vertex" signal there is.
		const edge = size * 1.7;
		return <boxGeometry args={[edge, edge, edge]} />;
	}
	if (kind === "midpoint") {
		// Stands in for OSNAP's midpoint triangle: an octahedron shows a
		// triangular silhouette from every camera position, which a flat triangle
		// would not, and costs no billboarding.
		return <octahedronGeometry args={[size * 1.4]} />;
	}
	return <sphereGeometry args={[size, 16, 16]} />;
}

/** The corner where the "move along X" leg ends and "move along Y" begins,
 * and the corner where that ends and "move along Z" (to `b`) begins. */
function DimensionChain({ a, b }: { a: Vec3Mm; b: Vec3Mm }) {
	const c1: Vec3Mm = { x: b.x, y: a.y, z: a.z };
	const c2: Vec3Mm = { x: b.x, y: b.y, z: a.z };

	const maxAxisMm = Math.max(
		Math.abs(a.x - b.x),
		Math.abs(a.y - b.y),
		Math.abs(a.z - b.z),
	);

	return (
		<>
			<AxisSegment from={a} to={c1} axis="x" maxAxisMm={maxAxisMm} />
			<AxisSegment from={c1} to={c2} axis="y" maxAxisMm={maxAxisMm} />
			<AxisSegment from={c2} to={b} axis="z" maxAxisMm={maxAxisMm} />
		</>
	);
}

function AxisSegment({
	from,
	to,
	axis,
	maxAxisMm,
}: {
	from: Vec3Mm;
	to: Vec3Mm;
	axis: "x" | "y" | "z";
	/** Largest of the measurement's three axis deltas — a leg only draws if
	 * its own length is significant relative to this, not just nonzero. */
	maxAxisMm: number;
}) {
	const lengthMm = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
	if (!isAxisSignificant(lengthMm, maxAxisMm)) return null;

	return (
		<Line
			points={[
				[m(from.x), m(from.y), m(from.z)],
				[m(to.x), m(to.y), m(to.z)],
			]}
			color={AXIS_COLOR[axis]}
			dashed
			dashSize={0.025}
			gapSize={0.015}
			lineWidth={1.5}
			depthTest={false}
			toneMapped={false}
		/>
	);
}
