import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AdminUserProvider } from "@/app/admin/AdminUserContext";
import { currentUser } from "@/lib/auth/session";
import "../globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

// Admin reads live rows behind a login — never bake a build-time snapshot of
// the catalogue, tutorials or deliveries into a static page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "EzCabinet · Admin",
	description: "Internal catalogue, design and site-content admin.",
};

export default async function AdminRootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await currentUser();

	return (
		<html
			lang="en"
			className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
		>
			<body className="flex min-h-full flex-col font-sans">
				<AdminUserProvider name={user?.name ?? null}>
					{children}
				</AdminUserProvider>
			</body>
		</html>
	);
}
