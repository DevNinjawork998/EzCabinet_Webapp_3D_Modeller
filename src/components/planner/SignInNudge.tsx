"use client";

import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import { authClient } from "@/lib/auth/client";
import { useCopy } from "./CopyContext";

const DISMISSED = "ezcabinet.planner.nudgeDismissed";

/**
 * Appears once the customer has placed something worth keeping, and never
 * before: the planner opens with no account because the conversion decision in
 * CLAUDE.md says a customer trades a phone number *after* sinking time into a
 * design, not before seeing the 3D scene.
 *
 * It is a nudge, not a gate. The design is already safe on disk (plannerDraft);
 * this is about the customer knowing they can come back to it.
 *
 * It renders in the flow of the price footer, directly above the quote
 * button, never as a floating layer. It used to be `fixed` against the
 * viewport, which put it exactly on top of the estimated total — the one
 * number the customer is deciding on — and, at z-30, over the breakdown
 * modal too. Being about checkout, beside the checkout button is where it
 * belongs anyway.
 */
export function SignInNudge({ cabinetCount }: { cabinetCount: number }) {
	const t = useCopy();
	const { data: session, isPending } = authClient.useSession();
	const [dismissed, setDismissed] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(DISMISSED) === "1");
		} catch {
			setDismissed(false);
		}
	}, []);

	const visible =
		!isPending && !session?.user && !dismissed && cabinetCount > 0;

	// Fire "shown" once per appearance, not on every re-render (session poll,
	// parent update, ...) — a track call in the render body would fire dozens
	// of times per drag.
	useEffect(() => {
		if (visible) track("sign_in_nudge", { action: "shown" });
	}, [visible]);

	if (!visible) return null;

	async function signIn() {
		setBusy(true);
		setError(null);
		try {
			const { error: failure } = await authClient.signIn.social({
				provider: "google",
				callbackURL: window.location.href,
			});
			if (failure) {
				setError(t.signIn.error);
				setBusy(false);
				return;
			}
			// Firing on success only, or the funnel counts nudges that never
			// reached Google — the browser is mid-redirect from here, so `busy`
			// is left set rather than cleared.
			track("sign_in_nudge", { action: "accepted" });
		} catch {
			setError(t.signIn.error);
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-2 rounded-[10px] border border-neutral-200 bg-[#faf9f7] px-3 py-2.5">
			<p className="text-[12px] text-neutral-700 leading-4">{t.signIn.nudge}</p>
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={signIn}
					disabled={busy}
					className="rounded-[8px] bg-neutral-900 px-3 py-1.5 font-medium text-[12px] text-white disabled:opacity-60"
				>
					{t.signIn.nudgeAction}
				</button>
				<button
					type="button"
					onClick={() => {
						track("sign_in_nudge", { action: "dismissed" });
						setDismissed(true);
						try {
							localStorage.setItem(DISMISSED, "1");
						} catch {}
					}}
					className="text-[12px] text-neutral-500 hover:text-neutral-900"
				>
					{t.signIn.nudgeDismiss}
				</button>
			</div>
			{error && <p className="text-[12px] text-red-700">{error}.</p>}
		</div>
	);
}
