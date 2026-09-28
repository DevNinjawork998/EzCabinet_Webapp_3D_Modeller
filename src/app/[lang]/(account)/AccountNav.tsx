"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The design's "Your account" side nav. Current = this page or one under it. */
export function AccountNav({
	heading,
	items,
}: {
	heading: string;
	items: { href: string; label: string; count: number; matches: string[] }[];
}) {
	const pathname = usePathname();
	return (
		<nav
			aria-label={heading}
			className="flex flex-[0_0_200px] flex-col gap-0.5 md:sticky md:top-6"
		>
			<p className="mb-2 ml-2.5 font-semibold text-[#5c574e] text-[12px] uppercase tracking-[.06em]">
				{heading}
			</p>
			{items.map((item) => {
				const current = item.matches.some((m) => pathname.startsWith(m));
				return (
					<Link
						key={item.href}
						href={item.href}
						aria-current={current ? "page" : undefined}
						className={`flex min-h-10 items-center justify-between gap-2 rounded-lg px-2.5 text-[13px] hover:bg-[#ecebe7] hover:text-[#171717] ${
							current
								? "bg-white font-semibold text-[#171717] shadow-[0_0_0_1px_#e5e5e5]"
								: "font-medium text-[#404040]"
						}`}
					>
						<span>{item.label}</span>
						<span className="font-medium text-[#5c574e] text-[12px] tabular-nums">
							{item.count}
						</span>
					</Link>
				);
			})}
		</nav>
	);
}
