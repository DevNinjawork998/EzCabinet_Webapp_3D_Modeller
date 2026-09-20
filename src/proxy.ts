import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authEnabled } from "@/lib/auth/enabled";
import { needsLocaleRedirect, negotiateLocale } from "@/lib/copy/locales";

/**
 * Two jobs, deliberately kept apart.
 *
 * `/admin/*` and `/api/admin/*` are sent to the login page when no session
 * cookie is present. This is a redirect, not a security check: it never reads
 * the database and therefore never knows a role. The boundary is
 * `requireAuth()`, called inside every admin page and route handler — a route
 * that forgets to call it is unprotected no matter what happens here.
 *
 * Everything else public is sent to a locale-prefixed URL.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
		if (!authEnabled()) return NextResponse.next();
		if (pathname === "/admin/login") return NextResponse.next();

		if (getSessionCookie(request)) return NextResponse.next();

		if (pathname.startsWith("/api/admin")) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const loginUrl = new URL("/admin/login", request.url);
		loginUrl.searchParams.set("next", pathname);
		return NextResponse.redirect(loginUrl);
	}

	if (needsLocaleRedirect(pathname)) {
		const locale = negotiateLocale(request.headers.get("accept-language"));
		const url = request.nextUrl.clone();
		url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
		return NextResponse.redirect(url);
	}

	return NextResponse.next();
}

export const config = {
	// Everything except: Next's own assets, public API routes (the mesh
	// endpoint is this app's hot path — every cabinet on screen fetches it),
	// and anything with a file extension (images, favicon, etc). `api/(?!admin)`
	// is load-bearing: a bare `api` exclusion would drop /api/admin/* out of
	// the matcher entirely and silently unauthenticate the admin API, since
	// the admin gate above only runs when the proxy runs at all.
	matcher: ["/((?!_next|_vercel|api/(?!admin)|.*\\..*).*)"],
};
