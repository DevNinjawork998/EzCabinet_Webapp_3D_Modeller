import { orderRef } from "./ref";

/**
 * How a customer pays for an order.
 *
 * EzCabinet will take payment through a Malaysian gateway, not chosen
 * yet. Until then every order is `manual`: the confirmation page shows bank
 * transfer details and an admin marks the order paid when the money lands.
 *
 * ponytail: manual only. The gateway becomes a second provider here — a
 * redirect URL instead of bank details — plus its webhook route marking the
 * order paid; nothing that reads an order needs to change.
 */
export const PAYMENT_PROVIDER = "manual";

/** PLACEHOLDER — EzCabinet's real account. See CLAUDE.md Open questions. */
export const BANK_TRANSFER = {
	bank: "Bank to be confirmed",
	accountName: "EzCabinet Sdn Bhd",
	accountNumber: "To be confirmed",
};

export type PaymentInstructions = {
	kind: "bank-transfer";
	bank: string;
	accountName: string;
	accountNumber: string;
	/** What the customer types as the transfer reference: the order number. */
	reference: string;
	amountRm: number;
};

export function paymentInstructions(order: {
	number: number;
	createdAt: Date | string;
	totalRm: number;
}): PaymentInstructions {
	return {
		kind: "bank-transfer",
		...BANK_TRANSFER,
		reference: orderRef(order.number, order.createdAt),
		amountRm: order.totalRm,
	};
}
