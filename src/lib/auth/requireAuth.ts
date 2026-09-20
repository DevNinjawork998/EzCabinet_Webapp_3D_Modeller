import "server-only";
import { authEnabled } from "@/lib/auth/enabled";
import { can, type Permission } from "@/lib/auth/permissions";
import { type AuthUser, currentUser } from "@/lib/auth/session";

export class AuthError extends Error {
	constructor(readonly status: 401 | 403 | 404) {
		super(`auth_${status}`);
		this.name = "AuthError";
	}
}

/** Who the app thinks you are when AUTH_ENABLED is off. Never persisted. */
export const BYPASS_USER: AuthUser = {
	id: "auth-disabled",
	email: "auth-disabled@localhost",
	name: "Auth disabled",
	image: null,
	role: "SUPERADMIN",
	disabled: false,
	mustChangePassword: false,
};

/**
 * The access boundary. `proxy.ts` only redirects; this is the check that
 * counts, and every admin page and route handler must call it.
 *
 * A customer gets 404 rather than 403: a 403 confirms the surface is there.
 * A staff member missing one permission gets 403, because they already know
 * the admin area exists and a 404 would just be confusing.
 */
export async function requireAuth(permission: Permission): Promise<AuthUser> {
	if (!authEnabled()) return BYPASS_USER;

	const user = await currentUser();
	if (!user) throw new AuthError(401);
	if (user.role === "CUSTOMER") throw new AuthError(404);
	if (!can(user.role, permission)) throw new AuthError(403);
	return user;
}
