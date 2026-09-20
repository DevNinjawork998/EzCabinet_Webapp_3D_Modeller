"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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

type StatusFilter = "all" | "active" | "suspended";

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
	all: "All",
	active: "Active",
	suspended: "Suspended",
};

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0]?.[0] ?? "";
	const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
	return (first + second).toUpperCase();
}

/**
 * Staff only, always: this screen exists to hand out and revoke admin
 * power, so the list never widens to real customers — the one colleague on
 * screen would otherwise be a needle in that haystack.
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
	const [status, setStatus] = useState<StatusFilter>("all");
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const reload = useCallback(async (q: string) => {
		const params = new URLSearchParams({ staff: "1" });
		if (q) params.set("q", q);
		const res = await fetch(`/api/admin/users?${params.toString()}`);
		if (!res.ok) return;
		const data = await res.json();
		setUsers(data.users);
	}, []);

	useEffect(() => {
		reload(query);
	}, [query, reload]);

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
		await reload(query);
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
		await reload(query);
		router.refresh();
	}

	const counts = useMemo(
		() => ({
			all: users.length,
			active: users.filter((u) => !u.disabled).length,
			suspended: users.filter((u) => u.disabled).length,
		}),
		[users],
	);

	const shown = useMemo(
		() =>
			users.filter((u) => {
				if (status === "active") return !u.disabled;
				if (status === "suspended") return u.disabled;
				return true;
			}),
		[users, status],
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap gap-2">
					{(["all", "active", "suspended"] as const).map((f) => (
						<button
							key={f}
							type="button"
							aria-pressed={status === f}
							onClick={() => setStatus(f)}
							className={`rounded-full border px-3 py-1.5 text-[13px] ${
								status === f
									? "border-[#1f5138] bg-[#1f5138]/10 font-medium text-[#1f5138]"
									: "border-[#e5e5e5] text-neutral-600 hover:bg-neutral-50"
							}`}
						>
							{STATUS_FILTER_LABEL[f]} ({counts[f]})
						</button>
					))}
				</div>
				<div className="min-w-[220px] flex-1 sm:max-w-[280px]">
					<label htmlFor="user-search" className="sr-only">
						Search by name or email
					</label>
					<input
						id="user-search"
						type="search"
						placeholder="Search by name or email"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-[13px]"
					/>
				</div>
			</div>

			{error && <p className="text-[13px] text-[#7f1d1d]">{error}</p>}

			<div className="overflow-hidden rounded-[14px] border border-[#e5e5e5] bg-white">
				<div className="grid grid-cols-[1fr_150px_140px_110px] items-center gap-3 border-[#e5e5e5] border-b bg-[#f7f6f4] px-4 py-2.5 font-semibold text-[11px] text-neutral-500 uppercase tracking-wide">
					<span>Member</span>
					<span>Role</span>
					<span>Last active</span>
					<span className="text-right">Actions</span>
				</div>
				<ul>
					{shown.map((user) => {
						const isSelf = user.id === selfId;
						return (
							<li
								key={user.id}
								className="grid grid-cols-[1fr_150px_140px_110px] items-center gap-3 border-[#e5e5e5] border-b px-4 py-3 last:border-b-0"
							>
								<div className="flex min-w-0 items-center gap-3">
									<span
										aria-hidden="true"
										className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1f5138]/10 font-semibold text-[12px] text-[#1f5138]"
									>
										{initialsOf(user.name)}
									</span>
									<span className="min-w-0">
										<span className="flex flex-wrap items-center gap-1.5">
											<span className="truncate font-medium text-[14px]">
												{user.name}
											</span>
											{isSelf && (
												<span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-[11px] text-neutral-500">
													you
												</span>
											)}
											<span
												className={`rounded-full px-2 py-0.5 font-medium text-[11px] ${
													user.disabled
														? "bg-[#7f1d1d]/10 text-[#7f1d1d]"
														: "bg-[#1f5138]/10 text-[#1f5138]"
												}`}
											>
												{user.disabled ? "Suspended" : "Active"}
											</span>
										</span>
										<span className="block truncate text-[12px] text-neutral-500">
											{user.email}
										</span>
									</span>
								</div>
								<label className="sr-only" htmlFor={`role-${user.id}`}>
									Role for {user.name}
								</label>
								<select
									id={`role-${user.id}`}
									value={user.role}
									disabled={isSelf || busyId === user.id}
									title={isSelf ? "You can't change your own role" : undefined}
									onChange={(e) => changeRole(user.id, e.target.value as Role)}
									className="w-fit rounded-lg border border-[#e5e5e5] px-2 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
								>
									{STAFF_ROLES.map((role) => (
										<option key={role} value={role}>
											{ROLE_LABELS[role]}
										</option>
									))}
								</select>
								<span className="text-[12px] text-neutral-500">
									{user.lastLoginAt
										? `Last in ${shortTime(new Date(user.lastLoginAt).toISOString())}`
										: "Never signed in"}
								</span>
								<div className="flex justify-end">
									<button
										type="button"
										aria-label={
											isSelf
												? "You can't suspend yourself"
												: user.disabled
													? `Restore ${user.name}`
													: `Suspend ${user.name}`
										}
										disabled={isSelf || busyId === user.id}
										title={isSelf ? "You can't disable yourself" : undefined}
										onClick={() => toggleDisabled(user.id, !user.disabled)}
										className="rounded-full border border-[#e5e5e5] px-3 py-1.5 text-[13px] hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
									>
										{user.disabled ? "Restore" : "Suspend"}
									</button>
								</div>
							</li>
						);
					})}
					{shown.length === 0 && (
						<li className="px-4 py-8 text-center text-[13px] text-neutral-500">
							No member matches that.
						</li>
					)}
				</ul>
			</div>

			<p className="text-[12px] text-neutral-500">
				Showing {shown.length} of {users.length} members
			</p>
		</div>
	);
}
