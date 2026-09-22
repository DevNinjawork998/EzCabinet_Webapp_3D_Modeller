# WhatsApp order notifications — design

Date: 2026-09-22
Status: approved in brainstorming, awaiting spec review

## Goal

A customer who places an order hears about it on WhatsApp: their order number,
their payment being confirmed, each step the factory takes on their cabinets,
the tracking number when a carrier is booked, and the delivery's progress. This
is customer engagement, not a support channel — the number sends updates and
points anyone who replies at EzCabinet's sales team.

## Decisions

| Question | Decision |
| --- | --- |
| Provider | **Meta WhatsApp Cloud API, direct.** No BSP, no SDK — plain HTTPS through `lib/logistics/http.ts`. |
| Where factory stages come from | **An admin advances them on `/admin/orders/[id]`.** Factory Tracker is not integrated; the stage enum is shaped so it can push onto the same endpoint in Phase 4. |
| Stage vocabulary | **Fixed enum in code**, forward-only. |
| Triggers | Order placed, payment confirmed, each production stage, delivery booked, picked up, delivered, failed/cancelled. |
| Consent | **Unticked checkbox at checkout**, stored with a timestamp. No opt-in, no message. |
| Language | **The customer's site language** (en / zh / ms), captured at checkout. |
| Inbound replies | **Auto-reply with the sales contact**, at most once per 24 h per number. |
| Delivery mechanism | **Outbox table + immediate send + retry on the existing cron.** |

Rejected mechanisms: sending inline in the request (a slow or down Meta blocks
the admin, and a failure loses the message with no record); Vercel Queues or
Workflow (new infrastructure for 7 message types at a factory's order volume —
Postgres already gives the same guarantees here).

## Constraint that shapes everything

A business-initiated WhatsApp message must be a **Meta-approved template**
(utility category) with positional variables. Free-form text is only allowed
inside the 24-hour window after the customer messages the business. So every
notification below is one template per language, approved ahead of time in
WhatsApp Manager, and the app only fills in variables.

## Data model

### `Order` additions

```prisma
whatsappOptIn    Boolean          @default(false)
whatsappOptInAt  DateTime?
/// The locale the customer checked out in; picks the template language.
locale           String           @default("en")
/// Null until paid. Forward-only.
productionStage  ProductionStage?

enum ProductionStage {
  MEASURE
  CUTTING
  EDGING
  ASSEMBLY
  QC
  READY
}
```

The stage names are placeholders until EzCabinet's factory confirms its real
steps (see Rollout). Renaming them is a migration plus three translations.
`MEASURE` comes first because the order page already promises a site re-measure
straight after payment. Stage labels live in the site dictionaries
(`order.stages.*` in `lib/copy/{en,zh,ms}.ts`) so the order page and the
messages say the same words.

`locale` is validated against `LOCALES` in `lib/copy/locales.ts`, not a Prisma
enum, for the same reason `carrierId` is not: adding a language should not be a
migration.

### `Notification` — the outbox and the customer-facing log

```prisma
model Notification {
  id            String             @id @default(cuid())
  orderId       String
  order         Order              @relation(fields: [orderId], references: [id], onDelete: Cascade)
  deliveryId    String?
  kind          NotificationKind
  stage         ProductionStage?
  /// One message per real-world event. A second insert for the same event is
  /// a unique violation and is ignored.
  dedupeKey     String             @unique
  /// E.164, snapshotted — the order's phone can be corrected later.
  to            String
  template      String
  locale        String
  vars          Json
  status        NotificationStatus @default(PENDING)
  attempts      Int                @default(0)
  lastError     String?
  metaMessageId String?            @unique
  /// When this row last entered the queue — creation, or an admin's Resend.
  /// The 48 h expiry counts from here, not from `createdAt`.
  queuedAt      DateTime           @default(now())
  sentAt        DateTime?
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt

  @@index([status, queuedAt])
  @@index([orderId])
}

enum NotificationKind {
  ORDER_PLACED
  PAYMENT_CONFIRMED
  STAGE
  DELIVERY_BOOKED
  PICKED_UP
  DELIVERED
  DELIVERY_FAILED
}

enum NotificationStatus {
  PENDING
  SENT
  DELIVERED
  READ
  FAILED
}
```

`deliveryId` is a bare id, not a relation: a delivery can be split (consumed and
deleted), and the message that was sent about it is still history.

### `WhatsappAutoReply` — the auto-reply throttle

```prisma
model WhatsappAutoReply {
  /// E.164 of whoever messaged us.
  phone     String   @id
  repliedAt DateTime
}
```

One row per number. The webhook upserts it when it sends an auto-reply and
skips the reply when `repliedAt` is under 24 h old. Not a `Notification`: an
inbound message need not belong to any order.

