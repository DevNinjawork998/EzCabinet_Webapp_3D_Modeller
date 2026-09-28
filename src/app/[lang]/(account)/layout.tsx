import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale } from "@/lib/copy/locales";
import { AccountNav } from "./AccountNav";

/**
 * The customer account frame: the shared header and the "Your account" side
 * nav around My orders and each order. It decides nothing about access — a
 * layout is not given the URL, so it cannot send a visitor to sign-in and
 * back; each page does that with `viewerOf`.
 */
export const metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const [user, t] = await Promise.all([currentUser(), getDictionary(lang)]);
	const orders = user
		? await prisma.order.count({ where: { userId: user.id } })
		: 0;

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-[#171717]">
			<SiteHeader lang={lang} t={t} />
			<div className="flex flex-1 justify-center px-4 pt-8 pb-16 sm:px-7">
				<div className="flex w-full max-w-[1040px] flex-wrap items-start gap-7">
					<AccountNav
						heading={t.account.navHeading}
						items={[
							{
								href: `/${lang}/orders`,
								label: t.account.myOrders,
								count: orders,
								matches: [`/${lang}/orders`, `/${lang}/order/`],
							},
						]}
					/>
					<main className="flex min-w-0 flex-[1_1_520px] flex-col gap-[18px]">
						{children}
					</main>
				</div>
			</div>
		</div>
	);
}
