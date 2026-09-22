"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fieldClass } from "@/components/admin/styles";
import type {
	NotificationKind,
	NotificationStatus,
	ProductionStage,
} from "@/generated/prisma/enums";
import { en } from "@/lib/copy/en";
import type { DeliveryStatusName } from "@/lib/logistics/types";
import { nextStage } from "@/lib/orders/stage";
import type { SummaryLine } from "@/lib/orders/summary";
import { shortTime } from "../../logistics/time";
import { STATUS_LABEL } from "../../logistics/tracking";
import {
	ORDER_STATUS_LABEL,
	ORDER_STATUS_TONE,
	type OrderStatusName,
	rm,
} from "../status";

export type OrderView = {
	id: string;
	ref: string;
	publicToken: string;
	status: OrderStatusName;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	customerEmail: string | null;
	siteAddress: string;
	addressNotes: string | null;
	roomLabel: string;
	finishLabel: string;
	lines: SummaryLine[];
	cabinetsRm: number;
	deliveryRm: number;
	totalRm: number;
	paymentProvider: string;
	paymentRef: string | null;
	paidAt: string | null;
	paidByName: string | null;
	deliveries: { id: string; number: number; status: DeliveryStatusName }[];
	productionStage: ProductionStage | null;
	whatsappOptIn: boolean;
	notifications: {
		id: string;
		kind: NotificationKind;
		stage: ProductionStage | null;
		status: NotificationStatus;
		lastError: string | null;
		createdAt: string;
	}[];
};

const FOCUS =
	"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";
const CARD =
	"flex flex-col gap-3 rounded-[14px] border border-neutral-200 bg-white px-5 py-[18px]";
const EYEBROW =
	"font-semibold text-[12px] text-neutral-600 uppercase tracking-[.06em]";
