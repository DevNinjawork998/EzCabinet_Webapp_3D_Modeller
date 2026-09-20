"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ROLE_LABELS, type Role, STAFF_ROLES } from "@/lib/auth/permissions";

function generatePassword(): string {
	return crypto.randomUUID().slice(0, 16);
}

/** One sentence per staff role, shown under the invite row as it changes. */
const ROLE_HINTS: Record<Role, string> = {
	SUPERADMIN: "Full access, including managing people.",
	ADMIN: "Everything except managing people.",
	CUSTOMER: "",
};

/**
 * Invite creates staff and only staff. Inviting an email that already has a
 * customer row promotes that row instead — the client's decision that an
 * employee who already used the planner with their own Google account must
 * not be locked out of it — so this shows a different success message and
 * never shows a generated password for that path, because it was never used.
 *
 * Inline card, not a dialog: the invite-a-member form sits above the table
 * so a superadmin never leaves the page to add someone.
 */
export function InviteStaff() {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState<Role>(STAFF_ROLES[STAFF_ROLES.length - 1]);
	const [password, setPassword] = useState(generatePassword());
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<{
		promoted: boolean;
		password: string;
	} | null>(null);
	const [submitting, setSubmitting] = useState(false);

	function reset() {
		setEmail("");
		setName("");
		setRole(STAFF_ROLES[STAFF_ROLES.length - 1]);
		setPassword(generatePassword());
		setError(null);
		setResult(null);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		const res = await fetch("/api/admin/users", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, name, role, password }),
		});
		setSubmitting(false);
		if (!res.ok) {
			const data = await res.json().catch(() => null);
			setError(
				data?.error === "already_staff"
					? "That email already has a staff account."
					: "Could not create that account.",
			);
			return;
		}
		const data = await res.json();
		setResult({ promoted: Boolean(data.promoted), password });
		router.refresh();
	}

	return (
		<div className="rounded-[14px] border border-[#e5e5e5] bg-white p-5">
			<p className="mb-3 font-semibold text-[11px] text-neutral-500 uppercase tracking-wide">
				Invite a member
			</p>
			{result ? (
				<div className="flex flex-col gap-3">
					{result.promoted ? (
						<p className="text-[13px] text-[#1f5138]">
							Role granted. Existing account given the {ROLE_LABELS[role]} role.
							They keep signing in the way they already do.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<p className="text-[13px] text-[#1f5138]">
								Staff account created. Give this password to them in person — it
								is not shown again.
							</p>
							<code className="block w-fit rounded-lg bg-neutral-100 px-3 py-2 text-[13px]">
								{result.password}
							</code>
						</div>
					)}
					<button
						type="button"
						onClick={reset}
						className="self-start rounded-full border border-[#e5e5e5] px-4 py-2 text-[13px] hover:bg-neutral-50"
					>
						Invite another
					</button>
				</div>
			) : (
				<form onSubmit={submit} className="flex flex-col gap-3">
					<div className="flex flex-wrap items-end gap-3">
						<label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px]">
							Work email
							<input
								type="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="rounded-lg border border-[#e5e5e5] px-3 py-2"
							/>
						</label>
						<label className="flex min-w-[160px] flex-col gap-1 text-[13px]">
							Name
							<input
								type="text"
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="rounded-lg border border-[#e5e5e5] px-3 py-2"
							/>
						</label>
						<label className="flex flex-col gap-1 text-[13px]">
							Role
							<select
								value={role}
								onChange={(e) => setRole(e.target.value as Role)}
								className="rounded-lg border border-[#e5e5e5] px-3 py-2"
							>
								{STAFF_ROLES.map((r) => (
									<option key={r} value={r}>
										{ROLE_LABELS[r]}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1 text-[13px]">
							Password
							<div className="flex gap-2">
								<input
									type="text"
									required
									minLength={12}
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="w-[160px] rounded-lg border border-[#e5e5e5] px-3 py-2"
								/>
								<button
									type="button"
									onClick={() => setPassword(generatePassword())}
									className="rounded-lg border border-[#e5e5e5] px-3 py-2 text-[13px] hover:bg-neutral-50"
								>
									Generate
								</button>
							</div>
						</label>
						<button
							type="submit"
							disabled={submitting}
							className="rounded-full bg-[#1f5138] px-5 py-2.5 font-medium text-[13px] text-white hover:bg-[#193f2c] disabled:cursor-not-allowed disabled:opacity-50"
						>
							{submitting ? "Inviting…" : "Invite"}
						</button>
					</div>
					<p className="text-[12px] text-neutral-500">{ROLE_HINTS[role]}</p>
					{error && <p className="text-[13px] text-[#7f1d1d]">{error}</p>}
				</form>
			)}
		</div>
	);
}
