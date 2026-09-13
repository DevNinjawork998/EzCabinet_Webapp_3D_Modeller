"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fieldClass } from "@/components/admin/styles";
import type { DeliveryStatusName } from "@/lib/logistics/types";
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
	paidBy: string | null;
	deliveries: { id: string; number: number; status: DeliveryStatusName }[];
};

const FOCUS =
	"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";
const CARD =
	"flex flex-col gap-3 rounded-[14px] border border-neutral-200 bg-white px-5 py-[18px]";
const EYEBROW =
	"font-semibold text-[12px] text-neutral-600 uppercase tracking-[.06em]";
const CHIP = `min-h-9 rounded-full border border-neutral-200 bg-white px-[15px] py-2 font-medium text-[12px] text-neutral-600 hover:bg-[#f8f7f4] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const PRIMARY = `inline-flex min-h-9 items-center self-start rounded-full bg-[#1f5138] px-[18px] py-2.5 font-semibold text-[12px] text-white hover:bg-[#17402c] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

/**
 * One order: what was bought, who for, and its two admin moves — mark it paid
 * (manual payment, until a gateway does this) and create its delivery.
 */
export function OrderDetail({ order }: { order: OrderView }) {
	const router = useRouter();
	const [actor, setActor] = useState("");
	const [paymentRef, setPaymentRef] = useState("");
	const [busy, setBusy] = useState<"paid" | "cancel" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The same remembered name the delivery pages record against their updates.
	useEffect(() => {
		setActor(localStorage.getItem("ic.logistics.actor") ?? "");
	}, []);
	const rememberActor = (name: string) => {
		setActor(name);
		localStorage.setItem("ic.logistics.actor", name);
	};

	async function act(kind: "paid" | "cancel") {
		if (actor.trim() === "") {
			setError("Put your name in first — it goes on the record.");
			return;
		}
		if (kind === "cancel" && !confirm(`Cancel order ${order.ref}?`)) return;
		setBusy(kind);
		setError(null);
		const res = await fetch(`/api/admin/orders/${order.id}/${kind}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ actor, paymentRef: paymentRef.trim() || null }),
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
										Your name — recorded against the payment
										<input
											className={fieldClass(false, FOCUS)}
											value={actor}
											onChange={(e) => rememberActor(e.target.value)}
											placeholder="e.g. Farah"
										/>
									</label>
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
										disabled={busy !== null || actor.trim() === ""}
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
								{order.paidBy ? ` · marked by ${order.paidBy}` : ""}
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
				</aside>
			</div>
		</main>
	);
}
