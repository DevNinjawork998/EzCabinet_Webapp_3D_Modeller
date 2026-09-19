"use client";

import { fill } from "@/lib/copy/fill";
import { CEILING_LIMITS, type RoomTypeId } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import {
	type FloorPlan,
	outlineOf,
	type RoomShape,
	reshape,
	wallLabelMm,
	wallsOf,
} from "@/lib/planner/floorplan";
import type { RoomLayout } from "@/lib/planner/room";
import { useCopy } from "../CopyContext";
import { DimensionField } from "../DimensionField";
import { chip } from "./chrome";

/** A wall's number, in a matching badge wherever it shows up: the map, the
 * field list and the 3D floor. One target colour (`#1f5138`, the brand
 * green) so a customer can match a field to a wall without reading labels. */
function WallBadge({
	n,
	target,
	label,
}: {
	n: number;
	target: boolean;
	label: string;
}) {
	return (
		<span
			aria-hidden="true"
			title={label}
			className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px]"
			style={{
				backgroundColor: target ? "#1f5138" : "#e5e5e5",
				color: target ? "#ffffff" : "#525252",
			}}
		>
			{n}
		</span>
	);
}

/** The room's own floor plan, small: every wall numbered so a customer can
 * find "wall 3" in the room rather than guess from a list. Inline SVG, per
 * CLAUDE.md — no WebGL context for a thumbnail. */
