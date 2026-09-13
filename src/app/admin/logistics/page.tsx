import { AdminHeader } from "@/components/admin/AdminHeader";
import { prisma } from "@/lib/catalogue/db";
import { readPublishedPlannerCatalogue } from "@/lib/catalogue/store";
import { WORKSHOP_ADDRESS } from "@/lib/logistics/carriers";
import { geocoderFault, refreshGeocoderHealth } from "@/lib/logistics/geocode";
import { easyparcelAppConfigured } from "@/lib/logistics/oauth";
import { hasConnection } from "@/lib/logistics/tokens";
import { deliveryItemsFor } from "@/lib/orders/items";
import { orderDesignSchema } from "@/lib/orders/layoutSchema";
import { type FormState, formFromOrder } from "./form";
import { LogisticsManager } from "./LogisticsManager";

/**
 * Deliveries: getting finished cabinets from the workshop to a customer's site.
 *
 * A job is either typed in, or created from a paid order with `?fromOrder=` —
 * the order page's "Create delivery" — which opens the same form already filled.
 */
export default async function LogisticsAdminPage({
	searchParams,
}: {
	searchParams: Promise<{ fromOrder?: string }>;
}) {
	const { fromOrder } = await searchParams;
	const deliveries = await prisma.delivery.findMany({
		orderBy: { number: "desc" },
	});
	// Skip the DB round trip when the app itself isn't configured — an
	// unconfigured deployment doesn't need a query to be told what the
	// environment already answers.
	const appConfigured = easyparcelAppConfigured();
	// Probed, not assumed. A key that is present and refused looks identical to
	// a working one from here, and the banner is where an admin finds out.
	const geocoder = await refreshGeocoderHealth();
	const easyparcel = {
		appConfigured,
		connected: appConfigured ? await hasConnection("easyparcel") : false,
	};
	const prefill = fromOrder ? await prefillFromOrder(fromOrder) : null;

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader />
			<main className="mx-auto flex w-full max-w-[900px] flex-col gap-8 px-7 pt-8 pb-16">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">Deliveries</h1>
					<p className="text-neutral-500 text-[13px]">
						Book a pickup with a logistics partner and follow it to site.
						Compare partners before booking — the price you confirm is the one
						recorded against the job.
					</p>
				</div>
				<LogisticsManager
					initial={JSON.parse(JSON.stringify(deliveries))}
					workshopAddress={WORKSHOP_ADDRESS}
					geocodingConfigured={geocoder.ok}
					geocodingFault={geocoderFault()}
					easyparcel={easyparcel}
					prefill={prefill}
				/>
			</main>
		</div>
	);
}

/**
 * The form for a paid order. Items come from the design as ordered, measured
 * against today's catalogue so a weight added since the order still arrives.
 * Null for an order that is not paid or not there — the list opens as usual.
 */
async function prefillFromOrder(orderId: string): Promise<FormState | null> {
	const order = await prisma.order.findUnique({ where: { id: orderId } });
	if (order?.status !== "PAID") return null;
	const design = orderDesignSchema.safeParse(order.design);
	const { data: catalogue } = await readPublishedPlannerCatalogue();
	const items = design.success
		? deliveryItemsFor(design.data.layout, catalogue)
		: [];
	return formFromOrder(order, items, WORKSHOP_ADDRESS);
}
