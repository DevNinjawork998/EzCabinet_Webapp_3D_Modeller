import { Html, Line } from "@react-three/drei";
import { type SyntheticEvent, useState } from "react";
import type {
	Offsets,
	PlannerEngine,
	PlannerLayout,
	Positioned,
} from "@/lib/planner/layout";
import { cabinetBoundsMm } from "@/lib/planner/measure";
import { useCopy } from "./CopyContext";
import { GapInput } from "./GapInput";

const m = (mm: number) => mm / 1000;

const LINE_COLOR = "#1f5138";

const CHIP =
	"whitespace-nowrap rounded-[6px] border border-[#1f5138] bg-white/95 px-1.5 py-0.5 font-semibold text-[#1f5138] text-[11px] leading-none tabular-nums shadow-[0_1px_4px_rgba(0,0,0,.16)]";

/** How far in front of the cabinet's face the dimension line floats, so it
 * reads as a line drawn over the room rather than one buried in a carcass. */
const STANDOFF_MM = 90;

/** Half-length of the tick at each end of a dimension line. */
const TICK_MM = 180;

/**
 * Where the selected cabinet sits, drawn on the scene.
 *
 * Not the measuring tool: nothing is picked. Selecting a cabinet is the whole
 * gesture, and what comes back is its **position** — the clear gap to each
 * side, and how high it hangs if it is a wall unit. `offsetsOf` decides the
 * numbers; this draws them.
 *
 * Each figure is also where it is changed: tap "835 mm", type 500, and the
 * cabinet slides until that gap is 500. The number a customer reads and the
 * number they type are the same number, measured to the same thing.
 *
 * The gaps run to whatever is actually in the way — a neighbour's edge, or the
 * wall — because that is what the customer can move into. A number measured
 * past a neighbour to the far wall would be a gap that isn't there.
 *
 * A zero gap draws nothing. A cabinet pushed flush against its neighbour is
 * the normal case in a run, and "0 mm" repeated down a wall is noise sitting
 * on top of the thing it describes.
 *
 * Rendered as a sibling of `Run`, like `MeasureOverlay` — the millimetres
 * `cabinetBoundsMm` reports are already the scene's outer world space, so no
 * group offset belongs here.
 */
export function PositionDimensions({
	position,
	offsets,
	layout,
	engine,
	onLayoutChange,
}: {
	position: Positioned;
	offsets: Offsets;
	layout: PlannerLayout;
	engine: PlannerEngine;
	onLayoutChange: (next: PlannerLayout) => void;
}) {
	const t = useCopy();
	const id = position.placed.id;
	const box = cabinetBoundsMm(position, layout, engine);

	/** Wall millimetres are measured from the left wall; the scene centres the
	 * run on the origin. Same shift `cabinetBoundsMm` applies. */
	const worldX = (alongWallMm: number) => alongWallMm - layout.wallWidthMm / 2;

	// On the floor for a base unit, at its own underside for a hung one: the
	// line belongs on the plane the cabinet slides along.
	const alongY = box.minY;
	const zMm = box.maxZ + STANDOFF_MM;

	return (
		<>
			{offsets.leftMm > 0 && (
				<Dimension
					fromMm={worldX(offsets.leftAnchorMm)}
					toMm={box.minX}
					atMm={alongY}
					zMm={zMm}
					valueMm={offsets.leftMm}
					label={t.planner.selection.editGap}
					onCommit={(mm) =>
						onLayoutChange(engine.setGap(layout, id, "left", mm))
					}
				/>
			)}

			{offsets.rightMm > 0 && (
				<Dimension
					fromMm={box.maxX}
					toMm={worldX(offsets.rightAnchorMm)}
					atMm={alongY}
					zMm={zMm}
					valueMm={offsets.rightMm}
					label={t.planner.selection.editGap}
					onCommit={(mm) =>
						onLayoutChange(engine.setGap(layout, id, "right", mm))
					}
				/>
			)}

			{offsets.floorMm !== null && offsets.floorMm > 0 && (
				<Dimension
					vertical
					fromMm={0}
					toMm={offsets.floorMm}
					atMm={box.minX}
					zMm={zMm}
					valueMm={offsets.floorMm}
					label={t.planner.selection.editGap}
					// Ceiling mode lines the tops up and `floorHeightMmOf` overrules any
					// stored height, so an edit there would change nothing on screen.
					onCommit={
						layout.wallToCeiling
							? undefined
							: (mm) => onLayoutChange(engine.setHangAt(layout, id, mm))
					}
				/>
			)}
		</>
	);
}