function WallMap({
	plan,
	targetWall,
	onPickAction,
}: {
	plan: FloorPlan;
	targetWall: number;
	onPickAction: (wall: number) => void;
}) {
	const t = useCopy();
	const walls = wallsOf(plan);
	const outline = outlineOf(plan);
	const xs = outline.map((p) => p.xMm);
	const zs = outline.map((p) => p.zMm);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minZ = Math.min(...zs);
	const maxZ = Math.max(...zs);
	const width = maxX - minX;
	const height = maxZ - minZ;
	const margin = Math.max(width, height) * 0.18;
	const insetMm = Math.min(width, height) * 0.12;

	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: each badge inside carries its own aria-label
		<svg
			viewBox={`${minX - margin} ${minZ - margin} ${width + margin * 2} ${height + margin * 2}`}
			preserveAspectRatio="xMidYMid meet"
			className="h-[140px] w-full"
		>
			<polygon
				points={outline.map((p) => `${p.xMm},${p.zMm}`).join(" ")}
				fill="#f4f3f1"
			/>
			{walls.map((wall, i) => (
				<line
					// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
					key={i}
					x1={wall.startMm.xMm}
					y1={wall.startMm.zMm}
					x2={wall.endMm.xMm}
					y2={wall.endMm.zMm}
					stroke={i === targetWall ? "#1f5138" : "#a3a3a3"}
					strokeWidth={i === targetWall ? width * 0.014 : width * 0.007}
					strokeLinecap="round"
				/>
			))}
			{walls.map((wall, i) => {
				const { xMm, zMm } = wallLabelMm(wall, insetMm);
				const label = fill(t.planner.room.wallName, { n: i + 1 });
				return (
					// biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; role+tabIndex+onKeyDown makes this one
					<g
						// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
						key={i}
						role="button"
						tabIndex={0}
						aria-label={label}
						onClick={() => onPickAction(i)}
						onKeyDown={(e) => {
							if (e.key !== "Enter" && e.key !== " ") return;
							e.preventDefault();
							onPickAction(i);
						}}
						style={{ cursor: "pointer" }}
					>
						<circle
							cx={xMm}
							cy={zMm}
							r={insetMm * 0.55}
							fill={i === targetWall ? "#1f5138" : "#ffffff"}
							stroke={i === targetWall ? "#1f5138" : "#a3a3a3"}
							strokeWidth={width * 0.004}
						/>
						<text
							x={xMm}
							y={zMm}
							textAnchor="middle"
							dominantBaseline="central"
							fontSize={insetMm * 0.7}
							fill={i === targetWall ? "#ffffff" : "#525252"}
						>
							{i + 1}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

const SHAPES: RoomShape[] = ["rect", "l", "l-mirror"];

/** A shape's outline, drawn from the template itself so the picture can never
 * disagree with the room it makes. Inline SVG, per CLAUDE.md: no WebGL
 * context per thumbnail. */
function ShapeThumb({ shape }: { shape: RoomShape }) {
	const plan = reshape(
		{ template: "rect", widthMm: 3000, depthMm: 3000 },
		shape,
	);
	const points = outlineOf(plan)
		.map((p) => `${p.xMm},${p.zMm}`)
		.join(" ");
	return (
		<svg viewBox="-1700 -1700 3400 3400" className="h-8 w-8" aria-hidden="true">
			<polygon
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth={160}
			/>
		</svg>
	);
}

/**
 * The Room panel body: which room, what shape, how long each wall is, and
 * whether the targeted wall's run fits on it.
 */
export function RoomPanel({
	catalogue,
	roomId,
	layout,
	freeMm,
	overhangMm,
	shape,
	reachable,
	wallRanges,
	targetWall,
	onShapeAction,
	onChangeRoomAction,
	onWallLengthAction,
	onTargetWallAction,
	onCeilingAction,
	onOpenDefaultsAction,
}: {
	catalogue: PlannerCatalogue;
	roomId: RoomTypeId;
	layout: RoomLayout;
	/** Wall left over on the targeted wall, negative when its run is longer. */
	freeMm: number;
	overhangMm: number;
	shape: RoomShape;
	/** Which shapes a press would actually reach. */
	reachable: Record<RoomShape, boolean>;
	/** Per wall, the lengths `setWallLength` will actually reach. */
	wallRanges: { minMm: number; maxMm: number }[];
	targetWall: number;
	onShapeAction: (shape: RoomShape) => void;
	onChangeRoomAction: (id: RoomTypeId) => void;
	onWallLengthAction: (wall: number, mm: number) => void;
	onTargetWallAction: (wall: number) => void;
	onCeilingAction: (mm: number) => void;
	onOpenDefaultsAction: () => void;
}) {
	const t = useCopy();
	const shapeLabel: Record<RoomShape, string> = {
		rect: t.planner.room.shapeRect,
		l: t.planner.room.shapeL,
		"l-mirror": t.planner.room.shapeLMirror,
	};

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
					{SHAPES.map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={shape === option}
							aria-label={shapeLabel[option]}
							title={shapeLabel[option]}
							disabled={option !== shape && !reachable[option]}
							onClick={() => onShapeAction(option)}
							className={`${chip(shape === option)} disabled:cursor-not-allowed disabled:text-neutral-300`}
						>
							<ShapeThumb shape={option} />
						</button>
					))}
				</div>
				{SHAPES.some((option) => option !== shape && !reachable[option]) && (
					<p className="text-[11px] text-neutral-500 leading-4">
						{t.planner.room.shapeLocked}
					</p>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<p className="text-[11px] text-neutral-500 leading-4">
					{t.planner.room.wallsHint}
				</p>
				<WallMap
					plan={layout.plan}
					targetWall={targetWall}
					onPickAction={onTargetWallAction}
				/>
				{wallsOf(layout.plan).map((wall, i) => {
					const label = fill(t.planner.room.wallName, { n: i + 1 });
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: a wall's index is its identity
							key={i}
							onFocusCapture={() => onTargetWallAction(i)}
							className={`flex items-center gap-2 ${i === targetWall ? "rounded-lg bg-[#eef3ef] p-1" : "p-1"}`}
						>
							<WallBadge n={i + 1} target={i === targetWall} label={label} />
							<div className="flex-1">
								<DimensionField
									label={label}
									valueMm={wall.lengthMm}
									minMm={wallRanges[i]?.minMm ?? wall.lengthMm}
									maxMm={wallRanges[i]?.maxMm ?? wall.lengthMm}
									stepMm={50}
									onChangeAction={(mm) => onWallLengthAction(i, mm)}
								/>
							</div>
						</div>
					);
				})}
			</div>

			<DimensionField
				label={t.planner.room.ceiling}
				valueMm={layout.ceilingHeightMm}
				minMm={CEILING_LIMITS.minMm}
				maxMm={CEILING_LIMITS.maxMm}
				stepMm={50}
				onChangeAction={onCeilingAction}
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
