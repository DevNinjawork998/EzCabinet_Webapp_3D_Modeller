import Link from "next/link";
import { notFound } from "next/navigation";
import { journeySteps } from "@/app/admin/logistics/tracking";
import { SiteHeader } from "@/components/SiteHeader";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { htmlLang, isLocale, type Locale } from "@/lib/copy/locales";
import { LABEL as CARRIER_LABEL } from "@/lib/logistics/carriers";
import {
	customerEvents,
	orderRef,
	readItems,
	shipmentBooked,
	trackingTone,
} from "@/lib/logistics/publicTracking";
import { canViewOrder, viewerOf } from "@/lib/orders/access";
import { CopyOrderId } from "./CopyOrderId";

/**
 * The page a customer opens from the link we send them: what they ordered,
 * where it is going, and how far along it is.
 *
 * Reached by an unguessable `publicToken` rather than the job number. The
 * number is sequential and is printed on the page precisely so it can be said
 * out loud — which is why it cannot also be the key to an address and a
 * delivery window.
 *
 * A server component with no client fetch: it is one query, it must be right in
 * the first paint on a phone on mobile data, and everything moving on it moves
 * at courier speed rather than at render speed.
 *
 * A delivery that belongs to an order is locked like the order page
 * (`lib/orders/access.ts`); a standalone admin-booked one stays link-access,
 * since its recipient has no account.
 */

/**
 * Never indexed. A tracking link is one customer's address, and a crawler that
 * finds one has found a page no search result should ever carry.
 */
export const metadata = { robots: { index: false, follow: false } };

/** Malaysia is the whole audience; a function on Vercel runs in UTC. */
const TZ = "Asia/Kuala_Lumpur";

const dateAt = (value: Date, lang: Locale) =>
	new Intl.DateTimeFormat(htmlLang(lang), {
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
		timeZone: TZ,
	}).format(value);

const dateOnly = (value: Date, lang: Locale) =>
	new Intl.DateTimeFormat(htmlLang(lang), {
		weekday: "short",
		day: "numeric",
		month: "short",
		timeZone: TZ,
	}).format(value);

const fill = (template: string, values: Record<string, string | number>) =>
	template.replace(/\{(\w+)\}/g, (whole, key) =>
		key in values ? String(values[key]) : whole,
	);

const CARD =
	"rounded-[14px] border border-[#e5e5e5] bg-white px-[22px] py-5 text-[#171717]";
const CARD_HEADING =
	"font-semibold text-[#525252] text-[12px] uppercase tracking-[.06em]";
const GREEN = "#1f5138";

