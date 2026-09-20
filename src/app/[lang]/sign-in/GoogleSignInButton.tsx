"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";

/**
 * The one interactive thing on the sign-in page. `signIn.social` redirects the
 * whole browser to Google on success, so there is nothing to await past that
 * — the failure path (Task 10's lesson) is what needs a visible error rather
 * than a silently discarded promise.
 */
export function GoogleSignInButton({
	callbackURL,
	label,
	errorMessage,
}: {
	/** Where Better Auth sends the browser back to once Google is done. */
	callbackURL: string;
	label: string;
	errorMessage: string;
}) {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	async function signIn() {
		setBusy(true);
		setFailed(false);
		try {
			const { error } = await authClient.signIn.social({
				provider: "google",
				callbackURL,
			});
			if (error) {
				setFailed(true);
				setBusy(false);
			}
			// On success the browser is mid-redirect to Google; leave `busy` set
			// rather than flashing the button back to normal.
		} catch {
			setFailed(true);
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				onClick={signIn}
				disabled={busy}
				className="flex items-center justify-center gap-2 rounded-[9px] border border-neutral-300 bg-white py-2.5 font-medium text-sm disabled:opacity-60"
			>
				{label}
			</button>
			{failed && (
				<p
					role="alert"
					className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700"
				>
					{errorMessage}.
				</p>
			)}
		</div>
	);
}
