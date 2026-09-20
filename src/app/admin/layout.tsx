import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AdminUserProvider } from "@/app/admin/AdminUserContext";
import { authEnabled } from "@/lib/auth/enabled";
import { BYPASS_USER } from "@/lib/auth/requireAuth";
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
	// Bypass lives here, not in `currentUser()` — that function's contract is
	// "the signed-in row, read fresh from the database", and `BYPASS_USER.id`
	// is not a real row. Each display site decides what "no auth" should look
	// like for itself; `POST /api/orders` (a later task) reads the same
	// `authEnabled()` and chooses `null` instead.
	const user = authEnabled() ? await currentUser() : BYPASS_USER;

	return (
		<html
			lang="en"
			className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
		>
			<body className="flex min-h-full flex-col font-sans">
				<AdminUserProvider name={user?.name ?? null} role={user?.role ?? null}>
					{children}
				</AdminUserProvider>
			</body>
		</html>
	);
}
