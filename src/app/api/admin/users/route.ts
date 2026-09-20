import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { inviteSchema } from "@/lib/auth/invite";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";

export const runtime = "nodejs";

export const GET = withAuth("users:manage", async (request) => {
	const url = new URL(request.url);
	const staffOnly = url.searchParams.get("staff") === "1";
	const search = url.searchParams.get("q")?.trim() ?? "";

	const users = await prisma.user.findMany({
		where: {
			...(staffOnly ? { NOT: { role: "CUSTOMER" } } : {}),
			...(search
				? {
						OR: [
							{ email: { contains: search, mode: "insensitive" as const } },
							{ name: { contains: search, mode: "insensitive" as const } },
						],
					}
				: {}),
		},
		select: {
			id: true,
			email: true,
			name: true,
			role: true,
			disabled: true,
			lastLoginAt: true,
			createdAt: true,
		},
		orderBy: [{ role: "asc" }, { createdAt: "desc" }],
		take: 200,
	});
	return NextResponse.json({ users });
});

/**
 * Invite: the superadmin creates the account and sets its first password,
 * handed over in person. No email is sent, because sending one means running
 * an email vendor for three internal users.
 */
export const POST = withAuth("users:manage", async (request, _ctx, actor) => {
	const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const { email, name, role, password } = parsed.data;
	const invitedById = actor.id === "auth-disabled" ? null : actor.id;

	const existing = await prisma.user.findUnique({ where: { email } });
	if (existing) {
		// Not self-service escalation: this is a superadmin deliberately
		// granting a role on /admin/users, gated by users:manage. The account
		// keeps whatever sign-in it already has — if they arrived through
		// Google there is no password to set, and the `password` field of this
		// form is ignored.
		if (existing.role !== "CUSTOMER") {
			return NextResponse.json({ error: "already_staff" }, { status: 409 });
		}
		await prisma.user.update({
			where: { id: existing.id },
			data: { role, invitedById },
		});
		return NextResponse.json({ ok: true, id: existing.id, promoted: true });
	}

	// Better Auth owns password hashing and the credential Account row, so the
	// invite goes through its own sign-up rather than writing a hash by hand.
	// `asResponse: true` keeps `nextCookies()` from attaching the new
	// account's Set-Cookie onto this response — otherwise the superadmin
	// pressing "Invite" would be signed in as the person they just invited.
	await auth.api.signUpEmail({
		body: { email, name, password },
		asResponse: true,
	});

	const created = await prisma.user.findUnique({ where: { email } });
	if (!created) {
		return NextResponse.json({ error: "create_failed" }, { status: 500 });
	}

	// The role is set here, never by the sign-up body — `input: false` in the
	// auth config is what makes that the only possible path. `emailVerified`
	// is set true because staff sign in with Google, and Better Auth refuses
	// to link a Google account to an unverified row; we send no verification
	// mail, so this is the only way it is ever true. Typing a colleague's work
	// email here is the assertion that the address is theirs.
	await prisma.user.update({
		where: { id: created.id },
		data: {
			role,
			emailVerified: true,
			mustChangePassword: true,
			invitedById,
		},
	});

	return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
});
