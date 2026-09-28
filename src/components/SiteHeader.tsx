import Link from "next/link";
import type { Dictionary } from "@/lib/copy/en";
import { AccountMenu } from "./AccountMenu";

const NAV =
	"flex min-h-9 items-center rounded-lg px-2.5 font-medium text-[#404040] text-[13px] hover:bg-[#f4f3f1] hover:text-[#171717]";

/** The design's header for the account pages and the track page. */
export function SiteHeader({ lang, t }: { lang: string; t: Dictionary }) {
	return (
		<header className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-[#e5e5e5] border-b bg-white px-4 py-2.5 sm:px-7">
			<div className="flex items-center gap-5">
				<Link
					href={`/${lang}`}
					className="px-0.5 py-1.5 font-bold text-[#171717] text-[14px]"
				>
					{t.common.brand}
				</Link>
				<nav aria-label="Main" className="hidden gap-1 sm:flex">
					<Link href={`/${lang}/planner`} className={NAV}>
						{t.planner.crumbs.roomPlanner}
					</Link>
					<Link href={`/${lang}/tutorials`} className={NAV}>
						{t.landing.nav.tutorials}
					</Link>
				</nav>
			</div>
			<AccountMenu
				lang={lang}
				labels={{
					signIn: t.account.signIn,
					signOut: t.account.signOut,
					myOrders: t.account.myOrders,
					menu: t.account.menuLabel,
				}}
			/>
		</header>
	);
}
