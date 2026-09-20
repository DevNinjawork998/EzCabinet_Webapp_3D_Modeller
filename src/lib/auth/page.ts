import "server-only";
import { notFound, redirect } from "next/navigation";
import { AuthError, requireAuth } from "@/lib/auth/requireAuth";
import type { Permission } from "@/lib/auth/permissions";

/**
 * The page-boundary twin of `withAuth`: a server component calls this at the
 * top of its body instead of `requireAuth` directly, so an `AuthError`
 * becomes a redirect or a 404 rather than an uncaught throw surfacing as a
 * 500.
 */
export async function requirePage(permission: Permission) {
	try {
		return await requireAuth(permission);
	} catch (error) {
		if (error instanceof AuthError && error.status === 401) {
			redirect("/admin/login");
		}
		notFound();
	}
}
