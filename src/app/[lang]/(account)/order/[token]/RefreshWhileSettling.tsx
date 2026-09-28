"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const FIRST_MS = 3_000;
const MAX_MS = 30_000;

/** Half again each time, capped: quick while a webhook is seconds away, gentle through a slow FPX bank. */
export const nextDelay = (ms: number) => Math.min(ms * 1.5, MAX_MS);

/**
 * Back from the gateway, the order is still AWAITING_PAYMENT until the
 * gateway's webhook lands — usually seconds, up to half an hour for an FPX
 * bank. Re-render the server page until then, so the customer sees PAID
 * without refreshing. The page stops rendering this once the order settles,
 * which is what ends the loop. A hidden tab skips its turn.
 */
export function RefreshWhileSettling() {
	const router = useRouter();

	useEffect(() => {
		let delay = FIRST_MS;
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			if (document.visibilityState === "visible") router.refresh();
			delay = nextDelay(delay);
			timer = setTimeout(tick, delay);
		};
		timer = setTimeout(tick, delay);
		return () => clearTimeout(timer);
	}, [router]);

	return null;
}
