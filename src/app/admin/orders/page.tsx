import Link from "next/link";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { prisma } from "@/lib/catalogue/db";
import { orderRef } from "@/lib/orders/ref";
import { shortTime } from "../logistics/time";
import { STATUS_LABEL } from "../logistics/tracking";
import { ORDER_STATUS_LABEL, ORDER_STATUS_TONE, rm } from "./status";

/**
 * Orders customers placed from the planner, newest first. Payment is marked
 * here, and a paid order is where a delivery is created from.
 */
export default async function OrdersAdminPage() {
	const orders = await prisma.order.findMany({
		orderBy: { number: "desc" },
		select: {
			id: true,
			number: true,
			createdAt: true,
			status: true,
			customerName: true,
			siteAddress: true,
			totalRm: true,
			deliveries: {
				select: { number: true, status: true },
				orderBy: { createdAt: "desc" },
				take: 1,
			},
		},
	});

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader />
			<main className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-7 pt-8 pb-16">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">Orders</h1>
					<p className="text-[13px] text-neutral-500">
						Mark an order paid when the transfer lands, then create its delivery
						— the customer, address and cabinets come across with it.
					</p>
				</div>

				<p className="text-[13px] text-neutral-500">
					{orders.length} {orders.length === 1 ? "order" : "orders"}
				</p>

				{orders.length === 0 ? (
					<p className="rounded-xl border border-neutral-200 bg-white px-4 py-8 text-center text-[13px] text-neutral-500">
						No orders yet. They appear here when a customer checks out from the
						planner.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{orders.map((order) => {
							const delivery = order.deliveries[0];
							return (
								<li key={order.id}>
									<Link
										href={`/admin/orders/${order.id}`}
										className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 hover:bg-[#faf9f7] focus-visible:outline-2 focus-visible:outline-neutral-900 focus-visible:outline-offset-2"
									>
										<span className="w-[132px] shrink-0 font-medium text-[12px] text-neutral-500 tabular-nums">
											{orderRef(order.number, order.createdAt)}
										</span>
										<span className="min-w-[160px] flex-1">
											<span className="block font-medium text-[14px]">
												{order.customerName}
											</span>
											<span className="block truncate text-[12px] text-neutral-500">
												{order.siteAddress}
											</span>
										</span>
										<span className="text-[12px] text-neutral-500">
											{shortTime(order.createdAt.toISOString())}
										</span>
										<span className="w-[100px] text-right font-medium text-[13px] tabular-nums">
											{rm(order.totalRm)}
										</span>
										<span
											className={`rounded-full px-2.5 py-1 font-medium text-[11px] ${ORDER_STATUS_TONE[order.status]}`}
										>
											{ORDER_STATUS_LABEL[order.status]}
										</span>
										<span className="w-[140px] text-[12px] text-neutral-500">
											{delivery
												? `Delivery #${delivery.number} · ${STATUS_LABEL[delivery.status]}`
												: "No delivery"}
										</span>
										<span className="font-semibold text-[#1f5138] text-[12px]">
											Open →
										</span>
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</main>
		</div>
	);
}
