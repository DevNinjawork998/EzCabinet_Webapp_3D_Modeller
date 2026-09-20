import { AdminHeader } from "@/components/admin/AdminHeader";
import { requirePage } from "@/lib/auth/page";
import { prisma } from "@/lib/catalogue/db";
import { TutorialManager } from "./TutorialManager";

/**
 * The DIY tutorial library.
 *
 * Video bytes never touch this app: the browser uploads straight to Mux and
 * only the ids come back here. See `/api/admin/tutorials/upload` for why that
 * is a hard requirement rather than an optimisation.
 */
export default async function TutorialsAdminPage() {
	await requirePage("content:write");
	const tutorials = await prisma.tutorial.findMany({
		orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
	});

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader />
			<main className="mx-auto flex w-full max-w-[840px] flex-col gap-8 px-7 pt-8 pb-16">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">DIY tutorials</h1>
					<p className="text-neutral-500 text-[13px]">
						Videos are hosted by Mux and appear on the public tutorials page as
						soon as they finish processing. Uploads go straight from your
						browser to Mux, so a large file will not time out.
					</p>
				</div>
				<TutorialManager initial={tutorials} />
			</main>
		</div>
	);
}