/**
 * One dimension line: the span, a tick at each end, and the figure.
 *
 * A vertical line is the same shape with the axes swapped — it runs up y at a
 * fixed x instead of along x at a fixed y — so `fromMm`/`toMm` are the span
 * and `atMm` is whichever coordinate stays put.
 */
function Dimension({
	fromMm,
	toMm,
	atMm,
	zMm,
	valueMm,
	vertical = false,
	label,
	onCommit,
}: {
	fromMm: number;
	toMm: number;
	atMm: number;
	zMm: number;
	valueMm: number;
	vertical?: boolean;
	label?: string;
	/** Present when the figure can be typed over. */
	onCommit?: (mm: number) => void;
}) {
	const z = m(zMm);
	const point = (alongMm: number): [number, number, number] =>
		vertical ? [m(atMm), m(alongMm), z] : [m(alongMm), m(atMm), z];

	const start = point(fromMm);
	const end = point(toMm);

	// The ticks run across the line: along the wall for a vertical span, and
	// straight up for a horizontal one — a gap on the floor is drawn at floor
	// level, so half a tick would be under it.
	const tick = (at: [number, number, number]): [number, number, number][] =>
		vertical
			? [
					[at[0] - m(TICK_MM) / 2, at[1], at[2]],
					[at[0] + m(TICK_MM) / 2, at[1], at[2]],
				]
			: [
					[at[0], at[1], at[2]],
					[at[0], at[1] + m(TICK_MM), at[2]],
				];

	return (
		<>
			<Line points={[start, end]} color={LINE_COLOR} lineWidth={2} />
			<Line points={tick(start)} color={LINE_COLOR} lineWidth={2} />
			<Line points={tick(end)} color={LINE_COLOR} lineWidth={2} />
			<Html
				position={point((fromMm + toMm) / 2)}
				center
				zIndexRange={[4, 0]}
				pointerEvents={onCommit ? "auto" : "none"}
			>
				{onCommit ? (
					<EditableFigure valueMm={valueMm} label={label} onCommit={onCommit} />
				) : (
					<span className={CHIP}>{Math.round(valueMm)} mm</span>
				)}
			</Html>
		</>
	);
}

/** The overlay sits inside the element the scene listens on, so a tap here
 * would otherwise land as a click on empty floor — deselecting the very
 * cabinet being edited — or start a drag. */
const keepFromScene = (e: SyntheticEvent) => e.stopPropagation();

function EditableFigure({
	valueMm,
	label,
	onCommit,
}: {
	valueMm: number;
	label?: string;
	onCommit: (mm: number) => void;
}) {
	const [editing, setEditing] = useState(false);

	if (editing) {
		return (
			<GapInput
				valueMm={valueMm}
				onCommit={onCommit}
				onDone={() => setEditing(false)}
				aria-label={label}
				autoFocus
				onFocus={(e) => e.currentTarget.select()}
				onPointerDown={keepFromScene}
				onClick={keepFromScene}
				className={`${CHIP} w-[64px] text-right outline-none ring-2 ring-[#1f5138]/30`}
			/>
		);
	}

	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onPointerDown={keepFromScene}
			onClick={(e) => {
				keepFromScene(e);
				setEditing(true);
			}}
			className={`${CHIP} cursor-text underline decoration-dotted underline-offset-2 hover:bg-[#e7efe9]`}
		>
			{Math.round(valueMm)} mm
		</button>
	);
}
