"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { fill } from "@/lib/copy/fill";
import { htmlLang } from "@/lib/copy/locales";
import type { FinishId, RoomTypeId } from "@/lib/planner/catalogue";
import { doorStyleIn, roomTypeIn } from "@/lib/planner/catalogue";
import type { PlannerLayout } from "@/lib/planner/layout";
import { computePlannerPrice } from "@/lib/planner/pricing";
import { useCatalogue, useEngine } from "./CatalogueContext";
import { useCopy, useLocale } from "./CopyContext";
import { AdminLink, PlannerHeader } from "./PlannerHeader";
import { priceLineDetail, priceLineLabel } from "./priceLineCopy";

function ScenePlaceholder() {
	const t = useCopy();
	return (
		<div className="flex h-full items-center justify-center text-neutral-500 text-sm">
			{t.quote.loading}
		</div>
	);
}

const PlannerScene = dynamic(() => import("./PlannerScene"), {
	ssr: false,
	loading: () => <ScenePlaceholder />,
});

/**
 * Lead capture UI only — there is no `/api/quote` yet (that's Phase 3, see
 * CLAUDE.md). Submitting shows a local confirmation rather than pretending to
 * send anything, so the demo doesn't claim a capability the backend doesn't
 * have.
 */
export function QuoteScreen({
	roomId,
	layout,
	finish,
	finishTextures,
	onBackToStudioAction,
	onBackToStartAction,
}: {
	roomId: RoomTypeId;
	layout: PlannerLayout;
	finish: FinishId;
	/** Finish id → uploaded decor photo. The quote screenshot is what goes out
	 * over WhatsApp, so it has to show the same board the planner did. */
	finishTextures: Record<string, string>;
	onBackToStudioAction: () => void;
	onBackToStartAction: () => void;
}) {
	const t = useCopy();
	const locale = useLocale();
	const catalogue = useCatalogue();
	const { allPositions } = useEngine();
	const room = roomTypeIn(catalogue, roomId);
	const price = computePlannerPrice(layout, finish, catalogue);
	const placed = allPositions(layout);
	const finishLabel = catalogue.finishes.find((f) => f.id === finish)?.label;
	const formatRm = (amount: number, opts?: Intl.NumberFormatOptions) =>
		new Intl.NumberFormat(htmlLang(locale), {
			style: "currency",
			currency: "MYR",
			currencyDisplay: "narrowSymbol",
			...opts,
		}).format(amount);

	const doorStyleIds = new Set(
		placed
			.map((p) => p.placed.doorStyleId)
			.filter((id): id is string => id !== null),
	);
	const frontLabel =
		doorStyleIds.size === 0
			? t.quote.noFrontsYet
			: doorStyleIds.size === 1
				? fill(t.quote.frontsLabel, {
						label: doorStyleIn(catalogue, [...doorStyleIds][0])?.label ?? "",
					})
				: t.quote.mixedFronts;

	const pickerRef = useRef<((x: number, y: number) => number) | null>(null);
	const hitTestRef = useRef<((x: number, y: number) => string | null) | null>(
		null,
	);
	const [submitted, setSubmitted] = useState(false);

	return (
		<main className="flex h-screen flex-col bg-[#e9e7e3] text-neutral-900">
			<PlannerHeader
				trail={[
					{ label: t.common.brand, href: "/" },
					{ label: t.planner.crumbs.roomPlanner, onClick: onBackToStartAction },
					{ label: t.planner.crumbs.quote },
				]}
			>
				<button
					type="button"
					onClick={onBackToStudioAction}
					className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-[12px] hover:border-neutral-400"
				>
					{t.quote.backToEditing}
				</button>
				<AdminLink />
			</PlannerHeader>

			<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
				<div className="flex flex-1 flex-col gap-4 overflow-y-auto p-8">
					{submitted ? (
						<div className="max-w-[420px] rounded-lg border border-emerald-200 bg-emerald-50 p-4">
							<p className="font-semibold text-emerald-900 text-sm">
								{t.quote.savedHeading}
							</p>
							<p className="mt-1 text-[13px] text-emerald-800 leading-5">
								{t.quote.savedBody}
							</p>
						</div>
					) : (
						<div>
							<h2 className="mb-1 font-semibold text-[22px]">
								{fill(t.quote.heading, { room: room.label.toLowerCase() })}
							</h2>
							<p className="max-w-[480px] text-[14px] text-neutral-500 leading-5">
								{t.quote.description}
							</p>
						</div>
					)}

					<form
						className="flex max-w-[420px] flex-col gap-3"
						onSubmit={(e) => {
							e.preventDefault();
							// Counts only. The form's fields are personal data and never
							// go to analytics — see src/lib/analytics.ts.
							track("quote_submitted", {
								room: roomId,
								cabinets: placed.length,
								totalRm: Math.round(price.totalRm),
							});
							setSubmitted(true);
						}}
					>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.fullName}
							</span>
							<input
								type="text"
								required
								disabled={submitted}
								className="rounded-lg border border-neutral-300 px-3 py-2.5 text-[14px] disabled:bg-neutral-50"
								placeholder="Nur Aisyah binti Kamal"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.phone}
							</span>
							<input
								type="text"
								required
								disabled={submitted}
								className="rounded-lg border border-neutral-300 px-3 py-2.5 text-[14px] disabled:bg-neutral-50"
								placeholder="+60 12-345 6789"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.email}
							</span>
							<input
								type="email"
								disabled={submitted}
								className="rounded-lg border border-neutral-300 px-3 py-2.5 text-[14px] disabled:bg-neutral-50"
								placeholder="you@example.com"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.area}
							</span>
							<input
								type="text"
								disabled={submitted}
								className="rounded-lg border border-neutral-300 px-3 py-2.5 text-[14px] disabled:bg-neutral-50"
								placeholder="Petaling Jaya, Selangor"
							/>
						</label>
						<label className="mt-1 flex items-start gap-2">
							<input
								type="checkbox"
								required
								disabled={submitted}
								className="mt-0.5"
							/>
							<span className="text-[12px] text-neutral-500 leading-4">
								{t.quote.remeasureNote}
							</span>
						</label>
						<button
							type="submit"
							disabled={submitted}
							className="mt-1 rounded-lg bg-neutral-900 px-3 py-3 font-medium text-[14px] text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{submitted ? t.quote.saved : t.quote.submitCta}
						</button>
					</form>
				</div>

				<aside className="flex w-full shrink-0 flex-col gap-4 border-neutral-200 border-t bg-[#f7f6f4] p-6 lg:h-full lg:w-[360px] lg:border-t-0 lg:border-l">
					<div className="relative h-[180px] overflow-hidden rounded-lg border border-neutral-200">
						<PlannerScene
							layout={layout}
							finish={finish}
							finishTextures={finishTextures}
							selectedIds={new Set()}
							doorTargetId={null}
							onLayoutChangeAction={() => {}}
							onSelectAction={() => {}}
							pickerRef={pickerRef}
							hitTestRef={hitTestRef}
						/>
					</div>
					<div>
						<p className="font-semibold text-[13px]">
							{fill(t.quote.summary, {
								room: room.label,
								wall: (layout.wallWidthMm / 1000).toFixed(2),
								count: placed.length,
								unit: placed.length === 1 ? t.planner.unit : t.planner.units,
							})}
						</p>
						<p className="mt-0.5 text-[12px] text-neutral-500">
							{finishLabel} · {frontLabel}
						</p>
					</div>
					<ul className="flex flex-col gap-1 border-neutral-200 border-t pt-3">
						{price.categories.map((line) => (
							<li
								key={line.id}
								className="flex items-baseline justify-between gap-2 text-[12px]"
							>
								<span className="min-w-0 text-neutral-600">
									{priceLineLabel(t, line)}{" "}
									<span className="text-[11px] text-neutral-400">
										{priceLineDetail(t, line)}
									</span>
								</span>
								<span className="shrink-0 tabular-nums">
									{new Intl.NumberFormat(htmlLang(locale), {
										minimumFractionDigits: 2,
										maximumFractionDigits: 2,
									}).format(line.amountRm)}
								</span>
							</li>
						))}
					</ul>

					<div className="flex items-baseline justify-between border-neutral-200 border-t pt-3">
						<span className="text-[13px] text-neutral-500">
							{t.quote.estimatedTotal}
						</span>
						<span className="font-semibold text-xl">
							{formatRm(price.totalRm, { maximumFractionDigits: 0 })}
						</span>
					</div>
					<p className="flex items-center gap-1.5 text-[#b45309] text-[11px] leading-4">
						<span className="rounded border border-[#b45309] px-1 py-0.5 font-semibold">
							{t.quote.estimateBadge}
						</span>{" "}
						{t.quote.notAQuoteNote}
					</p>
				</aside>
			</div>
		</main>
	);
}
