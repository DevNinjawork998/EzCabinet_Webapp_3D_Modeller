"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ROLE_LABELS, type Role, STAFF_ROLES } from "@/lib/auth/permissions";

function generatePassword(): string {
	return crypto.randomUUID().slice(0, 16);
}

/**
 * Invite creates staff and only staff. Inviting an email that already has a
 * customer row promotes that row instead — the client's decision that an
 * employee who already used the planner with their own Google account must
 * not be locked out of it — so this shows a different success message and
 * never shows a generated password for that path, because it was never used.
 */
export function InviteStaff() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
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
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-[13px] text-white hover:bg-neutral-800"
			>
				Invite staff
			</button>
			{open && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
					<div className="w-full max-w-[420px] rounded-xl bg-white p-6 shadow-xl">
						{result ? (
							<div className="flex flex-col gap-4">
								<h2 className="font-semibold text-[16px]">
									{result.promoted ? "Role granted" : "Staff account created"}
								</h2>
								{result.promoted ? (
									<p className="text-[13px] text-neutral-600">
										Existing account given the {ROLE_LABELS[role]} role. They
										keep signing in the way they already do.
									</p>
								) : (
									<>
										<p className="text-[13px] text-neutral-600">
											Give this to them in person. It is not shown again.
										</p>
										<code className="block rounded-lg bg-neutral-100 px-3 py-2 text-[13px]">
											{result.password}
										</code>
									</>
								)}
								<button
									type="button"
									onClick={() => {
										reset();
										setOpen(false);
									}}
									className="self-end rounded-lg border border-neutral-300 px-4 py-2 text-[13px] hover:bg-neutral-50"
								>
									Done
								</button>
							</div>
						) : (
							<form onSubmit={submit} className="flex flex-col gap-4">
								<h2 className="font-semibold text-[16px]">Invite staff</h2>
								<label className="flex flex-col gap-1 text-[13px]">
									Email
									<input
										type="email"
										required
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										className="rounded-lg border border-neutral-300 px-3 py-2"
									/>
								</label>
								<label className="flex flex-col gap-1 text-[13px]">
									Name
									<input
										type="text"
										required
										value={name}
										onChange={(e) => setName(e.target.value)}
										className="rounded-lg border border-neutral-300 px-3 py-2"
									/>
								</label>
								<label className="flex flex-col gap-1 text-[13px]">
									Role
									<select
										value={role}
										onChange={(e) => setRole(e.target.value as Role)}
										className="rounded-lg border border-neutral-300 px-3 py-2"
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
											className="flex-1 rounded-lg border border-neutral-300 px-3 py-2"
										/>
										<button
											type="button"
											onClick={() => setPassword(generatePassword())}
											className="rounded-lg border border-neutral-300 px-3 py-2 text-[13px] hover:bg-neutral-50"
										>
											Generate
										</button>
									</div>
									<span className="text-[12px] text-neutral-500">
										Ignored if the email already has an account.
									</span>
								</label>
								{error && <p className="text-[13px] text-red-600">{error}</p>}
								<div className="flex justify-end gap-2">
									<button
										type="button"
										onClick={() => {
											reset();
											setOpen(false);
										}}
										className="rounded-lg border border-neutral-300 px-4 py-2 text-[13px] hover:bg-neutral-50"
									>
										Cancel
									</button>
									<button
										type="submit"
										disabled={submitting}
										className="rounded-lg bg-neutral-900 px-4 py-2 font-medium text-[13px] text-white hover:bg-neutral-800"
									>
										{submitting ? "Inviting…" : "Invite"}
									</button>
								</div>
							</form>
						)}
					</div>
				</div>
			)}
		</>
	);
}
