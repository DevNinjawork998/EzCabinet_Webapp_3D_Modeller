"use client";

import { useEffect, useRef, useState } from "react";
import {
	type StripePayApi,
	StripePayment,
} from "@/components/planner/StripePayment";
import type { PaymentStart } from "@/lib/payments/types";
import { RefreshWhileSettling } from "./RefreshWhileSettling";

/**
 * Pay for an existing order on the active gateway — the retry after a failed
 * or abandoned checkout. Asks `/api/orders/[token]/pay`, which resumes the
 * order's open payment, and does what it says: Stripe's Payment Element with
 * a Pay button, or a hosted-page gateway's signed form.
 *
 * Stripe asks for billing details itself here (`collectBilling`): this page
 * has no form of ours to take them from.
 *
 * A 409 means the order's payment already went through (or is still with
 * the bank) and its webhook has not landed: say so and keep re-rendering the
 * page until it does, rather than offer a second charge or a load error.
 */
export function OnlinePayment({
	token,
	payLabel,
	errorText,
	settlingText,
}: {
	token: string;
	payLabel: string;
	errorText: string;
	settlingText: string;
}) {
	const [start, setStart] = useState<PaymentStart | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [settling, setSettling] = useState(false);
	const payApi = useRef<StripePayApi | null>(null);

	useEffect(() => {
		fetch(`/api/orders/${token}/pay`, { method: "POST" })
			.then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
			.then(setStart, (status) =>
				status === 409 ? setSettling(true) : setError(errorText),
			);
	}, [token, errorText]);

	async function payWithStripe() {
		if (!payApi.current) return;
		setBusy(true);
		setError(null);
		const message = await payApi.current.confirm({
			returnUrl: window.location.origin + window.location.pathname,
		});
		setBusy(false);
		setError(message);
	}

	if (settling) {
		return (
			<p role="status" className="text-[#404040] text-[13px] leading-[19px]">
				<RefreshWhileSettling />
				{settlingText}
			</p>
		);
	}

	return (
		<>
			{error && (
				<p
					role="alert"
					className="mb-3 rounded-lg border border-[#fca5a5] bg-[#fef2f2] px-3 py-2 text-[#7f1d1d] text-[12px]"
				>
					{error}
				</p>
			)}
			{start?.kind === "stripe-elements" && (
				<div className="flex flex-col gap-4">
					<StripePayment
						publishableKey={start.publishableKey}
						clientSecret={start.clientSecret}
						collectBilling
						apiRef={payApi}
					/>
					<button
						type="button"
						onClick={payWithStripe}
						disabled={busy}
						className="flex min-h-12 w-full items-center justify-center rounded-[10px] bg-neutral-900 px-3 font-semibold text-[14px] text-white tabular-nums hover:bg-neutral-800 disabled:opacity-50"
					>
						{payLabel}
					</button>
				</div>
			)}
			{start?.kind === "redirect" && (
				<form action={start.url} method={start.method}>
					{Object.entries(start.fields).map(([name, value]) => (
						<input key={name} type="hidden" name={name} value={value} />
					))}
					<button
						type="submit"
						className="flex min-h-12 w-full items-center justify-center rounded-[10px] bg-neutral-900 px-3 font-semibold text-[14px] text-white hover:bg-neutral-800"
					>
						{payLabel}
					</button>
				</form>
			)}
		</>
	);
}
