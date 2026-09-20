import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import {
	easyparcelAppConfigured,
	easyparcelLoginUrl,
} from "@/lib/logistics/oauth";

export const runtime = "nodejs";

/**
 * Send the admin to EasyParcel's login so they can link the account.
 *
 * This route's own `withAuth("logistics:book", ...)` below is the gate —
 * `proxy.ts` only checks that a session cookie exists, it does not read a
 * role. The callback this leads to is deliberately not gated the same way
 * (see its own file for why); the `state` cookie is what ties the two
 * together.
 *
 * `state` is a nonce in a short-lived cookie, checked on the way back. It is
 * the CSRF guard EasyParcel's own docs ask for: without it, anyone can feed
 * this app an authorization code for an account we did not choose.
 */
export const GET = withAuth("logistics:book", async () => {
	if (!easyparcelAppConfigured()) {
		return NextResponse.json({ error: "not_configured" }, { status: 409 });
	}

	// `easyparcelRedirectUri` throws on a deployment with no APP_URL. Answer
	// with the reason rather than a stack: the fix is an environment variable,
	// and the person clicking Connect is the person who can set it.
	let loginUrl: string;
	try {
		loginUrl = easyparcelLoginUrl(randomUUID());
	} catch (error) {
		return NextResponse.json(
			{ error: "app_url_not_set", message: (error as Error).message },
			{ status: 409 },
		);
	}

	const state = new URL(loginUrl).searchParams.get("state") ?? randomUUID();
	const response = NextResponse.redirect(loginUrl);
	response.cookies.set("easyparcel_oauth_state", state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 600,
	});
	return response;
});
