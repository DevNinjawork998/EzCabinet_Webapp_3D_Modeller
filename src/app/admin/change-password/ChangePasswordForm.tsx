"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { changeOwnPassword } from "./actions";

const MIN_LENGTH = 12;

/** A message safe to show a customer — never the provider's own wording. */
function messageFor(code: string): string {
	if (code === "INVALID_PASSWORD") return "Current password is incorrect.";
	if (code === "PASSWORD_TOO_SHORT")
		return `New password must be at least ${MIN_LENGTH} characters.`;
	return "Could not change password. Try again.";
}

export function ChangePasswordForm() {
	const router = useRouter();
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit() {
		setError(null);

		if (newPassword.length < MIN_LENGTH) {
			setError(`New password must be at least ${MIN_LENGTH} characters.`);
			return;
		}
		if (newPassword !== confirmPassword) {
			setError("Passwords don't match.");
			return;
		}

		setBusy(true);
		try {
			const result = await changeOwnPassword(currentPassword, newPassword);
			if (!result.ok) {
				setError(messageFor(result.error));
				setBusy(false);
				return;
			}
			router.push("/admin/cabinet-designs");
		} catch {
			setError("Could not change password. Try again.");
			setBusy(false);
		}
	}

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
			className="mt-6 flex flex-col gap-4"
		>
			<label className="flex flex-col gap-1.5">
				<span className="font-medium text-neutral-700 text-xs">
					Current password
				</span>
				<input
					type="password"
					value={currentPassword}
					onChange={(e) => setCurrentPassword(e.target.value)}
					placeholder="The password you were given"
					autoComplete="current-password"
					className="min-h-10 rounded-[9px] border border-[#d4d4d4] px-3.5 py-2.5 text-sm"
				/>
			</label>

			<label className="flex flex-col gap-1.5">
				<span className="font-medium text-neutral-700 text-xs">
					New password
				</span>
				<input
					type="password"
					value={newPassword}
					onChange={(e) => setNewPassword(e.target.value)}
					autoComplete="new-password"
					className="min-h-10 rounded-[9px] border border-[#d4d4d4] px-3.5 py-2.5 text-sm"
				/>
				<span className="text-neutral-400 text-xs">
					At least {MIN_LENGTH} characters.
				</span>
			</label>

			<label className="flex flex-col gap-1.5">
				<span className="font-medium text-neutral-700 text-xs">
					Confirm new password
				</span>
				<input
					type="password"
					value={confirmPassword}
					onChange={(e) => setConfirmPassword(e.target.value)}
					autoComplete="new-password"
					className="min-h-10 rounded-[9px] border border-[#d4d4d4] px-3.5 py-2.5 text-sm"
				/>
			</label>

			{error && (
				<p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-red-900 text-sm">
					{error}
				</p>
			)}

			<button
				type="submit"
				disabled={busy}
				className="min-h-10 rounded-[9px] bg-neutral-900 font-medium text-sm text-white disabled:opacity-60"
			>
				{busy ? "Changing…" : "Change password"}
			</button>
		</form>
	);
}
