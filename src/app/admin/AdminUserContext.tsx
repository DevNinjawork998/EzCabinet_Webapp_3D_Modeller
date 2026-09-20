"use client";

import { createContext, useContext } from "react";

/**
 * The signed-in staff member's display name, read once in the (server)
 * layout via `currentUser()` and handed down to `AdminHeader` — a client
 * component rendered per admin page, not by the layout itself — so it can
 * show who is signed in next to the sign-out control without querying the
 * database itself.
 */
const AdminUserContext = createContext<string | null>(null);

export function AdminUserProvider({
	name,
	children,
}: {
	name: string | null;
	children: React.ReactNode;
}) {
	return (
		<AdminUserContext.Provider value={name}>
			{children}
		</AdminUserContext.Provider>
	);
}

export function useAdminUserName(): string | null {
	return useContext(AdminUserContext);
}
