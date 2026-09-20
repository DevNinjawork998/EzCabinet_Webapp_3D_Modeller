"use server";

import { currentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/catalogue/db";

/**
 * Clears the caller's own `mustChangePassword` flag.
 *
 * Deliberately not gated by `requirePage`/`requireAuth`: a user who must
 * change their password is refused by both, so gating this the same way
 * would make the flag unclearable. It calls `currentUser()` directly instead
 * — the same session check the change-password page itself uses — which
 * still requires a valid, non-disabled session for the account being
 * updated, and it only ever touches that caller's own row (`session.id`,
 * never a client-supplied id).
 *
 * The client only calls this after `authClient.changePassword` has already
 * returned success, which requires the account's *current* password — so in
 * the intended flow this only fires once the handed-over password has
 * actually been replaced. A signed-in user could in principle call this
 * action without changing their password first and skip the nag; that is a
 * self-service downgrade of their own account's hygiene, not a privilege
 * escalation, since it requires a valid session for that exact account —
 * which is exactly the access level needed to open the change-password
 * screen in the first place.
 */
export async function clearMustChangePassword(): Promise<void> {
	const user = await currentUser();
	if (!user) return;
	await prisma.user.update({
		where: { id: user.id },
		data: { mustChangePassword: false },
	});
}