### Dedupe keys

| Kind | Key |
| --- | --- |
| `ORDER_PLACED` | `order:<orderId>:placed` |
| `PAYMENT_CONFIRMED` | `order:<orderId>:paid` |
| `STAGE` | `order:<orderId>:stage:<STAGE>` |
| `DELIVERY_BOOKED` | `delivery:<deliveryId>:booked` |
| `PICKED_UP` / `DELIVERED` / `DELIVERY_FAILED` | `delivery:<deliveryId>:<kind>` |

This is what makes duplicate carrier readings safe: `applyTrackingUpdate`
already receives the same status from both the webhook and the cron poll by
design, and both will try to enqueue — the second insert is a no-op.

## Triggers

Each trigger inserts its `Notification` row **in the same transaction** as the
state change it reports, so "the order is paid" and "the customer must be told"
cannot diverge.

**One exception: delivery booked.** The booking route's final write records a
booking the carrier has already charged for. If the notification insert failed
inside that transaction it would roll the write back, the row would look
unbooked, and a retry would buy a second lorry. So that route enqueues after the
booking write commits, in its own `try`, and logs a failure instead of
propagating it.

| Event | Write site | Template variables | Button link |
| --- | --- | --- | --- |
| Order placed | `POST /api/orders` | name, order ref (`IC-YYYYMMDD-NNN`), total RM | `/order/{publicToken}` |
| Payment confirmed | `POST /api/admin/orders/[id]/paid` | order ref | `/order/{publicToken}` |
| Stage advanced | **new** `POST /api/admin/orders/[id]/stage` | order ref, localized stage name | `/order/{publicToken}` |
| Delivery booked | `POST /api/admin/deliveries/[id]/book` | order ref, carrier name, tracking no. (`carrierOrderId`) | `/track/{publicToken}` |
| Picked up / delivered / failed or cancelled | `applyTrackingUpdate` (`lib/logistics/store.ts`) | order ref | `/track/{publicToken}` |

Rules:

- **No opt-in, no row.** `enqueue` checks `order.whatsappOptIn` and returns.
- **A delivery with no `orderId`** (a job an admin made by hand) sends nothing —
  there is no consent record for its phone.
- **Split deliveries** each get their own "booked" message: they have separate
  tracking numbers.
- `DRIVER_ASSIGNED` and `IN_TRANSIT` send nothing. Picked up, delivered and
  failed are the three moments a customer acts on.
- **Order cancelled sends nothing** in v1 — money is involved and sales phones
  the customer.
- Links go in a URL button with a dynamic suffix (Meta's template feature), so
  the unguessable token never appears in the message body text.

## Module: `src/lib/whatsapp/`

Server-only, like `lib/logistics`.

- **`templates.ts`** — pure. `(kind, vars, locale, stage?) → Meta template
  payload`. One table holds each kind's template name and variable order;
  stage names come from the site dictionaries. The template wording itself is in
  `docs/ops/whatsapp-ezcabinet-setup.md`, the copy EzCabinet submits; the
  variable order here must match it.
- **`send.ts`** — one Cloud API call, `POST /v{N}/{phone-number-id}/messages`,
  through `lib/logistics/http.ts` (timeout, retry only when safe). Returns the
  Meta message id or a classified error.
- **`outbox.ts`** — `enqueue(tx, event)` inserts a row and swallows the
  unique-violation; `flush(ids?)` sends `PENDING` rows and records the outcome.
- **`webhook.ts`** — signature verification and payload parsing, pure and
  tested.

## Sending

1. The trigger site calls `enqueue` inside its transaction.
2. After commit the route calls `after(() => flush([id]))` (`next/server`), so
   the admin's click or the customer's checkout never waits on Meta.
3. `/api/cron/track-deliveries` (every 10 minutes, already exists) also calls
   `flush()` for `PENDING` rows and retryable `FAILED` rows. No new cron.
   `flush` caps rows per run, like the tracking poll does.

### Error handling

| Error | Outcome |
| --- | --- |
| 429, 5xx, timeout, Meta rate-limit codes | Stays `PENDING`; `attempts` + 1, `lastError` set. After 5 attempts, `FAILED`. |
| Meta permanent error — recipient not on WhatsApp, template paused or rejected, user blocked the business | `FAILED`, never retried, error shown to the admin. |
| Row queued more than 48 h ago and never sent | `FAILED` with `lastError: "expired"`. A three-day-late "your cabinet is in assembly" is worse than none. |
| `WHATSAPP_TOKEN` unset | Rows stay `PENDING`, one log line, nothing throws. |

`FAILED` is terminal: only an admin's Resend (which resets `attempts` and
`queuedAt`) puts a row back in the queue. Each send first claims the row with a
conditional update on `attempts`, and the cron only picks rows untouched for a
minute, so the `after()` flush and a cron run cannot both send one message.

