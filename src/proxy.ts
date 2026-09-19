import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_COOKIE, isValidAdminSession } from "@/lib/adminAuth";
import { needsLocaleRedirect, negotiateLocale } from "@/lib/copy/locales";

/**
 * Two jobs, deliberately kept apart.
 *
 * `/admin/*` and `/api/admin/*` are gated behind the shared-secret cookie —
 * unchanged behaviour, and it runs first. Everything else public is sent to a
 * locale-prefixed URL. `needsLocaleRedirect` exempts admin, api, `_next` and
 * files, so the two branches can never contend for the same request.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
		if (pathname === "/api/admin/login" || pathname === "/admin/login") {
			return NextResponse.next();
		}

		const session = request.cookies.get(ADMIN_COOKIE)?.value;
		if (await isValidAdminSession(session)) return NextResponse.next();

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
