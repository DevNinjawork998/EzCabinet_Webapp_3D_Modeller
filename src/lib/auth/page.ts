import "server-only";
import { notFound, redirect } from "next/navigation";
import type { Permission } from "@/lib/auth/permissions";
import { AuthError, requireAuth } from "@/lib/auth/requireAuth";

/**
 * The page-boundary twin of `withAuth`: a server component calls this at the
 * top of its body instead of `requireAuth` directly, so an `AuthError`
 * becomes a redirect or a 404 rather than an uncaught throw surfacing as a
 * 500.
 */
export async function requirePage(permission: Permission) {
	try {
		const user = await requireAuth(permission);
		// A generated or handed-over password must not become permanent. This
		// check lives here rather than in `requireAuth` because the
		// change-password page itself calls `currentUser()` directly, not
		// `requirePage` — putting the redirect in the shared boundary would
		// make that page redirect to itself.
		if (user.mustChangePassword) redirect("/admin/change-password");
		return user;
	} catch (error) {
		if (error instanceof AuthError && error.status === 401) {
			redirect("/admin/login");
		}
		if (!(error instanceof AuthError)) throw error;
		notFound();
	}
}
