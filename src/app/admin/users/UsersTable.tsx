"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ROLE_LABELS, type Role, STAFF_ROLES } from "@/lib/auth/permissions";
import { shortTime } from "../logistics/time";

type UserRow = {
	id: string;
	email: string;
	name: string;
	role: Role;
	disabled: boolean;
	lastLoginAt: Date | string | null;
};

/**
 * Staff only, by default: without it the list fills with real customers and
 * the one colleague on the screen is a needle in that haystack.
 */
export function UsersTable({
	initial,
	selfId,
}: {
	initial: UserRow[];
	selfId: string;
}) {
	const router = useRouter();
	const [users, setUsers] = useState(initial);
	const [staffOnly, setStaffOnly] = useState(true);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const reload = useCallback(async (staff: boolean, q: string) => {
		const params = new URLSearchParams();
		if (staff) params.set("staff", "1");
		if (q) params.set("q", q);
		const res = await fetch(`/api/admin/users?${params.toString()}`);
		if (!res.ok) return;
		const data = await res.json();
		setUsers(data.users);
	}, []);

	useEffect(() => {
		reload(staffOnly, query);
	}, [staffOnly, query, reload]);

	async function changeRole(id: string, role: Role) {
		setError(null);
		setBusyId(id);
		const res = await fetch(`/api/admin/users/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role }),
		});
		setBusyId(null);
		if (!res.ok) {
			setError(
				res.status === 409
					? "That change isn't allowed — you can't change your own role, and the last superadmin can't be demoted."
					: "Could not change the role.",
			);
			return;
		}
		await reload(staffOnly, query);
		router.refresh();
	}

	async function toggleDisabled(id: string, disabled: boolean) {
		setError(null);
		setBusyId(id);
		const res = await fetch(`/api/admin/users/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ disabled }),
		});
		setBusyId(null);
		if (!res.ok) {
			setError(
				res.status === 409
					? "You can't disable yourself."
					: "Could not update that account.",
			);
			return;
		}
		await reload(staffOnly, query);
		router.refresh();
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-2 text-[13px] text-neutral-700">
					<input
						type="checkbox"
						checked={staffOnly}
						onChange={(e) => setStaffOnly(e.target.checked)}
					/>
					Staff only
				</label>
				<input
					type="search"
					placeholder="Search by name or email"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="min-w-[220px] flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-[13px]"
				/>
			</div>

			{error && <p className="text-[13px] text-red-600">{error}</p>}

			<ul className="flex flex-col gap-2">
				{users.map((user) => {
					const isSelf = user.id === selfId;
					return (
						<li
							key={user.id}
							className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3"
						>
							<span className="min-w-[180px] flex-1">
								<span className="block font-medium text-[14px]">
									{user.name}
									{isSelf && (
										<span className="ml-1.5 font-normal text-[11px] text-neutral-400">
											(you)
										</span>
									)}
								</span>
								<span className="block text-[12px] text-neutral-500">
									{user.email}
								</span>
							</span>
							<span className="w-[140px] shrink-0 text-[12px] text-neutral-500">
								{user.lastLoginAt
									? `Last in ${shortTime(new Date(user.lastLoginAt).toISOString())}`
									: "Never signed in"}
							</span>
							{user.role === "CUSTOMER" ? (
								<span className="text-[13px] text-neutral-500">Customer</span>
							) : (
								<select
									value={user.role}
									disabled={isSelf || busyId === user.id}
									title={isSelf ? "You can't change your own role" : undefined}
									onChange={(e) => changeRole(user.id, e.target.value as Role)}
									className="rounded-lg border border-neutral-300 px-2 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
								>
									{STAFF_ROLES.map((role) => (
										<option key={role} value={role}>
											{ROLE_LABELS[role]}
										</option>
									))}
								</select>
							)}
							{user.disabled && (
								<span className="rounded-full bg-red-100 px-2.5 py-1 font-medium text-[11px] text-red-700">
									Disabled
								</span>
							)}
							{user.role !== "CUSTOMER" && (
								<button
									type="button"
									disabled={isSelf || busyId === user.id}
									title={isSelf ? "You can't disable yourself" : undefined}
									onClick={() => toggleDisabled(user.id, !user.disabled)}
									className="rounded-lg border border-neutral-300 px-3 py-1.5 text-[13px] hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
								>
									{user.disabled ? "Enable" : "Disable"}
								</button>
							)}
						</li>
					);
				})}
				{users.length === 0 && (
					<p className="rounded-xl border border-neutral-200 bg-white px-4 py-8 text-center text-[13px] text-neutral-500">
						No accounts match.
					</p>
				)}
			</ul>
		</div>
	);
}
