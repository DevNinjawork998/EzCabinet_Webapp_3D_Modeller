# Customer account: shell and My orders

2026-09-28. Status: approved in conversation, awaiting spec review.

Piece **A** of the Claude Design file `Customer Account.dc.html`
(project `df15da59-8dbe-4c27-bc54-78ebcde47403`). Later pieces, each its own
spec: **B** profile + WhatsApp number, **C** saved addresses, **D** saved
designs (overlaps Phase 3 share links). Receipt PDF and 3D preview images wait
for screenshot capture.

## Decisions

| Question | Decision |
| --- | --- |
| Customer sign-in | **Google only**, unchanged. The design's email/password sign-up, "Forgot password?" and marketing-email opt-in are not built: password sign-up is closed and the app runs no email service. |
| Scope of this spec | Header account menu, account layout with side nav, richer order cards, order detail inside the layout. |
| Where the shared header appears | Account pages (My orders, order detail) and the track page. The landing page keeps its marketing header but gets the same avatar menu / Sign in on its right, replacing its plain "My orders" link. The planner keeps its own chrome. |
| Production stages and order refs | The app's real ones (`lib/orders/stage.ts`, `orderRef` → `IC-YYYYMMDD-NNN`), not the design's placeholder stages and `EZ-` refs. |
| Unbuilt design parts | Omitted, not stubbed: Saved designs, Profile, Receipt, Reorder, 3D preview images, "See saved designs". |

## Structure

A route group `src/app/[lang]/(account)/` holds `orders/` and `order/[token]/`
(moved from `src/app/[lang]/`). Route groups do not change URLs, so
`/[lang]/orders` and `/[lang]/order/[token]` are unchanged — WhatsApp template
buttons, Stripe's `return_url` and the admin "customer view" link keep working.

`(account)/layout.tsx` (server component):

- reads `currentUser()` (nullable) — it does **not** redirect or decide access:
  a layout is not given the current URL, so it cannot build the sign-in `next`;
- renders `SiteHeader` and, beside the page, the "Your account" side nav;
- side nav: **My orders** with the viewer's order count
  (`prisma.order.count({ where: { userId } })`), current when the path is
  `orders` or `order/*` (a small client component reads `usePathname`).
  Nothing else until pieces B and D exist.

Access stays exactly where it is: each page calls `viewerOf(lang, path)`
(signed out → Google sign-in and back) and the order page `canViewOrder`
(stranger → `notFound()`). The existing access tests must keep passing
unchanged.

## Shared header — `src/components/SiteHeader.tsx`

Design's header: **EzCabinet** (→ `/[lang]`), **Room planner**
(→ `/[lang]/planner`), **Tutorials** (→ `/[lang]/tutorials`), and on the right:

- **Signed in:** a round avatar with the user's initials (from `name`, falling
  back to the email's first letter) and a chevron; it opens a menu with the
  name and email, **My orders**, and **Sign out**
  (`authClient.signOut()`, then navigate to `/[lang]`).
- **Signed out:** **Sign in** → `/[lang]/sign-in?next=<current path>`.

The menu is a client component: `aria-haspopup="menu"`, `aria-expanded`,
`role="menu"` / `menuitem`, closes on Escape, on outside click and on
navigation; focus returns to the trigger on Escape. The server passes the user
(`{ name, email } | null`) in as a prop; no client session fetch.

Used by `(account)/layout.tsx` and `track/[token]/page.tsx` (replacing its
breadcrumb bar). The landing page renders only the right-hand part
(`AccountMenu` / Sign in) in its existing header, replacing the "My orders"
nav link in both desktop and mobile navs.

## Order cards — `/[lang]/orders`

`src/lib/orders/card.ts` — pure, tested:

```ts
orderCard(order: {
  status: OrderStatus;
  productionStage: ProductionStage | null;
  hasDelivery: boolean;
}): {
  badge: "paid" | "awaiting" | "cancelled";
  stage:
    | { kind: "notStarted" }            // awaiting or cancelled
    | { kind: "paid" }                  // paid, no stage yet
    | { kind: "stage"; stage: ProductionStage }
    | { kind: "delivery" };             // paid and a delivery exists
  canPay: boolean;                      // status === AWAITING_PAYMENT
  canTrack: boolean;                    // hasDelivery
}
```

Card (design layout, no 3D preview box):

- **Title:** `{room label} · {n} units` — room from `ROOM_TYPES`, unit count from
  the stored breakdown's cabinet lines (`summaryLines` quantities summed). No run
  length: a room can have several walls.
- **Meta:** ref in Geist Mono · `Ordered {date}`; **total** right-aligned.
- **Badge** colours from the design: paid `#17402c` on `#e8f0eb`; awaiting
  `#4a4120` on `#f7f3e6`; cancelled `#5c574e` on `#ecebe7`. Beside it the stage
  text: "Not in production yet", "Payment received", the stage name
  (`t.order.stages`), or "Delivery to your site".
- **Actions:** **Pay now** (if `canPay`, → the order page), **View order**,
  **Track delivery** (if `canTrack`, → `/[lang]/track/[latest delivery token]`).

Empty state: the design's copy ("When you order a design, it shows up here
with its payment, production and delivery status.") with **Start planning**
(→ `/[lang]/planner`).

The query stays `where: { userId: viewer.id }` and adds `breakdown` and the
latest delivery's `publicToken` to its `select`.

## Order detail — `/[lang]/order/[token]`

Same data and behaviour as today, laid out as the design's detail view:

- **← My orders** button; **title** (as the card), ref and date; payment
  **badge** right.
- **Status line** under the title: today's heading/body pairs (confirming,
  processing, paid, cancelled, awaiting) as one line. `RefreshWhileSettling`
  unchanged.
- **Left column — Progress:** `STAGES` then "Delivery to your site", with the
  design's dots: reached = filled `#1f5138` with ✓; next = white with a
  `#1f5138` ring; later = `#d4d4d4`. Before payment nothing is reached and
  "Payment received" is next. Replaces "What happens next".
- **Right column:**
  - the payment card (Stripe `OnlinePayment` or bank transfer instructions)
    while awaiting payment — replaces the design's "Pay" link;
  - **Summary:** `summaryLines` + `summaryExtras`, delivery, **Total paid** /
    **Total due**;
  - **Delivery address**;
  - **Track delivery** when a delivery exists.
- `CopyOrderId` stays (beside the ref).

## Copy

New keys in `en`, `ms`, `zh` (sentence case, RM): header (Room planner, Sign
in, Sign out, account menu label), side nav heading and item, card (units,
ordered on, badges, stage texts, Pay now, View order, Track delivery), empty
state, detail (back, progress heading, summary heading, total due). Existing
`t.order.*` keys are reused where they fit.

## Testing

- `lib/orders/__tests__/card.test.ts` — every status × stage × delivery
  combination.
- Existing tests unchanged and passing: `access.test.ts`, the order, orders and
  track page tests (paths move with the files).
- `SiteHeader` menu: no DOM test library in the repo; its logic is only
  open/close, so it is covered by the browser pass.
- Browser pass against the design, signed in, at desktop and 390 px width:
  empty orders, an awaiting order (Pay now → payment card), a paid order
  mid-production, an order with a delivery (Track delivery), account menu
  open/close/sign-out, signed-out header on the track page.

## Out of scope

Profile, WhatsApp number step, saved addresses, saved designs, reorder,
receipt PDF, 3D preview images, email/password auth, marketing emails.
