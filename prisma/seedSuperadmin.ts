import { auth } from "@/lib/auth";
import { prisma } from "@/lib/catalogue/db";

/**
 * The bootstrap: there is no superadmin, so there is nobody to invite one.
 *
 * Refuses to run when a superadmin already exists. That is not politeness —
 * it stops a re-run during a deploy from silently resetting the password of
 * the account that holds every permission in the app.
 */
async function main() {
	const email = process.env.SUPERADMIN_EMAIL;
	const password = process.env.SUPERADMIN_PASSWORD;
	if (!email || !password) {
		throw new Error("SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD must be set");
	}
	if (password.length < 12) {
		throw new Error("SUPERADMIN_PASSWORD must be at least 12 characters");
	}

	const existing = await prisma.user.count({ where: { role: "SUPERADMIN" } });
	if (existing > 0) {
		console.log(`A superadmin already exists (${existing}). Nothing to do.`);
		return;
	}

	const already = await prisma.user.findUnique({ where: { email } });
	if (already) {
		await prisma.user.update({
			where: { email },
			data: { role: "SUPERADMIN", emailVerified: true, disabled: false },
		});
		console.log(`Promoted ${email} to SUPERADMIN.`);
		return;
	}

	await auth.api.signUpEmail({
		body: { email, name: "Superadmin", password },
		asResponse: true,
	});
	const created = await prisma.user.findUnique({ where: { email } });
	if (!created) throw new Error("sign-up failed");

	await prisma.user.update({
		where: { id: created.id },
		data: { role: "SUPERADMIN", emailVerified: true, mustChangePassword: true },
	});
	console.log(`Created ${email} as SUPERADMIN.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
