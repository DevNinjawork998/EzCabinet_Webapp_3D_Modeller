"use client";

import { Html } from "@react-three/drei";
import { fill } from "@/lib/copy/fill";
import { type FloorPlan, wallsOf } from "@/lib/planner/floorplan";
import { useCopy } from "./CopyContext";
import { EditableFigure } from "./PositionDimensions";

const m = (mm: number) => mm / 1000;
/** How far inside the room a wall's label sits, clear of the wall itself. */
const INSET_MM = 300;

/**
 * Each wall's length, on the plan, editable in place — the IKEA room editor.
 * Tapping one also makes that wall the one the add menu builds on. The engine
 * clamps whatever is typed, so a wall never shrinks through its cabinets.
 */
export function WallLengths({
	plan,
	onPickAction,
	onLengthAction,
}: {
	plan: FloorPlan;
	onPickAction?: (wall: number) => void;
	onLengthAction: (wall: number, mm: number) => void;
}) {
	const t = useCopy();
	return (
		<>
			{wallsOf(plan).map((wall, i) => (
				<Html
					// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
					key={i}
					position={[
						m(
							(wall.startMm.xMm + wall.endMm.xMm) / 2 +
								wall.inward.xMm * INSET_MM,
						),
						0.02,
						m(
							(wall.startMm.zMm + wall.endMm.zMm) / 2 +
								wall.inward.zMm * INSET_MM,
						),
					]}
					center
					zIndexRange={[4, 0]}
				>
					{/* Capture, so the pick happens before the figure stops the
					    event from reaching the scene. */}
					<div onPointerDownCapture={() => onPickAction?.(i)}>
						<EditableFigure
							valueMm={wall.lengthMm}
							label={fill(t.planner.room.wallName, { n: i + 1 })}
							onCommit={(mm) => onLengthAction(i, mm)}
						/>
					</div>
				</Html>
			))}
		</>
	);
}
