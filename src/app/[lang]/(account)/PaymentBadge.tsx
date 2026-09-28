import type { OrderCard } from "@/lib/orders/card";

const STYLE: Record<OrderCard["badge"], string> = {
	paid: "bg-[#e8f0eb] text-[#17402c]",
	awaiting: "bg-[#f7f3e6] text-[#4a4120]",
	cancelled: "bg-[#ecebe7] text-[#5c574e]",
};

export function PaymentBadge({
	badge,
	label,
}: {
	badge: OrderCard["badge"];
	label: string;
}) {
	return (
		<span
			className={`inline-flex min-h-6 items-center rounded-full px-2.5 font-semibold text-[12px] ${STYLE[badge]}`}
		>
			{label}
		</span>
	);
}
