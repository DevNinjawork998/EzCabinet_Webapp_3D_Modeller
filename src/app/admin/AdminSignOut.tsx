"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export function AdminSignOut({ name }: { name: string }) {
	const router = useRouter();
	return (
		<button
			type="button"
			onClick={async () => {
				await authClient.signOut();
				router.push("/admin/login");
			}}
			className="text-neutral-500 text-xs hover:text-neutral-900"
		>
			{name} · Sign out
		</button>
	);
}
