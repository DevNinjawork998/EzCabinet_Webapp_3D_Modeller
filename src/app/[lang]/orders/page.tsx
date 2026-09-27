import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";
import { viewerOf } from "@/lib/orders/access";
import { orderRef } from "@/lib/orders/ref";
import { ROOM_TYPES } from "@/lib/planner/catalogue";

/**
 * A signed-in customer's own orders, newest first. The query is scoped to the
 * session's user id and takes nothing from the URL, so there is no parameter
 * to point at somebody else's orders. Staff see only orders they placed
 * themselves; every order is at /admin/orders.
 */
export const metadata = { robots: { index: false, follow: false } };

const CARD =
	"flex items-center justify-between gap-4 rounded-[14px] border border-[#e5e5e5] bg-white px-[22px] py-4 text-[#171717] hover:border-[#c9c6c0]";

const rm = (amount: number) =>
	`RM ${amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;

// ponytail: room names are the catalogue's English labels; localise when rooms get copy keys.
const roomLabel = (id: string) =>
	ROOM_TYPES.find((room) => room.id === id)?.label ?? id;

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
			},
		}),
		getDictionary(lang),
	]);
	const s = t.orders;
	const statusLabel = (order: (typeof orders)[number]) =>
		order.status === "CANCELLED"
			? s.statusCancelled
			: order.status === "AWAITING_PAYMENT"
				? s.statusAwaiting
				: order.productionStage
					? t.order.stages[order.productionStage]
					: s.statusPaid;

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-[#171717]">
			<header className="flex shrink-0 items-center gap-1.5 border-[#e5e5e5] border-b bg-white px-7 py-3.5 text-[#6b6b6b] text-[12px]">
				<Link href={`/${lang}`} className="px-1 py-1.5 hover:text-neutral-600">
					{t.common.brand}
				</Link>
				<span>/</span>
				<span className="px-1 py-1.5 font-medium text-[#171717]">
					{s.breadcrumb}
				</span>
			</header>

			<main className="flex flex-1 justify-center px-6 py-14">
				<div className="flex w-full max-w-[560px] flex-col gap-3">
					<h1 className="mb-3 font-semibold text-[24px]">{s.heading}</h1>
					{orders.length === 0 ? (
						<div className="flex flex-col items-start gap-3 rounded-[14px] border border-[#e5e5e5] bg-white px-[22px] py-6">
							<p className="font-medium text-[15px]">{s.empty}</p>
							<p className="text-[#5c574e] text-[14px]">{s.emptyBody}</p>
							<Link
								href={`/${lang}/planner`}
								className="rounded-full bg-[#171717] px-4 py-2 font-medium text-[13px] text-white"
							>
								{s.startPlanning}
							</Link>
						</div>
					) : (
						orders.map((order) => (
							<Link
								key={order.publicToken}
								href={`/${lang}/order/${order.publicToken}`}
								className={CARD}
							>
								<div>
									<p className="font-semibold text-[14px] tracking-[.02em]">
										{orderRef(order.number, order.createdAt)}
									</p>
									<p className="text-[#8a857c] text-[12px]">
										{roomLabel(order.roomId)} ·{" "}
										{fill(s.placedOn, {
											date: order.createdAt.toLocaleDateString(lang, {
												day: "numeric",
												month: "short",
												year: "numeric",
											}),
										})}
									</p>
								</div>
								<div className="text-right">
									<p className="font-medium text-[14px] tabular-nums">
										{rm(order.totalRm)}
									</p>
									<p className="text-[#5c574e] text-[12px]">
										{statusLabel(order)}
									</p>
								</div>
							</Link>
						))
					)}
				</div>
			</main>
		</div>
	);
}
