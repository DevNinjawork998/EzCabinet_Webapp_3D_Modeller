import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyOrderId } from "@/app/[lang]/track/[token]/CopyOrderId";
import {
	priceLineDetail,
	priceLineLabel,
} from "@/components/planner/priceLineCopy";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";
import { canViewOrder, viewerOf } from "@/lib/orders/access";
import { orderCard, unitCount } from "@/lib/orders/card";
import { paymentInstructions } from "@/lib/orders/payment";
import { orderRef } from "@/lib/orders/ref";
import { STAGES, stageReached } from "@/lib/orders/stage";
import { summaryExtras, summaryLines } from "@/lib/orders/summary";
import { activeGateway } from "@/lib/payments/registry";
import { ROOM_TYPES } from "@/lib/planner/catalogue";
import { PaymentBadge } from "../../PaymentBadge";
import { OnlinePayment } from "./OnlinePayment";
import { RefreshWhileSettling } from "./RefreshWhileSettling";

/**
 * The page a customer lands on after checkout: what they ordered, what it
 * cost, how to pay, and — once logistics has a job — a link to follow it.
 *
 * Addressed by the order's `publicToken`, never its number, and never
 * indexed: it carries a home address. The token is an address, not a key —
 * only the account that placed the order, or staff, may open it
 * (`lib/orders/access.ts`). Anyone else gets the same 404 as a made-up token.
 * `noindex` comes from the account layout.
 */

const CARD =
	"rounded-[14px] border border-[#e5e5e5] bg-white px-[22px] py-5 text-[#171717]";
const CARD_HEADING =
	"font-semibold text-[#525252] text-[12px] uppercase tracking-[.06em]";

