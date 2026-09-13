/** Order statuses as the admin screens say and colour them. */
export type OrderStatusName = "AWAITING_PAYMENT" | "PAID" | "CANCELLED";

export const ORDER_STATUS_LABEL: Record<OrderStatusName, string> = {
	AWAITING_PAYMENT: "Awaiting payment",
	PAID: "Paid",
	CANCELLED: "Cancelled",
};

export const ORDER_STATUS_TONE: Record<OrderStatusName, string> = {
	AWAITING_PAYMENT: "bg-[#f2efe6] text-[#6b5f2e]",
	PAID: "bg-[#e7f0ea] text-[#1f5138]",
	CANCELLED: "bg-neutral-100 text-neutral-500",
};

export const rm = (amount: number) =>
	`RM ${amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
