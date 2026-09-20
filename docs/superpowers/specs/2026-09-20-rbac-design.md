# Accounts and role-based access

**Date:** 2026-09-20
**Status:** approved, not implemented
**Supersedes:** the shared-secret admin gate (`lib/adminAuth.ts`, `Auth` in `CLAUDE.md`)

## The problem

There is one locked door and no idea who walked through it. `ADMIN_PASSWORD`
is a single shared secret; the cookie is an HMAC of it and carries no
identity. Anyone holding it can publish a catalogue, mark an order paid and
spend the EasyParcel wallet. `Order.paidBy` is a *typed-in name*, and its
schema comment says why: "Admin auth is one shared password, so this typed
name is the record."

Customers, meanwhile, have no account at all. A design is anonymous until the
save-and-share gate takes an email address.

This spec introduces real accounts, five roles, and a superadmin who assigns
them.

## Scope

In:

- Better Auth wired to Google (customers) and email+password (staff)
- A `User` table with a `role` column, and the permission vocabulary the roles
  map onto
- `/admin/users` — invite staff, change role, disable
- Every admin page and API route gated by an explicit permission check
- Sign-in required at checkout; `Order.userId` and `Order.paidByUserId`
- Planner autosave, so nothing is lost across the OAuth redirect
- A dismissible sign-in nudge in the planner
- `AUTH_ENABLED`, a development-only bypass

Out — sub-project C, its own spec:

- "My designs" and "my orders" screens
- Back-filling `Order.userId` on pre-cutover orders
- Share links owned by an account

## Decisions

| Decision | Chosen | Why |
| --- | --- | --- |
| Library | **Better Auth** | Social-only for customers means no password-reset mail and no transactional email vendor, which is most of what a hosted provider is paid for. Users stay in our own Postgres: no per-MAU bill as checkout-requires-login grows MAU with sales, and no PDPA question about where Malaysian customer data sits. |
| Staff sign-in | email + password | Two doors that never cross. A customer account has no path to a staff role. |
| Customer sign-in | **Google only** | Facebook is deferred, not rejected — see below. |
| Staff onboarding | invite-only | Public sign-up can only ever produce a `CUSTOMER`. Escalation is not a code path that exists. |
| Permission model | fixed roles | Five roles, each a constant permission set in code. No permission-matrix UI, no DB read per gate, and the mapping is one table-driven test. |
| Staff passwords | set by the superadmin, handed over in person | Three internal users, one office. Avoids an email sender entirely. |
| Cutover | hard | `ADMIN_PASSWORD` and `lib/adminAuth.ts` are deleted in the same release that seeds the first superadmin. Two live auth paths means the weakest one has full access. |
| Entry friction | none | The planner opens without an account, as today. |

### Rejected

**Clerk.** Fastest to ship, and its pre-built password reset, MFA and email
delivery are real work we would not do. But social-only customers need none of
it; the free tier ends at 10k MAU and login-to-checkout ties MAU to sales; and
user records on Clerk's US/EU infrastructure is a PDPA answer EzCabinet's
counsel would have to give.

**Auth.js.** Free and self-hosted like Better Auth, with a wider ecosystem.
Its credentials provider is deliberately bare, which is exactly the staff path
we need, and its session ergonomics in the App Router are clunkier.

**A `VISITOR` role.** Proposed as the default on sign-up. Dropped: anonymous
browsing needs no account, and public sign-up produces a real `CUSTOMER` with
somewhere to put a design. Nobody would ever occupy the state.

**Per-surface permission toggles.** Superadmin ticking individual surfaces per
user. Real flexibility, but it buys a permissions matrix screen and moves
every gate from a code constant to a DB read, for three internal users.

**An entry gate or a pre-planner nudge.** The data-loss worry it answers is
answered better by autosave — see below. `CLAUDE.md` records the conversion
reason for keeping entry free: "by then the customer has sunk time into a
design and will trade a phone number to keep it."

### Deferred

**Facebook Login.** Wanted, and it matters in Malaysia — but it needs the app
Live and the business verified with EzCabinet's company documents before it
returns `email`, which is a lead time nothing else here waits on. In Better
Auth it is one provider block, one environment variable pair and one more
button on the sign-in screen, so adding it later costs nothing this spec has
to plan around. Do not let it block the build.

