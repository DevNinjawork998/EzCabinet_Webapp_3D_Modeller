import Link from "next/link";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale } from "@/lib/copy/locales";
import { GoogleSignInButton } from "./GoogleSignInButton";

/** Never indexed: it exists to bounce a customer back into checkout. */
export const metadata = { robots: { index: false, follow: false } };

/**
 * Checkout's one hard stop. Browsing, planning and pricing stay anonymous —
 * the conversion decision in CLAUDE.md — so this page is only ever reached
 * from a 401 at `POST /api/orders`, and `?next=` is where it sends the
 * customer back to. The design itself is already safe in `plannerDraft`'s
 * localStorage, not carried through this redirect.
 *
 * Google only. Facebook is deferred — it needs EzCabinet's business
 * verification — and lands as one more button here plus one more block in
 * `src/lib/auth.ts`, nothing else.
 */
export default async function SignInPage({
	params,
	searchParams,
}: {
	params: Promise<{ lang: string }>;
	searchParams: Promise<{ next?: string }>;
}) {
	const [{ lang }, { next }] = await Promise.all([params, searchParams]);
	if (!isLocale(lang)) notFound();
	const t = await getDictionary(lang);
	const s = t.signIn;

	return (
		<main className="flex min-h-screen items-center justify-center bg-[#f4f3f1] px-6 text-neutral-900">
			<div className="flex w-full max-w-[360px] flex-col gap-5 rounded-[14px] border border-neutral-200 bg-white px-7 py-8">
				<div>
					<h1 className="font-semibold text-[22px]">{s.heading}</h1>
					<p className="mt-1.5 text-[14px] text-neutral-500 leading-5">
						{s.body}
					</p>
				</div>

				<GoogleSignInButton
					callbackURL={next || `/${lang}`}
					label={s.continueWithGoogle}
					errorMessage={s.error}
				/>

				<Link
					href={`/${lang}`}
					className="text-center text-[12px] text-neutral-500 hover:text-neutral-900"
				>
					{s.back}
				</Link>
			</div>
		</main>
	);
}
