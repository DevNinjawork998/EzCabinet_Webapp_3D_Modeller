"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { CATEGORIES } from "@/lib/catalogue/cabinetDesignLabels";
import type { Dictionary } from "@/lib/copy/en";
import { fill } from "@/lib/copy/fill";
import { htmlLang } from "@/lib/copy/locales";
import { splitDoorLeaves } from "@/lib/mesh/renderMesh";
import {
	type Construction,
	constructionOf,
	type FinishId,
	familyIn,
	isCorner,
	type RoomTypeId,
	roomTypeIn,
	WALL_HANG_LIMITS,
} from "@/lib/planner/catalogue";
import { type HingeSide, type Positioned, rowFor } from "@/lib/planner/layout";
import {
	AXIS_COLOR,
	AXIS_LABEL,
	isAxisSignificant,
	MEASURE_AXES,
	type MeasureAxis,
	measure,
	SNAP_LABEL,
	type SnapPoint,
} from "@/lib/planner/measure";
import { fitOutOf } from "@/lib/planner/parts";
import { computePlannerPrice } from "@/lib/planner/pricing";
import {
	emptyRoom,
	type RoomLayout,
	runIndexOf,
	setDoors,
	setHinge,
} from "@/lib/planner/room";
import { useCatalogue, useRoomEngine } from "./CatalogueContext";
import { useCopy, useLocale } from "./CopyContext";
import { peekDesignMesh } from "./DesignedCabinet";
import { DimensionField } from "./DimensionField";
import { AdminLink, PlannerHeader } from "./PlannerHeader";
import type { PlannerView } from "./PlannerScene";
import { priceLineDetail, priceLineLabel } from "./priceLineCopy";
import { CabinetMenu } from "./studio/CabinetMenu";
import { DesignRecap } from "./studio/DesignRecap";
import { PriceFooter } from "./studio/PriceFooter";
import { RoomPanel } from "./studio/RoomPanel";
import { RunList } from "./studio/RunList";
import { SelectionPanel, type SelectionVerb } from "./studio/SelectionPanel";
import { PanelOption, PanelToggle, StudioPanel } from "./studio/StudioPanel";
import { type StudioTool, ToolRail } from "./studio/ToolRail";
import { FamilyThumb } from "./thumbs";

/** Where a family with no library category is shelved in the add menu. */
const KIND_CATEGORY = {
	base: "BASE_CABINET",
	wall: "WALL_CABINET",
	tall: "TALL_CABINET",
} as const;

function ScenePlaceholder() {
	const t = useCopy();
	return (
		<div className="flex h-full items-center justify-center text-neutral-500 text-sm">
			{t.planner.canvas.loading}
		</div>
	);
}

const PlannerScene = dynamic(() => import("./PlannerScene"), {
	ssr: false,
	loading: () => <ScenePlaceholder />,
});

/** Labels for the view toggle, in the order a fitter reads them. */
const views = (t: Dictionary): { id: PlannerView; label: string }[] => [
	{ id: "3d", label: t.planner.view.threeD },
	{ id: "elevation", label: t.planner.view.elevation },
	{ id: "plan", label: t.planner.view.plan },
];

/** Hung at a set height, or run up to the ceiling. The stored hang height
 *  survives the switch, so this is a mode and not a destructive edit. */
const wallModes = (t: Dictionary): { toCeiling: boolean; label: string }[] => [
	{ toCeiling: false, label: t.planner.room.hanging },
	{ toCeiling: true, label: t.planner.room.toCeiling },
];

/** Kick board over the legs, or the levellers left on show. Most people want
 *  the board; a few like the furniture look of the feet. */
const baseModes = (t: Dictionary): { skirted: boolean; label: string }[] => [
	{ skirted: true, label: t.planner.room.skirted },
	{ skirted: false, label: t.planner.room.legsShown },
];

/** Built into the alcove, or standing clear of the side walls. */
const runModes = (t: Dictionary): { toWall: boolean; label: string }[] => [
	{ toWall: false, label: t.planner.room.openEnds },
	{ toWall: true, label: t.planner.room.toWalls },
];

/** Doors shut, or swung open so the customer can see the inside they are
 *  buying. View state, never on the layout — see `openIds`. */
/**
 * How the run shows its fronts.
 *
 * `hidden` exists because `open` cannot answer "show me every interior". Two
 * cabinets whose doors hinge on the same shared stile cannot both be open —
 * not here and not in a real kitchen — so swinging them all at once stacks
 * two leaves into the same space whatever angle they stop at. Taking the
 * fronts away is the honest way to show the whole run at once, and it is what
 * this toggle was specified as from the start.
 */
type DoorView = "closed" | "open" | "hidden";

const doorModes = (t: Dictionary): { id: DoorView; label: string }[] => [
	{ id: "closed", label: t.planner.room.doorsClosed },
	{ id: "open", label: t.planner.room.doorsOpen },
	{ id: "hidden", label: t.planner.room.doorsHidden },
];

/** Which stile a lone door hangs on, named the way a fitter says it. */
const hingeSides = (t: Dictionary): { side: HingeSide; label: string }[] => [
	{ side: "left", label: t.planner.selection.hingeLeft },
	{ side: "right", label: t.planner.selection.hingeRight },
];

