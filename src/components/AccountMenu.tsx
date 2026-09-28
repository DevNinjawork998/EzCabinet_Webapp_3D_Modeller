"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { initialsOf } from "@/lib/initials";

/**
 * The header's right-hand side: an avatar menu when signed in, a Sign in
 * button when not. Reads the session in the browser so the pages it sits on
 * (the landing page above all) can stay statically rendered.
 */
export function AccountMenu({
	lang,
	labels,
}: {
	lang: string;
	labels: { signIn: string; signOut: string; myOrders: string; menu: string };
}) {
	const { data, isPending } = authClient.useSession();
	const pathname = usePathname();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Same footprint as the avatar, so the header does not jump once it loads.
	if (isPending) return <span aria-hidden className="h-10 w-[58px]" />;

	const user = data?.user;
	if (!user) {
		return (
			<Link
				href={`/${lang}/sign-in?next=${encodeURIComponent(pathname)}`}
				className="flex min-h-9 items-center rounded-lg border border-[#d4d4d4] bg-white px-3.5 font-medium text-[#171717] text-[13px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
			>
				{labels.signIn}
			</Link>
		);
	}

	const item =
		"flex min-h-[38px] items-center rounded-lg px-2.5 text-left text-[13px] text-[#171717] hover:bg-[#f4f3f1] active:bg-[#ecebe7]";

	return (
		<div ref={root} className="relative">
			<button
				ref={trigger}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={labels.menu}
				onClick={() => setOpen((v) => !v)}
				className="flex min-h-10 items-center gap-2 rounded-full border border-[#e5e5e5] bg-white py-[3px] pr-2.5 pl-[3px] text-[#171717] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
			>
				<span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1f5138] font-semibold text-[12px] text-white">
					{initialsOf(user.name, user.email)}
				</span>
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
					<path
						d="M2.5 4 5 6.5 7.5 4"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open && (
				<div
					role="menu"
					aria-label={labels.menu}
					className="absolute top-[calc(100%+6px)] right-0 z-20 flex w-60 flex-col rounded-xl border border-[#e5e5e5] bg-white p-1.5 shadow-[0_12px_32px_rgba(23,23,23,.12)]"
				>
					<div className="mb-1 border-[#ecebe7] border-b px-2.5 pt-2.5 pb-3">
						<p className="truncate font-semibold text-[13px]">{user.name}</p>
						<p className="truncate text-[#5c574e] text-[12px]">{user.email}</p>
					</div>
					<Link
						role="menuitem"
						href={`/${lang}/orders`}
						className={item}
						onClick={() => setOpen(false)}
					>
						{labels.myOrders}
					</Link>
					<button
						type="button"
						role="menuitem"
						className={`${item} mt-1 rounded-t-none border-[#ecebe7] border-t text-[#5c574e] hover:text-[#171717]`}
						onClick={async () => {
							setOpen(false);
							await authClient.signOut();
							router.push(`/${lang}`);
							router.refresh();
						}}
					>
						{labels.signOut}
					</button>
				</div>
			)}
		</div>
	);
}
