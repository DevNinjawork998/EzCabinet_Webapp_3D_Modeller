import "server-only";
import { headers } from "next/headers";
import type { $Enums } from "@/generated/prisma/client";
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

/** Compile-time proof that our Role union and Prisma's generated enum agree.
 *  If either gains a role the other lacks, this stops compiling — which is
 *  the point: the alternative is ROLE_PERMISSIONS[role] being undefined
 *  inside a permission check at runtime. */
type RoleParity = Role extends $Enums.Role
	? $Enums.Role extends Role
		? true
		: never
	: never;
const _roleParity: RoleParity = true;
void _roleParity;

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
	return user;
}
