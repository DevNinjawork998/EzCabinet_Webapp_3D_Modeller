# RBAC cutover runbook

The switch from the shared `ADMIN_PASSWORD` cookie to real accounts
(`SUPERADMIN` / `ADMIN` / `CUSTOMER`). Design: `docs/superpowers/specs/2026-09-20-rbac-design.md`.

This is a **hard cutover** — there is no dual-running period. The moment the
migration lands, `ADMIN_PASSWORD` stops being read by any code path; the only
question this runbook answers is when it is safe to delete it from the
environment.

## Before you start

Do these before the deploy, not during it — both are easy to get wrong quietly.

1. **Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the Vercel project
   environment before the deploy that ships this branch.**
   `src/lib/auth.ts` builds `socialProviders.google` with `?? ""` for both
   values. With the env vars missing, Better Auth does **not** skip the
   provider — it registers it with two empty strings, so the "Continue with
   Google" button renders normally and the failure only shows up on the
   OAuth callback, as an opaque error with nothing pointing back at a missing
   env var. Set both before anyone presses the button on the deployed site.

2. **Add the production redirect URI to the Google OAuth client**, alongside
   the existing localhost one:

   ```
   https://<domain>/api/auth/callback/google
   ```

   Skipping this is the other quiet failure: local sign-in keeps working
   (its own redirect URI is already registered), so a `redirect_uri_mismatch`
   on production is easy to mistake for a Vercel or DNS problem instead of a
   one-line fix in the Google Cloud console.

## Cutover steps

1. **Run the migration.** It adds `User`, `Role`, the Better Auth tables,
   `Order.userId` and `Order.paidByUserId`, and drops `Order.paidBy`.

   Before generating or running a migration that drops `Order.paidBy`
   against any database that isn't disposable dev data, check first:

   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM "Order" WHERE "paidBy" IS NOT NULL;'
   ```

   Zero rows: proceed. Any other count: **stop** — that is a real record of
   who marked an order paid by hand, and it needs to be backfilled into
   `paidByUserId` (matched by staff name against the `User` table) before the
   column is dropped, or the record is gone for good. This is not
   hypothetical busywork: the count was non-zero on the local dev database
   during this task's own execution (one seeded test order, `paidBy =
   "Testing Name"`), which is exactly the case this check exists to catch
   before it happens against production data.

2. **Seed the superadmin.**

   ```bash
   pnpm seed:superadmin
   ```

   run against the production database.

3. **Deploy.**

4. **Verify on the deployed site, not just locally:**
   - The superadmin signs in and can reach `/admin/users`.
   - **A real Google sign-in completes** — this is the check that catches
     both items in "Before you start": a misconfigured client shows up here,
     not in the migration or the deploy. Use a staff Google account (or the
     superadmin's, if it's a Google-capable address) and confirm the
     callback lands back on an admin page rather than an error.

5. **Remove `ADMIN_PASSWORD` from the Vercel project environment — last,
   and only after step 4 has passed on the deployed site.** Nothing in the
   code reads it any more (`lib/adminAuth.ts` and the `/api/admin/login` and
   `/api/admin/logout` routes were deleted in an earlier task), so removing
   it earlier costs nothing functionally — the reason to wait is that it is
   the one remaining way in if step 4's Google check fails and the password
   fallback on `/admin/login` is what gets a staff member into `/admin/users`
   to fix whatever is wrong.

Existing orders keep `userId = null` and stay reachable by `publicToken`.
Nothing is back-filled by the migration itself.

## Known, deliberately not defended against

The role-enum migration (`20260920023623_align_role_enum`) narrows the
`Role` enum with a bare `USING ("role"::text::"Role_new")` cast, which would
fail against a row holding the dropped `SALES` or `CATALOGUE` value. **Do
not add a `CASE` remap for this.** No such row can exist: the enum was
introduced and narrowed within the same unreleased branch, `main` never had
the wider enum, and the only writers of `role` are the seed (`SUPERADMIN`)
and the invite flow (built from `STAFF_ROLES`, which is already `SUPERADMIN
| ADMIN`). Defensive SQL for a value that structurally cannot exist is dead
code in the worst possible place to keep it — a migration nobody re-reads
until something goes wrong. If a future role is reinstated, it is one row in
`ROLE_PERMISSIONS`, not a reason to revisit this migration.

## Client dependency, not a code task

**Google OAuth consent screen.** Needs a verified domain and a privacy
policy URL — which points at `/[lang]/privacy`, still a draft awaiting
EzCabinet's counsel. Until the app is verified, Google caps sign-in at 100
test users, which is fine for development and not for launch. Start this
well before the cutover; it has its own lead time independent of anything
above.
