import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/catalogue/db";

/**
 * Two doors that never cross.
 *
 * Customers arrive through Google. Staff arrive through email and password,
 * on an account a superadmin created for them — public sign-up can only ever
 * produce a CUSTOMER, so there is no code path by which a customer account
 * becomes staff.
 *
 * `input: false` on every field below is the load-bearing line. Without it a
 * crafted sign-up body could post its own `role`, and the whole model is one
 * POST away from being decorative. Do not relax it to make a form easier.
 *
 * A server-side call to `auth.api.signUpEmail(...)` (Tasks 7 and 8, staff
 * invites) must pass `asResponse: true` and discard the returned `Response`.
 * `nextCookies()` below attaches `Set-Cookie` from any server-side auth API
 * call onto the ambient response; without `asResponse` a superadmin creating
 * a staff account would be silently signed in as the account they just
 * created.
 */
export const auth = betterAuth({
	database: prismaAdapter(prisma, { provider: "postgresql" }),
	emailAndPassword: {
		enabled: true,
		// No reset mail: three internal users in one office, and the superadmin
		// sets the initial password by hand. Adding self-serve reset means
		// adding an email vendor.
	},
	socialProviders: {
		google: {
			clientId: process.env.GOOGLE_CLIENT_ID ?? "",
			clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
		},
	},
	user: {
		additionalFields: {
			role: { type: "string", input: false, defaultValue: "CUSTOMER" },
			disabled: { type: "boolean", input: false, defaultValue: false },
			mustChangePassword: {
				type: "boolean",
				input: false,
				defaultValue: false,
			},
			invitedById: { type: "string", input: false, required: false },
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7,
		// Off deliberately. A cached session would carry a stale role for its
		// lifetime, and the spec requires a role change or a disable to bite on
		// the very next request.
		cookieCache: { enabled: false },
	},
	plugins: [nextCookies()],
});