const CHIP = `min-h-9 rounded-full border border-neutral-200 bg-white px-[15px] py-2 font-medium text-[12px] text-neutral-600 hover:bg-[#f8f7f4] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const PRIMARY = `inline-flex min-h-9 items-center self-start rounded-full bg-[#1f5138] px-[18px] py-2.5 font-semibold text-[12px] text-white hover:bg-[#17402c] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

const STAGE_LABEL = en.order.stages;

const KIND_LABEL: Record<NotificationKind, string> = {
	ORDER_PLACED: "Order placed",
	PAYMENT_CONFIRMED: "Payment confirmed",
	STAGE: "Production step",
	DELIVERY_BOOKED: "Delivery booked",
	PICKED_UP: "Picked up",
	DELIVERED: "Delivered",
	DELIVERY_FAILED: "Delivery failed",
};

const MESSAGE_STATUS: Record<NotificationStatus, string> = {
	PENDING: "Queued",
	SENT: "Sent",
	DELIVERED: "Delivered",
	READ: "Read",
	FAILED: "Failed",
};

/**
 * One order: what was bought, who for, and its admin moves — mark it paid,
 * advance production, create its delivery.
 */
export function OrderDetail({ order }: { order: OrderView }) {
	const router = useRouter();
	const [paymentRef, setPaymentRef] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function act(kind: "paid" | "cancel") {
		if (kind === "cancel" && !confirm(`Cancel order ${order.ref}?`)) return;
		setBusy(kind);
		setError(null);
		const res = await fetch(`/api/admin/orders/${order.id}/${kind}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paymentRef: paymentRef.trim() || null }),
		});
		setBusy(null);
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(
				body?.error === "not_awaiting_payment"
					? "This order is no longer awaiting payment. Reload to see where it is."
					: "Could not update this order.",
			);
			return;
		}
		router.refresh();
	}

	async function post(url: string, body: unknown, key: string) {
		setBusy(key);
		setError(null);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		setBusy(null);
		if (!res.ok) {
			const payload = await res.json().catch(() => null);
			setError(
				payload?.error === "not_next_stage"
					? "Someone else moved this order on. Reload to see where it is."
					: "Could not update this order.",
			);
			return;
		}
		router.refresh();
	}

	const upcoming = nextStage(order.productionStage);

	const awaiting = order.status === "AWAITING_PAYMENT";
	const paid = order.status === "PAID";

	return (
		<main className="mx-auto flex w-full max-w-[1080px] flex-col gap-[18px] px-7 pt-7 pb-16">
			{error && (
				<p
					role="alert"
					className="rounded-[10px] bg-[#fbf1ee] px-3.5 py-[11px] text-[#7a2c1c] text-[13px]"
				>
					{error}
				</p>
			)}

			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">
						Order {order.ref} — {order.customerName}
					</h1>
					<p className="text-[13px] text-neutral-500">
						Placed {shortTime(order.createdAt)} · {order.roomLabel} ·{" "}
						{order.finishLabel}
					</p>
				</div>
				<span
					className={`rounded-full px-3 py-1.5 font-semibold text-[11px] ${ORDER_STATUS_TONE[order.status]}`}
				>
					{ORDER_STATUS_LABEL[order.status]}
				</span>
			</div>

			<div className="flex flex-wrap items-start gap-[18px]">
				<div className="flex min-w-0 flex-[3_1_440px] flex-col gap-[18px]">
					<section className={CARD}>
						<h2 className={EYEBROW}>What was ordered</h2>
						<ul className="flex flex-col">
							{order.lines.map((line) => (
								<li
									key={line.name}
									className="flex justify-between gap-3 border-[#f1f0ed] border-b py-2 text-[13px]"
								>
									<span>
										{line.name}{" "}
										<span className="text-[#8a857c]">× {line.qty}</span>
									</span>
									<span className="shrink-0 tabular-nums">
										{rm(line.amountRm)}
									</span>
								</li>
							))}
						</ul>
						<div className="flex flex-col gap-1 text-[13px]">
							<div className="flex justify-between text-neutral-500">
								<span>Cabinets</span>
								<span className="tabular-nums">{rm(order.cabinetsRm)}</span>
							</div>
							<div className="flex justify-between text-neutral-500">
								<span>Delivery</span>
								<span className="tabular-nums">{rm(order.deliveryRm)}</span>
							</div>
							<div className="flex justify-between border-[#ecebe7] border-t pt-2 font-semibold">
								<span>Total</span>
								<span className="tabular-nums">{rm(order.totalRm)}</span>
							</div>
						</div>
					</section>

					<section className={CARD}>
						<h2 className={EYEBROW}>Payment</h2>
						{awaiting && (
							<>
								<p className="text-[13px] text-neutral-600">
									Waiting for a bank transfer of {rm(order.totalRm)} with{" "}
									<span className="font-medium">{order.ref}</span> as the
									reference. Mark it paid once it shows in the account.
								</p>
								<div className="flex flex-wrap gap-3">
									<label className="flex max-w-[260px] flex-1 flex-col gap-1 text-[12px] text-neutral-500">
										Bank reference (optional)
										<input
											className={fieldClass(false, FOCUS)}
											value={paymentRef}
											onChange={(e) => setPaymentRef(e.target.value)}
										/>
									</label>
								</div>
								<div className="flex flex-wrap gap-2">
									<button
										type="button"
										className={PRIMARY}
										disabled={busy !== null}
										onClick={() => act("paid")}
									>
										{busy === "paid" ? "Marking paid…" : "Mark paid"}
									</button>
									<button
										type="button"
										className={CHIP}
										disabled={busy !== null}
										onClick={() => act("cancel")}
									>
										Cancel order
									</button>
								</div>
							</>
						)}
						{paid && (
							<p className="text-[13px] text-neutral-600">
								Paid {order.paidAt ? shortTime(order.paidAt) : ""}
								{order.paidByName ? ` · marked by ${order.paidByName}` : ""}
								{order.paymentRef ? ` · ref ${order.paymentRef}` : ""} ·{" "}
								{order.paymentProvider}
							</p>
						)}
						{order.status === "CANCELLED" && (
							<p className="text-[13px] text-neutral-500">
								Cancelled before payment.
							</p>
						)}
					</section>

					{paid && (
						<section className={CARD}>
							<h2 className={EYEBROW}>Production</h2>
							<p className="text-[13px] text-neutral-600">
								{order.productionStage
									? `Now at: ${STAGE_LABEL[order.productionStage]}`
									: "Not started."}
								{order.whatsappOptIn
									? " Each step is sent to the customer on WhatsApp."
									: ""}
							</p>
							{upcoming && (
								<button
									type="button"
									className={PRIMARY}
									disabled={busy !== null}
									onClick={() =>
										post(
											`/api/admin/orders/${order.id}/stage`,
											{ stage: upcoming },
											"stage",
										)
									}
								>
									{busy === "stage"
										? "Saving…"
										: `Advance to: ${STAGE_LABEL[upcoming]}`}
								</button>
							)}
						</section>
					)}

					<section className={CARD}>
						<h2 className={EYEBROW}>Deliveries</h2>
						{order.deliveries.length === 0 ? (
							<p className="text-[13px] text-neutral-500">
								{paid
									? "No delivery yet. Create one — the customer, address and cabinets are filled in for you."
									: "A delivery can be created once the order is paid."}
							</p>
						) : (
							<ul className="flex flex-col gap-1.5">
								{order.deliveries.map((delivery) => (
									<li key={delivery.id}>
										<Link
											href={`/admin/logistics/${delivery.id}`}
											className={`text-[13px] underline ${FOCUS}`}
										>
											Delivery #{delivery.number} ·{" "}
											{STATUS_LABEL[delivery.status]}
										</Link>
									</li>
								))}
							</ul>
						)}
						{paid && (
							<Link
								href={`/admin/logistics?fromOrder=${order.id}`}
								className={PRIMARY}
							>
								Create delivery →
							</Link>
						)}
					</section>
				</div>

				<aside className="flex min-w-0 flex-[1_1_268px] flex-col gap-3.5 self-start">
					<section className={CARD}>
						<h2 className={EYEBROW}>Customer</h2>
						{[
							["Name", order.customerName],
							["Phone", order.customerPhone],
							["Email", order.customerEmail ?? "not given"],
							["Deliver to", order.siteAddress],
							["Access", order.addressNotes ?? "none given"],
						].map(([label, value]) => (
							<div key={label} className="flex flex-col gap-0.5">
								<span className="text-[#8a857c] text-[11px]">{label}</span>
								<span className="wrap-anywhere text-[12px] text-neutral-700 leading-[17px]">
									{value}
								</span>
							</div>
						))}
						<a
							href={`/en/order/${order.publicToken}`}
							target="_blank"
							rel="noreferrer"
							className={`text-[12px] underline ${FOCUS}`}
						>
							Customer's confirmation page
						</a>
					</section>

					<section className={CARD}>
						<h2 className={EYEBROW}>WhatsApp</h2>
						{!order.whatsappOptIn ? (
							<p className="text-[12px] text-neutral-500">
								Customer did not opt in to WhatsApp.
							</p>
						) : order.notifications.length === 0 ? (
							<p className="text-[12px] text-neutral-500">No messages yet.</p>
						) : (
							<ul className="flex flex-col gap-2">
								{order.notifications.map((n) => (
									<li key={n.id} className="flex flex-col gap-0.5 text-[12px]">
										<span className="text-neutral-700">
											{KIND_LABEL[n.kind]}
											{n.stage ? ` · ${STAGE_LABEL[n.stage]}` : ""}
										</span>
										<span
											className={
												n.status === "FAILED"
													? "text-[#7a2c1c]"
													: "text-[#8a857c]"
											}
										>
											{MESSAGE_STATUS[n.status]} · {shortTime(n.createdAt)}
											{n.lastError ? ` · ${n.lastError}` : ""}
										</span>
										{n.status === "FAILED" && (
											<button
												type="button"
												className={`${CHIP} self-start`}
												disabled={busy !== null}
												onClick={() =>
													post(
														`/api/admin/orders/${order.id}/notifications/${n.id}/resend`,
														{},
														n.id,
													)
												}
											>
												{busy === n.id ? "Resending…" : "Resend"}
											</button>
										)}
									</li>
								))}
							</ul>
						)}
					</section>
				</aside>
			</div>
		</main>
	);
}
