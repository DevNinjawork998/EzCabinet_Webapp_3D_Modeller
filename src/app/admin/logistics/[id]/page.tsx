import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { prisma } from "@/lib/catalogue/db";
import { geocoderFault, refreshGeocoderHealth } from "@/lib/logistics/geocode";
import { easyparcelAppConfigured } from "@/lib/logistics/oauth";
import { hasConnection } from "@/lib/logistics/tokens";
import { DeliveryDetail } from "../DeliveryDetail";

/**
 * One delivery: compare partners, book, follow it to site.
 *
 * Its own page rather than a panel that unfolds under a row in the list, so a
 * job has a URL — the one an admin pastes to a colleague, and the one a split
 * links its two halves to.
 */
export default async function DeliveryPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const delivery = await prisma.delivery.findUnique({
		where: { id },
		include: { events: { orderBy: { at: "desc" } } },
	});
	if (!delivery) notFound();

	const appConfigured = easyparcelAppConfigured();
	const geocoder = await refreshGeocoderHealth();

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader
				trail={[
					{ label: "Deliveries", href: "/admin/logistics" },
					{ label: `#${delivery.number}` },
				]}
			/>
			<DeliveryDetail
				initial={JSON.parse(JSON.stringify(delivery))}
				geocodingConfigured={geocoder.ok}
				geocodingFault={geocoderFault()}
				easyparcel={{
					appConfigured,
					connected: appConfigured ? await hasConnection("easyparcel") : false,
				}}
			/>
		</div>
	);
}
