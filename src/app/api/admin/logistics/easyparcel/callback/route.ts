import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/requireAuth";
import { exchangeCode } from "@/lib/logistics/tokens";

export const runtime = "nodejs";

// Deliberately not behind withAuth: this is EasyParcel redirecting the
// admin's own browser back to us, and the `state` cookie match below is the
// check that matters. requireAuth here would turn a timing problem into a
// failed carrier connection. The handler reads no data and writes only the
// token exchange this app itself initiated.
void requireAuth;

/**
 * Where EasyParcel sends the admin back with an authorization code.
 *
 * Always redirects to the logistics page rather than rendering — this is a
 * browser round trip, and the admin should land back where they started with a
 * banner saying what happened.
 */
export async function GET(request: NextRequest) {
	const url = new URL(request.url);
	const code = url.searchParams.get("code") ?? "";
	const state = url.searchParams.get("state") ?? "";

	const expected = request.cookies.get("easyparcel_oauth_state")?.value;

	const done = (result: string) => {
		const back = new URL("/admin/logistics", url.origin);
		back.searchParams.set("easyparcel", result);
		const response = NextResponse.redirect(back);
		response.cookies.delete("easyparcel_oauth_state");
		return response;
	};

	// An unmatched state means this code did not come from a link we issued.
	if (code === "" || state === "" || state !== expected) {
		return done("failed");
	}

	try {
		// Real accounts exist now, but this callback isn't behind `withAuth` and
		// carries no session — so "admin" is still the only actor recorded here,
		// not a specific signed-in name.
		await exchangeCode(code, "admin");
	} catch {
		return done("failed");
	}

	return done("connected");
}
