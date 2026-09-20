"use client";

import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import { authClient } from "@/lib/auth/client";

const DISMISSED = "ezcabinet.planner.nudgeDismissed";

/**
 * Appears once the customer has placed something worth keeping, and never
 * before: the planner opens with no account because the conversion decision in
 * CLAUDE.md says a customer trades a phone number *after* sinking time into a
 * design, not before seeing the 3D scene.
 *
 * It is a nudge, not a gate. The design is already safe on disk (plannerDraft);
 * this is about the customer knowing they can come back to it.
 */
export function SignInNudge({ cabinetCount }: { cabinetCount: number }) {
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
				setError("Could not open Google sign-in. Try again");
				setBusy(false);
				return;
			}
			// Firing on success only, or the funnel counts nudges that never
			// reached Google — the browser is mid-redirect from here, so `busy`
			// is left set rather than cleared.
			track("sign_in_nudge", { action: "accepted" });
		} catch {
			setError("Could not open Google sign-in. Try again");
			setBusy(false);
		}
	}

	return (
		<div className="fixed inset-x-3 bottom-24 z-30 mx-auto flex max-w-[420px] flex-col gap-1.5 rounded-[10px] border border-neutral-300 bg-white px-4 py-3 shadow-lg md:inset-x-auto md:right-6">
			<div className="flex items-center gap-3">
				<p className="flex-1 text-sm">Sign in to save this design.</p>
				<button
					type="button"
					onClick={signIn}
					disabled={busy}
					className="rounded-[8px] bg-neutral-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-60"
				>
					Sign in
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
					className="text-neutral-500 text-xs hover:text-neutral-900"
				>
					Not now
				</button>
			</div>
			{error && <p className="text-red-700 text-xs">{error}.</p>}
		</div>
	);
}
