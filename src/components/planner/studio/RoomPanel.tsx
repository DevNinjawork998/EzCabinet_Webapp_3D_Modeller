"use client";

import { fill } from "@/lib/copy/fill";
import {
	CEILING_LIMITS,
	ROOM_DEPTH_LIMITS,
	type RoomTypeId,
} from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { WALL_LIMITS } from "@/lib/planner/layout";
import type { RoomLayout, RoomShape } from "@/lib/planner/room";
import { useCopy } from "../CopyContext";
import { DimensionField } from "../DimensionField";
import { chip } from "./chrome";

/**
 * The Room panel body: which room, how big, and whether the run fits in it.
 *
 * Everything else that used to live here — the base, run, wall-unit and door
 * modes — is behind the Defaults panel now. What is left is the one question
 * this panel exists to answer, which is what the cabinets have to fit inside.
 *
 * It was a permanent 236px column until the rail grew a Room tool. Three
 * sliders you set once at the start do not earn a fifth of the window for the
 * whole session, and the right-hand recap prints the same wall, run and
 * wall-free figures anyway — so what was lost by moving it here is the sliders
 * being in reach, never the numbers being in view. `StudioPanel` supplies the
 * heading, the hint and the scroll container this used to carry itself.
 */
export function RoomPanel({
	catalogue,
	roomId,
	layout,
	minWallMm,
	freeMm,
	overhangMm,
	shape,
	reachable,
	minDepthMm,
	onShapeAction,
	onChangeRoomAction,
	onWallWidthAction,
	onCeilingAction,
	onDepthAction,
	onOpenDefaultsAction,
}: {
	catalogue: PlannerCatalogue;
	roomId: RoomTypeId;
	layout: RoomLayout;
	/** The shortest wall the placed run fits on — the slider's real floor. */
	minWallMm: number;
	/** Wall left over, negative when the run is longer than the wall. */
	freeMm: number;
	overhangMm: number;
	/** One wall, or which side the corner of an L is on. */
	shape: RoomShape;
	/** Which shapes a press would actually reach. One wall is refused while the
	 * side wall or corner holds anything; an L while the main run fills the end
	 * its corner would take. */
	reachable: Record<RoomShape, boolean>;
	/** The shortest room the side wall's cabinets fit in. */
	minDepthMm: number;
	onShapeAction: (shape: RoomShape) => void;
	onChangeRoomAction: (id: RoomTypeId) => void;
	onWallWidthAction: (mm: number) => void;
	onCeilingAction: (mm: number) => void;
	onDepthAction: (mm: number) => void;
	onOpenDefaultsAction: () => void;
}) {
	const t = useCopy();

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap gap-1">
				{catalogue.roomTypes.map((option) => (
					<button
						key={option.id}
						type="button"
						// A room with no cabinets yet has nothing to plan with.
						disabled={option.familyIds.length === 0}
						onClick={() => onChangeRoomAction(option.id)}
						aria-pressed={option.id === roomId}
						className={`${chip(option.id === roomId)} disabled:cursor-not-allowed disabled:text-neutral-300`}
					>
						{option.label}
						{option.familyIds.length === 0 && ` · ${t.common.comingSoon}`}
					</button>
				))}
			</div>

			<div className="flex flex-col gap-1.5">
				<p className="text-[12px] text-neutral-600">{t.planner.room.shape}</p>
				<div className="flex flex-wrap gap-1">
					{(
						[
							["straight", t.planner.room.shapeStraight],
							["left", t.planner.room.shapeLeft],
							["right", t.planner.room.shapeRight],
						] as const
					).map(([option, label]) => (
						<button
							key={option}
							type="button"
							aria-pressed={shape === option}
							disabled={option !== shape && !reachable[option]}
							onClick={() => onShapeAction(option)}
							className={`${chip(shape === option)} disabled:cursor-not-allowed disabled:text-neutral-300`}
						>
							{label}
						</button>
					))}
				</div>
				{shape !== "straight" && !reachable.straight && (
					<p className="text-[11px] text-neutral-500 leading-4">
						{t.planner.room.shapeLocked}
					</p>
				)}
				{(["left", "right"] as const).some(
					(option) => option !== shape && !reachable[option],
				) && (
					<p className="text-[11px] text-neutral-500 leading-4">
						{t.planner.room.shapeRefused}
					</p>
				)}
			</div>

			<DimensionField
				label={t.planner.room.wallLength}
				valueMm={layout.wallWidthMm}
				minMm={minWallMm}
				maxMm={WALL_LIMITS.maxMm}
				stepMm={50}
				onChangeAction={onWallWidthAction}
			/>
			{minWallMm > WALL_LIMITS.minMm && layout.wallWidthMm === minWallMm && (
				<p className="-mt-1 text-[11px] text-neutral-500 leading-4">
					{fill(t.planner.room.narrowWallNote, { min: minWallMm })}
				</p>
			)}

			<DimensionField
				label={t.planner.room.ceiling}
				valueMm={layout.ceilingHeightMm}
				minMm={CEILING_LIMITS.minMm}
				maxMm={CEILING_LIMITS.maxMm}
				stepMm={50}
				onChangeAction={onCeilingAction}
			/>

			<DimensionField
				label={
					shape === "straight"
						? t.planner.room.roomDepth
						: t.planner.room.sideWallLength
				}
				valueMm={layout.roomDepthMm}
				minMm={minDepthMm}
				maxMm={ROOM_DEPTH_LIMITS.maxMm}
				stepMm={50}
				onChangeAction={onDepthAction}
			/>

			<div className="mt-0.5 flex flex-col gap-1.5 border-[#f0efec] border-t pt-3">
				<p className="text-[12px] text-neutral-500 leading-[17px]">
					{/* `freeMm` arrives in whole millimetres; see StudioScreen. */}
					{freeMm < 0
						? fill(t.planner.room.fitOver, { mm: -freeMm })
						: fill(t.planner.room.fitFree, { mm: freeMm })}
				</p>

				{/* The run overhanging the wall and the run being longer than the
				    wall are two different sentences: one is about the cabinets
				    hanging past the end, the other about the wall being too short
				    to hold them. */}
				{overhangMm > 0 && (
					<p className="text-[11px] text-amber-700 leading-4">
						{fill(t.planner.room.overhangWarning, { overhang: overhangMm })}
					</p>
				)}

				<button
					type="button"
					onClick={onOpenDefaultsAction}
					className="min-h-9 self-start rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[12px] text-neutral-700 hover:bg-[#faf9f7] hover:text-neutral-900"
				>
					{t.planner.room.moreSettings}
				</button>
			</div>
		</div>
	);
}