/**
 * How many leaves this cabinet's front is split into — one gets a hinge choice,
 * a pair does not.
 *
 * Read off the *drawn* geometry wherever there is any. The drafted mesh is the
 * primary path and it disagrees with `fitOutOf` in practice: the client's own
 * base-cabinet family carries `geometry.doorLeaves: 2` learned from one design,
 * so every rung claims a pair, while their drawn 600 and 800 are single doors.
 * Trusting the family there would deny a hinge choice to exactly the cabinets
 * that need one.
 *
 * `peekDesignMesh` is null until the bytes land, and the fallback is then both
 * the right answer and the geometry actually on screen.
 */
const leavesOn = (position: Positioned, construction: Construction) => {
	const groups = peekDesignMesh(
		position.family.sizes.find((size) => size.widthMm === position.widthMm)
			?.meshDesignId,
	);
	const door = groups?.find((group) => group.role === "door");
	return door
		? splitDoorLeaves(door).length
		: fitOutOf(position.family, position.widthMm, construction).doorLeaves;
};

/** A single W/H/D value, colour-matched to its dashed leg in the 3D overlay
 * (`AXIS_COLOR`) — the pairing a floating in-scene label used to try to make
 * and failed at once the leg got too short on screen to hold text. */
function DimChip({
	axis,
	valueMm,
	maxAxisMm,
}: {
	axis: "x" | "y" | "z";
	valueMm: number;
	/** Largest of the measurement's three axis deltas — a chip only shows if
	 * its own value is significant relative to this, not just nonzero. */
	maxAxisMm: number;
}) {
	// Not a dimension the user meant to read — a width pick shouldn't also
	// report a stray few cm of "depth" from an imprecise click.
	if (!isAxisSignificant(valueMm, maxAxisMm)) return null;

	const letter = axis === "x" ? "W" : axis === "y" ? "H" : "D";
	return (
		<span
			className="rounded px-1.5 py-0.5 font-medium text-[11px] text-white"
			style={{ backgroundColor: AXIS_COLOR[axis] }}
		>
			{letter} {Math.round(valueMm)}
		</span>
	);
}

