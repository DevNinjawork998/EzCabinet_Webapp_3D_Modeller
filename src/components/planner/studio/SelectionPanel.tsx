"use client";

import { fill } from "@/lib/copy/fill";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import type { HingeSide, Offsets, Positioned } from "@/lib/planner/layout";
import type { RoomLayout } from "@/lib/planner/room";
import { useCopy } from "../CopyContext";
import { GapInput } from "../GapInput";
import { chip, verbBtn } from "./chrome";

/**
 * Which verb has an open section under the list.
 *
 * Duplicate and Remove are on the same list but are not verbs in this sense —
 * they happen on press and open nothing, so they never become the value here.
 */
export type SelectionVerb = "resize" | "replace" | "move" | null;

export function SelectionPanel({
	catalogue,
	layout,
	selected,
	verb,
	onVerbAction,
	widthOptions,
	replaceOptions,
	doorsOpen,
	hingeOptions,
	leaves,
	priceLabel,
	onWidthAction,
	onReplaceAction,
	offsets,
	onGapAction,
	onSwapAction,
	canSwap,
	onHangAtAction,
	onRotationAction,
	onToggleDoorAction,
	onHingeAction,
	onDoorStyleAction,
	onDuplicateAction,
	onRemoveAction,
}: {
	catalogue: PlannerCatalogue;
	layout: RoomLayout;
	selected: Positioned;
	verb: SelectionVerb;
	onVerbAction: (verb: SelectionVerb) => void;
	widthOptions: { widthMm: number; fits: boolean }[];
	/** Families in the same row as this cabinet — the only legal swaps. */
	replaceOptions: {
		id: string;
		label: string;
		meta: string;
		current: boolean;
	}[];
	doorsOpen: boolean;
	hingeOptions: { side: HingeSide; label: string }[];
	/** How many leaves this front is split into. A pair gets no hinge choice. */
	leaves: number;
	priceLabel: string;
	onWidthAction: (widthMm: number) => void;
	onReplaceAction: (familyId: string) => void;
	/** The clear gap each side, as `offsetsOf` measures it. */
	offsets: Offsets | null;
	onGapAction: (side: "left" | "right", mm: number) => void;
	onSwapAction: (direction: 1 | -1) => void;
	/** Any cabinet — the row it belongs to has a height and this one may sit
	 * off it, on the floor as readily as on the wall. */
	onHangAtAction: (mm: number) => void;
	/** Turn it on the spot, in degrees. */
	onRotationAction: (deg: number) => void;
	/** Whether there is a cabinet on that side to trade places with. */
	canSwap: { left: boolean; right: boolean };
	onToggleDoorAction: () => void;
	onHingeAction: (side: HingeSide) => void;
	onDoorStyleAction: (doorStyleId: string) => void;
	onDuplicateAction: () => void;
	onRemoveAction: () => void;
}) {
	const t = useCopy();
	const isWall = selected.family.kind === "wall";
	const hangAtMm =
		selected.placed.hangAtMm ??
		(isWall ? layout.hangingHeightMm : selected.family.floorHeightMm);

	const verbs = [
		// One design is one width: a cabinet with a single size has nothing to
		// resize to, and a greyed-out verb would read as broken.
		...(selected.family.sizes.length > 1
			? [
					{
						key: "resize" as const,
						label: t.planner.selection.verbResize,
						meta: `${selected.widthMm} mm`,
						press: () => onVerbAction(verb === "resize" ? null : "resize"),
					},
				]
			: []),
		{
			key: "replace" as const,
			label: t.planner.selection.verbReplace,
			meta: selected.family.label,
			press: () => onVerbAction(verb === "replace" ? null : "replace"),
		},
		{
			key: "move" as const,
			label: t.planner.selection.verbMove,
			meta: t.planner.selection.moveMeta,
			press: () => onVerbAction(verb === "move" ? null : "move"),
		},
		{
			key: "doors" as const,
			label: doorsOpen
				? t.planner.selection.verbCloseDoors
				: t.planner.selection.verbOpenDoors,
			meta: "",
			press: onToggleDoorAction,
			disabled: selected.placed.doorStyleId === null,
		},
		{
			key: "duplicate" as const,
			label: t.planner.selection.duplicate,
			meta: "⌘D",
			press: onDuplicateAction,
		},
		{
			key: "remove" as const,
			label: t.planner.selection.remove,
			meta: "Del",
			danger: true,
			press: onRemoveAction,
		},
	];

	return (
		<div>
			<div className="border-[#f0efec] border-b px-4 py-3.5">
				<p className="font-semibold text-[11px] text-[#1f5138] uppercase tracking-[0.06em]">
					{t.planner.selection.heading}
				</p>
				<p className="mt-1 font-semibold text-[15px]">
					{fill(t.planner.selection.nameWidth, {
						name: selected.family.label,
						width: selected.widthMm,
					})}
				</p>
				<p className="mt-0.5 text-[12px] text-neutral-500">
					{selected.widthMm} × {selected.family.heightMm} ×{" "}
					{selected.family.depthMm} mm · {priceLabel}
					{/* The height only when it is worth saying: a hung cabinet always
					    has one, and a floor unit only once it has been lifted. */}
					{isWall || selected.placed.hangAtMm !== undefined
						? ` · ${fill(t.planner.selection.hangsAt, { mm: hangAtMm })}`
						: ""}
					{selected.placed.rotationDeg
						? ` · ${selected.placed.rotationDeg}°`
						: ""}
				</p>
			</div>

			<div className="flex flex-col gap-1.5 border-[#f0efec] border-b px-4 py-3">
				{verbs.map((option) => (
					<button
						key={option.key}
						type="button"
						onClick={option.press}
						disabled={"disabled" in option ? option.disabled : false}
						aria-pressed={option.key === verb}
						className={`${verbBtn(
							option.key === verb,
							"danger" in option ? option.danger : false,
						)} disabled:cursor-not-allowed disabled:text-neutral-300`}
					>
						<span className="font-medium text-[13px]">{option.label}</span>
						<span className="ml-auto text-[11px] text-[#8a857c]">
							{option.meta}
						</span>
					</button>
				))}
			</div>

			{verb === "resize" && (
				<section className="flex flex-col gap-2 border-[#f0efec] border-b px-4 py-3.5">
					<p className="font-semibold text-[12px] text-neutral-700">
						{t.planner.selection.width}
					</p>
					<div className="flex flex-wrap gap-1">
						{widthOptions.map((option) => (
							<button
								key={option.widthMm}
								type="button"
								disabled={!option.fits}
								onClick={() => onWidthAction(option.widthMm)}
								aria-pressed={option.widthMm === selected.widthMm}
								className={`${chip(
									option.widthMm === selected.widthMm,
								)} disabled:cursor-not-allowed disabled:text-neutral-300`}
							>
								{option.widthMm}
								{!option.fits && ` · ${t.planner.selection.noRoom}`}
							</button>
						))}
					</div>
					<p className="text-[11px] text-[#8a857c] leading-[15px]">
						{fill(t.planner.selection.widthHint, {
							name: selected.family.label,
							n: selected.family.sizes.length,
						})}
					</p>
				</section>
			)}

			{verb === "replace" && (
				<section className="flex flex-col gap-1.5 border-[#f0efec] border-b px-4 py-3.5">
					<p className="font-semibold text-[12px] text-neutral-700">
						{t.planner.selection.replaceHeading}
					</p>
					{replaceOptions.map((option) => (
						<button
							key={option.id}
							type="button"
							onClick={() => onReplaceAction(option.id)}
							aria-pressed={option.current}
							className={verbBtn(option.current)}
						>
							<span className="font-medium text-[13px]">{option.label}</span>
							<span className="ml-auto text-[11px] text-[#8a857c]">
								{option.meta}
							</span>
						</button>
					))}
				</section>
			)}

			{verb === "move" && (
				<section className="flex flex-col gap-2 border-[#f0efec] border-b px-4 py-3.5">
					<p className="font-semibold text-[12px] text-neutral-700">
						{t.planner.selection.positionHeading}
					</p>
					<div className="flex gap-1">
						<button
							type="button"
							onClick={() => onSwapAction(-1)}
							disabled={!canSwap.left}
							aria-label={t.planner.selection.swapLeft}
							title={t.planner.selection.swapLeft}
							className="flex h-9 flex-1 items-center justify-center rounded-lg border border-neutral-300 text-[15px] text-[#1f5138] hover:bg-[#e7efe9] disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-300 disabled:hover:bg-transparent"
						>
							←
						</button>
						<button
							type="button"
							onClick={() => onSwapAction(1)}
							disabled={!canSwap.right}
							aria-label={t.planner.selection.swapRight}
							title={t.planner.selection.swapRight}
							className="flex h-9 flex-1 items-center justify-center rounded-lg border border-neutral-300 text-[15px] text-[#1f5138] hover:bg-[#e7efe9] disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-300 disabled:hover:bg-transparent"
						>
							→
						</button>
					</div>

					{/* The same two gaps the dimension lines draw, measured to the same
					    neighbour or wall. A "from left wall" figure measured past the
					    neighbour read 1990 beside a line reading 1410 — two numbers
					    for one position, and the customer could not match them. */}
					{offsets &&
						(["left", "right"] as const).map((side) => (
							<div
								key={side}
								className="flex items-center justify-between gap-2"
							>
								<label
									htmlFor={`gap-${side}`}
									className="text-[12px] text-neutral-500"
								>
									{side === "left"
										? t.planner.selection.gapLeft
										: t.planner.selection.gapRight}
								</label>
								<span className="flex items-center gap-1">
									<GapInput
										id={`gap-${side}`}
										valueMm={side === "left" ? offsets.leftMm : offsets.rightMm}
										onCommit={(mm) => onGapAction(side, mm)}
										className="w-[70px] rounded-[7px] border border-neutral-300 px-2 py-1.5 text-right text-[12px]"
									/>
									<span className="text-[11px] text-[#8a857c]">mm</span>
								</span>
							</div>
						))}
					<div className="flex items-center justify-between gap-2">
						<label htmlFor="hangatmm" className="text-[12px] text-neutral-500">
							{isWall
								? t.planner.selection.hangAtThis
								: t.planner.selection.standsAt}
						</label>
						<span className="flex items-center gap-1">
							<input
								id="hangatmm"
								type="number"
								step={10}
								value={hangAtMm}
								onChange={(e) => onHangAtAction(Number(e.target.value))}
								className="w-[70px] rounded-[7px] border border-neutral-300 px-2 py-1.5 text-right text-[12px]"
							/>
							<span className="text-[11px] text-[#8a857c]">mm</span>
						</span>
					</div>

					{/* The angle in figures as well as on the ring. A turn is a drag
					    round a gizmo, which is exactly the gesture a thumb on a phone
					    is worst at — so the number is typeable too. */}
					<div className="flex items-center justify-between gap-2">
						<label
							htmlFor="rotationdeg"
							className="text-[12px] text-neutral-500"
						>
							{t.planner.selection.turnedBy}
						</label>
						<span className="flex items-center gap-1">
							<input
								id="rotationdeg"
								type="number"
								step={15}
								value={selected.placed.rotationDeg ?? 0}
								onChange={(e) => onRotationAction(Number(e.target.value))}
								className="w-[70px] rounded-[7px] border border-neutral-300 px-2 py-1.5 text-right text-[12px]"
							/>
							<span className="text-[11px] text-[#8a857c]">°</span>
						</span>
					</div>

					<p className="text-[11px] text-[#8a857c] leading-[15px]">
						{t.planner.selection.swapHint}
					</p>
				</section>
			)}

			<section className="flex flex-col gap-2 px-4 py-3.5">
				<p className="font-semibold text-[11px] text-neutral-600 uppercase tracking-[0.06em]">
					{t.planner.selection.front}
				</p>
				<div className="flex flex-wrap gap-1">
					{catalogue.doorStyles.map((style) => (
						<button
							key={style.id}
							type="button"
							onClick={() => onDoorStyleAction(style.id)}
							aria-pressed={selected.placed.doorStyleId === style.id}
							className={chip(selected.placed.doorStyleId === style.id)}
						>
							{style.label}
						</button>
					))}
				</div>

				{/* Only a lone leaf gets a choice: a pair always hinges outward from
				    the middle, which is the only way a pair is hung. */}
				{selected.placed.doorStyleId && leaves === 1 && (
					<div className="flex flex-wrap gap-1">
						{hingeOptions.map((option) => (
							<button
								key={option.side}
								type="button"
								onClick={() => onHingeAction(option.side)}
								aria-pressed={selected.placed.hinge === option.side}
								className={chip(selected.placed.hinge === option.side)}
							>
								{option.label}
							</button>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
