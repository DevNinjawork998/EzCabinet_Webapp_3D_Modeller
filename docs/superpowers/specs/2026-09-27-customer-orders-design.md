# Customer orders: a signed-in customer sees their own orders, and only theirs

2026-09-27. Status: approved in conversation, awaiting spec review.

## Goal

After checkout a customer has no way back to their orders except the one link
the confirmation redirect gave them. Add a **My orders** page, and make every
order view **authorised**: a customer sees the orders tagged to their account
and no one else's, whoever holds the link.

## What already exists

- **Authentication is done.** Better Auth with Google (OAuth 2.0 / OIDC) is
  `lib/auth.ts`; customers already sign in with it at checkout. This work is
  authorisation only — nothing changes in the OAuth flow.
- `currentUser()` (`lib/auth/session.ts`) reads the user row on every call, so
  a disabled account loses access on the next request.
- `Order.userId` is set by `POST /api/orders` from the session, but is
  nullable: `AUTH_ENABLED=false` lets checkout store an ownerless order.
- `/[lang]/order/[token]` and `/[lang]/track/[token]` open for **anyone holding
  the token**. Both show the site address. The order link is handed out by the
  checkout redirect, the WhatsApp template buttons (`lib/whatsapp/templates.ts`)
  and the admin order screen (`OrderDetail.tsx`); the track link by the
  WhatsApp delivery templates and `DeliveryDetail.tsx`.
- `permissions.ts` already states the model: a customer's access to their own
  orders is *ownership*, checked where the rows are read, not a permission.

## Decisions

| Question | Decision |
| --- | --- |
| Who may open an order | The signed-in **owner**, or **staff** whose role has `orders:read`. Nobody else, link or not. |
| Ownerless orders | Not allowed. `Order.userId` becomes `NOT NULL`; checkout requires a signed-in user in every environment. |
| Existing ownerless rows | **Deleted** by the migration, after a per-environment count has been shown to the user. |
| Track page | Locked the same way **when the delivery belongs to an order**. A standalone admin-booked delivery (no order) keeps link access — its recipient has no account to sign in with. |
| Where the check lives | One module, `lib/orders/access.ts`, used by every reader. Not `proxy.ts` (it only redirects, by project rule) and not Postgres RLS (no precedent in the app, needs a per-request session variable). |

## Access rule

`lib/orders/access.ts`:

```ts
/** Pure. The whole rule; the table test is its specification. */
export function canViewOrder(
  user: Pick<AuthUser, "id" | "role"> | null,
  order: { userId: string },
): boolean
// owner: user.id === order.userId
// staff: can(user.role, "orders:read")
// else false (including user === null)
```

Ownership compares **ids only**. Email is never an access key: a checkout email
is typed, not verified.

A server-only helper next to it resolves a page's request into one of three
outcomes, so each page does not re-derive them:

| Visitor | Outcome |
| --- | --- |
| Signed out | `redirect(/[lang]/sign-in?next=<current path>)` — a WhatsApp tap becomes tap → Google → the order |
| Owner or staff | the row |
| Anyone else, or unknown token | `notFound()` — identical to a missing token, so the page never confirms an order exists (the `requireAuth` convention: customers get 404, not 403) |

`AUTH_ENABLED=false` makes the helper treat the visitor as `BYPASS_USER`
(superadmin), consistent with the admin surface; it is ignored on any Vercel
deployment as today.

The token stays in the URL. It is now an address, not a credential.

## Pages

### `/[lang]/orders` (new)

- Server component. Signed out → sign-in redirect with `next=/[lang]/orders`.
- Query: `prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } })`
  with a narrow `select`. The id comes from the session only — the page takes
  no id, token or filter from the client, so there is nothing to tamper with.
- A staff user sees only orders they placed themselves; staff use `/admin/orders`.
- Each card: order ref (`orderRef`), date, room, total (RM), status —
  awaiting payment / paid / cancelled — or the production stage once started.
  Links to `/[lang]/order/[token]`.
- Empty: "No orders yet" and a *Start planning* button.
- `robots: noindex, nofollow`, like the order page.

### `/[lang]/order/[token]` (changed)

Loads by token including `userId`, then applies the access helper before
rendering anything. The file's header comment, which describes the token as
the key, is rewritten.

### `/[lang]/track/[token]` (changed)

If the delivery has an `orderId`, apply the same helper against that order.
Without one, behaviour is unchanged.

### Entry points

"My orders" link in the homepage header (desktop and mobile nav, beside
Tutorials) and on the order page. Copy in `en`, `ms`, `zh`.

## Checkout

`POST /api/orders`: no signed-in user → **401 in every environment**. The
`AUTH_ENABLED=false` branch that stored `userId: null` is removed; the flag
keeps opening the admin surface only. Local checkout needs a Google sign-in
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local`).

## Data

`prisma/schema.prisma`, `Order`:

```prisma
userId String
user   User   @relation("OrderCustomer", fields: [userId], references: [id], onDelete: Restrict)

@@index([userId, createdAt])
```

`Restrict`: deleting a user who has orders is refused. Orders are money
records and outlive an account.

### Migration (hand-written — Known issue 12, no shadow database)

1. `DELETE FROM "Order" WHERE "userId" IS NULL;` — notifications cascade;
   deliveries keep their row with `orderId` set null (existing `SetNull`), so a
   carrier booking is never orphaned from our records.
2. `ALTER COLUMN "userId" SET NOT NULL`.
3. Replace the foreign key with `ON DELETE RESTRICT`.
4. Create the `(userId, createdAt)` index.

Verified with `prisma migrate diff --from-config-datasource --to-schema` (no
remaining diff). **Before it is applied to preview or production**, the user is
shown `SELECT count(*) FROM "Order" WHERE "userId" IS NULL` for that database;
the delete is irreversible.

## Testing

- `lib/orders/__tests__/access.test.ts` — table over `canViewOrder`: owner,
  another customer, superadmin, admin, signed out, and a different id sharing
  the owner's email (denied).
- Checkout route: 401 with no session, `AUTH_ENABLED` on and off.
- Order and track pages: signed out → redirect with `next`; owner → renders;
  staff → renders; other customer → `notFound`; track page standalone delivery
  → renders signed out. `currentUser` and Prisma mocked.
- `/orders` page: query is scoped to the session user's id.
- Browser check with two Google accounts: B opens A's order link → 404;
  signed out → sign-in redirect → back to the order.

## Docs

- CLAUDE.md: UX flow (order page access, My orders), the `AUTH_ENABLED`
  paragraph in Auth (no longer allows anonymous checkout).
- `lib/orders/access.ts` header states the rule.

## Out of scope

- Claiming orders by email.
- Cancelling or editing an order from the customer side.
- Share links for designs (Phase 3, separate).
