import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import type { Role } from "@/lib/auth/permissions";
import { prisma } from "@/lib/catalogue/db";

export type AuthUser = {
	id: string;
	email: string;
	name: string;
	image: string | null;
	role: Role;
	disabled: boolean;
	mustChangePassword: boolean;
};

/**
 * The signed-in user, read fresh from the database on every call.
 *
 * The session token carries no role. Reading the row is what makes a role
 * change, or an offboarding, take effect on the next request rather than
 * whenever a week-long session happens to expire.
 */
export async function currentUser(): Promise<AuthUser | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user?.id) return null;

	const user = await prisma.user.findUnique({
		where: { id: session.user.id },
		select: {
			id: true,
			email: true,
			name: true,
			image: true,
			role: true,
			disabled: true,
			mustChangePassword: true,
		},
	});
	if (!user || user.disabled) return null;
	return user as AuthUser;
}