The last row is the local-dev and preview behaviour. **Preview deployments must
not carry `WHATSAPP_TOKEN`** — a preview is a public URL and must never message
a real customer.

## Webhook: `/api/whatsapp/webhook`

Public prefix, so it authenticates itself — `proxy.ts` only gates `/admin`.

- **`GET`** — Meta's subscription handshake: echo `hub.challenge` when
  `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN` (compared with
  `secretsMatch`).
- **`POST`** — verify `X-Hub-Signature-256` as HMAC-SHA256 of the raw body with
  `WHATSAPP_APP_SECRET`; mismatch is 401. Unlike EasyParcel (Known issue 3),
  Meta signs its webhooks, so this is a real check.
  - **Status events** (`sent`, `delivered`, `read`, `failed`) update the row
    found by `metaMessageId`. Status only moves forward; a late `delivered`
    after `read` is ignored.
  - **Inbound messages** get one free-form auto-reply — "This number sends order
    updates only. To chat with our team: wa.me/<sales number>" — in the
    matching order's locale when the phone matches an order, English otherwise.
    At most once per 24 h per number, throttled by `WhatsappAutoReply`.
    The inbound text is not stored — it is whatever a customer typed, and
    nothing reads it.

## UI

### Customer

- **Checkout:** an unticked checkbox under the phone field — "Send order updates
  to this number on WhatsApp" — in the dictionary for all three locales. The
  checkout locale is stored on the order.
- **Order page `/[lang]/order/[token]`:** a production-stage strip (Cutting →
  … → Ready). Every stage message links here, so the page must say what the
  message said.
- **Privacy draft `/[lang]/privacy`:** a paragraph naming Meta as a processor
  for WhatsApp messages. Flag to EzCabinet's counsel with the rest of that draft.

### Admin — `/admin/orders/[id]`

- **Stage control:** one "Advance to: <next stage>" button, forward-only, one
  step at a time, visible once the order is paid. Gated by the same permission
  as marking paid (`orders:markPaid`); if the two jobs ever belong to
  different people, a separate permission is one row in `permissions.ts`.
- **Messages panel:** every `Notification` for the order — kind, status (sent /
  delivered / read / failed), error text, and **Resend** on a failed row
  (resets it to `PENDING` and flushes). An order without opt-in says "Customer
  did not opt in to WhatsApp" instead.

## Environment

| Variable | What |
| --- | --- |
| `WHATSAPP_TOKEN` | System-user permanent access token. Production only. |
| `WHATSAPP_PHONE_NUMBER_ID` | The Cloud API phone number id. |
| `WHATSAPP_APP_SECRET` | Signs the webhook. |
| `WHATSAPP_VERIFY_TOKEN` | Our secret for the subscription handshake. |
| `WHATSAPP_SALES_NUMBER` | E.164, the number the auto-reply points at. |

## Testing

- **Unit:** `templates.ts` — every kind × every locale builds a payload with
  variables in the approved order; dedupe-key builder; Meta error classifier;
  webhook signature verification (good, bad, missing header); status
  forward-only.
- **Rules as pure functions** (the repo has no route tests, so each route's
  rules live in a tested function it calls): the next stage and refusal of a
  backward or skipped step; no opt-in builds no row; a delivery with no order
  builds no row; which delivery statuses message; dedupe keys equal for a
  repeated carrier reading. The auth coverage test picks the new admin routes up
  automatically.
- **Fixtures:** recorded Meta responses, as `lib/logistics` does.
- **Real API:** `pnpm whatsapp:ping <e164>` sends one template to a test number.
  Not in CI, for the same reasons `easyparcel:ping` is not.

## Rollout — EzCabinet's side

These block go-live, not the build. The full checklist, with how-to steps and
the template copy to submit, is `docs/ops/whatsapp-ezcabinet-setup.md` — that
file is the source of the approved wording `templates.ts` must match.

1. **Meta Business verification** and a **dedicated phone number** for the
   Cloud API. That number cannot also be used in the WhatsApp phone app.
2. **Template approval:** 7 templates × 3 languages.
3. **The factory's real stage names.**
4. **The sales WhatsApp number** for the auto-reply.
5. **Counsel sign-off** on the privacy paragraph.

## Out of scope (v1)

- A two-way inbox for replies.
- An order-cancelled message.
- Marketing or re-engagement messages.
- Factory Tracker pushing stages. The enum and the stage endpoint are shaped for
  it; wiring it is Phase 4.
- Opting out from the order page. A customer who blocks the number is handled
  by Meta's permanent-error classification.
