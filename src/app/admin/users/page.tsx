import { AdminHeader } from "@/components/admin/AdminHeader";
import { requirePage } from "@/lib/auth/page";
import { prisma } from "@/lib/catalogue/db";
import { InviteStaff } from "./InviteStaff";
import { UsersTable } from "./UsersTable";

export default async function UsersPage() {
	const actor = await requirePage("users:manage");

	const users = await prisma.user.findMany({
		where: { NOT: { role: "CUSTOMER" } },
		select: {
			id: true,
			email: true,
			name: true,
			role: true,
			disabled: true,
			lastLoginAt: true,
		},
		orderBy: [{ role: "asc" }, { createdAt: "desc" }],
		take: 200,
	});

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader trail={[{ label: "Admin" }, { label: "People" }]} />
			<main className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-7 pt-8 pb-16">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">Team access</h1>
					<p className="text-[13px] text-neutral-500">
						Staff accounts are created here. Anyone who signs in with Google is
						a customer and stays one.
					</p>
				</div>
				<InviteStaff />
				<UsersTable initial={users} selfId={actor.id} />
			</main>
		</div>
	);
}
