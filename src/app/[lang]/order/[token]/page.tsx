import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyOrderId } from "@/app/[lang]/track/[token]/CopyOrderId";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";
import { paymentInstructions } from "@/lib/orders/payment";
import { orderRef } from "@/lib/orders/ref";
import { STAGES, stageReached } from "@/lib/orders/stage";
import { summaryLines } from "@/lib/orders/summary";

/**
 * The page a customer lands on after checkout: what they ordered, what it
 * cost, how to pay, and — once logistics has a job — a link to follow it.
 *
 * Reached by the order's unguessable `publicToken`, never its number, and
 * never indexed: it carries a home address.
 */
export const metadata = { robots: { index: false, follow: false } };

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
}: {
	params: Promise<{ lang: string; token: string }>;
}) {
	const { lang, token } = await params;
	if (!isLocale(lang)) notFound();

	const [order, t] = await Promise.all([
		prisma.order.findUnique({
			where: { publicToken: token },
			// Short on purpose: the row also holds the phone number, the email and
			// who marked it paid, none of which this page shows.
			select: {
				number: true,
				createdAt: true,
				status: true,
				siteAddress: true,
				breakdown: true,
				cabinetsRm: true,
				deliveryRm: true,
				totalRm: true,
				productionStage: true,
				deliveries: {
					select: { publicToken: true },
					orderBy: { createdAt: "desc" },
					take: 1,
				},
			},
		}),
		getDictionary(lang),
	]);
	if (order === null) notFound();

	const o = t.order;
	const ref = orderRef(order.number, order.createdAt);
	const lines = summaryLines(order.breakdown);
	const delivery = order.deliveries[0] ?? null;
	const pay =
		order.status === "AWAITING_PAYMENT" ? paymentInstructions(order) : null;
	const [heading, body] =
		order.status === "PAID"
			? [o.headingPaid, o.bodyPaid]
			: order.status === "CANCELLED"
				? [o.headingCancelled, o.bodyCancelled]
				: [o.headingAwaiting, o.bodyAwaiting];

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-[#171717]">
			<header className="flex shrink-0 items-center gap-1.5 border-[#e5e5e5] border-b bg-white px-7 py-3.5 text-[#6b6b6b] text-[12px]">
				<Link href={`/${lang}`} className="px-1 py-1.5 hover:text-neutral-600">
					{t.common.brand}
				</Link>
				<span>/</span>
				<span className="px-1 py-1.5 font-medium text-[#171717]">
					{o.breadcrumb}
				</span>
			</header>

			<main className="flex flex-1 justify-center px-6 py-14">
				<div className="flex w-full max-w-[560px] flex-col gap-6">
					<div className="flex flex-col items-center gap-3.5 text-center">
						<div>
							<h1 className="mb-1.5 font-semibold text-[24px]">{heading}</h1>
							<p className="text-[#5c574e] text-[14px]">{body}</p>
						</div>
						<div className="flex items-center gap-2 rounded-full border border-[#e5e5e5] bg-white py-2 pr-2 pl-4">
							<span className="text-[#5c574e] text-[12px]">{o.orderId}</span>
							<span className="font-semibold text-[13px] tracking-[.02em]">
								{ref}
							</span>
							<CopyOrderId
								value={ref}
								label={o.copyOrderId}
								copiedLabel={o.copied}
							/>
						</div>
					</div>

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
						<div className="mt-1 flex justify-between pt-3.5 text-[12px]">
							<span className="text-[#5c574e]">{o.subtotal}</span>
							<span className="tabular-nums">{rm(order.cabinetsRm)}</span>
						</div>
						<div className="flex justify-between pt-1.5 text-[12px]">
							<span className="text-[#5c574e]">{o.delivery}</span>
							<span className="tabular-nums">{rm(order.deliveryRm)}</span>
						</div>
						<div className="mt-1.5 flex justify-between border-[#ecebe7] border-t pt-2.5 font-semibold text-[14px]">
							<span>{order.status === "PAID" ? o.totalPaid : o.total}</span>
							<span className="tabular-nums">{rm(order.totalRm)}</span>
						</div>
					</section>

					<section className={CARD}>
						<h2 className={`${CARD_HEADING} mb-1.5`}>{o.addressHeading}</h2>
						<p className="whitespace-pre-line text-[13px] leading-5">
							{order.siteAddress}
						</p>
					</section>

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

					{order.status === "PAID" && (
						<section className={CARD}>
							<h2 className={`${CARD_HEADING} mb-3.5`}>{o.nextHeading}</h2>
							<ol className="flex flex-col gap-3">
								{(
									[
										{ label: o.stagePaid, done: true },
										...STAGES.map((stage) => ({
											label: o.stages[stage],
											detail:
												stage === "MEASURE" ? o.stageMeasureDetail : undefined,
											done: stageReached(order.productionStage, stage),
										})),
										{ label: o.stageDelivery },
									] as {
										label: string;
										detail?: string;
										done?: boolean;
									}[]
								).map((stage) => (
									<li key={stage.label} className="flex items-start gap-3">
										<span
											className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] text-white ${
												stage.done ? "bg-[#1f5138]" : "bg-[#d4d4d4]"
											}`}
										>
											{stage.done ? "✓" : ""}
										</span>
										<div>
											<p className="font-medium text-[13px]">{stage.label}</p>
											{stage.detail && (
												<p className="text-[#737373] text-[12px] leading-[17px]">
													{stage.detail}
												</p>
											)}
										</div>
									</li>
								))}
							</ol>
							{delivery && (
								<Link
									href={`/${lang}/track/${delivery.publicToken}`}
									className="mt-4 inline-flex min-h-11 items-center rounded-full bg-[#1f5138] px-5 font-semibold text-[13px] text-white hover:bg-[#1a4430]"
								>
									{o.trackDelivery}
								</Link>
							)}
						</section>
					)}

					<div className="flex flex-wrap justify-center gap-3">
						<Link
							href={`/${lang}/planner`}
							className="flex min-h-11 items-center rounded-full border border-[#d4d4d4] px-[22px] font-medium text-[#404040] text-[13px] hover:border-[#a3a3a3] hover:bg-white"
						>
							{o.backToPlanner}
						</Link>
						<Link
							href={`/${lang}`}
							className="flex min-h-11 items-center rounded-full border border-[#d4d4d4] px-[22px] font-medium text-[#404040] text-[13px] hover:border-[#a3a3a3] hover:bg-white"
						>
							{o.backHome}
						</Link>
					</div>
				</div>
			</main>
		</div>
	);
}