## Permissions

`src/lib/auth/permissions.ts` — pure TypeScript, no imports, no DB. The one
place a role becomes a capability.

```
catalogue:read      see designs and their prices
catalogue:write     upload, edit and price a design
catalogue:publish   rebuild the live catalogue
orders:read         see orders
orders:markPaid     confirm payment arrived
logistics:read      see deliveries
logistics:book      book a carrier
content:write       site images, tutorials
users:manage        invite, change role, disable
```

| Role | Permissions |
| --- | --- |
| `SUPERADMIN` | all |
| `ADMIN` | all except `users:manage` |
| `SALES` | `orders:read`, `orders:markPaid`, `logistics:read`, `logistics:book`, `catalogue:read` |
| `CATALOGUE` | `catalogue:read`, `catalogue:write`, `catalogue:publish`, `content:write` |
| `CUSTOMER` | none — owns their own designs and orders, which is not an admin permission |

`catalogue:publish` is deliberately separate from `catalogue:write`.
Publishing rewrites the live price list for every customer
(`POST /api/admin/cabinet-designs/publish` → `buildCatalogue`). Onboarding a
design and repointing the money are different acts.

## Enforcement

Two layers, and only the second is a boundary.

```
proxy.ts        Reads the session cookie. Redirects /admin/* to the login page
                when it is absent. No DB hit, optimistic, fast. A wrong answer
                here is harmless.

requireAuth()   Called by every admin page and every /api/admin route with the
                permission it needs. Reads the session, loads the user, checks
                `disabled`, checks the permission. Throws 403, or 404 for a
                customer who should not learn the surface exists. THIS is the
                boundary.
```

A route handler with no `requireAuth` call is unprotected no matter what
`proxy.ts` does. The failure mode is a new route nobody remembers to gate, so
a test walks `src/app/api/admin/**/route.ts` and `src/app/admin/**/page.tsx`
and fails on any file with no `requireAuth` call.

`proxy.ts` keeps its current matcher and its locale branch untouched. Only the
`isValidAdminSession` call is replaced.

### The development bypass

`src/lib/auth/enabled.ts` is the only reader of `AUTH_ENABLED`.

```ts
export function authEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") return true;
  return process.env.AUTH_ENABLED !== "false";
}
```

When off: admin surfaces open, `POST /api/orders` accepts an anonymous order,
no sign-in UI renders. Today's behaviour minus the password prompt.

The production guard is not a convenience. A misdeployed environment variable
must not be able to unlock the admin surface or the orders API, so the flag is
ignored where it would do harm. Local and preview only.

## Schema

Better Auth generates `Session`, `Account` and `Verification`. Ours:

```prisma
enum Role {
  SUPERADMIN
  ADMIN
  SALES
  CATALOGUE
  CUSTOMER
}

model User {
  id                 String    @id @default(cuid())
  email              String    @unique
  name               String
  image              String?
  role               Role      @default(CUSTOMER)
  /// Staff only. Null on a social account — a customer has no password to steal.
  passwordHash       String?
  /// Set by an invite, cleared by the forced change on first sign-in.
  mustChangePassword Boolean   @default(false)
  /// Offboarding. Never hard-delete: a disabled employee's name must stay
  /// readable on the orders they touched.
  disabled           Boolean   @default(false)
  invitedById        String?
  lastLoginAt        DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  orders     Order[] @relation("OrderCustomer")
  ordersPaid Order[] @relation("OrderPaidBy")
}
```

On `Order`:

```prisma
  /// Null on a pre-cutover or anonymous order. `publicToken` still opens it.
  userId       String?
  /// Replaces the typed-in `paidBy`: admin auth now knows who it is.
  paidByUserId String?
```

`paidBy` (the typed string) is dropped along with its schema comment, which
exists only to explain the shared password.

Roles are not written into the session. A role change takes effect on the next
request; disabling a user kills their live sessions.

## Journeys

### Anonymous visitor becomes a customer

```
/ → pick a room → planner opens, no account
  ↓ first cabinet placed
dismissible bar: "Sign in to save this design"   [Sign in] [Not now]
  ↓ layout autosaves to localStorage on every mutation
checkout → sign-in required, the only hard stop
  ↓ [Continue with Google]
  ↓ layout stashed → OAuth → /api/auth/callback → back to checkout
User row created with role CUSTOMER, layout rehydrated, order placed
```

