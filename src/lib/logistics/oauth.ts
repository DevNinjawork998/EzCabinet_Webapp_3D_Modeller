import { z } from "zod";
import { carrierFetch } from "./http";
import { trace } from "./trace";

/**
 * EasyParcel's OAuth 2.0 half that touches no database.
 *
 * Split out of `tokens.ts` so it can be tested the way everything else in this
 * folder is — a stubbed `fetch` and no Prisma client. The token exchange is the
 * single call most likely to be wrong (form-encoded body, Basic app auth, a
 * reply shape we do not control), so it is the call that most needs to be
 * covered without a database in the way.
 *
 * Deliberately not `server-only`: it reads the client secret from the
 * environment, and a client bundle has no environment to read it from, but the
 * file that holds the credentials for real is `tokens.ts` and that one is.
 */

export const OAUTH_BASE = "https://api.easyparcel.com";

const CLIENT_ID = () => process.env.EASYPARCEL_CLIENT_ID ?? "";
const CLIENT_SECRET = () => process.env.EASYPARCEL_CLIENT_SECRET ?? "";

export function easyparcelAppConfigured(): boolean {
	return CLIENT_ID() !== "" && CLIENT_SECRET() !== "";
}

/**
 * The URL EasyParcel sends the admin back to. Must match a redirect URI
 * registered on the app in their Developer Hub, byte for byte — a mismatch is
 * an error on their login page, not in our logs.
 */
export function easyparcelRedirectUri(): string {
	const configured = (process.env.APP_URL ?? "").trim();

	// A localhost default is a convenience on a laptop and a trap on a server:
	// the redirect goes out as `http://localhost:3000/…`, EasyParcel answers
	// "invalid_client: `redirect_uri` does not match client value", and that
	// sentence names their client rather than our unset variable — so whoever
	// reads it goes looking in the Developer Hub for a fault that is in the
	// deployment's environment. Refuse instead, and say which variable.
	if (configured === "") {
		if (process.env.NODE_ENV === "production") {
			throw new Error(
				"APP_URL is not set, so there is no address to send an EasyParcel login back to. Set it to this deployment's own origin, and register that same URL plus /api/admin/logistics/easyparcel/callback on the app in EasyParcel's Developer Hub.",
			);
		}
		return "http://localhost:3000/api/admin/logistics/easyparcel/callback";
	}

	// EasyParcel compares the registered string, not the parsed URL, so
	// `https://x.com//api/…` and `https://x.com/api/…` are two registrations
	// even though they address the same route — and a trailing slash on APP_URL
	// is the easiest way to have one and register the other.
	return `${configured.replace(/\/+$/, "")}/api/admin/logistics/easyparcel/callback`;
}

export function easyparcelLoginUrl(state: string): string {
	const url = new URL(`${OAUTH_BASE}/oauth/login`);
	url.searchParams.set("client_id", CLIENT_ID());
	url.searchParams.set("redirect_uri", easyparcelRedirectUri());
	url.searchParams.set("state", state);
	return url.toString();
}

/**
 * Their token reply. `expires_at` is present in the documented sample but is
 * only ever derived from `expires_in`, so it is optional here and the seconds
 * are what we compute from — one clock (ours) rather than two.
 */
export const tokenResponseSchema = z.object({
	token_type: z.string().optional(),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	expires_at: z.string().optional(),
	refresh_token_expires_in: z.number().int().positive(),
	refresh_token_expires_at: z.string().optional(),
	app: z.looseObject({}).optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * How close to the expiry counts as expired.
 *
 * A token with twenty seconds left is a token that expires mid-request. Sixty
 * seconds is enough for the slowest call `carrierFetch` will wait for.
 */
const MARGIN_MS = 60_000;

export function willExpireSoon(expiresAt: Date, now = new Date()): boolean {
	return expiresAt.getTime() - now.getTime() <= MARGIN_MS;
}

// Corrected per pre-flight ruling: tokens.ts imports this, so it must be
// exported — the brief's interface list already says so.
export function expiryFrom(seconds: number): Date {
	return new Date(Date.now() + seconds * 1000);
}

/** `Basic base64(client_id:client_secret)` — how their token endpoint authenticates the app. */
function basicAuth(): string {
	const raw = `${CLIENT_ID()}:${CLIENT_SECRET()}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/**
 * Their token endpoint takes form-encoded parameters, not JSON — so this is the
 * one call in the logistics module that does not go through `carrierFetch`'s
 * JSON body path. The string body form exists for exactly this.
 */
export async function requestToken(
	params: Record<string, string>,
): Promise<TokenResponse> {
	const body = new URLSearchParams(params).toString();
	const reply = await carrierFetch<unknown>(`${OAUTH_BASE}/oauth/token`, {
		carrierId: "easyparcel",
		method: "POST",
		headers: {
			authorization: basicAuth(),
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
		// Safe to send twice: an authorization code that has already been spent
		// comes back as a 4xx, which is not retried.
		idempotent: true,
		// The request body is the credential being spent and the reply is the
		// credential being minted — unlike `lalamove.ts`'s quote replies, which
		// carry no secret and are printed in full, this one must never reach a
		// log line even with LOGISTICS_DEBUG on.
		sensitive: true,
	});
	const parsed = tokenResponseSchema.safeParse(reply);
	if (!parsed.success) {
		// Not the payload: on the documented shape it *is* a live access and
		// refresh token, and a schema failure from one renamed field would put
		// them in an Error message that travels wherever the caller reports
		// failures. The field paths are what a debugger needs and are not secret.
		const fields = parsed.error.issues
			.map((issue) => issue.path.join("."))
			.join(", ");
		trace("easyparcel.unreadable", { what: "token", fields });
		throw new Error(
			"EasyParcel's sign-in reply could not be read — try again, and tell the developer if it keeps happening.",
		);
	}
	return parsed.data;
}
