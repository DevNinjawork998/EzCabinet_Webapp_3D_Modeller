"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { authClient } from "@/lib/auth/client";
import { fill } from "@/lib/copy/fill";
import { htmlLang } from "@/lib/copy/locales";
import type { FinishId, RoomTypeId } from "@/lib/planner/catalogue";
import { doorStyleIn, ratesOf, roomTypeIn } from "@/lib/planner/catalogue";
import { computePlannerPrice } from "@/lib/planner/pricing";
import type { RoomLayout } from "@/lib/planner/room";
import { useCatalogue, useRoomEngine } from "./CatalogueContext";
import { CheckoutProgress } from "./CheckoutProgress";
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
	"min-h-[42px] rounded-lg bg-white px-3 py-2.5 text-[14px] text-[#171717] placeholder:text-[#a3a3a3] disabled:bg-neutral-50";
const fieldClass = (error: string | undefined) =>
	`${FIELD} ${error ? "border-[1.5px] border-[#b42318]" : "border border-[#d4d4d4]"}`;

type FieldErrors = Partial<
	Record<"name" | "phone" | "siteAddress" | "remeasure", string>
>;

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
	const { allPositions, runExtentsMm } = useRoomEngine();
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
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

	// The person paying is not always the person whose Google account it is,
	// so this only pre-fills the fields — both stay editable.
	const { data: session } = authClient.useSession();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	useEffect(() => {
		if (!session?.user) return;
		setName((current) => current || session.user.name || "");
		setEmail((current) => current || session.user.email || "");
	}, [session]);

	async function placeOrder(form: HTMLFormElement) {
		const field = (key: string) =>
			String(new FormData(form).get(key) ?? "").trim();

		// Checked here rather than by the browser so every problem shows at once,
		// in our words, next to its field. The server re-checks all of it.
		const errors: FieldErrors = {};
		if (!field("name")) errors.name = t.quote.errorNameRequired;
		if (!field("phone")) errors.phone = t.quote.errorPhoneRequired;
		const address = field("siteAddress");
		if (!address) errors.siteAddress = t.quote.errorAddressRequired;
		else if (address.length < 5) errors.siteAddress = t.quote.errorAddressShort;
		if (new FormData(form).get("remeasure") !== "on")
			errors.remeasure = t.quote.errorRemeasure;
		setFieldErrors(errors);
		if (Object.keys(errors).length > 0) return;

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
				whatsappOptIn: new FormData(form).get("whatsappOptIn") === "on",
				locale,
			}),
		}).catch(() => null);
		const body = await res?.json().catch(() => null);
		if (res?.status === 401 && body?.error === "sign_in_required") {
			// The design is already on disk (plannerDraft autosave), so there is
			// nothing to lose here — just send the customer to sign in and let
			// the existing rehydrate bring it back on the way in.
			router.push(
				`/${locale}/sign-in?next=${encodeURIComponent(
					window.location.pathname + window.location.search,
				)}`,
			);
			return;
		}
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

	const total = formatRm(price.totalRm + deliveryRm);
	const clearError = (key: keyof FieldErrors) =>
		setFieldErrors((current) =>
			current[key] ? { ...current, [key]: undefined } : current,
		);
	const errorText = (key: keyof FieldErrors) =>
		fieldErrors[key] && (
			<p id={`err-${key}`} role="alert" className="text-[#b42318] text-[12px]">
				{fieldErrors[key]}
			</p>
		);
	const describedBy = (key: keyof FieldErrors) =>
		fieldErrors[key] ? `err-${key}` : undefined;
	const LABEL = "font-medium text-[#404040] text-[12px]";

	return (
		<main className="flex h-[calc(100dvh-2.25rem)] flex-col bg-[#e9e7e3] text-[#171717]">
			<PlannerHeader
				trail={[
					{ label: t.common.brand, href: "/" },
					{ label: t.planner.crumbs.roomPlanner, onClick: onBackToStartAction },
					{ label: t.planner.crumbs.quote },
				]}
			>
				<CheckoutProgress
					ariaLabel={t.quote.progressAriaLabel}
					labels={[t.quote.stepDetails, t.quote.stepPayment, t.quote.stepDone]}
					step={0}
				/>
				<button
					type="button"
					onClick={onBackToStudioAction}
					className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[#d4d4d4] bg-white px-3 font-medium text-[12px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
				>
					<svg
						width="12"
						height="12"
						viewBox="0 0 12 12"
						fill="none"
						aria-hidden
					>
						<path
							d="M7.5 2.5 4 6l3.5 3.5"
							stroke="currentColor"
							strokeWidth="1.4"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					{t.quote.backToEditing}
				</button>
				<AdminLink />
			</PlannerHeader>

			<div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 pt-10 pb-14 sm:px-7">
				<div className="flex w-full max-w-[1040px] flex-wrap items-start gap-8">
					<div className="min-w-0 flex-[1_1_440px]">
						<h2 className="mb-1.5 font-semibold text-[22px]">
							{fill(t.quote.heading, { room: room.label.toLowerCase() })}
						</h2>
						<p className="mb-[22px] max-w-[480px] text-[#5c574e] text-[14px] leading-5">
							{t.quote.description}
						</p>

						<form
							noValidate
							className="flex max-w-[480px] flex-col gap-3"
							aria-describedby={error ? "order-error" : undefined}
							onSubmit={(e) => {
								e.preventDefault();
								placeOrder(e.currentTarget);
							}}
						>
							<label className="flex flex-col gap-1.5">
								<span className={LABEL}>{t.quote.fullName}</span>
								<input
									name="name"
									type="text"
									autoComplete="name"
									disabled={busy}
									className={fieldClass(fieldErrors.name)}
									aria-invalid={!!fieldErrors.name}
									aria-describedby={describedBy("name")}
									placeholder="Nur Aisyah binti Kamal"
									value={name}
									onChange={(e) => {
										setName(e.target.value);
										clearError("name");
									}}
								/>
								{errorText("name")}
							</label>
							<label className="flex flex-col gap-1.5">
								<span className={LABEL}>{t.quote.phone}</span>
								<input
									name="phone"
									type="tel"
									autoComplete="tel"
									disabled={busy}
									className={fieldClass(fieldErrors.phone)}
									aria-invalid={!!fieldErrors.phone}
									aria-describedby={describedBy("phone")}
									placeholder="+60 12-345 6789"
									onChange={() => clearError("phone")}
								/>
								{errorText("phone")}
							</label>
							<label className="flex flex-col gap-1.5">
								<span className={LABEL}>{t.quote.email}</span>
								<input
									name="email"
									type="email"
									autoComplete="email"
									disabled={busy}
									className={fieldClass(undefined)}
									placeholder="you@example.com"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
							</label>
							<label className="flex flex-col gap-1.5">
								<span className={LABEL}>{t.quote.siteAddress}</span>
								<textarea
									name="siteAddress"
									autoComplete="street-address"
									rows={2}
									disabled={busy}
									className={`${fieldClass(fieldErrors.siteAddress)} min-h-16 resize-y`}
									aria-invalid={!!fieldErrors.siteAddress}
									aria-describedby={describedBy("siteAddress")}
									placeholder="12 Jalan Meranti 4, 47120 Puchong, Selangor"
									onChange={() => clearError("siteAddress")}
								/>
								{errorText("siteAddress")}
							</label>
							<label className="flex flex-col gap-1.5">
								<span className={LABEL}>{t.quote.addressNotes}</span>
								<input
									name="addressNotes"
									type="text"
									disabled={busy}
									className={fieldClass(undefined)}
								/>
							</label>
							<label className="mt-1 flex min-h-9 cursor-pointer items-start gap-[9px]">
								<input
									name="remeasure"
									type="checkbox"
									disabled={busy}
									aria-describedby={describedBy("remeasure")}
									onChange={() => clearError("remeasure")}
									className="mt-px h-4 w-4 shrink-0 accent-[#171717]"
								/>
								<span className="text-[#5c574e] text-[12px] leading-[17px]">
									{t.quote.remeasureNote}
								</span>
							</label>
							{fieldErrors.remeasure && (
								<p
									id="err-remeasure"
									role="alert"
									className="-mt-1.5 ml-[25px] text-[#b42318] text-[12px]"
								>
									{fieldErrors.remeasure}
								</p>
							)}
							<label className="flex min-h-9 cursor-pointer items-start gap-[9px]">
								<input
									name="whatsappOptIn"
									type="checkbox"
									disabled={busy}
									className="mt-px h-4 w-4 shrink-0 accent-[#171717]"
								/>
								<span className="text-[#5c574e] text-[12px] leading-[17px]">
									{t.quote.whatsappOptIn}
								</span>
							</label>
							{error && (
								<p
									id="order-error"
									role="alert"
									className="rounded-lg border border-[#fca5a5] bg-[#fef2f2] px-3 py-2 text-[#7f1d1d] text-[13px]"
								>
									{error}
								</p>
							)}
							<button
								type="submit"
								disabled={busy}
								className="mt-1 flex min-h-12 items-center justify-center gap-2.5 rounded-[10px] bg-[#171717] px-3 font-medium text-[14px] text-white transition hover:bg-[#262626] active:bg-[#0a0a0a] disabled:cursor-not-allowed disabled:opacity-50"
							>
								{busy ? (
									t.quote.submitting
								) : (
									<>
										{t.quote.submitCta}
										<span className="font-semibold tabular-nums">{total}</span>
									</>
								)}
							</button>
						</form>
					</div>

					<aside className="flex min-w-[300px] flex-[0_1_380px] flex-col gap-4 rounded-[14px] border border-[#e5e5e5] bg-[#f7f6f4] p-[22px] lg:sticky lg:top-0">
						<div className="relative h-[180px] overflow-hidden rounded-[10px] border border-[#e5e5e5] bg-[#efeeeb]">
							<PlannerScene
								layout={layout}
								finish={finish}
								finishTextures={finishTextures}
								selectedIds={new Set()}
								doorTargetId={null}
								targetRun={0}
								frameWholeRoom
								showPanPuck={false}
								onLayoutChangeAction={() => {}}
								onSelectAction={() => {}}
								pickerRef={pickerRef}
								hitTestRef={hitTestRef}
							/>
						</div>
						<div>
							<p className="mb-[3px] font-semibold text-[13px]">
								{fill(t.quote.summary, {
									room: room.label,
									// Every wall with a run, as the studio reads it.
									runs:
										runExtentsMm(layout)
											.map((mm) => `${(mm / 1000).toFixed(2)} m`)
											.join(" + ") || "0.00 m",
									count: placed.length,
									unit: placed.length === 1 ? t.planner.unit : t.planner.units,
								})}
							</p>
							<p className="text-[#5c574e] text-[12px]">
								{finishLabel} · {frontLabel}
							</p>
						</div>
						<ul className="flex flex-col gap-1.5 border-[#e5e5e5] border-t pt-3">
							{price.categories.map((line) => (
								<li
									key={line.id}
									className="flex items-baseline justify-between gap-2.5 text-[12px]"
								>
									<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[5px] text-[#525252]">
										<span>{priceLineLabel(t, line)}</span>
										<span className="text-[#8a857c] text-[11px]">
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

						<div className="flex flex-col gap-[5px] border-[#e5e5e5] border-t pt-3 text-[13px]">
							<div className="flex justify-between text-[#5c574e]">
								<span>{t.quote.subtotal}</span>
								<span className="tabular-nums">{formatRm(price.totalRm)}</span>
							</div>
							<div className="flex justify-between text-[#5c574e]">
								<span>{t.quote.delivery}</span>
								<span className="tabular-nums">{formatRm(deliveryRm)}</span>
							</div>
							<div className="mt-1 flex items-baseline justify-between">
								<span className="font-medium">{t.quote.total}</span>
								<span className="font-semibold text-[20px] tabular-nums">
									{total}
								</span>
							</div>
						</div>
					</aside>
				</div>
			</div>
		</main>
	);
}
