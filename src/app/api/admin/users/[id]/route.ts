import { NextResponse } from "next/server";
import { z } from "zod";
import { roleChangeAllowed, roleChangeSchema } from "@/lib/auth/invite";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";

export const runtime = "nodejs";

const patchSchema = z.union([
	roleChangeSchema,
	z.object({ disabled: z.boolean() }),
]);

export const PATCH = withAuth<{ params: Promise<{ id: string }> }>(
	"users:manage",
	async (request, { params }, actor) => {
		const { id } = await params;
		const parsed = patchSchema.safeParse(
			await request.json().catch(() => null),
		);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		const target = await prisma.user.findUnique({
			where: { id },
			select: { id: true, role: true },
		});
		if (!target) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		const isSelf = target.id === actor.id;

		if ("disabled" in parsed.data) {
			if (isSelf) {
				return NextResponse.json({ error: "not_yourself" }, { status: 409 });
			}
			await prisma.user.update({
				where: { id },
				data: { disabled: parsed.data.disabled },
			});
			// Sessions carry no role, but a disabled user must lose theirs now
			// rather than at the end of the week they were issued for.
			if (parsed.data.disabled) {
				await prisma.session.deleteMany({ where: { userId: id } });
			}
			return NextResponse.json({ ok: true });
		}

		const superadminCount = await prisma.user.count({
			where: { role: "SUPERADMIN", disabled: false },
		});
		const allowed = roleChangeAllowed({
			superadminCount,
			isSelf,
			wasSuperadmin: target.role === "SUPERADMIN",
			next: parsed.data.role,
		});
		if (!allowed) {
			return NextResponse.json({ error: "not_allowed" }, { status: 409 });
		}

		await prisma.user.update({
			where: { id },
			data: { role: parsed.data.role },
		});
		return NextResponse.json({ ok: true });
	},
);
