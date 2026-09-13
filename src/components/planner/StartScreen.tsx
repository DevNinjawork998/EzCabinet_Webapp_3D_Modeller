import { fill } from "@/lib/copy/fill";
import type { RoomTypeId } from "@/lib/planner/catalogue";
import { useCatalogue } from "./CatalogueContext";
import { useCopy } from "./CopyContext";
import { AdminLink, PlannerHeader } from "./PlannerHeader";

const ROOM_ICON_PATHS: Record<RoomTypeId, React.ReactNode> = {
	kitchen: (
		<>
			<rect
				x={4}
				y={20}
				width={30}
				height={28}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
			<rect
				x={4}
				y={4}
				width={30}
				height={12}
				fill="currentColor"
				fillOpacity={0.25}
				stroke="currentColor"
				strokeWidth={1}
			/>
			<rect
				x={40}
				y={10}
				width={56}
				height={38}
				fill="currentColor"
				fillOpacity={0.1}
				stroke="currentColor"
				strokeWidth={1}
			/>
		</>
	),
	living: (
		<>
			<rect
				x={4}
				y={24}
				width={46}
				height={24}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
			<rect
				x={56}
				y={6}
				width={40}
				height={42}
				fill="currentColor"
				fillOpacity={0.1}
				stroke="currentColor"
				strokeWidth={1}
			/>
		</>
	),
	bedroom: (
		<>
			<rect
				x={18}
				y={4}
				width={24}
				height={44}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
			<rect
				x={46}
				y={4}
				width={20}
				height={44}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
			<rect
				x={70}
				y={4}
				width={20}
				height={44}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
		</>
	),
	foyer: (
		<>
			<rect
				x={10}
				y={4}
				width={26}
				height={34}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
			<rect
				x={42}
				y={26}
				width={34}
				height={12}
				fill="currentColor"
				fillOpacity={0.15}
				stroke="currentColor"
				strokeWidth={1}
			/>
		</>
	),
};

/**
 * Pick a room, then plan it on its empty wall.
 *
 * A room no design is filed under yet is shown but cannot be picked: listing
 * only the rooms that are ready would hide that the others are coming, and
 * letting one open would drop the customer on a wall with nothing to add.
 */
export function StartScreen({
	roomId,
	onPickRoom,
	onStart,
}: {
	roomId: RoomTypeId;
	onPickRoom: (id: RoomTypeId) => void;
	onStart: () => void;
}) {
	const t = useCopy();
	const catalogue = useCatalogue();
	const plannable = (id: RoomTypeId) =>
		(catalogue.roomTypes.find((r) => r.id === id)?.familyIds.length ?? 0) > 0;
	const ROOM_SUBTITLE: Record<RoomTypeId, string> = {
		kitchen: t.planner.start.roomSubtitle.kitchen,
		living: t.planner.start.roomSubtitle.living,
		bedroom: t.planner.start.roomSubtitle.bedroom,
		foyer: t.planner.start.roomSubtitle.foyer,
	};

	return (
		<main className="flex h-[calc(100dvh-2.25rem)] flex-col bg-[#e9e7e3] text-neutral-900">
			<PlannerHeader
				trail={[
					{ label: t.common.brand, href: "/" },
					{ label: t.planner.crumbs.roomPlanner },
				]}
			>
				<span className="text-[13px] text-neutral-500">
					{t.landing.hero.eyebrow}
				</span>
				<AdminLink />
			</PlannerHeader>

			<div className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-10">
				<div className="max-w-lg text-center">
					<h1 className="mb-2 font-semibold text-2xl">
						{t.planner.start.heading}
					</h1>
					<p className="text-neutral-500 text-sm leading-5">
						{t.planner.start.subtitle}
					</p>
				</div>

				<div className="grid w-full max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
					{catalogue.roomTypes.map((option) => {
						const active = option.id === roomId;
						const ready = option.familyIds.length > 0;
						return (
							<button
								key={option.id}
								type="button"
								disabled={!ready}
								onClick={() => onPickRoom(option.id)}
								className={`rounded-xl border-2 p-4 text-center transition disabled:cursor-not-allowed disabled:opacity-50 ${
									active && ready
										? "border-neutral-900"
										: "border-neutral-200 enabled:hover:border-neutral-400"
								}`}
							>
								<div className="flex h-[72px] items-center justify-center">
									<svg
										viewBox="0 0 100 50"
										className={`h-14 w-full ${active ? "text-neutral-600" : "text-neutral-400"}`}
										role="img"
										aria-label={fill(t.planner.start.roomIconAlt, {
											room: option.label,
										})}
									>
										<title>
											{fill(t.planner.start.roomIconAlt, {
												room: option.label,
											})}
										</title>
										{ROOM_ICON_PATHS[option.id]}
									</svg>
								</div>
								<p className="mt-2.5 font-semibold text-sm">{option.label}</p>
								<p className="mt-0.5 text-neutral-500 text-xs">
									{ready ? ROOM_SUBTITLE[option.id] : t.common.comingSoon}
								</p>
							</button>
						);
					})}
				</div>

				<button
					type="button"
					onClick={onStart}
					disabled={!plannable(roomId)}
					className="rounded-lg bg-neutral-900 px-7 py-3 font-medium text-sm text-white transition hover:bg-neutral-800 disabled:opacity-40"
				>
					{t.planner.start.cta}
				</button>
			</div>
		</main>
	);
}