const rm = (amount: number) =>
	`RM ${amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;

export default async function OrderPage({
	params,
	searchParams,
}: {
	params: Promise<{ lang: string; token: string }>;
	searchParams: Promise<{ redirect_status?: string }>;
}) {
	const { lang, token } = await params;
	// Back from the gateway — Stripe appends `redirect_status` to the return
	// URL (a Fiuu return route would map its status to the same). Only ever
	// changes wording and what is offered: PAID comes from the webhook alone.
	const returned = (await searchParams).redirect_status;
	if (!isLocale(lang)) notFound();
	const viewer = await viewerOf(lang, `/${lang}/order/${token}`);

	const [order, t] = await Promise.all([
		prisma.order.findUnique({
			where: { publicToken: token },
			// Short on purpose: the row also holds the phone number, the email and
			// who marked it paid, none of which this page shows.
			select: {
				userId: true,
				number: true,
				createdAt: true,
				status: true,
				siteAddress: true,
				breakdown: true,
				cabinetsRm: true,
				deliveryRm: true,
				totalRm: true,
				productionStage: true,
				roomId: true,
				deliveries: {
					select: { publicToken: true },
					orderBy: { createdAt: "desc" },
					take: 1,
				},
			},
		}),
		getDictionary(lang),
	]);
	if (order === null || !canViewOrder(viewer, order)) notFound();

	const o = t.order;
	const ref = orderRef(order.number, order.createdAt);
	const lines = summaryLines(order.breakdown);
	const extras = summaryExtras(order.breakdown);
	const delivery = order.deliveries[0] ?? null;
	const awaiting = order.status === "AWAITING_PAYMENT";
	// Paid at the gateway, webhook not landed yet — or the bank still deciding.
	const confirming = awaiting && returned === "succeeded";
	const processing = awaiting && returned === "processing";
	const failed = awaiting && returned === "failed";
	const settling = confirming || processing;
	// The active gateway when there is one, bank transfer when there is not.
	const payOnline = awaiting && !settling && (await activeGateway()) !== null;
	const pay =
		awaiting && !settling && !payOnline ? paymentInstructions(order) : null;
	const [heading, body] =
		order.status === "PAID"
			? [o.headingPaid, o.bodyPaid]
			: order.status === "CANCELLED"
				? [o.headingCancelled, o.bodyCancelled]
				: confirming
					? [o.headingConfirming, o.bodyConfirming]
					: processing
						? [o.headingProcessing, o.bodyProcessing]
						: payOnline
							? [o.headingAwaiting, o.bodyAwaitingOnline]
							: [o.headingAwaiting, o.bodyAwaiting];

	const card = orderCard({
		status: order.status,
		productionStage: order.productionStage,
		hasDelivery: delivery !== null,
	});
	const units = unitCount(order.breakdown);
	const room =
		ROOM_TYPES.find((r) => r.id === order.roomId)?.label ?? order.roomId;
	const title =
		units === 0
			? room
			: fill(units === 1 ? t.orders.unitsOne : t.orders.unitsOther, {
					room,
					count: units,
				});
	const badgeLabel = {
		paid: t.orders.statusPaid,
		awaiting: t.orders.statusAwaiting,
		cancelled: t.orders.statusCancelled,
	}[card.badge];
	const paid = order.status === "PAID";
	const progress: { label: string; detail?: string; done: boolean }[] = [
		{ label: o.stagePaid, done: paid },
		...STAGES.map((stage) => ({
			label: o.stages[stage],
			detail: stage === "MEASURE" ? o.stageMeasureDetail : undefined,
			done: paid && stageReached(order.productionStage, stage),
		})),
		{ label: o.stageDelivery, done: false },
	];
	const next = progress.findIndex((step) => !step.done);

	return (
		<>
			{settling && <RefreshWhileSettling />}
			<Link
				href={`/${lang}/orders`}
				className="flex min-h-9 items-center gap-1.5 self-start rounded-lg border border-[#d4d4d4] bg-white px-3 font-medium text-[#171717] text-[12px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
			>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
					<path
						d="M7.5 2.5 4 6l3.5 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
				{t.account.myOrders}
			</Link>

			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">{title}</h1>
					<p className="flex flex-wrap items-center gap-1.5 text-[#5c574e] text-[13px]">
						<span className="font-mono">{ref}</span>
						<CopyOrderId
							value={ref}
							label={o.copyOrderId}
							copiedLabel={o.copied}
						/>
						<span>
							·{" "}
							{fill(t.orders.orderedOn, {
								date: order.createdAt.toLocaleDateString(lang, {
									day: "numeric",
									month: "short",
									year: "numeric",
								}),
							})}
						</span>
					</p>
				</div>
				<PaymentBadge badge={card.badge} label={badgeLabel} />
			</div>

			<p className="text-[#404040] text-[14px]" role="status">
				<span className="font-semibold text-[#171717]">{heading}.</span> {body}
			</p>

			<div className="flex flex-wrap items-start gap-[18px]">
				<section className={`${CARD} min-w-0 flex-[1_1_300px]`}>
					<h2 className={`${CARD_HEADING} mb-3.5`}>{o.progressHeading}</h2>
					<ol className="flex flex-col gap-3">
						{progress.map((step, i) => (
							<li key={step.label} className="flex items-start gap-3">
								<span
									className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] text-white ${
										step.done
											? "bg-[#1f5138]"
											: i === next
												? "border-2 border-[#1f5138] bg-white"
												: "bg-[#d4d4d4]"
									}`}
								>
									{step.done ? "✓" : ""}
								</span>
								<div>
									<p className="font-medium text-[13px]">{step.label}</p>
									{step.detail && (
										<p className="text-[#5c574e] text-[12px] leading-[17px]">
											{step.detail}
										</p>
									)}
								</div>
							</li>
						))}
					</ol>
				</section>

				<div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
					{payOnline && (
						<section className={CARD}>
							{failed && (
								<div
									role="alert"
									className="mb-4 rounded-[10px] border border-[#f0b4ae] bg-[#fdf1ef] px-3.5 py-3 text-[#3d3a34] text-[13px] leading-[18px]"
								>
									<p className="mb-0.5 font-semibold">
										{t.quote.paymentFailedTitle}
									</p>
									<p>{t.quote.paymentFailedBody}</p>
								</div>
							)}
							<h2 className={`${CARD_HEADING} mb-3.5`}>{o.payOnlineHeading}</h2>
							<OnlinePayment
								token={token}
								payLabel={fill(o.payOnlineCta, { amount: rm(order.totalRm) })}
								errorText={o.payOnlineError}
								settlingText={o.bodyConfirming}
							/>
						</section>
					)}

					{pay && (
						<section className={CARD}>
							<h2 className={`${CARD_HEADING} mb-3.5`}>{o.payHeading}</h2>
							<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
								{(
									[
										[o.payBank, pay.bank],
										[o.payAccountName, pay.accountName],
										[o.payAccountNumber, pay.accountNumber],
										[o.payReference, pay.reference],
										[o.payAmount, rm(pay.amountRm)],
									] as const
								).map(([label, value]) => (
									<div key={label} className="contents">
										<dt className="text-[#5c574e]">{label}</dt>
										<dd className="font-medium tabular-nums">{value}</dd>
									</div>
								))}
							</dl>
							<p className="mt-3.5 border-[#ecebe7] border-t pt-3 text-[#737373] text-[12px] leading-[17px]">
								{o.payNote}
							</p>
						</section>
					)}

					<section className={CARD}>
						<h2 className={`${CARD_HEADING} mb-3.5`}>{o.summaryHeading}</h2>
						{lines.map((line) => (
							<div
								key={line.name}
								className="flex items-start justify-between gap-3 border-[#f1f0ed] border-b py-2.5"
							>
								<div>
									<p className="mb-0.5 font-medium text-[13px]">{line.name}</p>
									<p className="text-[#8a857c] text-[12px]">
										{fill(o.qty, { count: line.qty })}
									</p>
								</div>
								<span className="shrink-0 font-medium text-[13px] tabular-nums">
									{rm(line.amountRm)}
								</span>
							</div>
						))}
						{extras.map((line) => (
							<div
								key={line.id}
								className="flex items-start justify-between gap-3 border-[#f1f0ed] border-b py-2.5"
							>
								<div>
									<p className="mb-0.5 font-medium text-[13px]">
										{priceLineLabel(t, line)}
									</p>
									<p className="text-[#8a857c] text-[12px]">
										{priceLineDetail(t, line)}
									</p>
								</div>
								<span className="shrink-0 font-medium text-[13px] tabular-nums">
									{rm(line.amountRm)}
								</span>
							</div>
						))}
						<div className="mt-1 flex justify-between pt-3.5 text-[12px]">
							<span className="text-[#5c574e]">{o.subtotal}</span>
							<span className="tabular-nums">{rm(order.cabinetsRm)}</span>
						</div>
						<div className="flex justify-between pt-1.5 text-[12px]">
							<span className="text-[#5c574e]">{o.delivery}</span>
							<span className="tabular-nums">{rm(order.deliveryRm)}</span>
						</div>
						<div className="mt-1.5 flex justify-between border-[#ecebe7] border-t pt-2.5 font-semibold text-[14px]">
							<span>{paid ? o.totalPaid : o.totalDue}</span>
							<span className="tabular-nums">{rm(order.totalRm)}</span>
						</div>
					</section>

					<section className={CARD}>
						<h2 className={`${CARD_HEADING} mb-1.5`}>{o.addressHeading}</h2>
						<p className="whitespace-pre-line text-[13px] leading-5">
							{order.siteAddress}
						</p>
					</section>

					{delivery && (
						<Link
							href={`/${lang}/track/${delivery.publicToken}`}
							className="inline-flex min-h-10 items-center self-start rounded-[9px] bg-[#1f5138] px-4 font-semibold text-[13px] text-white hover:bg-[#1a4430]"
						>
							{o.trackDelivery}
						</Link>
					)}
				</div>
			</div>
		</>
	);
}
