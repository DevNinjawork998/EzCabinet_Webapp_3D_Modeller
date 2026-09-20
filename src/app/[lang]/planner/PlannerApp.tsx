"use client";

import { useCallback, useEffect, useState } from "react";
import {
	CatalogueProvider,
	useRoomEngine,
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
import { wallsOf } from "@/lib/planner/floorplan";
import { computePlannerPrice } from "@/lib/planner/pricing";
import { emptyRoom, type RoomLayout } from "@/lib/planner/room";
import { loadDraft, saveDraft } from "@/lib/plannerDraft";

type Screen = "start" | "studio" | "quote";

/** Every room opens on its empty wall, and keeps its own work. */
const initialRooms = (
	catalogue: PlannerCatalogue,
): Record<RoomTypeId, RoomLayout> =>
	Object.fromEntries(
		catalogue.roomTypes.map((room) => [
			room.id,
			emptyRoom(room.defaultWallWidthMm),
		]),
	) as Record<RoomTypeId, RoomLayout>;

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
	const { allPositions, duplicateModule, removeModules } = useRoomEngine();

	const [screen, setScreen] = useState<Screen>("start");
	// One effect rather than an event at each of the five `setScreen` calls —
	// the funnel's step boundaries, including the initial start screen.
	useEffect(() => {
		track("screen_viewed", { screen });
	}, [screen]);
	// Restored once, from whatever autosave `plannerDraft.ts` left in
	// localStorage — a sign-in redirect, a refresh or a crash all take the
	// page's React state with them, and this is what survives that.
	const [restored] = useState(() => loadDraft());
	const [roomId, setRoomId] = useState<RoomTypeId>(
		(restored?.roomId as RoomTypeId) ?? initialRoomId,
	);
	// One layout per room, so switching to the foyer and back does not throw
	// away the kitchen the customer just arranged.
	const [rooms, setRooms] = useState<Record<RoomTypeId, RoomLayout>>(() =>
		restored
			? ({ ...initialRooms(catalogue), ...restored.rooms } as Record<
					RoomTypeId,
					RoomLayout
				>)
			: initialRooms(catalogue),
	);
	// Defaults to whatever the catalogue lists first — hardcoding an id here
	// would render an unstyled room for any catalogue that drops it.
	const [finish, setFinish] = useState<FinishId>(
		(restored?.finishId as FinishId) ?? catalogue.finishes[0].id,
	);
	const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

	// One effect, not a call at each of the dozens of `setLayoutAction` sites:
	// the draft only has to be correct by the time the page can be navigated
	// away from, and React has already batched by then.
	useEffect(() => {
		saveDraft({ version: 1, roomId, finishId: finish, rooms });
	}, [roomId, finish, rooms]);

	const layout = rooms[roomId];
	const setLayout = useCallback(
		(next: RoomLayout | ((prev: RoomLayout) => RoomLayout)) =>
			setRooms((prev) => ({
				...prev,
				[roomId]:
					typeof next === "function"
						? (next as (p: RoomLayout) => RoomLayout)(prev[roomId])
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
					wallMm: wallsOf(layout.plan)[0].lengthMm,
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
