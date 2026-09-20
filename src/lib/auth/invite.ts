import { z } from "zod";
import { type Role, STAFF_ROLES } from "@/lib/auth/permissions";

/**
 * An invite creates staff, and only staff — a CUSTOMER is what public sign-up
 * produces, and offering it here would be the escalation path the whole
 * invite-only model exists to remove.
 */
export const inviteSchema = z.object({
	email: z.email().max(200),
	name: z.string().trim().min(1).max(120),
	role: z.enum(STAFF_ROLES as [Role, ...Role[]]),
	password: z.string().min(12).max(200),
});

export type Invite = z.infer<typeof inviteSchema>;

export const roleChangeSchema = z.object({
	role: z.enum(STAFF_ROLES as [Role, ...Role[]]),
});

/**
 * Two locks, both about not being able to shut yourself out:
 * you cannot change your own role, and the last superadmin cannot be demoted.
 */
export function roleChangeAllowed(input: {
	superadminCount: number;
	isSelf: boolean;
	wasSuperadmin: boolean;
	next: Role;
}): boolean {
	if (input.isSelf) return false;
	if (
		input.wasSuperadmin &&
		input.next !== "SUPERADMIN" &&
		input.superadminCount <= 1
	) {
		return false;
	}
	return true;
}
