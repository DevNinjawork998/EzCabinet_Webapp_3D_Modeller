"use client";

import { Html } from "@react-three/drei";
import { fill } from "@/lib/copy/fill";
import { type FloorPlan, wallLabelMm, wallsOf } from "@/lib/planner/floorplan";
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
			{wallsOf(plan).map((wall, i) => {
				const label = fill(t.planner.room.wallName, { n: i + 1 });
				const { xMm, zMm } = wallLabelMm(wall, INSET_MM);
				return (
					<Html
						// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
						key={i}
						position={[m(xMm), 0.02, m(zMm)]}
						center
						zIndexRange={[4, 0]}
					>
						{/* Capture, so the pick happens before the figure stops the
						    event from reaching the scene. */}
						<div
							onPointerDownCapture={() => onPickAction?.(i)}
							className="flex items-center gap-1"
						>
							<span className="rounded bg-white/90 px-1 text-[10px] text-neutral-500">
								{label}
							</span>
							<EditableFigure
								valueMm={wall.lengthMm}
								label={label}
								onCommit={(mm) => onLengthAction(i, mm)}
							/>
						</div>
					</Html>
				);
			})}
		</>
	);
}

/** How far out from the wall a floor badge sits, in the room's own units. */
const BADGE_INSET_MM = 350;

/**
 * A numbered chip at the foot of every wall, shown in 3D and elevation while
 * the Room panel is open — the plan view already has `WallLengths` for this.
 * Tapping one targets that wall, the same as tapping the wall itself.
 */
export function WallNumbers({
	plan,
	targetWall,
	onPickAction,
}: {
	plan: FloorPlan;
	targetWall: number;
	onPickAction?: (wall: number) => void;
}) {
	const t = useCopy();
	return (
		<>
			{wallsOf(plan).map((wall, i) => {
				const { xMm, zMm } = wallLabelMm(wall, BADGE_INSET_MM);
				const target = i === targetWall;
				return (
					<Html
						// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
						key={i}
						position={[m(xMm), 0.02, m(zMm)]}
						center
						zIndexRange={[3, 0]}
					>
						<button
							type="button"
							aria-label={fill(t.planner.room.wallName, { n: i + 1 })}
							onPointerDownCapture={(e) => {
								e.stopPropagation();
								onPickAction?.(i);
							}}
							onClick={(e) => e.stopPropagation()}
							className="flex h-6 w-6 items-center justify-center rounded-full font-medium text-[11px] shadow-sm"
							style={{
								backgroundColor: target ? "#1f5138" : "#ffffff",
								color: target ? "#ffffff" : "#525252",
								border: `1px solid ${target ? "#1f5138" : "#a3a3a3"}`,
							}}
						>
							{i + 1}
						</button>
					</Html>
				);
			})}
		</>
	);
}
