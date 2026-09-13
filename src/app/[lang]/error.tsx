"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { captureError } from "@/lib/analytics";
import { isLocale, type Locale } from "@/lib/copy/locales";

/**
 * Inline rather than from the dictionary: an error boundary takes no props, and
 * shipping all three full dictionaries into the client for three strings is the
 * wrong trade on a mobile budget.
 */
const COPY: Record<Locale, { title: string; body: string; retry: string }> = {
	en: {
		title: "Something went wrong",
		body: "Please try again. If it keeps happening, reload the page.",
		retry: "Try again",
	},
	zh: {
		title: "出了点问题",
		body: "请重试。如果问题持续出现，请重新加载页面。",
		retry: "重试",
	},
	ms: {
		title: "Ada masalah berlaku",
		body: "Sila cuba lagi. Jika masalah berterusan, muat semula halaman.",
		retry: "Cuba lagi",
	},
};

export default function LocaleError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const { lang } = useParams<{ lang: string }>();
	const locale: Locale = isLocale(lang) ? lang : "en";
	const t = COPY[locale];

	useEffect(() => {
		captureError(error, { boundary: "locale", digest: error.digest ?? null });
	}, [error]);

	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#e9e7e3] p-8 text-center text-neutral-900">
			<h1 className="font-semibold text-[20px]">{t.title}</h1>
			<p className="max-w-[40ch] text-[14px] text-neutral-600">{t.body}</p>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={reset}
					className="rounded-lg bg-neutral-900 px-4 py-2 font-medium text-[13px] text-white"
				>
					{t.retry}
				</button>
				<Link
					href={`/${locale}`}
					className="rounded-lg border border-neutral-300 px-4 py-2 text-[13px]"
				>
					EzCabinet
				</Link>
			</div>
		</main>
	);
}
