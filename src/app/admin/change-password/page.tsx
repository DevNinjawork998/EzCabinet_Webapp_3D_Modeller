import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { ChangePasswordForm } from "./ChangePasswordForm";

/**
 * Deliberately does not call `requirePage`/`requireAuth`: those now redirect
 * a user with `mustChangePassword` set straight back to this page, which
 * would be an infinite redirect. `currentUser()` is the same session read
 * without that check.
 */
export default async function ChangePasswordPage() {
	const user = await currentUser();
	if (!user) redirect("/admin/login");

	return (
		<main className="flex min-h-screen items-center justify-center bg-[#f4f3f1] p-6 text-neutral-900">
			<div className="w-full max-w-[380px] rounded-2xl border border-[#e4e2df] bg-white p-8">
				<h1 className="font-semibold text-[19px]">Change your password</h1>
				<p className="mt-1.5 text-neutral-500 text-sm">
					You're signing in with a password someone else set. Choose one only
					you know before continuing.
				</p>
				<ChangePasswordForm />
			</div>
		</main>
	);
}
