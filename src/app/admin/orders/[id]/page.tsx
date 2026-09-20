import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { requirePage } from "@/lib/auth/page";
import { prisma } from "@/lib/catalogue/db";
import { readPublishedPlannerCatalogue } from "@/lib/catalogue/store";
import { orderRef } from "@/lib/orders/ref";
import { summaryLines } from "@/lib/orders/summary";
import { OrderDetail } from "./OrderDetail";

export default async function OrderAdminPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	await requirePage("orders:read");
	const { id } = await params;
	const [order, published] = await Promise.all([
		prisma.order.findUnique({
			where: { id },
			include: {
				deliveries: {
					select: { id: true, number: true, status: true },
					orderBy: { createdAt: "desc" },
				},
			},
		}),
		readPublishedPlannerCatalogue(),
	]);
	if (!order) notFound();

	const ref = orderRef(order.number, order.createdAt);
	// Labels from today's catalogue, ids as the fallback: a room or finish can be
	// renamed or retired after the order, and the order must still read.
	const roomLabel =
		published.data.roomTypes.find((room) => room.id === order.roomId)?.label ??
		order.roomId;
	const finishLabel =
		published.data.finishes.find((finish) => finish.id === order.finishId)
			?.label ?? order.finishId;

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader
				trail={[{ label: "Orders", href: "/admin/orders" }, { label: ref }]}
			/>
			<OrderDetail
				order={{
					id: order.id,
					ref,
					publicToken: order.publicToken,
					status: order.status,
					createdAt: order.createdAt.toISOString(),
					customerName: order.customerName,
					customerPhone: order.customerPhone,
					customerEmail: order.customerEmail,
					siteAddress: order.siteAddress,
					addressNotes: order.addressNotes,
					roomLabel,
					finishLabel,
					lines: summaryLines(order.breakdown),
					cabinetsRm: order.cabinetsRm,
					deliveryRm: order.deliveryRm,
					totalRm: order.totalRm,
					paymentProvider: order.paymentProvider,
					paymentRef: order.paymentRef,
					paidAt: order.paidAt?.toISOString() ?? null,
					paidBy: order.paidBy,
					deliveries: order.deliveries,
				}}
			/>
		</div>
	);
}
