import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";
import { viewerOf } from "@/lib/orders/access";
import { orderCard, unitCount } from "@/lib/orders/card";
import { orderRef } from "@/lib/orders/ref";
import { ROOM_TYPES } from "@/lib/planner/catalogue";
import { PaymentBadge } from "../PaymentBadge";

/**
 * A signed-in customer's own orders, newest first. The query is scoped to the
 * session's user id and takes nothing from the URL, so there is no parameter
 * to point at somebody else's orders. Staff see only orders they placed
 * themselves; every order is at /admin/orders.
 */

const rm = (amount: number) =>
	`RM ${amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;

// ponytail: room names are the catalogue's English labels; localise when rooms get copy keys.
const roomLabel = (id: string) =>
	ROOM_TYPES.find((room) => room.id === id)?.label ?? id;

const BUTTON =
	"flex min-h-9 items-center rounded-lg border border-[#d4d4d4] bg-white px-3.5 font-medium text-[#171717] text-[12px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]";

export default async function OrdersPage({
	params,
}: {
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const viewer = await viewerOf(lang, `/${lang}/orders`);

	const [orders, t] = await Promise.all([
		prisma.order.findMany({
			where: { userId: viewer.id },
			orderBy: { createdAt: "desc" },
			select: {
				publicToken: true,
				number: true,
				createdAt: true,
				status: true,
				roomId: true,
				totalRm: true,
				productionStage: true,
				breakdown: true,
				deliveries: {
					select: { publicToken: true },
					orderBy: { createdAt: "desc" },
					take: 1,
				},
			},
		}),
		getDictionary(lang),
	]);
	const s = t.orders;
	const badgeLabel = {
		paid: s.statusPaid,
		awaiting: s.statusAwaiting,
		cancelled: s.statusCancelled,
	};

	return (
		<>
			<h1 className="font-semibold text-[22px]">{s.heading}</h1>
			{orders.length === 0 ? (
				<div className="flex flex-col items-center gap-2.5 rounded-[14px] border border-[#e5e5e5] bg-white px-6 py-10 text-center">
					<p className="font-semibold text-[15px]">{s.empty}</p>
					<p className="max-w-[340px] text-[#5c574e] text-[13px] leading-[19px]">
						{s.emptyBody}
					</p>
					<Link
						href={`/${lang}/planner`}
						className="mt-1.5 flex min-h-[42px] items-center rounded-[10px] bg-[#171717] px-[18px] font-semibold text-[13px] text-white hover:bg-[#262626]"
					>
						{s.startPlanning}
					</Link>
				</div>
			) : (
				orders.map((order) => {
					const delivery = order.deliveries[0] ?? null;
					const card = orderCard({
						status: order.status,
						productionStage: order.productionStage,
						hasDelivery: delivery !== null,
					});
					const units = unitCount(order.breakdown);
					const room = roomLabel(order.roomId);
					const title =
						units === 0
							? room
							: fill(units === 1 ? s.unitsOne : s.unitsOther, {
									room,
									count: units,
								});
					const stage =
						card.stage.kind === "notStarted"
							? s.stageNotStarted
							: card.stage.kind === "paid"
								? t.order.stagePaid
								: card.stage.kind === "delivery"
									? t.order.stageDelivery
									: t.order.stages[card.stage.stage];
					const orderHref = `/${lang}/order/${order.publicToken}`;
					return (
						<article
							key={order.publicToken}
							className="flex flex-col gap-2.5 rounded-[14px] border border-[#e5e5e5] bg-white p-4"
						>
							<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
								<div className="min-w-0">
									<h2 className="font-semibold text-[15px]">{title}</h2>
									<p className="mt-0.5 text-[#5c574e] text-[12px]">
										<span className="font-mono">
											{orderRef(order.number, order.createdAt)}
										</span>
										{" · "}
										{fill(s.orderedOn, {
											date: order.createdAt.toLocaleDateString(lang, {
												timeZone: "Asia/Kuala_Lumpur",
												day: "numeric",
												month: "short",
												year: "numeric",
											}),
										})}
									</p>
								</div>
								<p className="font-semibold text-[16px] tabular-nums">
									{rm(order.totalRm)}
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<PaymentBadge
									badge={card.badge}
									label={badgeLabel[card.badge]}
								/>
								<span className="text-[#404040] text-[12px]">{stage}</span>
							</div>
							<div className="mt-0.5 flex flex-wrap gap-2">
								{card.canPay && (
									<Link
										href={orderHref}
										className="flex min-h-9 items-center rounded-lg bg-[#171717] px-3.5 font-semibold text-[12px] text-white hover:bg-[#262626]"
									>
										{s.payNow}
									</Link>
								)}
								<Link href={orderHref} className={BUTTON}>
									{s.viewOrder}
								</Link>
								{card.canTrack && delivery && (
									<Link
										href={`/${lang}/track/${delivery.publicToken}`}
										className={BUTTON}
									>
										{t.order.trackDelivery}
									</Link>
								)}
							</div>
						</article>
					);
				})
			)}
		</>
	);
}
