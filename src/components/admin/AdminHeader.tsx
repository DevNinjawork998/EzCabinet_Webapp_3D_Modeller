"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AdminSignOut } from "@/app/admin/AdminSignOut";
import {
	useAdminUserName,
	useAdminUserRole,
} from "@/app/admin/AdminUserContext";

/**
 * The admin chrome: a breadcrumb row over a tab bar.
 *
 * Shared by every admin page so the tabs stay in one place — the design has
 * a single "Catalogue" tab because the mockup only knows about this one
 * screen, but the real app has three working admin routes, so they're
 * listed as siblings here.
 *
 * Which tab is current comes from the route, not a prop: the router already
 * knows, and a prop would be the same fact written twice.
 */

const TABS = [
	{ label: "Cabinet designs", href: "/admin/cabinet-designs" },
	{ label: "Orders", href: "/admin/orders" },
	{ label: "Logistics", href: "/admin/logistics" },
	{ label: "Site content", href: "/admin/site-content" },
	{ label: "Tutorials", href: "/admin/tutorials" },
];

const SUPERADMIN_TABS = [{ label: "People", href: "/admin/users" }];

/**
 * `trail` is where a page sits under "EzCabinet /" — a delivery's own
 * page reads "Deliveries / #14". Left out, the crumb just says "Admin". The
 * last entry is the current page and never a link.
 */
export function AdminHeader({
	trail = [{ label: "Admin" }],
}: {
	trail?: { label: string; href?: string }[];
}) {
	const pathname = usePathname();
	const name = useAdminUserName();
	const role = useAdminUserRole();
	const tabs = role === "SUPERADMIN" ? [...TABS, ...SUPERADMIN_TABS] : TABS;

	return (
		<header className="flex shrink-0 flex-col border-neutral-200 border-b bg-white">
			<div className="flex items-center justify-between gap-6 px-7 pt-3.5">
				<div className="flex items-center gap-1.5 text-neutral-400 text-xs">
					<Link
						href="/"
						target="_blank"
						className="px-1 py-1.5 text-neutral-400 hover:text-neutral-600"
					>
						EzCabinet
					</Link>
					{trail.map((crumb, i) => (
						<span key={crumb.label} className="flex items-center gap-1.5">
							<span>/</span>
							{crumb.href && i < trail.length - 1 ? (
								<Link
									href={crumb.href}
									className="px-1 py-1.5 text-neutral-400 hover:text-neutral-600"
								>
									{crumb.label}
								</Link>
							) : (
								<span className="px-1 py-1.5 font-medium text-neutral-900">
									{crumb.label}
								</span>
							)}
						</span>
					))}
				</div>
				<div className="flex items-center gap-2">
					<Link
						href="/planner"
						target="_blank"
						className="flex min-h-9 items-center gap-1.5 rounded-lg border border-neutral-300 px-3.5 py-2.5 text-neutral-700 text-xs"
					>
						<svg
							width="13"
							height="13"
							viewBox="0 0 13 13"
							fill="none"
							aria-hidden="true"
						>
							<path
								d="M4 2H2v9h9V9M7 2h4v4M11 2 6 7"
								stroke="currentColor"
								strokeWidth="1.2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
						View as customer
					</Link>
					<AdminSignOut name={name ?? "Admin"} />
				</div>
			</div>

			<nav className="flex items-center gap-1 px-6 pt-3">
				{tabs.map((tab) => {
					const active = pathname.startsWith(tab.href);
					return (
						<Link
							key={tab.href}
							href={tab.href}
							aria-current={active ? "page" : undefined}
							className={`border-b-2 px-3 py-2.5 text-[13px] ${
								active
									? "border-neutral-900 font-semibold text-neutral-900"
									: "border-transparent text-neutral-500 hover:text-neutral-900"
							}`}
						>
							{tab.label}
						</Link>
					);
				})}
			</nav>
		</header>
	);
}
