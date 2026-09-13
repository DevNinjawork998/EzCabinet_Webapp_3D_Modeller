import Link from "next/link";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";

/**
 * The privacy notice the consent banner links to.
 *
 * A draft, and labelled as one on the page: EzCabinet is the data
 * controller under the PDPA, so the wording is theirs to approve. What it must
 * keep saying is what the code does — see `src/lib/analytics.ts`.
 */
export default async function PrivacyPage({
	params,
}: {
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const t = await getDictionary(lang);
	const p = t.privacy;

	const sections = [
		[p.purposeHeading, p.purpose],
		[p.collectHeading, p.collect],
		[p.notCollectHeading, p.notCollect],
		[p.whereHeading, p.where],
		[p.choiceHeading, p.choice],
		[p.contactHeading, fill(p.contact, { email: t.landing.footer.email })],
	] as const;

	return (
		<main className="mx-auto flex w-full max-w-[680px] flex-col gap-6 px-6 py-14 text-neutral-900">
			<div>
				<Link
					href={`/${lang}`}
					className="text-[13px] text-neutral-500 underline"
				>
					{p.back}
				</Link>
				<h1 className="mt-4 font-semibold text-[28px]">{p.title}</h1>
				<p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
					{p.draft}
				</p>
				<p className="mt-4 text-[15px] text-neutral-600 leading-6">{p.intro}</p>
			</div>
			{sections.map(([heading, body]) => (
				<section key={heading}>
					<h2 className="font-semibold text-[16px]">{heading}</h2>
					<p className="mt-1.5 text-[14px] text-neutral-600 leading-6">
						{body}
					</p>
				</section>
			))}
		</main>
	);
}
