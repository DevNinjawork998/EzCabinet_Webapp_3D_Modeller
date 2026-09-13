"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { consentStatus, setConsent } from "@/lib/analytics";
import type { Dictionary } from "@/lib/copy/en";
import type { Locale } from "@/lib/copy/locales";

/**
 * Starts telemetry on idle and asks for consent once.
 *
 * Renders nothing until PostHog has loaded and reports "pending", so the
 * banner never competes with the first paint — and never appears at all where
 * analytics is off (no token, script blocked). Mounted in the public layout
 * only; admin is not tracked.
 */
export function Analytics({
	copy,
	lang,
}: {
	copy: Dictionary["consent"];
	lang: Locale;
}) {
	const [pending, setPending] = useState(false);

	useEffect(() => {
		let live = true;
		consentStatus().then((status) => {
			if (live) setPending(status === "pending");
		});
		return () => {
			live = false;
		};
	}, []);

	if (!pending) return null;

	const choose = (granted: boolean) => {
		setConsent(granted);
		setPending(false);
	};

	return (
		<section
			aria-label={copy.title}
			className="fixed inset-x-3 bottom-3 z-50 max-w-sm rounded-xl border border-neutral-200 bg-white p-4 text-neutral-900 shadow-lg sm:right-auto sm:left-4"
		>
			<p className="font-semibold text-[14px]">{copy.title}</p>
			<p className="mt-1 text-[13px] text-neutral-600 leading-5">
				{copy.body}{" "}
				<Link href={`/${lang}/privacy`} className="underline">
					{copy.learnMore}
				</Link>
			</p>
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					onClick={() => choose(true)}
					className="rounded-lg bg-neutral-900 px-3 py-2 font-medium text-[13px] text-white"
				>
					{copy.accept}
				</button>
				<button
					type="button"
					onClick={() => choose(false)}
					className="rounded-lg border border-neutral-300 px-3 py-2 text-[13px] text-neutral-700"
				>
					{copy.reject}
				</button>
			</div>
		</section>
	);
}
