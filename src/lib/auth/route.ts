import "server-only";
import { NextResponse } from "next/server";
import type { Permission } from "@/lib/auth/permissions";
import { AuthError, requireAuth } from "@/lib/auth/requireAuth";
import type { AuthUser } from "@/lib/auth/session";

/**
 * Wraps a route handler in its permission check, so the check cannot be
 * forgotten halfway down a handler that already started writing.
 *
 * The second argument is whatever Next passes through — `{ params }` on a
 * dynamic route, nothing on a static one — and is handed on untouched.
 */
export function withAuth<Ctx>(
	permission: Permission,
	handler: (
		request: Request,
		context: Ctx,
		user: AuthUser,
	) => Promise<Response> | Response,
) {
	return async (request: Request, context: Ctx): Promise<Response> => {
		let user: AuthUser;
		try {
			user = await requireAuth(permission);
		} catch (error) {
			if (error instanceof AuthError) {
				return NextResponse.json(
					{ error: error.message },
					{ status: error.status },
				);
			}
			throw error;
		}
		return handler(request, context, user);
	};
}
