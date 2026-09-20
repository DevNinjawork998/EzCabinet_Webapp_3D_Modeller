"use server";

import { APIError } from "better-auth";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { currentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/catalogue/db";

/**
 * Changes the caller's own password and, only on success, clears
 * `mustChangePassword`.
 *
 * There is deliberately no separate "clear the flag" step. An earlier
 * version cleared the flag from its own action, gated only by
 * `currentUser()` — which meant any signed-in staff member could clear it
 * without ever changing their password: sequencing on the client ("only
 * call clear after change succeeds") is not a control, since the action
 * itself was reachable directly by exactly the person most motivated to
 * skip the screen. Folding the change into this one call removes that gap:
 * `prisma.user.update` below is only reached once `auth.api.changePassword`
 * has already verified `currentPassword` server-side, so clearing the flag
 * requires proving both passwords, not just holding a session.
 *
 * Not gated by `requirePage`/`requireAuth` for the same reason the page
 * itself calls `currentUser()` directly: a user who must change their
 * password is refused by both, which would make this action unreachable
 * for exactly the person who needs it.
 */
export async function changeOwnPassword(
	currentPassword: string,
	newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const user = await currentUser();
	if (!user) return { ok: false, error: "not_signed_in" };

	try {
		// `revokeOtherSessions: true` rotates the session: Better Auth's
		// `nextCookies()` after-hook (unconditional — see the module comment on
		// `auth` in src/lib/auth.ts) writes the new session cookie onto this
		// server action's own response, so the caller stays signed in on the
		// fresh session rather than being dumped at the login page. Verified
		// in node_modules/better-auth/dist/integrations/next-js.mjs.
		await auth.api.changePassword({
			body: { currentPassword, newPassword, revokeOtherSessions: true },
			headers: await headers(),
		});
	} catch (error) {
		// Verified in node_modules/@better-auth/core/dist/api/index.mjs +
		// node_modules/.pnpm/better-call@*/dist/error.mjs: a server-side
		// `auth.api.*` call (no `asResponse`) throws the `APIError` rather than
		// returning `{ error }` — that shape is only what the *client* method
		// returns. `error.body.code` carries the machine-readable reason
		// (e.g. "INVALID_PASSWORD"); it is safe to hand back to the caller,
		// which maps it to a sentence-case message rather than showing
		// `error.message` directly.
		if (error instanceof APIError) {
			return { ok: false, error: error.body?.code ?? "unknown" };
		}
		return { ok: false, error: "unknown" };
	}

	// Only reachable once Better Auth has accepted the change above — see the
	// function comment for why that is the point.
	await prisma.user.update({
		where: { id: user.id },
		data: { mustChangePassword: false },
	});
	return { ok: true };
}
