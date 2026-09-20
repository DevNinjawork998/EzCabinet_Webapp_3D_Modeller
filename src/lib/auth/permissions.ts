/**
 * The whole access model, as one table of constants.
 *
 * Pure — no imports, no database, no React. A role's permissions are a
 * compile-time fact, not a row somebody can edit, which is what keeps every
 * gate a cheap array lookup and this file's test the specification.
 *
 * `catalogue:publish` is deliberately separate from `catalogue:write`:
 * publishing rewrites the live price list for every customer, so onboarding a
 * design and repointing the money are different acts.
 */

export const PERMISSIONS = [
	"catalogue:read",
	"catalogue:write",
	"catalogue:publish",
	"orders:read",
	"orders:markPaid",
	"logistics:read",
	"logistics:book",
	"content:write",
	"users:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
	"SUPERADMIN",
	"ADMIN",
	"SALES",
	"CATALOGUE",
	"CUSTOMER",
] as const;

export type Role = (typeof ROLES)[number];

const ADMIN_PERMISSIONS = PERMISSIONS.filter(
	(permission) => permission !== "users:manage",
);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
	SUPERADMIN: PERMISSIONS,
	ADMIN: ADMIN_PERMISSIONS,
	SALES: [
		"orders:read",
		"orders:markPaid",
		"logistics:read",
		"logistics:book",
		"catalogue:read",
	],
	CATALOGUE: [
		"catalogue:read",
		"catalogue:write",
		"catalogue:publish",
		"content:write",
	],
	// A customer owns their own designs and orders. That is ownership, not an
	// admin permission, and it is checked where those rows are read.
	CUSTOMER: [],
};

/** Every role that can reach the admin surface at all. */
export const STAFF_ROLES: readonly Role[] = ROLES.filter(
	(role) => ROLE_PERMISSIONS[role].length > 0,
);

export function can(role: Role, permission: Permission): boolean {
	return ROLE_PERMISSIONS[role].includes(permission);
}

/** Human labels for the role picker on /admin/users. Sentence case. */
export const ROLE_LABELS: Record<Role, string> = {
	SUPERADMIN: "Superadmin",
	ADMIN: "Admin",
	SALES: "Sales",
	CATALOGUE: "Catalogue",
	CUSTOMER: "Customer",
};