export default async function TrackPage({
	params,
}: {
	params: Promise<{ lang: string; token: string }>;
}) {
	const { lang, token } = await params;
	if (!isLocale(lang)) notFound();

	const [delivery, t] = await Promise.all([
		prisma.delivery.findUnique({
			where: { publicToken: token },
			// Explicit, and short on purpose: this row also holds the customer's
			// phone number, the admin's address notes, who spent the money and
			// every carrier payload we have kept. None of that is the customer's
			// to be shown, and a `select` is the only place that stays true when
			// the model grows a column.
			select: {
				number: true,
				siteAddress: true,
				scheduledAt: true,
				status: true,
				carrierId: true,
				carrierOrderId: true,
				items: true,
				createdAt: true,
				events: {
					orderBy: { at: "desc" },
					select: { id: true, at: true, status: true },
				},
				order: { select: { userId: true } },
			},
		}),
		getDictionary(lang),
	]);
	if (delivery === null) notFound();
	if (delivery.order !== null) {
		const viewer = await viewerOf(lang, `/${lang}/track/${token}`);
		if (!canViewOrder(viewer, delivery.order)) notFound();
	}

	const booked = shipmentBooked(delivery.status);
	const tone = trackingTone(delivery.status);
	const items = readItems(delivery.items);
	const events = customerEvents(
		delivery.events.map((event) => ({
			...event,
			at: event.at.toISOString(),
		})),
	);
	const steps = journeySteps(delivery.status, events, delivery.carrierId);

	const heading =
		tone === "delivered"
			? t.track.headingDelivered
			: tone === "stopped"
				? t.track.headingStopped
				: t.track.headingPlaced;
	const body =
		tone === "delivered"
			? t.track.bodyDelivered
			: tone === "stopped"
				? t.track.bodyStopped
				: t.track.bodyPlaced;
	const carrierName =
		delivery.carrierId === null
			? null
			: (CARRIER_LABEL[delivery.carrierId] ?? delivery.carrierId);
	const carrierLine = !booked
		? t.track.awaitingCarrier
		: carrierName === null
			? null
			: delivery.carrierOrderId === null
				? fill(t.track.carrierBooked, { carrier: carrierName })
				: fill(t.track.carrierRef, {
						carrier: carrierName,
						reference: delivery.carrierOrderId,
					});

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-[#171717]">
			<SiteHeader lang={lang} t={t} />

			<main className="flex flex-1 justify-center px-6 py-14">
				<div className="flex w-full max-w-[560px] flex-col gap-6">
					<div className="flex flex-col items-center gap-3.5 text-center">
						<span
							className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full"
							style={{ background: tone === "stopped" ? "#8a857c" : GREEN }}
						>
							{tone === "stopped" ? (
								<svg
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									role="img"
									aria-label={heading}
								>
									<path
										d="M12 7v6M12 16.5v.5"
										stroke="#fff"
										strokeWidth="2.2"
										strokeLinecap="round"
									/>
								</svg>
							) : (
								<svg
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									role="img"
									aria-label={heading}
								>
									<path
										d="M5 12.5l4.5 4.5L19 7"
										stroke="#fff"
										strokeWidth="2.2"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							)}
						</span>
						<div>
							<h1 className="mb-1.5 font-semibold text-[24px]">{heading}</h1>
							<p className="text-[#5c574e] text-[14px]">{body}</p>
						</div>
						<div className="flex items-center gap-2 rounded-full border border-[#e5e5e5] bg-white py-2 pr-2 pl-4">
							<span className="text-[#5c574e] text-[12px]">
								{t.track.orderId}
							</span>
							<span className="font-semibold text-[13px] tracking-[.02em]">
								{orderRef(delivery.number)}
							</span>
							<CopyOrderId
								value={orderRef(delivery.number)}
								label={t.track.copyOrderId}
								copiedLabel={t.track.copied}
							/>
						</div>
					</div>

					<section className={CARD}>
						<p className={`mb-3.5 ${CARD_HEADING}`}>{t.track.summaryHeading}</p>
						{items.length === 0 ? (
							<p className="text-[#8a857c] text-[13px]">{t.track.noItems}</p>
						) : (
							items.map(({ item, key }) => (
								<div
									key={key}
									className="flex items-start justify-between gap-3 border-[#f1f0ed] border-b py-2.5"
								>
									<div>
										<p className="mb-[3px] font-medium text-[13px]">
											{item.label}
										</p>
										<p className="text-[#8a857c] text-[12px]">
											{fill(t.track.qty, { count: item.qty })}
										</p>
									</div>
									<span className="shrink-0 text-[#8a857c] text-[12px]">
										{item.widthMm} × {item.heightMm} × {item.depthMm} mm
									</span>
								</div>
							))
						)}
					</section>

					<section className={`${CARD} flex flex-col gap-4`}>
						<div>
							<p className={`mb-1.5 ${CARD_HEADING}`}>
								{t.track.addressHeading}
							</p>
							<p className="wrap-anywhere text-[13px] leading-5">
								{delivery.siteAddress}
							</p>
						</div>
						<div className="flex items-center justify-between gap-3 border-[#ecebe7] border-t pt-3.5">
							<div>
								<p className="mb-[3px] text-[#5c574e] text-[12px]">
									{booked ? t.track.etaHeading : t.track.awaitingEtaHeading}
								</p>
								<p className="font-medium text-[13px]">
									{delivery.scheduledAt === null
										? t.track.etaPending
										: dateOnly(delivery.scheduledAt, lang)}
								</p>
							</div>
							<span className="shrink-0 rounded-full bg-[#f2efe6] px-3 py-1.5 font-semibold text-[#6b5f2e] text-[11px]">
								{t.track.status[delivery.status]}
							</span>
						</div>
					</section>

					<section className={CARD}>
						<div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
							<p className={CARD_HEADING}>
								{booked ? t.track.statusHeading : t.track.awaitingHeading}
							</p>
							{carrierLine && (
								<p className="text-[#5c574e] text-[12px]">{carrierLine}</p>
							)}
						</div>

						{booked ? (
							<>
								{/* Five stops at 11px do not fit a 360px phone, so the tracker
								    scrolls sideways inside the card rather than squeezing the
								    labels into one character per line. */}
								<div className="-mx-[22px] mb-5 overflow-x-auto px-[22px]">
									<div className="flex min-w-[460px]">
										{steps.map((step, i) => {
											const lit =
												step.state === "done" || step.state === "active";
											return (
												<div
													key={step.status}
													className="flex flex-1 flex-col items-center"
												>
													<div className="flex w-full items-center">
														<div
															className="h-0.5 flex-1"
															style={{
																background:
																	i === 0
																		? "transparent"
																		: lit
																			? GREEN
																			: "#e5e5e5",
															}}
														/>
														<span
															className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] text-white"
															style={{
																background: lit ? GREEN : "#d4d4d4",
																borderColor: lit ? GREEN : "#d4d4d4",
																boxShadow:
																	step.state === "active"
																		? "0 0 0 3px #dbe8e0"
																		: undefined,
															}}
														>
															{step.state === "done" ? "✓" : ""}
														</span>
														<div
															className="h-0.5 flex-1"
															style={{
																background:
																	i === steps.length - 1
																		? "transparent"
																		: step.state === "done"
																			? GREEN
																			: "#e5e5e5",
															}}
														/>
													</div>
													<p
														className="mt-2 text-center font-semibold text-[11px]"
														style={{ color: lit ? "#171717" : "#a3a19b" }}
													>
														{t.track.status[step.status]}
													</p>
												</div>
											);
										})}
									</div>
								</div>

								<div className="flex flex-col gap-2.5">
									{events.length === 0 ? (
										<p className="text-[#8a857c] text-[13px]">
											{t.track.timelineEmpty}
										</p>
									) : (
										events.map((event) => (
											<div
												key={`${event.at}-${event.status}`}
												className="flex items-start gap-3"
											>
												<span
													className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full"
													style={{ background: GREEN }}
												/>
												<div className="flex-1">
													<p className="mb-0.5 text-[13px]">
														{t.track.status[event.status]}
													</p>
													<p className="text-[#8a857c] text-[11px]">
														{dateAt(new Date(event.at), lang)}
													</p>
												</div>
											</div>
										))
									)}
								</div>
							</>
						) : (
							<>
								<ol className="m-0 flex list-none flex-col p-0">
									{[
										{
											label: t.track.stagePlaced,
											detail: dateAt(delivery.createdAt, lang),
											done: true,
										},
										{
											label: t.track.stageBuilding,
											detail: t.track.stageBuildingDetail,
											done: false,
										},
									].map((stage) => (
										<li
											key={stage.label}
											className="flex items-start gap-3 pb-3.5"
										>
											<span
												className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] text-white"
												style={{
													background: GREEN,
													borderColor: GREEN,
													boxShadow: stage.done
														? undefined
														: "0 0 0 3px #dbe8e0",
												}}
											>
												{stage.done ? "✓" : ""}
											</span>
											<div className="min-w-0 flex-1">
												<p className="mb-0.5 font-medium text-[13px]">
													{stage.label}
												</p>
												<p className="text-[#8a857c] text-[12px] leading-[17px]">
													{stage.detail}
												</p>
											</div>
										</li>
									))}
								</ol>
								<div className="flex flex-col gap-1.5 border-[#ecebe7] border-t pt-3.5">
									<p className="text-[#404040] text-[13px] leading-[19px]">
										{t.track.awaitingNote}
									</p>
									<p className="text-[#8a857c] text-[12px] leading-[17px]">
										{t.track.awaitingNoteSub}
									</p>
								</div>
							</>
						)}
					</section>

					<div className="flex flex-wrap justify-center gap-3">
						<Link
							href={`/${lang}/planner`}
							className="flex min-h-11 items-center rounded-full px-[22px] py-3 font-semibold text-[13px] text-white hover:bg-[#1a4430]"
							style={{ background: GREEN }}
						>
							{t.track.backToPlanner}
						</Link>
						<Link
							href={`/${lang}`}
							className="flex min-h-11 items-center rounded-full border border-[#d4d4d4] px-[22px] py-3 font-medium text-[#404040] text-[13px] hover:border-[#a3a3a3] hover:bg-white"
						>
							{t.track.backHome}
						</Link>
					</div>
				</div>
			</main>
		</div>
	);
}
