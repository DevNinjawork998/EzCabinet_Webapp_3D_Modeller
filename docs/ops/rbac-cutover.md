# RBAC cutover runbook

The switch from the shared `ADMIN_PASSWORD` cookie to real accounts
(`SUPERADMIN` / `ADMIN` / `CUSTOMER`). Design: `docs/superpowers/specs/2026-09-20-rbac-design.md`.

This is a **hard cutover** — there is no dual-running period once the new
code is live. But the steps below are ordered **expand/contract**, not
big-bang: the new build ships and is verified *before* the migration drops
anything, because the old build is still reading `Order.paidBy` right up
until the new build replaces it, and Prisma's generated queries name their
columns explicitly — an old build against a post-migration database 500s on
every order read (`/admin/orders`, `/admin/orders/[id]`, `/admin/logistics`,
and the customer-facing `/[lang]/order/[token]`). Doing the migration first
is the mistake this runbook exists to prevent.

## Before you start

Do these before the deploy, not during it — all are easy to get wrong quietly,
and none of them fail loudly at deploy time.

1. **Set all four Better Auth environment variables in the Vercel project —
   not just the two for Google:**

   - `BETTER_AUTH_SECRET` — **critical.** Better Auth throws outright in
     production if this is unset or left at its default
     (`node_modules/better-auth/dist/context/create-context.mjs:42`, "You are
     using the default secret…"). Unlike the old scheme, there is no shared
     password to fall back on if this is missing: every auth call on the
     deployed site fails, staff included. Generate one and set it before the
     deploy that ships this branch, not after.
   - `BETTER_AUTH_URL` — set it to the production domain
     (`https://<domain>`). Without it, Better Auth derives the origin from
     the incoming request instead
     (`node_modules/better-auth/dist/utils/url.mjs:71`,
     `create-context.mjs:65` warns "callbacks and redirects may not work
     correctly"). On Vercel that can mean the redirect URI it sends to
     Google is the deployment hostname, not the custom domain — which
     produces the exact `redirect_uri_mismatch` failure the next item warns
     about, from a cause that item does not name. Set this or you will spend
     an hour in the Google console blaming the wrong side.
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — `src/lib/auth.ts` builds
     `socialProviders.google` with `?? ""` for both. Missing env vars do
     **not** make Better Auth skip the provider — it registers it with two
     empty strings, so "Continue with Google" renders normally and the
     failure only shows up on the OAuth callback, as an opaque error with
     nothing pointing back at a missing env var.

   All four are in `.env.example`; set all four, not the two that are easiest
   to notice are missing.

2. **Add the production redirect URI to the Google OAuth client**, alongside
   the existing localhost one:

   ```
   https://<domain>/api/auth/callback/google
   ```

   Skipping this is the other quiet failure, and it compounds with
   `BETTER_AUTH_URL` above: local sign-in keeps working (its own redirect URI
   is already registered), so a `redirect_uri_mismatch` on production is easy
   to mistake for a Vercel or DNS problem instead of a one-line fix in the
   Google Cloud console — or, if `BETTER_AUTH_URL` was also skipped, a
   moving-target hostname that makes the console fix look like it didn't
   take.

## Cutover steps

1. **Set the environment variables above in the Vercel project** (all four
   Better Auth vars, plus anything else "Before you start" lists). Do this
   first — the next step's build reads them at runtime, not at build time,
   but there is no reason to deploy a build that cannot yet authenticate
   anyone.

2. **Deploy the new build.** The old build is still running against the
   pre-migration schema, which still has `Order.paidBy` — the new code
   neither reads nor writes that column (this task removed the last three
   references), so the new build runs correctly whether or not the column
   still exists. This is what makes step 3 safe to do after, not before.

3. **Run the migration**, against the production database:

   ```bash
   DATABASE_URL="<production connection string>" pnpm exec prisma migrate deploy
   ```

   `pnpm exec prisma migrate deploy` — not `pnpm build`, which only runs
   `prisma generate`, and not `pnpm db:migrate` (`prisma migrate dev`), which
   refuses to run non-interactively and prompts for confirmation on a
   destructive change. `migrate deploy` applies whatever migrations are
   already committed under `prisma/migrations/`, in order, without prompting
   — exactly what a deploy pipeline needs and exactly why it is the right
   tool for a step that must not stop to ask a question nobody is watching
   for.

   Before this step drops `Order.paidBy`, check what is in that column
   against production, the same way this task checked it against dev:

   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM "Order" WHERE "paidBy" IS NOT NULL;'
   ```

   Zero rows: proceed. Any other count: **stop** — that is a real record of
   who marked an order paid by hand, and it needs to be backfilled into
   `paidByUserId` (matched by staff name against the `User` table) before the
   column is dropped, or the record is gone for good.

   **This is the point of no return.** See Rollback below before running
   this step, not after.

4. **Seed the superadmin, against production, then verify a real sign-in.**

   ```bash
   DATABASE_URL="<production connection string>" \
   SUPERADMIN_EMAIL="<their real work email>" \
   SUPERADMIN_PASSWORD="<a real password, 12+ characters>" \
   pnpm seed:superadmin
   ```

   Name both `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` explicitly on the
   command line (or in whatever the runner's real environment is) — do not
   run this bare. `package.json` runs the script with
   `--env-file-if-exists=.env.local`, which on an operator's own laptop
   points at the local dev database. Run without overriding `DATABASE_URL`,
   this command will happily seed the local database, print "Created … as
   SUPERADMIN", and leave production with no superadmin at all — a
   silent-success failure, not a loud one.

   Then, on the **deployed site**, not locally:
   - The superadmin signs in (Google or the password just seeded) and can
     reach `/admin/users`.
   - **A real Google sign-in completes end to end.** This is the check that
     catches everything in "Before you start" at once — a misconfigured
     client, a wrong `BETTER_AUTH_URL`, or a missing secret all show up here,
     not in the migration or the deploy. Use a staff Google account and
     confirm the callback lands back on an admin page rather than an error.

5. **Remove `ADMIN_PASSWORD` from the Vercel project environment — last, and
   only after step 4 has passed on the deployed site.** Nothing in the code
   reads it any more (`lib/adminAuth.ts` and the `/api/admin/login` and
   `/api/admin/logout` routes were deleted in an earlier task), so removing
   it earlier costs nothing functionally — the reason to wait is that it is
   the one remaining way in if step 4's Google check fails and the password
   fallback on `/admin/login` is what gets a staff member into `/admin/users`
   to fix whatever is wrong.

Existing orders keep `userId = null` and stay reachable by `publicToken`.
Nothing is back-filled by the migration itself.

## Rollback

**The point of no return is step 3 (the migration), not step 5.** Before
step 3, rollback is simple: re-promote the previous Vercel deployment. The
old build reads `Order.paidBy`, which still exists, so it works exactly as
before — the new environment variables sitting unused in the project does no
harm.

**After step 3, the previous deployment cannot be re-promoted.** `paidBy` is
gone; the old build's queries name that column explicitly and every order
read 500s. There is no "undo the migration" step — go forward, not back:
fix whatever step 4 or 5 found wrong on the current (new) deployment, using
the password fallback on `/admin/login` if Google is what broke.

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
