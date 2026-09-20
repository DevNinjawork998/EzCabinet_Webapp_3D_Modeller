import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/catalogue/db";

/**
 * One door, gated by who created the row — not by which provider they used.
 *
 * Customers arrive through Google, self-service. Staff sign in with either
 * Google or the password a superadmin set for them, on an account a
 * superadmin created (or promoted from an existing customer row) — public
 * sign-up can only ever produce a CUSTOMER, so there is no code path by
 * which a customer account grants itself a role. A staff row promoted from
 * an existing customer keeps only the sign-in it already had (Google), since
 * the promotion sets no password — see `POST /api/admin/users`.
 *
 * `input: false` on every field below is the load-bearing line. Without it a
 * crafted sign-up body could post its own `role`, and the whole model is one
 * POST away from being decorative. Do not relax it to make a form easier.
 *
 * A server-side call to `auth.api.signUpEmail(...)` (Tasks 7 and 8, staff
 * invites) still passes `asResponse: true` and discards the returned
 * `Response` — that keeps the caller from reading a session out of it by
 * accident, and the route separately re-reads the new row by email. But
 * `asResponse` does **not** stop the cookie: `nextCookies()`'s after-hook
 * matcher is unconditional (`better-auth/dist/integrations/next-js.mjs`),
 * so it still runs and still writes `Set-Cookie` for whatever session
 * `signUpEmail` created, onto the ambient response, regardless of
 * `asResponse`. `autoSignIn: false` below is what actually prevents it — it
 * stops `signUpEmail` creating a `Session` row at all, so there is no
 * cookie for the after-hook to attach. Without it, a superadmin pressing
 * "Invite" is silently signed in as the account they just created.
 */
export const auth = betterAuth({
	database: prismaAdapter(prisma, { provider: "postgresql" }),
	emailAndPassword: {
		enabled: true,
		// See the module comment above: this is the line that stops a staff
		// invite from signing the inviting superadmin in as the invitee.
		autoSignIn: false,
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
	databaseHooks: {
		session: {
			create: {
				// Stamped on session creation rather than on each request:
				// /admin/users wants "has anyone used this account lately", not a
				// precise last-seen, and a write per request would be a write per
				// page view. This fires for every path that creates a session —
				// credential sign-in and Google sign-in alike, both funnel through
				// the same `internalAdapter.createSession` — so a Google-only
				// staff member's row updates too.
				//
				// Verified against node_modules/better-auth/dist/db/with-hooks.mjs:
				// `createWithHooks` calls `hooks[model].create.after(created,
				// context)` — one argument is the created row (here the session,
				// carrying `userId`), not the `{ user }`/`{ session }` shape the
				// brief's own snippet assumed — and awaits it via
				// `queueAfterTransactionHook`, which runs and is awaited after the
				// transaction commits, before the API response is sent.
				//
				// Wrapped in try/catch: this hook has no `onError`, so an
				// unhandled throw here would propagate out of session creation and
				// fail the sign-in itself. A stale `lastLoginAt` is a cosmetic
				// miss; a failed sign-in is not an acceptable price for it.
				after: async (session) => {
					try {
						await prisma.user.update({
							where: { id: session.userId },
							data: { lastLoginAt: new Date() },
						});
					} catch (error) {
						console.error("Failed to stamp lastLoginAt", error);
					}
				},
			},
		},
	},
	plugins: [nextCookies()],
});
