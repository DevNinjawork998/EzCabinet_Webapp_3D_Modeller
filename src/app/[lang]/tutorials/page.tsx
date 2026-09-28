import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale } from "@/lib/copy/locales";
import type { PublicTutorial } from "@/lib/tutorials";
import { TutorialsBrowser } from "./TutorialsBrowser";

/**
 * The public DIY tutorial library.
 *
 * A server component so the list is in the first HTML — these pages are an
 * SEO surface as much as a support one, and a client-side fetch would leave a
 * crawler an empty grid. The filtering and the player are the client's job.
 *
 * Only `READY` rows are published: a tutorial Mux is still encoding has no
 * playback id, and showing a card that cannot play is worse than not showing
 * it at all.
 */
export default async function TutorialsPage({
	params,
}: {
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();

	const [rows, t] = await Promise.all([
		prisma.tutorial.findMany({
			where: { status: "READY" },
			orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
			select: {
				id: true,
				title: true,
				description: true,
				category: true,
				level: true,
				playbackId: true,
				durationSec: true,
			},
		}),
		getDictionary(lang),
	]);
	const tutorials: PublicTutorial[] = rows;

	return (
		<div className="flex min-h-screen flex-col bg-[#e9e7e3] text-neutral-900">
			{/* Nav */}
			<div className="sticky top-0 z-10 border-neutral-200 border-b bg-[#fdfcfb]">
				<div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-8">
					<div className="flex items-center gap-0.5 text-[#6b6b6b] text-[13px]">
						<Link
							href={`/${lang}`}
							className="px-1 py-2.5 font-semibold text-neutral-900"
						>
							{t.common.brand}
						</Link>
						<span>/</span>
						<span className="px-1 py-2.5 text-neutral-900">
							{t.landing.nav.tutorials}
						</span>
					</div>
					<div className="flex items-center gap-4">
						<Link
							href={`/${lang}/planner`}
							className="inline-flex min-h-9 items-center rounded-[9px] bg-[#1f5138] px-4.5 font-medium text-[13px] text-white hover:bg-[#17402c]"
						>
							{t.landing.nav.startPlanning}
						</Link>
						<Link
							href="/admin/login"
							target="_blank"
							className="border-neutral-200 border-l py-2.5 pl-4 text-[#6b6b6b] text-[12px] hover:text-neutral-500"
						>
							{t.landing.nav.admin}
						</Link>
					</div>
				</div>
			</div>

			{/* Header */}
			<div className="mx-auto w-full max-w-[1180px] px-8 pt-14">
				<p className="mb-2.5 font-semibold text-[#5c574e] text-xs uppercase tracking-[0.08em]">
					{t.tutorials.eyebrow}
				</p>
				<h1 className="mb-3 font-bold text-[34px] leading-[1.15] tracking-tight">
					{t.tutorials.heading}
				</h1>
				<p className="mb-9 max-w-[560px] text-[#4a4a4a] text-[15px] leading-[22px]">
					{t.tutorials.subtitle}
				</p>
			</div>

			<TutorialsBrowser tutorials={tutorials} copy={t} />
		</div>
	);
}