**Autosave is the data-loss fix, not the nudge.** An OAuth redirect navigates
away from the page: the R3F scene and every piece of React state are gone
whenever the customer signs in, early or late. Moving the prompt earlier moves
the loss earlier. So the planner writes its `RoomLayout` to `localStorage` on
every mutation — the layout document being the single source of truth is what
makes this one `JSON.stringify` — and reads it back on mount. Every read and
write is wrapped in try/catch: Safari private mode and blocked site data
return nothing, and a planner that starts empty is the correct outcome there.
This also survives a refresh, a crash and a closed tab, which the nudge never
did.

The nudge's dismissal is remembered in `localStorage` too, and it never
appears for a signed-in customer.

### The superadmin invites an employee

```
/admin/users → [Invite staff]
  ↓ email, name, role, initial password
row created with that role and mustChangePassword = true
  ↓ password handed over in person
employee → /admin/login → email + password → forced change → /admin
```

One row per email. An employee who already signed up as a customer on their
work email cannot be invited on it; they use a different address. That keeps
"a customer account cannot become staff" absolutely true rather than mostly
true, which is the whole point of invite-only.

### Role change and offboarding

`/admin/users` lists every account, filterable to staff, searchable by email —
the list fills with real customers, so the employee must not be a needle in a
haystack. A row changes role or is disabled. Both need `users:manage`.

A superadmin cannot disable or demote themselves; the seed refuses to leave
zero superadmins.

### Bootstrap

`pnpm seed:superadmin` reads `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD`,
creates that row as `SUPERADMIN`, and refuses to run if one already exists.
Run once against production at cutover.

### Wrong door

A signed-in customer requesting `/admin/*` gets 404, not 403. A 403 confirms
the surface is there.

## Files

```
src/lib/auth/permissions.ts   Role → Permission[]. Pure. Tested before it has a caller.
src/lib/auth/enabled.ts       AUTH_ENABLED, ignored in production
src/lib/auth/requireAuth.ts   server-only: session → user → permission → throw
src/lib/auth.ts               Better Auth config: Google, credentials
src/app/api/auth/[...all]/    Better Auth handler
src/app/admin/users/          the superadmin screen
src/app/admin/login/          rewritten for email + password
src/app/[lang]/sign-in/       customer: Google
src/proxy.ts                  cookie check replaces isValidAdminSession
src/components/planner/       autosave, rehydrate, dismissible nudge
src/app/api/orders/route.ts   requires a session unless authEnabled() is false
src/lib/adminAuth.ts          DELETED
```

## Testing

`permissions.ts` gets a table-driven test per role before anything imports it —
the project convention, and here it is also the whole security model in one
assertion list.

`requireAuth` is tested for: no session; a disabled user with a valid session;
a valid session with the wrong role; the right role; `AUTH_ENABLED=false`
outside production; and `AUTH_ENABLED=false` with `VERCEL_ENV=production`,
which must still enforce.

The route-coverage test walks the admin route and page files and fails on any
that never calls `requireAuth`.

Autosave gets a round-trip test through a `localStorage` stub, including a stub
that throws on write.

## Cutover

1. Migration adds `User`, `Role`, the Better Auth tables, `Order.userId`,
   `Order.paidByUserId`; drops `Order.paidBy`.
2. `pnpm seed:superadmin` against production.
3. Deploy.
4. Verify the superadmin signs in and can reach `/admin/users`.
5. Remove `ADMIN_PASSWORD` from the Vercel project environment.

Existing orders keep `userId = null` and stay reachable by `publicToken`.
Nothing is back-filled.

## Client dependencies

Not a code task, and it has a lead time worth starting now:

- **Google OAuth consent screen.** Needs a verified domain and a privacy
  policy URL — which points at `/[lang]/privacy`, still a draft awaiting
  EzCabinet's counsel. Until the app is verified, Google caps it at 100 test
  users, which is fine for development and not for launch.

## Consequences for CLAUDE.md

The `Auth` section is rewritten: the shared-secret cookie is gone. "No login
to configure" survives, but checkout now requires an account. The `Order`
schema comment explaining `paidBy` goes with the column.
