"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { fill } from "@/lib/copy/fill";
import { htmlLang } from "@/lib/copy/locales";
import type { FinishId, RoomTypeId } from "@/lib/planner/catalogue";
import { doorStyleIn, ratesOf, roomTypeIn } from "@/lib/planner/catalogue";
import { wallsOf } from "@/lib/planner/floorplan";
import { computePlannerPrice } from "@/lib/planner/pricing";
import type { RoomLayout } from "@/lib/planner/room";
import { useCatalogue, useRoomEngine } from "./CatalogueContext";
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

const FIELD =
	"rounded-lg border border-neutral-300 px-3 py-2.5 text-[14px] disabled:bg-neutral-50";

/**
 * Checkout. The customer's details and the design go to `POST /api/orders`,
 * which re-checks and re-prices the design against the published catalogue and
 * answers with the order's token; the confirmation page takes it from there.
 *
 * The totals shown here are the same functions the server runs, so they agree —
 * but the server's figure is the one charged.
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
	layout: RoomLayout;
	finish: FinishId;
	/** Finish id → uploaded decor photo. The quote screenshot is what goes out
	 * over WhatsApp, so it has to show the same board the planner did. */
	finishTextures: Record<string, string>;
	onBackToStudioAction: () => void;
	onBackToStartAction: () => void;
}) {
	const t = useCopy();
	const locale = useLocale();
	const router = useRouter();
	const catalogue = useCatalogue();
	const { allPositions } = useRoomEngine();
	const room = roomTypeIn(catalogue, roomId);
	const price = computePlannerPrice(layout, finish, catalogue);
	const deliveryRm = ratesOf(catalogue).deliveryFlatRm;
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

	const pickerRef = useRef<
		((x: number, y: number) => { run: number; xMm: number } | null) | null
	>(null);
	const hitTestRef = useRef<((x: number, y: number) => string | null) | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function placeOrder(form: HTMLFormElement) {
		const field = (name: string) =>
			String(new FormData(form).get(name) ?? "").trim();
		setBusy(true);
		setError(null);
		const res = await fetch("/api/orders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				roomId,
				finishId: finish,
				layout,
				customer: {
					name: field("name"),
					phone: field("phone"),
					email: field("email") || null,
					siteAddress: field("siteAddress"),
					addressNotes: field("addressNotes") || null,
				},
				remeasureAccepted: true,
			}),
		}).catch(() => null);
		const body = await res?.json().catch(() => null);
		if (!res?.ok || typeof body?.token !== "string") {
			setBusy(false);
			setError(
				body?.error === "bad_phone"
					? t.quote.errorPhone
					: body?.error === "invalid_design"
						? t.quote.errorDesign
						: t.quote.errorGeneric,
			);
			return;
		}
		// Counts only. The form's fields are personal data and never go to
		// analytics — see src/lib/analytics.ts.
		track("quote_submitted", {
			room: roomId,
			cabinets: placed.length,
			totalRm: Math.round(price.totalRm + deliveryRm),
		});
		router.push(`/${locale}/order/${body.token}`);
	}

	return (
		<main className="flex h-[calc(100dvh-2.25rem)] flex-col bg-[#e9e7e3] text-neutral-900">
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
					<div>
						<h2 className="mb-1 font-semibold text-[22px]">
							{fill(t.quote.heading, { room: room.label.toLowerCase() })}
						</h2>
						<p className="max-w-[480px] text-[14px] text-neutral-500 leading-5">
							{t.quote.description}
						</p>
					</div>

					<form
						className="flex max-w-[420px] flex-col gap-3"
						aria-describedby={error ? "order-error" : undefined}
						onSubmit={(e) => {
							e.preventDefault();
							placeOrder(e.currentTarget);
						}}
					>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.fullName}
							</span>
							<input
								name="name"
								type="text"
								autoComplete="name"
								required
								disabled={busy}
								className={FIELD}
								placeholder="Nur Aisyah binti Kamal"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.phone}
							</span>
							<input
								name="phone"
								type="tel"
								autoComplete="tel"
								required
								disabled={busy}
								className={FIELD}
								placeholder="+60 12-345 6789"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.email}
							</span>
							<input
								name="email"
								type="email"
								autoComplete="email"
								disabled={busy}
								className={FIELD}
								placeholder="you@example.com"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.siteAddress}
							</span>
							<textarea
								name="siteAddress"
								autoComplete="street-address"
								required
								minLength={5}
								rows={2}
								disabled={busy}
								className={FIELD}
								placeholder="12 Jalan Meranti 4, 47120 Puchong, Selangor"
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="font-medium text-[12px] text-neutral-700">
								{t.quote.addressNotes}
							</span>
							<input
								name="addressNotes"
								type="text"
								disabled={busy}
								className={FIELD}
							/>
						</label>
						<label className="mt-1 flex items-start gap-2">
							<input
								type="checkbox"
								required
								disabled={busy}
								className="mt-0.5"
							/>
							<span className="text-[12px] text-neutral-500 leading-4">
								{t.quote.remeasureNote}
							</span>
						</label>
						{error && (
							<p
								id="order-error"
								role="alert"
								className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700"
							>
								{error}
							</p>
						)}
						<button
							type="submit"
							disabled={busy}
							className="mt-1 rounded-lg bg-neutral-900 px-3 py-3 font-medium text-[14px] text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{busy ? t.quote.submitting : t.quote.submitCta}
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
							targetRun={0}
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
								wall: (wallsOf(layout.plan)[0].lengthMm / 1000).toFixed(2),
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

					<div className="flex flex-col gap-1 border-neutral-200 border-t pt-3 text-[13px]">
						<div className="flex items-baseline justify-between text-neutral-500">
							<span>{t.quote.subtotal}</span>
							<span className="tabular-nums">{formatRm(price.totalRm)}</span>
						</div>
						<div className="flex items-baseline justify-between text-neutral-500">
							<span>{t.quote.delivery}</span>
							<span className="tabular-nums">{formatRm(deliveryRm)}</span>
						</div>
						<div className="mt-1 flex items-baseline justify-between">
							<span className="font-medium">{t.quote.total}</span>
							<span className="font-semibold text-xl tabular-nums">
								{formatRm(price.totalRm + deliveryRm)}
							</span>
						</div>
					</div>
				</aside>
			</div>
		</main>
	);
}