export function StudioScreen({
	roomId,
	onChangeRoomAction,
	layout,
	setLayoutAction,
	finish,
	finishTextures,
	setFinishAction,
	selectedIds,
	setSelectedIdsAction,
	onGoToQuoteAction,
	onBackToStartAction,
}: {
	roomId: RoomTypeId;
	onChangeRoomAction: (id: RoomTypeId) => void;
	layout: RoomLayout;
	setLayoutAction: (
		next: RoomLayout | ((prev: RoomLayout) => RoomLayout),
	) => void;
	finish: FinishId;
	/** Finish id → uploaded decor photo. Passed straight through to the scene. */
	finishTextures: Record<string, string>;
	setFinishAction: (id: FinishId) => void;
	selectedIds: readonly string[];
	setSelectedIdsAction: (ids: readonly string[]) => void;
	onGoToQuoteAction: () => void;
	onBackToStartAction: () => void;
}) {
	const t = useCopy();
	const locale = useLocale();
	const rm = (amount: number, opts?: Intl.NumberFormatOptions) =>
		new Intl.NumberFormat(htmlLang(locale), {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
			...opts,
		}).format(amount);
	const formatRm = (amount: number, opts?: Intl.NumberFormatOptions) =>
		new Intl.NumberFormat(htmlLang(locale), {
			style: "currency",
			currency: "MYR",
			currencyDisplay: "narrowSymbol",
			...opts,
		}).format(amount);
	const catalogue = useCatalogue();
	const {
		addModule,
		allPositions,
		closeGaps,
		duplicateModule,
		fits,
		flushWallToTallTops,
		freeSpans,
		hangingHeightMmOf,
		minWallWidthMm,
		overhangMm,
		positionsOf,
		removeModules,
		replaceFamily,
		rowEndMm,
		runExtentMm,
		offsetsOf,
		setGap,
		setBaseSkirting,
		setCeilingHeight,
		setHangAt,
		setHangingHeight,
		setRoomDepth,
		setRotation,
		setWallToCeiling,
		setWallToWall,
		setWallWidth,
		setWidth,
		swapWithNeighbour,
		widthOptionsFor,
	} = useRoomEngine();
	const room = roomTypeIn(catalogue, roomId);
	const selectedSet = new Set(selectedIds);

	// Filled in by the scene: screen-point → run position / cabinet under it.
	const pickerRef = useRef<((x: number, y: number) => number) | null>(null);
	const hitTestRef = useRef<((x: number, y: number) => string | null) | null>(
		null,
	);
	const [dragFamilyId, setDragFamilyId] = useState<string | null>(null);
	const [view, setView] = useState<PlannerView>("3d");
	// A pan now survives a layout change, so something has to be able to put
	// the framing back. Bumping this is the only thing that refits the camera.
	const [refitKey, setRefitKey] = useState(0);
	// Which cabinets are standing open. Deliberately *not* on the layout: it is
	// not something the customer buys, so it must not ride along in a share link
	// or a quote. One set drives both the global toggle and the per-cabinet
	// button, so the two can never disagree about what is open.
	const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
	// A view mode, not a property of the design — same reasoning as `openIds`,
	// and it must not ride along in a share link or a quote either.
	const [doorsHidden, setDoorsHidden] = useState(false);
	// The rail's active tool. `select` is the resting state, `measure` is what
	// used to be `measureMode`, and the other four open the overlay panel. One
	// piece of state rather than two, so the rail and the panel can never
	// disagree about what is open.
	// An empty wall opens on the cabinet menu: a bare room gives no clue where
	// cabinets come from, and adding one is the only useful first move.
	const [tool, setTool] = useState<StudioTool>(() =>
		allPositions(layout).length === 0 ? "add" : "select",
	);
	const panel = tool === "select" || tool === "measure" ? null : tool;
	const measureMode = tool === "measure";
	const [measurePoints, setMeasurePoints] = useState<SnapPoint[]>([]);
	// Which axis the second pick is pulled onto. `auto` infers it from the
	// direction of the pick, which is what turns a roughly-vertical pair of
	// clicks into a clean height instead of three numbers to squint at.
	const [measureAxis, setMeasureAxis] = useState<MeasureAxis>("auto");

	const select = (id: string | null, additive: boolean) => {
		setVerb(null);
		if (id === null) return setSelectedIdsAction([]);
		if (!additive) return setSelectedIdsAction([id]);
		setSelectedIdsAction(
			selectedIds.includes(id)
				? selectedIds.filter((current) => current !== id)
				: [...selectedIds, id],
		);
	};

	const pressTool = (next: StudioTool) => {
		track("tool_used", { tool: next });
		setTool((current) => (current === next ? "select" : next));
		if (next !== "measure") return;
		setMeasurePoints([]);
		// A dimension line taken to a door drawn open is a wrong number shown to
		// a customer: `snapToCabinet` snaps against the closed geometry either
		// way. Shut them rather than measure a lie.
		setOpenIds(new Set());
	};

	// Which verb has a section open under the list. Cleared whenever the
	// selection changes: a Resize panel left open over a different cabinet is
	// a control pointing at the wrong thing.
	const [verb, setVerb] = useState<SelectionVerb>(null);
	// Where the right-click menu is, and what it is about. Screen coordinates,
	// because the menu is `position: fixed` over everything.
	const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
		null,
	);

	/** Whether this cabinet has anything to trade places with, each way. */
	const neighboursOf = (position: Positioned) => {
		const run = Math.max(0, runIndexOf(layout, position.placed.id));
		const row = positionsOf(layout, rowFor(position.family.kind), run);
		const index = row.findIndex(
			(other) => other.placed.id === position.placed.id,
		);
		return { left: index > 0, right: index >= 0 && index < row.length - 1 };
	};

	/** The families this cabinet could become — same row, offered in this room.
	 * A run cabinet may never be swapped into a corner design, nor a corner unit
	 * into an ordinary one: the one-wall `replaceFamily` knows nothing of
	 * corners, and checkout would refuse the result. */
	const replaceOptionsFor = (position: Positioned) =>
		catalogue.families
			.filter(
				(family) =>
					isCorner(family) === isCorner(position.family) &&
					rowFor(family.kind) === rowFor(position.family.kind) &&
					room.familyIds.includes(family.id),
			)
			.map((family) => ({
				id: family.id,
				label: family.label,
				meta:
					family.sizes.length === 1
						? `${family.sizes[0].widthMm} mm`
						: fill(t.planner.selection.sizeRangeMeta, {
								min: family.sizes[0].widthMm,
								max: family.sizes[family.sizes.length - 1].widthMm,
							}),
				current: family.id === position.family.id,
			}));

	const removeSelected = () => {
		track("cabinet_removed", { count: selectedIds.length, via: "button" });
		setLayoutAction((prev) => removeModules(prev, selectedIds));
		setSelectedIdsAction([]);
	};

	const placed = allPositions(layout);
	// Only a cabinet with a front on it has anything to swing.
	const withDoors = placed.filter(
		(position) => position.placed.doorStyleId !== null,
	);
	const anyOpen = openIds.size > 0;
	const doorView: DoorView = doorsHidden
		? "hidden"
		: anyOpen
			? "open"
			: "closed";
	const selection = placed.filter((position) =>
		selectedSet.has(position.placed.id),
	);
	const selected: Positioned | undefined =
		selection.length === 1 ? selection[0] : undefined;

	const floorEnd = rowEndMm(layout, "floor");
	const overhang = overhangMm(layout);
	// Usually the run rather than the catalogue floor — worth naming which,
	// because a slider that stops for no visible reason reads as broken.
	const minWallMm = minWallWidthMm(layout);
	// Whole millimetres: a dragged cabinet lands on a fractional x, and the
	// customer measures with a tape, not a micrometer.
	const freeMm = Math.round(layout.wallWidthMm - runExtentMm(layout));
	const construction = constructionOf(catalogue);
	const price = computePlannerPrice(layout, finish, catalogue);
	// Named so the customer knows what the extra lines are for. Both are added
	// for them rather than chosen, so the total moving without explanation is
	// the thing to avoid.
	const coverPieces = [
		price.ceilingTrimFt > 0 && t.planner.price.trimStrip,
		price.skirtingFt > 0 && t.planner.price.skirtingBoard,
		price.endPanelCount > 0 && t.planner.price.endPanels,
	].filter((piece): piece is string => typeof piece === "string");

	const gapCount = layout.runs.reduce(
		(total, _, run) =>
			total +
			(["floor", "wall"] as const).reduce(
				(sum, row) =>
					sum +
					freeSpans(layout, row, run).filter(
						(gap) => gap.endMm < rowEndMm(layout, row, run) && gap.startMm > 0,
					).length,
				0,
			),
		0,
	);

	const dropCarcass = (familyId: string, clientX: number, clientY: number) => {
		const runXMm = pickerRef.current?.(clientX, clientY) ?? 0;
		track("cabinet_added", { family: familyId, via: "drag" });
		setLayoutAction((prev) => addModule(prev, familyId, runXMm));
	};

	// A third click starts a fresh measurement rather than adding a third
	// point — two points is the whole tool, like a real CAD measuring
	// command: pick, pick, read the result, pick again to start over.
	const onMeasurePick = (snap: SnapPoint) => {
		setMeasurePoints((prev) => (prev.length >= 2 ? [snap] : [...prev, snap]));
	};
	const measurement =
		measurePoints.length === 2
			? measure(measurePoints[0].point, measurePoints[1].point)
			: null;
	const maxMeasuredAxisMm = measurement
		? Math.max(measurement.widthMm, measurement.heightMm, measurement.depthMm)
		: 0;

	const canFlush = placed.some((position) => position.family.kind === "tall");

	const roomBody = (
		<RoomPanel
			catalogue={catalogue}
			roomId={roomId}
			layout={layout}
			minWallMm={minWallMm}
			freeMm={freeMm}
			overhangMm={overhang}
			onChangeRoomAction={onChangeRoomAction}
			onWallWidthAction={(mm) =>
				setLayoutAction((prev) => setWallWidth(prev, mm))
			}
			onCeilingAction={(mm) =>
				setLayoutAction((prev) => setCeilingHeight(prev, mm))
			}
			onDepthAction={(mm) => setLayoutAction((prev) => setRoomDepth(prev, mm))}
			onOpenDefaultsAction={() => setTool("defaults")}
		/>
	);

	// Shelved the way a showroom is: base cabinets together, wall cabinets
	// together. A family published before categories existed is shelved by how
	// it places.
	const offered = room.familyIds.flatMap((familyId) => {
		const family = familyIn(catalogue, familyId);
		return family ? [family] : [];
	});
	const addBody = (
		<div className="flex flex-col gap-3">
			{CATEGORIES.map((category) => {
				const shelf = offered.filter(
					(family) =>
						(family.category ?? KIND_CATEGORY[family.kind]) === category,
				);
				if (shelf.length === 0) return null;
				return (
					<section key={category} className="flex flex-col gap-1.5">
						<p className="font-semibold text-[11px] text-neutral-600 uppercase tracking-[0.06em]">
							{t.planner.addCabinets.categories[category]}
						</p>
						<div className="grid grid-cols-2 gap-2">
							{shelf.map((option) => {
								const familyId = option.id;
								const canFit = fits(layout, familyId);
								const price = formatRm(option.sizes[0].priceRm, {
									maximumFractionDigits: 0,
								});
								return (
									<button
										key={familyId}
										type="button"
										draggable={canFit}
										onDragStart={(e) => {
											e.dataTransfer.setData(
												"text/plain",
												`family:${familyId}`,
											);
											e.dataTransfer.effectAllowed = "copy";
											setDragFamilyId(familyId);
										}}
										onDragEnd={() => setDragFamilyId(null)}
										onClick={() => {
											track("cabinet_added", {
												family: familyId,
												via: "click",
											});
											setLayoutAction((prev) => addModule(prev, familyId, 0));
										}}
										disabled={!canFit}
										className={`rounded-lg border p-2 text-left transition ${
											canFit
												? "cursor-grab border-neutral-200 hover:border-neutral-500 active:cursor-grabbing"
												: "cursor-not-allowed border-neutral-100 opacity-40"
										}`}
									>
										<FamilyThumb family={option} />
										<p className="mt-1.5 font-medium text-[12px]">
											{option.label}
										</p>
										<p className="text-[11px] text-neutral-500">
											{option.sizes.length === 1
												? fill(t.planner.addCabinets.widthPrice, {
														width: option.sizes[0].widthMm,
														price,
													})
												: fill(t.planner.addCabinets.sizeRange, {
														min: option.sizes[0].widthMm,
														max: option.sizes[option.sizes.length - 1].widthMm,
														price,
													})}
										</p>
									</button>
								);
							})}
						</div>
					</section>
				);
			})}
		</div>
	);

	const viewBody = (
		<div className="flex flex-col gap-1.5">
			{views(t).map((option) => (
				<PanelOption
					key={option.id}
					label={option.label}
					hint={
						option.id === "3d"
							? t.planner.panel.threeDHint
							: option.id === "elevation"
								? t.planner.panel.elevationHint
								: t.planner.panel.planHint
					}
					pressed={view === option.id}
					onPressAction={() => {
						track("view_changed", { view: option.id });
						setView(option.id);
					}}
				/>
			))}
			<PanelOption
				label={t.planner.panel.resetView}
				hint={t.planner.panel.resetViewHint}
				onPressAction={() => setRefitKey((key) => key + 1)}
			/>
		</div>
	);

	const doorsBody = (
		<div className="flex flex-col gap-1.5">
			{doorModes(t).map((mode) => (
				<PanelOption
					key={mode.id}
					label={mode.label}
					hint={
						mode.id === "hidden"
							? t.planner.room.frontsOffNote
							: mode.id === "open"
								? t.planner.room.interiorsShownNote
								: t.planner.room.openDoorsNote
					}
					pressed={doorView === mode.id}
					onPressAction={() => {
						track("doors_toggled", { scope: "all", mode: mode.id });
						setDoorsHidden(mode.id === "hidden");
						setOpenIds(
							mode.id === "open"
								? new Set(withDoors.map((position) => position.placed.id))
								: new Set(),
						);
					}}
				/>
			))}
		</div>
	);

	const defaultsBody = (
		<div className="flex flex-col gap-4">
			<PanelToggle
				label={t.planner.room.baseUnitsAria}
				hint={
					layout.baseSkirting
						? t.planner.room.kickBoardNote
						: t.planner.room.levellersNote
				}
				value={layout.baseSkirting}
				options={baseModes(t).map((mode) => ({
					value: mode.skirted,
					label: mode.label,
				}))}
				onPickAction={(skirted) =>
					setLayoutAction((prev) => setBaseSkirting(prev, skirted))
				}
			/>

			<PanelToggle
				label={t.planner.room.runAria}
				hint={
					layout.wallToWall
						? t.planner.room.noPanelNeededNote
						: t.planner.room.panelNeededNote
				}
				value={layout.wallToWall}
				options={runModes(t).map((mode) => ({
					value: mode.toWall,
					label: mode.label,
				}))}
				onPickAction={(toWall) =>
					setLayoutAction((prev) => setWallToWall(prev, toWall))
				}
			/>

			<PanelToggle
				label={t.planner.room.wallUnitsAria}
				hint={fill(t.planner.room.undersidesNote, {
					height: hangingHeightMmOf(layout),
				})}
				value={layout.wallToCeiling}
				options={wallModes(t).map((mode) => ({
					value: mode.toCeiling,
					label: mode.label,
				}))}
				onPickAction={(toCeiling) =>
					setLayoutAction((prev) => setWallToCeiling(prev, toCeiling))
				}
			/>

			{!layout.wallToCeiling && (
				<DimensionField
					label={t.planner.room.wallUnitsHangAt}
					valueMm={layout.hangingHeightMm}
					minMm={WALL_HANG_LIMITS.minMm}
					maxMm={WALL_HANG_LIMITS.maxMm}
					stepMm={10}
					onChangeAction={(mm) =>
						setLayoutAction((prev) => setHangingHeight(prev, mm))
					}
				/>
			)}

			<button
				type="button"
				onClick={() => setLayoutAction((prev) => flushWallToTallTops(prev))}
				disabled={!canFlush}
				className="self-start text-[12px] text-[#1f5138] underline hover:text-[#17402c] disabled:text-neutral-300 disabled:no-underline"
			>
				{canFlush
					? t.planner.room.flushWallUnitTops
					: t.planner.room.addTallFirst}
			</button>

			<button
				type="button"
				onClick={() => setLayoutAction((prev) => closeGaps(prev))}
				disabled={gapCount === 0}
				className="self-start text-[12px] text-[#1f5138] underline hover:text-[#17402c] disabled:text-neutral-300 disabled:no-underline"
			>
				{gapCount > 0
					? fill(t.planner.run.closeGapsCount, { n: gapCount })
					: t.planner.run.closeGaps}
			</button>
		</div>
	);

	return (
		// Viewport less the language strip's `h-9` above it: a bare `h-screen`
		// pushed the checkout button 36px below the fold.
		<main className="flex h-[calc(100dvh-2.25rem)] flex-col bg-[#f4f3f1] text-neutral-900">
			<PlannerHeader
				trail={[
					{ label: t.common.brand, href: "/" },
					{ label: t.planner.crumbs.roomPlanner, onClick: onBackToStartAction },
					{ label: t.planner.crumbs.studio },
				]}
			>
				<button
					type="button"
					onClick={() => pressTool("measure")}
					aria-pressed={measureMode}
					title={t.planner.measure.tooltip}
					className={`rounded-full px-3 py-1 text-[12px] transition ${
						measureMode
							? "bg-neutral-900 text-white"
							: "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
					}`}
				>
					{measureMode
						? t.planner.measure.measuring
						: t.planner.measure.measure}
				</button>
				<button
					type="button"
					onClick={onBackToStartAction}
					className="text-[13px] text-neutral-500 hover:text-neutral-900"
				>
					{t.planner.changeRoom}
				</button>
				<Link
					href="/tutorials"
					target="_blank"
					className="hidden items-center gap-1.5 text-[13px] text-neutral-500 hover:text-neutral-900 sm:flex"
				>
					{/* A play triangle, drawn rather than installed: this is the only
					    icon on the screen and a library for one glyph is not worth the
					    bytes on the mobile budget. */}
					<svg
						viewBox="0 0 24 24"
						aria-hidden
						className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.8]"
					>
						<path d="M6 4l14 8-14 8V4z" />
					</svg>
					{t.planner.diyTutorials}
				</Link>
				<AdminLink />
			</PlannerHeader>

			<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
				<ToolRail active={tool} onPressAction={pressTool} />

				{/* biome-ignore lint/a11y/noStaticElementInteractions: the drop
				    target is the 3D canvas; the palette buttons are the keyboard
				    path. */}
				<div
					// `min-w-0`, or this column never shrinks: a flex item defaults to
					// min-width:auto, and the item's content is a <canvas> three.js
					// sizes in pixels. Narrowing the window left the canvas at its old
					// width, the row stayed that wide, and the right panel was pushed
					// off the screen edge rather than the scene giving ground.
					className="relative min-h-[45vh] min-w-0 flex-1 bg-[#faf9f7]"
					onDragOver={(e) => {
						e.preventDefault();
						e.dataTransfer.dropEffect = "copy";
					}}
					onContextMenu={(e) => {
						const id = hitTestRef.current?.(e.clientX, e.clientY) ?? null;
						if (!id) return;
						e.preventDefault();
						setSelectedIdsAction([id]);
						setVerb(null);
						setMenu({ x: e.clientX, y: e.clientY, id });
					}}
					onDrop={(e) => {
						e.preventDefault();
						const payload = e.dataTransfer.getData("text/plain");
						const [kind, id] = payload.split(":");
						if (kind === "family" && (id || dragFamilyId)) {
							dropCarcass(id || dragFamilyId || "", e.clientX, e.clientY);
						}
						setDragFamilyId(null);
					}}
				>
					{panel && (
						<StudioPanel kind={panel} onCloseAction={() => setTool("select")}>
							{panel === "room" && roomBody}
							{panel === "add" && addBody}
							{panel === "view" && viewBody}
							{panel === "doors" && doorsBody}
							{panel === "defaults" && defaultsBody}
						</StudioPanel>
					)}

					<PlannerScene
						layout={layout}
						finish={finish}
						finishTextures={finishTextures}
						selectedIds={selectedSet}
						openIds={openIds}
						doorsHidden={doorsHidden}
						doorTargetId={null}
						measureMode={measureMode}
						measurePoints={measurePoints}
						measureAxis={measureAxis}
						positionMode={verb === "move"}
						view={view}
						refitKey={refitKey}
						onLayoutChangeAction={setLayoutAction}
						onSelectAction={select}
						onMeasurePickAction={onMeasurePick}
						pickerRef={pickerRef}
						hitTestRef={hitTestRef}
					/>

					{menu && (
						<CabinetMenu
							x={menu.x}
							y={menu.y}
							onDismissAction={() => setMenu(null)}
							items={[
								...((placed.find((p) => p.placed.id === menu.id)?.family.sizes
									.length ?? 0) > 1
									? [
											{
												key: "resize",
												label: t.planner.selection.verbResize,
												press: () => setVerb("resize"),
											},
										]
									: []),
								{
									key: "replace",
									label: t.planner.selection.verbReplace,
									press: () => setVerb("replace"),
								},
								{
									key: "move",
									label: t.planner.selection.verbMove,
									press: () => setVerb("move"),
								},
								{
									key: "duplicate",
									label: t.planner.selection.duplicate,
									press: () =>
										setLayoutAction((prev) => duplicateModule(prev, menu.id)),
								},
								{
									key: "remove",
									label: t.planner.selection.remove,
									danger: true,
									press: removeSelected,
								},
							]}
						/>
					)}

					<div className="absolute top-3 left-3.5 z-[6] flex flex-wrap items-center gap-2">
						<span className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[12px] text-neutral-700 shadow-[0_1px_2px_rgba(0,0,0,.04)]">
							{fill(t.planner.canvas.runOfWall, {
								run: (floorEnd / 1000).toFixed(2),
								wall: (layout.wallWidthMm / 1000).toFixed(2),
							})}{" "}
							· {placed.length}{" "}
							{placed.length === 1 ? t.planner.unit : t.planner.units}
						</span>
						<span className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[12px] text-[#8a857c] shadow-[0_1px_2px_rgba(0,0,0,.04)]">
							{views(t).find((option) => option.id === view)?.label}
						</span>
					</div>

					{measureMode && (
						<div className="absolute top-3.5 right-3.5 flex flex-col items-end gap-1.5 rounded-lg bg-white/92 px-2.5 py-2 shadow-sm backdrop-blur">
							<fieldset className="flex items-center gap-0.5">
								<legend className="sr-only">
									{t.planner.measure.constrainLabel}
								</legend>
								{MEASURE_AXES.map((axis) => (
									<button
										key={axis}
										type="button"
										onClick={() => setMeasureAxis(axis)}
										aria-pressed={measureAxis === axis}
										className={`rounded px-1.5 py-0.5 text-[11px] transition ${
											measureAxis === axis
												? "bg-neutral-900 text-white"
												: "text-neutral-500 hover:bg-neutral-100"
										}`}
									>
										{AXIS_LABEL[axis]}
									</button>
								))}
							</fieldset>

							<div className="flex items-center gap-2">
								{measurement ? (
									<span className="flex items-center gap-2 text-[12px] text-neutral-800">
										<span>{Math.round(measurement.distanceMm)}mm</span>
										<DimChip
											axis="x"
											valueMm={measurement.widthMm}
											maxAxisMm={maxMeasuredAxisMm}
										/>
										<DimChip
											axis="y"
											valueMm={measurement.heightMm}
											maxAxisMm={maxMeasuredAxisMm}
										/>
										<DimChip
											axis="z"
											valueMm={measurement.depthMm}
											maxAxisMm={maxMeasuredAxisMm}
										/>
									</span>
								) : (
									<span className="text-[12px] text-neutral-500">
										{measurePoints.length === 0
											? t.planner.measure.clickToStart
											: t.planner.measure.clickSecondPoint}
									</span>
								)}
								{measurePoints.length > 0 && (
									<button
										type="button"
										onClick={() => setMeasurePoints([])}
										className="text-[12px] text-[#1f5138] hover:underline"
									>
										{t.planner.clear}
									</button>
								)}
							</div>

							{/* What each end actually landed on. The glyph in the scene
							    says the same thing, but a marker seen edge-on is easy to
							    misread and a wrong snap is a wrong number. */}
							{measurePoints.length > 0 && (
								<p className="text-[11px] text-neutral-400">
									{measurePoints
										.map((snap) => SNAP_LABEL[snap.kind])
										.join(" → ")}
								</p>
							)}
						</div>
					)}

					{selection.length === 0 && panel === null && !measureMode && (
						<p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[12px] text-[#a2998c]">
							{t.planner.canvas.selectHint}
						</p>
					)}

					<p className="absolute right-3.5 bottom-3.5 hidden max-w-[260px] text-right text-[12px] text-[#8a8580] leading-4 lg:block">
						{measureMode
							? t.planner.measure.hintMeasuring
							: t.planner.measure.hintDefault}
					</p>
				</div>

				<aside className="flex w-full shrink-0 flex-col border-neutral-200 border-t bg-white lg:h-full lg:w-[312px] lg:border-t-0 lg:border-l">
					<div className="min-h-0 flex-1 overflow-y-auto">
						{selection.length === 0 ? (
							<DesignRecap
								rows={[
									{ label: t.planner.design.room, value: room.label },
									{
										label: t.planner.design.wall,
										value: `${(layout.wallWidthMm / 1000).toFixed(2)} m · ${(
											layout.ceilingHeightMm / 1000
										).toFixed(2)} m`,
									},
									{
										label: t.planner.design.run,
										value: `${(runExtentMm(layout) / 1000).toFixed(2)} m · ${
											placed.length
										} ${placed.length === 1 ? t.planner.unit : t.planner.units}`,
									},
									{
										label: t.planner.design.wallFree,
										value:
											freeMm < 0
												? fill(t.planner.design.overBy, { mm: -freeMm })
												: `${freeMm} mm`,
									},
									// No Finish row: the swatches directly beneath this block
									// already show it, name it, and let you change it. Two
									// copies of one fact, forty pixels apart, in a column
									// where a 900px laptop could only show one of seven
									// cabinets in the run below.
								]}
								onAddAction={() => setTool("add")}
							/>
						) : selected ? (
							<SelectionPanel
								catalogue={catalogue}
								layout={layout}
								selected={selected}
								verb={verb}
								onVerbAction={setVerb}
								widthOptions={widthOptionsFor(layout, selected.placed.id)}
								replaceOptions={replaceOptionsFor(selected)}
								doorsOpen={openIds.has(selected.placed.id)}
								hingeOptions={hingeSides(t)}
								leaves={leavesOn(selected, construction)}
								priceLabel={formatRm(
									price.cabinets.find((l) => l.id === selected.placed.id)
										?.amountRm ?? 0,
									{ maximumFractionDigits: 0 },
								)}
								onWidthAction={(widthMm) => {
									track("cabinet_resized", {
										family: selected.family.id,
										widthMm,
									});
									setLayoutAction((prev) =>
										setWidth(prev, selected.placed.id, widthMm),
									);
								}}
								onReplaceAction={(familyId) => {
									track("cabinet_replaced", { family: familyId });
									setLayoutAction((prev) =>
										replaceFamily(prev, selected.placed.id, familyId),
									);
								}}
								offsets={offsetsOf(layout, selected.placed.id)}
								onGapAction={(side, mm) =>
									setLayoutAction((prev) =>
										setGap(prev, selected.placed.id, side, mm),
									)
								}
								onSwapAction={(direction) =>
									setLayoutAction((prev) =>
										swapWithNeighbour(prev, selected.placed.id, direction),
									)
								}
								canSwap={neighboursOf(selected)}
								onHangAtAction={(mm) =>
									setLayoutAction((prev) =>
										setHangAt(prev, selected.placed.id, mm),
									)
								}
								onRotationAction={(deg) =>
									setLayoutAction((prev) =>
										setRotation(prev, selected.placed.id, deg),
									)
								}
								onToggleDoorAction={() => {
									track("doors_toggled", { scope: "one" });
									setOpenIds((prev) => {
										const next = new Set(prev);
										if (!next.delete(selected.placed.id)) {
											next.add(selected.placed.id);
										}
										return next;
									});
								}}
								onHingeAction={(side) =>
									setLayoutAction((prev) =>
										setHinge(prev, selected.placed.id, side),
									)
								}
								onDoorStyleAction={(doorStyleId) => {
									track("door_style_changed", { doorStyle: doorStyleId });
									setLayoutAction((prev) =>
										setDoors(prev, [selected.placed.id], doorStyleId),
									);
								}}
								onDuplicateAction={() =>
									setLayoutAction((prev) =>
										duplicateModule(prev, selected.placed.id),
									)
								}
								onRemoveAction={removeSelected}
							/>
						) : (
							<div className="p-4">
								<p className="font-semibold text-[11px] text-[#1f5138] uppercase tracking-[0.06em]">
									{fill(t.planner.selection.nSelected, { n: selection.length })}
								</p>
								<div className="mt-3 flex flex-col gap-2.5">
									<div>
										<p className="mb-1.5 font-medium text-[11px] text-neutral-600">
											{t.planner.selection.front}
										</p>
										<div className="flex flex-wrap gap-1.5">
											{catalogue.doorStyles.map((style) => (
												<button
													key={style.id}
													type="button"
													onClick={() => {
														track("door_style_changed", {
															doorStyle: style.id,
														});
														setLayoutAction((prev) =>
															setDoors(prev, selectedIds, style.id),
														);
													}}
													className="rounded-md bg-white px-2.5 py-1 text-[12px] text-neutral-700 shadow-[inset_0_0_0_1px_#d4d4d4] transition hover:shadow-[inset_0_0_0_1px_#a3a3a3]"
												>
													{style.label}
												</button>
											))}
										</div>
									</div>

									<div className="flex gap-3">
										<button
											type="button"
											onClick={removeSelected}
											className="rounded-full bg-neutral-900 px-3 py-1 text-[12px] text-white"
										>
											{fill(t.planner.selection.removeAll, {
												n: selection.length,
											})}
										</button>
										<button
											type="button"
											onClick={() => setSelectedIdsAction([])}
											className="text-[12px] text-neutral-500 hover:text-neutral-900"
										>
											{t.planner.clear}
										</button>
									</div>
								</div>
							</div>
						)}

						<RunList
							placed={placed}
							selectedIds={selectedSet}
							gapCount={gapCount}
							priceLabels={Object.fromEntries(
								price.cabinets.map((line) => [
									line.id,
									formatRm(line.amountRm, { maximumFractionDigits: 0 }),
								]),
							)}
							onSelectAction={select}
							onCloseGapsAction={() =>
								setLayoutAction((prev) => closeGaps(prev))
							}
							onResetAction={() => {
								setLayoutAction(emptyRoom(room.defaultWallWidthMm));
								setSelectedIdsAction([]);
							}}
						/>
					</div>

					<div className="border-neutral-200 border-b p-3.5">
						<p className="mb-2 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
							{t.planner.finish.heading}
						</p>
						<div className="flex gap-1.5">
							{catalogue.finishes.map((option) => (
								<button
									key={option.id}
									type="button"
									onClick={() => setFinishAction(option.id)}
									aria-pressed={option.id === finish}
									title={option.label}
									className="h-[26px] w-[26px] rounded-md bg-center bg-cover"
									style={{
										backgroundColor: option.hex,
										// The board itself where the client has one. Without it
										// the chip showed the catalogue hex while the door beside
										// it rendered the real scan — and a finish added from a
										// supplier sheet keeps the picker's #cccccc default until
										// somebody remembers to correct it, so the chip was
										// grey for a walnut.
										...(finishTextures[option.id] && {
											backgroundImage: `url(${finishTextures[option.id]})`,
										}),
										boxShadow:
											option.id === finish
												? "0 0 0 2px #171717, 0 0 0 3px #fff"
												: option.hex === "#ffffff"
													? "inset 0 0 0 1px #d4d4d4"
													: "none",
									}}
								/>
							))}
						</div>
						<p className="mt-2 text-[12px] text-neutral-500">
							{fill(t.planner.finish.currentLabel, {
								label:
									catalogue.finishes.find((f) => f.id === finish)?.label ?? "",
							})}
						</p>
					</div>

					<PriceFooter
						lines={price.categories.map((line) => ({
							id: line.id,
							label: priceLineLabel(t, line),
							detail: priceLineDetail(t, line),
							amount: rm(line.amountRm),
						}))}
						coverNote={
							coverPieces.length > 0
								? `${coverPieces.join(` ${t.planner.price.and} `)} ${
										coverPieces.length === 1
											? t.planner.price.includedAboveSingular
											: t.planner.price.includedAbovePlural
									}`
								: null
						}
						totalLabel={formatRm(price.totalRm, { maximumFractionDigits: 0 })}
						ctaDisabled={placed.length === 0}
						onQuoteAction={onGoToQuoteAction}
					/>
				</aside>
			</div>
		</main>
	);
}
