import type { Metadata } from "next";
import { Geist, Geist_Mono, Libre_Caslon_Display } from "next/font/google";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Analytics } from "@/components/Analytics";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { getDictionary } from "@/lib/copy/dictionary";
import { htmlLang, isLocale, LOCALES } from "@/lib/copy/locales";
import "../globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});
/**
 * The wordmark, and nothing else. One weight, self-hosted by `next/font`, and
 * `swap` so Georgia paints first — a webfont on the LCP path for a single word
 * only earns its place if it never blocks the render.
 */
const caslon = Libre_Caslon_Display({
	variable: "--font-caslon",
	weight: "400",
	subsets: ["latin"],
	display: "swap",
});

/** All three locales are prerendered — they are the SEO surface. */
export function generateStaticParams() {
	return LOCALES.map((lang) => ({ lang }));
}

/**
 * Per-locale title and description, plus the `hreflang` alternates.
 *
 * The alternates are not decoration: three indexable URLs only earn their
 * keep if Google is told they are translations of one another. Without them
 * the whole reason for putting the locale in the path goes unpaid.
 */
export async function generateMetadata({
	params,
}: LayoutProps<"/[lang]">): Promise<Metadata> {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const dict = await getDictionary(lang);

	return {
		title: dict.meta.title,
		description: dict.meta.description,
		alternates: {
			canonical: `/${lang}`,
			languages: {
				en: "/en",
				"zh-Hans": "/zh",
				"ms-MY": "/ms",
				"x-default": "/en",
			},
		},
	};
}

export default async function RootLayout({
	children,
	params,
}: LayoutProps<"/[lang]">) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const dict = await getDictionary(lang);

	return (
		<html
			lang={htmlLang(lang)}
			className={`${geistSans.variable} ${geistMono.variable} ${caslon.variable} h-full antialiased`}
		>
			<body className="flex min-h-full flex-col font-sans">
				{/* useSearchParams needs a Suspense boundary or the whole tree
				    de-opts to client rendering; a bare fallback is fine since the
				    switcher paints almost immediately either way. */}
				<Suspense fallback={null}>
					<LanguageSwitcher current={lang} label={dict.common.language} />
				</Suspense>
				{children}
				<Analytics copy={dict.consent} lang={lang} />
			</body>
		</html>
	);
}
