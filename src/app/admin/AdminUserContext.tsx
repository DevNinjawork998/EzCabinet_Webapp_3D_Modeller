"use client";

import { createContext, useContext } from "react";
import type { Role } from "@/lib/auth/permissions";

/**
 * The signed-in staff member's name and role, read once in the (server)
 * layout via `currentUser()` and handed down to `AdminHeader` — a client
 * component rendered per admin page, not by the layout itself — so it can
 * show who is signed in next to the sign-out control, and gate the People
 * nav tab to superadmins, without querying the database itself.
 */
const AdminUserContext = createContext<{
	name: string | null;
	role: Role | null;
}>({ name: null, role: null });

export function AdminUserProvider({
	name,
	role,
	children,
}: {
	name: string | null;
	role: Role | null;
	children: React.ReactNode;
}) {
	return (
		<AdminUserContext.Provider value={{ name, role }}>
			{children}
		</AdminUserContext.Provider>
	);
}

export function useAdminUserName(): string | null {
	return useContext(AdminUserContext).name;
}

export function useAdminUserRole(): Role | null {
	return useContext(AdminUserContext).role;
}
