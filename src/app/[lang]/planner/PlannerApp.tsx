"use client";

import { useCallback, useEffect, useState } from "react";
import {
	CatalogueProvider,
	useEngine,
} from "@/components/planner/CatalogueContext";
import { CopyProvider } from "@/components/planner/CopyContext";
import { QuoteScreen } from "@/components/planner/QuoteScreen";
import { StartScreen } from "@/components/planner/StartScreen";
import { StudioScreen } from "@/components/planner/StudioScreen";
import { track } from "@/lib/analytics";
import type { Dictionary } from "@/lib/copy/en";
import type { Locale } from "@/lib/copy/locales";
import type { FinishId, RoomTypeId } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { emptyLayout, type PlannerLayout } from "@/lib/planner/layout";
import { computePlannerPrice } from "@/lib/planner/pricing";

type Screen = "start" | "studio" | "quote";

/** Every room opens on its empty wall, and keeps its own work. */
const initialRooms = (
	catalogue: PlannerCatalogue,
): Record<RoomTypeId, PlannerLayout> =>
	Object.fromEntries(
		catalogue.roomTypes.map((room) => [
			room.id,
			emptyLayout(room.defaultWallWidthMm),
		]),
	) as Record<RoomTypeId, PlannerLayout>;

export function PlannerApp({
	initialRoomId,
	catalogue,
	finishTextures,
	copy,
	locale,
}: {
	initialRoomId: RoomTypeId;
	/** The live published catalogue. */
	catalogue: PlannerCatalogue;
	/** Finish id → uploaded decor photo, for the finishes that have one. The
	 * same upload that gives the landing page its swatch, so the strip and the
	 * cabinet show the same board. */
	finishTextures: Record<string, string>;
	/** The active locale's strings, resolved server-side — `next/root-params`
	 * does not reach this client tree. */
	copy: Dictionary;
	locale: Locale;
}) {
	return (
		<CopyProvider copy={copy} locale={locale}>
			<CatalogueProvider catalogue={catalogue}>
				<PlannerScreens
					initialRoomId={initialRoomId}
					catalogue={catalogue}
					finishTextures={finishTextures}
				/>
			</CatalogueProvider>
		</CopyProvider>
	);
}

function PlannerScreens({
	initialRoomId,
	catalogue,
	finishTextures,
}: {
	initialRoomId: RoomTypeId;
	/** The live published catalogue. Passed down through `CatalogueProvider`;
	 * nothing reads it from a module global. */
	catalogue: PlannerCatalogue;
	/** Finish id → uploaded decor photo, for the finishes that have one. The
	 * same upload that gives the landing page its swatch, so the strip and the
	 * cabinet show the same board. */
	finishTextures: Record<string, string>;
}) {
	const { allPositions, duplicateModule, removeModules } = useEngine();

	const [screen, setScreen] = useState<Screen>("start");
	// One effect rather than an event at each of the five `setScreen` calls —
	// the funnel's step boundaries, including the initial start screen.
	useEffect(() => {
		track("screen_viewed", { screen });
	}, [screen]);
	const [roomId, setRoomId] = useState<RoomTypeId>(initialRoomId);
	// One layout per room, so switching to the foyer and back does not throw
	// away the kitchen the customer just arranged.
	const [rooms, setRooms] = useState<Record<RoomTypeId, PlannerLayout>>(() =>
		initialRooms(catalogue),
	);
	// Defaults to whatever the catalogue lists first — hardcoding an id here
	// would render an unstyled room for any catalogue that drops it.
	const [finish, setFinish] = useState<FinishId>(catalogue.finishes[0].id);
	const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

	const layout = rooms[roomId];
	const setLayout = useCallback(
		(next: PlannerLayout | ((prev: PlannerLayout) => PlannerLayout)) =>
			setRooms((prev) => ({
				...prev,
				[roomId]:
					typeof next === "function"
						? (next as (p: PlannerLayout) => PlannerLayout)(prev[roomId])
						: next,
			})),
		[roomId],
	);

	const removeSelected = useCallback(() => {
		setLayout((prev) => removeModules(prev, selectedIds));
		setSelectedIds([]);
	}, [selectedIds, setLayout, removeModules]);

	useEffect(() => {
		if (screen !== "studio") return;
		const onKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

			if (e.key === "Escape") {
				setSelectedIds([]);
				return;
			}
			// Duplicating two cabinets at once has no obvious answer for where the
			// copies go, so the shortcut is for a single selection only.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
				if (selectedIds.length !== 1) return;
				e.preventDefault();
				setLayout((prev) => duplicateModule(prev, selectedIds[0]));
				return;
			}
			if (e.key !== "Delete" && e.key !== "Backspace") return;
			if (selectedIds.length === 0) return;
			e.preventDefault();
			track("cabinet_removed", { count: selectedIds.length, via: "keyboard" });
			removeSelected();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [screen, selectedIds, removeSelected, setLayout, duplicateModule]);

	if (screen === "start") {
		return (
			<StartScreen
				roomId={roomId}
				onPickRoom={(id) => {
					track("room_picked", { room: id, from: "start" });
					setRoomId(id);
				}}
				onStart={() => {
					track("planner_started", { room: roomId });
					setSelectedIds([]);
					setScreen("studio");
				}}
			/>
		);
	}

	if (screen === "quote") {
		return (
			<QuoteScreen
				roomId={roomId}
				layout={layout}
				finish={finish}
				finishTextures={finishTextures}
				onBackToStudioAction={() => setScreen("studio")}
				onBackToStartAction={() => setScreen("start")}
			/>
		);
	}

	return (
		<StudioScreen
			roomId={roomId}
			onChangeRoomAction={(id) => {
				track("room_picked", { room: id, from: "studio" });
				setRoomId(id);
				setSelectedIds([]);
			}}
			layout={layout}
			setLayoutAction={setLayout}
			finish={finish}
			setFinishAction={(id) => {
				track("finish_changed", { finish: id });
				setFinish(id);
			}}
			finishTextures={finishTextures}
			selectedIds={selectedIds}
			setSelectedIdsAction={setSelectedIds}
			onGoToQuoteAction={() => {
				track("quote_viewed", {
					room: roomId,
					cabinets: allPositions(layout).length,
					wallMm: layout.wallWidthMm,
					totalRm: Math.round(
						computePlannerPrice(layout, finish, catalogue).totalRm,
					),
				});
				setScreen("quote");
			}}
			onBackToStartAction={() => setScreen("start")}
		/>
	);
}
