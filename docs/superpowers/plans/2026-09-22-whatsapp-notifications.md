# WhatsApp Order Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers who opt in at checkout get WhatsApp messages for order placed, payment confirmed, each admin-advanced production stage, delivery booked, picked up, delivered and failed.

**Architecture:** Every trigger inserts a `Notification` row (the outbox) in the same transaction as the state change, deduplicated by a unique `dedupeKey`. After commit, `after()` flushes it through the Meta WhatsApp Cloud API; the existing 10-minute cron retries whatever is still `PENDING`. A signed Meta webhook updates delivery/read status and auto-replies to inbound messages.

**Tech Stack:** Next.js 16 App Router (route handlers, `after` from `next/server`), Prisma 7 (`prisma-client` generator → `@/generated/prisma/*`), Postgres, zod 4, vitest, Biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-whatsapp-notifications-design.md`. Template wording EzCabinet submits to Meta: `docs/ops/whatsapp-ezcabinet-setup.md`.

## Global Constraints

- No new npm dependencies. Outbound HTTP goes through `carrierFetch` in `src/lib/logistics/http.ts`.
- Every file under `src/lib/whatsapp/` starts with `import "server-only";`.
- Every new route under `src/app/api/admin` is wrapped in `withAuth` (the auth coverage test in `src/lib/auth/__tests__/route.test.ts` fails the build otherwise). Stage advance and resend use the `"orders:markPaid"` permission.
- Template names, exactly: `order_placed`, `payment_confirmed`, `production_stage`, `delivery_booked`, `delivery_picked_up`, `delivery_delivered`, `delivery_failed`.
- Meta language codes: `en` → `en`, `zh` → `zh_CN`, `ms` → `ms`.
- Stage order, exactly: `MEASURE`, `CUTTING`, `EDGING`, `ASSEMBLY`, `QC`, `READY`.
- Retry: max 5 attempts; a row queued more than 48 h ago is failed as `"expired"`; `flush` handles at most 50 rows per run; the cron skips rows touched in the last 60 s.
- No opt-in → no `Notification` row. A delivery with no `orderId` → no row.
- UI copy is sentence case; every customer-facing string exists in `en.ts`, `zh.ts` and `ms.ts` (the dictionary test enforces identical keys and no untranslated values).
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`. Tabs for indentation (Biome).
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | `Order` fields, `Notification`, `WhatsappAutoReply`, three enums |
| `prisma/migrations/20260922000000_whatsapp_notifications/migration.sql` | hand-written migration (Known issue 12: `migrate dev` cannot run non-interactively) |
| `src/lib/orders/stage.ts` | stage order, next stage, refusal rule, reached — pure |
| `src/lib/whatsapp/templates.ts` | which event becomes which row (`draftFor`), row → Meta payload — pure |
| `src/lib/whatsapp/send.ts` | one Cloud API call, error classification, the row's next state |
| `src/lib/whatsapp/outbox.ts` | `enqueue`, `flush`, `flushSoon`, `autoReply` — the DB side |
| `src/lib/whatsapp/webhook.ts` | signature check, payload parse, status ordering — pure |
| `src/app/api/whatsapp/webhook/route.ts` | Meta's GET handshake + signed POST |
| `src/app/api/admin/orders/[id]/stage/route.ts` | advance production stage |
| `src/app/api/admin/orders/[id]/notifications/[notificationId]/resend/route.ts` | requeue a failed message |
| `src/lib/copy/{en,zh,ms}.ts` | opt-in label, stage names, auto-reply, privacy paragraph |
| existing: `src/app/api/orders/route.ts`, `…/paid/route.ts`, `…/deliveries/[id]/book/route.ts`, `src/lib/logistics/store.ts`, `src/app/api/cron/track-deliveries/route.ts` | triggers + retry |
| existing: `src/components/planner/QuoteScreen.tsx`, `src/app/[lang]/order/[token]/page.tsx`, `src/app/admin/orders/[id]/{page,OrderDetail}.tsx`, `src/app/[lang]/privacy/page.tsx` | UI |
| `scripts/whatsapp-ping.mjs` | real-API smoke test, not in CI |

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (the `Order` model at ~line 330, append new models/enums at the end)
- Create: `prisma/migrations/20260922000000_whatsapp_notifications/migration.sql`

**Interfaces:**
- Produces: Prisma models `Notification`, `WhatsappAutoReply`; `Order.whatsappOptIn`, `Order.whatsappOptInAt`, `Order.locale`, `Order.productionStage`, `Order.notifications`; enums `ProductionStage`, `NotificationKind`, `NotificationStatus` exported from `@/generated/prisma/enums`.

- [ ] **Step 1: Add fields to `Order`.** In `prisma/schema.prisma`, inside `model Order`, directly after the `paidAt DateTime?` line, add:

```prisma
  /// Ticked by the customer at checkout. No opt-in, no WhatsApp message.
  whatsappOptIn      Boolean          @default(false)
  whatsappOptInAt    DateTime?
  /// The site language the customer checked out in (`LOCALES`), which picks
  /// the WhatsApp template language. A string, not an enum, so adding a
  /// language is not a migration.
  locale             String           @default("en")
  /// Null until an admin starts production. Forward-only — `lib/orders/stage.ts`.
  productionStage    ProductionStage?
```

and after the `deliveries Delivery[]` line add:

```prisma
  notifications Notification[]
```

- [ ] **Step 2: Append the new enums and models** at the end of `prisma/schema.prisma`:

```prisma
/// The factory steps an admin advances an order through. Placeholders until
/// EzCabinet confirms its real ones — docs/ops/whatsapp-ezcabinet-setup.md.
enum ProductionStage {
  MEASURE
  CUTTING
  EDGING
  ASSEMBLY
  QC
  READY
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

/// `FAILED` is terminal until an admin presses Resend.
enum NotificationStatus {
  PENDING
  SENT
  DELIVERED
  READ
  FAILED
}

/// One WhatsApp message a customer is owed or was sent: the outbox and the
/// log the admin order page renders. Written in the same transaction as the
/// state change it reports — see `lib/whatsapp/outbox.ts`.
model Notification {
  id            String             @id @default(cuid())
  orderId       String
  order         Order              @relation(fields: [orderId], references: [id], onDelete: Cascade)
  /// A bare id, not a relation: a split consumes the delivery, and the
  /// message sent about it is still history.
  deliveryId    String?
  kind          NotificationKind
  stage         ProductionStage?
  /// One message per real-world event. A second insert for the same event is
  /// skipped — carriers report the same status by webhook and by poll.
  dedupeKey     String             @unique
  /// E.164, snapshotted — the order's phone can be corrected later.
  to            String
  template      String
  locale        String
  /// `{ body: string[], button: string }` — `TemplateVars` in templates.ts.
  vars          Json
  status        NotificationStatus @default(PENDING)
  attempts      Int                @default(0)
  lastError     String?
  metaMessageId String?            @unique
  /// When this row last entered the queue — creation or a Resend. The 48 h
  /// expiry counts from here.
  queuedAt      DateTime           @default(now())
  sentAt        DateTime?
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt

  @@index([status, queuedAt])
  @@index([orderId])
}

/// The auto-reply throttle: when we last answered this number.
model WhatsappAutoReply {
  /// E.164 of whoever messaged us.
  phone     String   @id
  repliedAt DateTime
}
```

- [ ] **Step 3: Write the migration by hand** — `prisma/migrations/20260922000000_whatsapp_notifications/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "ProductionStage" AS ENUM ('MEASURE', 'CUTTING', 'EDGING', 'ASSEMBLY', 'QC', 'READY');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ORDER_PLACED', 'PAYMENT_CONFIRMED', 'STAGE', 'DELIVERY_BOOKED', 'PICKED_UP', 'DELIVERED', 'DELIVERY_FAILED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "productionStage" "ProductionStage",
ADD COLUMN     "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsappOptInAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "kind" "NotificationKind" NOT NULL,
    "stage" "ProductionStage",
    "dedupeKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "vars" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "metaMessageId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappAutoReply" (
    "phone" TEXT NOT NULL,
    "repliedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappAutoReply_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_metaMessageId_key" ON "Notification"("metaMessageId");

-- CreateIndex
CREATE INDEX "Notification_status_queuedAt_idx" ON "Notification"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "Notification_orderId_idx" ON "Notification"("orderId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply and verify the migration matches the schema.**

```bash
pnpm db:up
pnpm prisma migrate deploy
pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

Expected: `migrate deploy` applies `20260922000000_whatsapp_notifications`; `migrate diff` prints an empty migration (`-- This is an empty migration.`). Any SQL in the diff output means the hand-written file and the schema disagree — fix the SQL file until it is empty.

- [ ] **Step 5: Regenerate the client and typecheck.**

Run: `pnpm prisma generate && pnpm typecheck`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260922000000_whatsapp_notifications
git commit -m "feat(whatsapp): notification outbox and production stage schema"
```

---

### Task 2: Copy — opt-in label, stage names, auto-reply, privacy paragraph

**Files:**
- Modify: `src/lib/copy/en.ts`, `src/lib/copy/zh.ts`, `src/lib/copy/ms.ts`
- Test: `src/lib/copy/__tests__/dictionary.test.ts` (existing — already enforces identical keys, no untranslated values, no empty strings)

**Interfaces:**
- Produces: `t.quote.whatsappOptIn`, `t.order.stages.{MEASURE,CUTTING,EDGING,ASSEMBLY,QC,READY}`, `t.whatsapp.autoReply` (contains `{number}`), `t.privacy.whatsappHeading`, `t.privacy.whatsapp`.
- Removes: `t.order.stageMeasure`, `t.order.stageBuild` (replaced by `t.order.stages.MEASURE` and the stage list; `stageMeasureDetail` stays).

- [ ] **Step 1: English.** In `src/lib/copy/en.ts`:

In the `quote` group, directly after `remeasureNote: …,` add:

```ts
		whatsappOptIn: "Send order updates to this number on WhatsApp",
```

In the `order` group, replace

```ts
		stageMeasure: "Site re-measure",
		stageMeasureDetail:
			"A designer confirms your measurements before production.",
		stageBuild: "Cabinets built in our workshop",
```

with

```ts
		stageMeasureDetail:
			"A designer confirms your measurements before production.",
		/** Production stages, in order — `lib/orders/stage.ts`. Also the words WhatsApp sends. */
		stages: {
			MEASURE: "Site re-measure",
			CUTTING: "Cutting",
			EDGING: "Edge banding",
			ASSEMBLY: "Assembly",
			QC: "Quality check",
			READY: "Ready for delivery",
		},
```

In the `privacy` group, directly after `where: …,` add:

```ts
		whatsappHeading: "WhatsApp order updates",
		whatsapp:
			"If you tick the box at checkout, we send updates about your order — payment, production steps and delivery — to your phone number on WhatsApp. WhatsApp is operated by Meta Platforms, which processes your number and these messages, possibly outside Malaysia. We send nothing else, and you can stop the updates by blocking the number.",
```

Directly before the `/** The one hard stop before checkout` comment that opens `signIn`, add a new group:

```ts
	/** Server-sent WhatsApp text — `lib/whatsapp/outbox.ts`. */
	whatsapp: {
		autoReply:
			"This number only sends EzCabinet order updates. To chat with our team, message us at {number}",
	},
```

- [ ] **Step 2: Chinese.** Same four places in `src/lib/copy/zh.ts` (same key positions as English; `stageMeasure` and `stageBuild` removed, `stageMeasureDetail` kept):

```ts
		whatsappOptIn: "通过 WhatsApp 向此号码发送订单进度",
```

```ts
		stages: {
			MEASURE: "到场重新测量",
			CUTTING: "板材切割",
			EDGING: "封边",
			ASSEMBLY: "组装",
			QC: "质量检查",
			READY: "准备送货",
		},
```

```ts
		whatsappHeading: "WhatsApp 订单通知",
		whatsapp:
			"如果您在结账时勾选此选项，我们会通过 WhatsApp 向您的电话号码发送订单进度——付款、生产步骤和送货。WhatsApp 由 Meta Platforms 运营，Meta 会处理您的号码和这些信息，处理地点可能在马来西亚境外。我们不会发送其他内容，您可以屏蔽该号码以停止接收通知。",
```

```ts
	whatsapp: {
		autoReply:
			"此号码仅用于发送 EzCabinet 订单通知。如需与我们的团队联系，请发送信息至 {number}",
	},
```

- [ ] **Step 3: Malay.** Same four places in `src/lib/copy/ms.ts`:

```ts
		whatsappOptIn: "Hantar kemas kini pesanan ke nombor ini melalui WhatsApp",
```

```ts
		stages: {
			MEASURE: "Ukur semula di tapak",
			CUTTING: "Pemotongan papan",
			EDGING: "Pelekatan jalur tepi",
			ASSEMBLY: "Pemasangan",
			QC: "Pemeriksaan kualiti",
			READY: "Sedia untuk dihantar",
		},
```

```ts
		whatsappHeading: "Kemas kini pesanan melalui WhatsApp",
		whatsapp:
			"Jika anda menanda kotak semasa pembayaran, kami akan menghantar kemas kini tentang pesanan anda — bayaran, langkah pengeluaran dan penghantaran — ke nombor telefon anda melalui WhatsApp. WhatsApp dikendalikan oleh Meta Platforms, yang memproses nombor anda dan mesej ini, mungkin di luar Malaysia. Kami tidak menghantar apa-apa lagi, dan anda boleh menghentikan kemas kini dengan menyekat nombor tersebut.",
```

```ts
	whatsapp: {
		autoReply:
			"Nombor ini hanya menghantar kemas kini pesanan EzCabinet. Untuk berbual dengan pasukan kami, hantar mesej ke {number}",
	},
```

- [ ] **Step 4: Fix the one existing reader of the removed keys.** In `src/app/[lang]/order/[token]/page.tsx`, the "What happens next" list uses `o.stageMeasure` and `o.stageBuild`. Replace the array literal

```tsx
								{[
									{ label: o.stagePaid, done: true },
									{ label: o.stageMeasure, detail: o.stageMeasureDetail },
									{ label: o.stageBuild },
									{ label: o.stageDelivery },
								].map((stage) => (
```

with (temporary — Task 9 replaces it with the full stage strip):

```tsx
								{[
									{ label: o.stagePaid, done: true },
									{ label: o.stages.MEASURE, detail: o.stageMeasureDetail },
									{ label: o.stageDelivery },
								].map((stage) => (
```

Run `grep -rn "stageMeasure\b\|stageBuild\b" src` — expected: no matches.

- [ ] **Step 5: Run the dictionary tests and typecheck.**

Run: `pnpm vitest run src/lib/copy && pnpm typecheck`
Expected: PASS. A failure listing a path means a key is missing or left in English in one locale — fix that locale.

- [ ] **Step 6: Commit**

```bash
git add src/lib/copy src/app/\[lang\]/order/\[token\]/page.tsx
git commit -m "feat(whatsapp): opt-in, stage, auto-reply and privacy copy"
```

---

### Task 3: Production stage rules

**Files:**
- Create: `src/lib/orders/stage.ts`
- Test: `src/lib/orders/__tests__/stage.test.ts`

**Interfaces:**
- Consumes: `ProductionStage` type from `@/generated/prisma/enums` (Task 1).
- Produces:
  - `STAGES: readonly ProductionStage[]` in the order above
  - `nextStage(current: ProductionStage | null): ProductionStage | null`
  - `stageRefusal(order: { status: string; productionStage: ProductionStage | null }, requested: ProductionStage): "not_paid" | "not_next_stage" | null`
  - `stageReached(current: ProductionStage | null, stage: ProductionStage): boolean`

- [ ] **Step 1: Write the failing test** — `src/lib/orders/__tests__/stage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextStage, STAGES, stageReached, stageRefusal } from "../stage";

describe("production stages", () => {
	it("runs in factory order", () => {
		expect(STAGES).toEqual([
			"MEASURE",
			"CUTTING",
			"EDGING",
			"ASSEMBLY",
			"QC",
			"READY",
		]);
	});

	it("starts at MEASURE and stops after READY", () => {
		expect(nextStage(null)).toBe("MEASURE");
		expect(nextStage("QC")).toBe("READY");
		expect(nextStage("READY")).toBeNull();
	});

	it("allows exactly the next stage of a paid order", () => {
		expect(
			stageRefusal({ status: "PAID", productionStage: "CUTTING" }, "EDGING"),
		).toBeNull();
	});

	it("refuses an unpaid order", () => {
		expect(
			stageRefusal(
				{ status: "AWAITING_PAYMENT", productionStage: null },
				"MEASURE",
			),
		).toBe("not_paid");
	});

	it("refuses a skipped, repeated or backward step", () => {
		const order = { status: "PAID", productionStage: "CUTTING" as const };
		expect(stageRefusal(order, "ASSEMBLY")).toBe("not_next_stage");
		expect(stageRefusal(order, "CUTTING")).toBe("not_next_stage");
		expect(stageRefusal(order, "MEASURE")).toBe("not_next_stage");
	});

	it("marks every stage up to the current one as reached", () => {
		expect(stageReached(null, "MEASURE")).toBe(false);
		expect(stageReached("EDGING", "CUTTING")).toBe(true);
		expect(stageReached("EDGING", "EDGING")).toBe(true);
		expect(stageReached("EDGING", "ASSEMBLY")).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/orders/__tests__/stage.test.ts`
Expected: FAIL — cannot resolve `../stage`.

- [ ] **Step 3: Implement** — `src/lib/orders/stage.ts`:

```ts
import type { ProductionStage } from "@/generated/prisma/enums";

/**
 * The factory steps a paid order moves through, in order.
 *
 * An admin advances them one at a time from `/admin/orders/[id]`; Factory
 * Tracker will push onto the same endpoint in Phase 4. Forward-only and one
 * step at a time, so a double-click or a stale tab cannot skip a step or send
 * the customer the same WhatsApp message twice.
 */
export const STAGES = [
	"MEASURE",
	"CUTTING",
	"EDGING",
	"ASSEMBLY",
	"QC",
	"READY",
] as const satisfies readonly ProductionStage[];

export function nextStage(
	current: ProductionStage | null,
): ProductionStage | null {
	const index = current === null ? -1 : STAGES.indexOf(current);
	return STAGES[index + 1] ?? null;
}

/** Why an admin may not move this order to `requested`, or null if they may. */
export function stageRefusal(
	order: { status: string; productionStage: ProductionStage | null },
	requested: ProductionStage,
): "not_paid" | "not_next_stage" | null {
	if (order.status !== "PAID") return "not_paid";
	if (nextStage(order.productionStage) !== requested) return "not_next_stage";
	return null;
}

export const stageReached = (
	current: ProductionStage | null,
	stage: ProductionStage,
): boolean =>
	current !== null && STAGES.indexOf(stage) <= STAGES.indexOf(current);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/orders/__tests__/stage.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/orders/stage.ts src/lib/orders/__tests__/stage.test.ts
git commit -m "feat(orders): forward-only production stages"
```

---

### Task 4: Templates — which event becomes which message

**Files:**
- Create: `src/lib/whatsapp/templates.ts`
- Test: `src/lib/whatsapp/__tests__/templates.test.ts`

**Interfaces:**
- Consumes: `orderRef` (`@/lib/orders/ref`), `isLocale`/`Locale` (`@/lib/copy/locales`), `LABEL` (`@/lib/logistics/carriers`), `DeliveryStatusName` (`@/lib/logistics/types`), enums from Task 1.
- Produces:
  - `NOTIFY_ORDER_SELECT` — a Prisma `select` object for the order fields a message needs
  - `type NotifyOrder` — `{ id; number; createdAt: Date; publicToken; customerName; customerPhone; totalRm: number; locale: string; whatsappOptIn: boolean }`
  - `type NotifyEvent` (union below), `type TemplateVars = { body: string[]; button: string }`, `type NotificationDraft`
  - `localeOf(value: string): Locale`
  - `deliveryKindFor(status: DeliveryStatusName): "PICKED_UP" | "DELIVERED" | "DELIVERY_FAILED" | null`
  - `draftFor(event: NotifyEvent): NotificationDraft | null`
  - `templatePayload(to: string, template: string, locale: Locale, vars: TemplateVars): object`
  - `textPayload(to: string, body: string): object`

- [ ] **Step 1: Write the failing test** — `src/lib/whatsapp/__tests__/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	deliveryKindFor,
	draftFor,
	localeOf,
	type NotifyOrder,
	templatePayload,
	textPayload,
} from "../templates";

const order: NotifyOrder = {
	id: "ord1",
	number: 14,
	createdAt: new Date("2026-08-26T04:00:00Z"),
	publicToken: "tok_order",
	customerName: "Aisyah",
	customerPhone: "+60123456789",
	totalRm: 12345.5,
	locale: "ms",
	whatsappOptIn: true,
};
const delivery = { id: "del1", publicToken: "tok_delivery" };

describe("draftFor", () => {
	it("builds nothing for a customer who did not opt in", () => {
		expect(
			draftFor({
				kind: "ORDER_PLACED",
				order: { ...order, whatsappOptIn: false },
			}),
		).toBeNull();
	});

	it("order placed: name, ref, total; button opens the order", () => {
		expect(draftFor({ kind: "ORDER_PLACED", order })).toEqual({
			orderId: "ord1",
			deliveryId: null,
			kind: "ORDER_PLACED",
			stage: null,
			dedupeKey: "order:ord1:placed",
			to: "+60123456789",
			template: "order_placed",
			locale: "ms",
			vars: {
				body: ["Aisyah", "IC-20260826-014", "12,345.50"],
				button: "tok_order",
			},
		});
	});

	it("payment confirmed", () => {
		const draft = draftFor({ kind: "PAYMENT_CONFIRMED", order });
		expect(draft?.dedupeKey).toBe("order:ord1:paid");
		expect(draft?.template).toBe("payment_confirmed");
		expect(draft?.vars).toEqual({
			body: ["IC-20260826-014"],
			button: "tok_order",
		});
	});

	it("stage: one key per stage, label as given", () => {
		const draft = draftFor({
			kind: "STAGE",
			order,
			stage: "ASSEMBLY",
			stageLabel: "Pemasangan",
		});
		expect(draft?.dedupeKey).toBe("order:ord1:stage:ASSEMBLY");
		expect(draft?.stage).toBe("ASSEMBLY");
		expect(draft?.vars.body).toEqual(["IC-20260826-014", "Pemasangan"]);
	});

	it("delivery booked: carrier label and tracking number; button opens tracking", () => {
		const draft = draftFor({
			kind: "DELIVERY_BOOKED",
			order,
			delivery: { ...delivery, carrierId: "lalamove", carrierOrderId: "LLM-9" },
		});
		expect(draft?.dedupeKey).toBe("delivery:del1:booked");
		expect(draft?.deliveryId).toBe("del1");
		expect(draft?.vars).toEqual({
			body: ["IC-20260826-014", "Lalamove", "LLM-9"],
			button: "tok_delivery",
		});
	});

	it("the same carrier reading twice gives the same key", () => {
		const event = { kind: "DELIVERED" as const, order, delivery };
		expect(draftFor(event)?.dedupeKey).toBe("delivery:del1:DELIVERED");
		expect(draftFor(event)?.dedupeKey).toBe(draftFor(event)?.dedupeKey);
		expect(draftFor(event)?.template).toBe("delivery_delivered");
	});

	it("falls back to English for a locale we do not serve", () => {
		expect(
			draftFor({ kind: "ORDER_PLACED", order: { ...order, locale: "fr" } })
				?.locale,
		).toBe("en");
	});
});

describe("deliveryKindFor", () => {
	it("messages only the three moments a customer acts on", () => {
		expect(deliveryKindFor("PICKED_UP")).toBe("PICKED_UP");
		expect(deliveryKindFor("DELIVERED")).toBe("DELIVERED");
		expect(deliveryKindFor("FAILED")).toBe("DELIVERY_FAILED");
		expect(deliveryKindFor("CANCELLED")).toBe("DELIVERY_FAILED");
		expect(deliveryKindFor("DRIVER_ASSIGNED")).toBeNull();
		expect(deliveryKindFor("IN_TRANSIT")).toBeNull();
		expect(deliveryKindFor("BOOKED")).toBeNull();
	});
});

describe("payloads", () => {
	it("template: Meta's shape, language code mapped, + stripped", () => {
		expect(
			templatePayload("+60123456789", "production_stage", "zh", {
				body: ["IC-1", "组装"],
				button: "tok",
			}),
		).toEqual({
			messaging_product: "whatsapp",
			to: "60123456789",
			type: "template",
			template: {
				name: "production_stage",
				language: { code: "zh_CN" },
				components: [
					{
						type: "body",
						parameters: [
							{ type: "text", text: "IC-1" },
							{ type: "text", text: "组装" },
						],
					},
					{
						type: "button",
						sub_type: "url",
						index: "0",
						parameters: [{ type: "text", text: "tok" }],
					},
				],
			},
		});
	});

	it("text", () => {
		expect(textPayload("+60123456789", "hi")).toEqual({
			messaging_product: "whatsapp",
			to: "60123456789",
			type: "text",
			text: { body: "hi" },
		});
	});

	it("localeOf keeps a served locale", () => {
		expect(localeOf("zh")).toBe("zh");
		expect(localeOf("")).toBe("en");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/whatsapp/__tests__/templates.test.ts`
Expected: FAIL — cannot resolve `../templates`.

- [ ] **Step 3: Implement** — `src/lib/whatsapp/templates.ts`:

```ts
import "server-only";
import type {
	NotificationKind,
	ProductionStage,
} from "@/generated/prisma/enums";
import { isLocale, type Locale } from "@/lib/copy/locales";
import { LABEL as CARRIER_LABEL } from "@/lib/logistics/carriers";
import type { DeliveryStatusName } from "@/lib/logistics/types";
import { orderRef } from "@/lib/orders/ref";

/**
 * Which event becomes which WhatsApp message.
 *
 * Every business-initiated message is a template Meta approved in advance, so
 * all this decides is the template name, the positional variables and the link
 * suffix. The wording lives in `docs/ops/whatsapp-ezcabinet-setup.md` — the
 * copy EzCabinet submits — and the variable order here must match it.
 */

/** The order fields a message needs. Select exactly these wherever one is built. */
export const NOTIFY_ORDER_SELECT = {
	id: true,
	number: true,
	createdAt: true,
	publicToken: true,
	customerName: true,
	customerPhone: true,
	totalRm: true,
	locale: true,
	whatsappOptIn: true,
} as const;

export type NotifyOrder = {
	id: string;
	number: number;
	createdAt: Date;
	publicToken: string;
	customerName: string;
	customerPhone: string;
	totalRm: number;
	locale: string;
	whatsappOptIn: boolean;
};

type DeliveryRef = { id: string; publicToken: string };

export type NotifyEvent =
	| { kind: "ORDER_PLACED" | "PAYMENT_CONFIRMED"; order: NotifyOrder }
	| {
			kind: "STAGE";
			order: NotifyOrder;
			stage: ProductionStage;
			/** Already translated into the order's locale — the site dictionary's word. */
			stageLabel: string;
	  }
	| {
			kind: "DELIVERY_BOOKED";
			order: NotifyOrder;
			delivery: DeliveryRef & { carrierId: string; carrierOrderId: string };
	  }
	| {
			kind: "PICKED_UP" | "DELIVERED" | "DELIVERY_FAILED";
			order: NotifyOrder;
			delivery: DeliveryRef;
	  };

/** Body variables in template order, and the URL button's dynamic suffix. */
export type TemplateVars = { body: string[]; button: string };

export type NotificationDraft = {
	orderId: string;
	deliveryId: string | null;
	kind: NotificationKind;
	stage: ProductionStage | null;
	dedupeKey: string;
	to: string;
	template: string;
	locale: Locale;
	vars: TemplateVars;
};

const TEMPLATE: Record<NotificationKind, string> = {
	ORDER_PLACED: "order_placed",
	PAYMENT_CONFIRMED: "payment_confirmed",
	STAGE: "production_stage",
	DELIVERY_BOOKED: "delivery_booked",
	PICKED_UP: "delivery_picked_up",
	DELIVERED: "delivery_delivered",
	DELIVERY_FAILED: "delivery_failed",
};

/** Meta's language codes for the locales we serve. */
const LANGUAGE: Record<Locale, string> = { en: "en", zh: "zh_CN", ms: "ms" };

export const localeOf = (value: string): Locale =>
	isLocale(value) ? value : "en";

/**
 * The delivery statuses a customer hears about. Assigned-driver and in-transit
 * pings are noise; picked up, delivered and failed are what they act on.
 */
export function deliveryKindFor(
	status: DeliveryStatusName,
): "PICKED_UP" | "DELIVERED" | "DELIVERY_FAILED" | null {
	if (status === "PICKED_UP" || status === "DELIVERED") return status;
	if (status === "FAILED" || status === "CANCELLED") return "DELIVERY_FAILED";
	return null;
}

const money = (amount: number) =>
	amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});

/** The row to enqueue for an event, or null when the customer did not opt in. */
export function draftFor(event: NotifyEvent): NotificationDraft | null {
	const { order } = event;
	if (!order.whatsappOptIn) return null;
	const ref = orderRef(order.number, order.createdAt);
	const base = {
		orderId: order.id,
		deliveryId: null,
		kind: event.kind,
		stage: null,
		to: order.customerPhone,
		template: TEMPLATE[event.kind],
		locale: localeOf(order.locale),
	};

	switch (event.kind) {
		case "ORDER_PLACED":
			return {
				...base,
				dedupeKey: `order:${order.id}:placed`,
				vars: {
					body: [order.customerName, ref, money(order.totalRm)],
					button: order.publicToken,
				},
			};
		case "PAYMENT_CONFIRMED":
			return {
				...base,
				dedupeKey: `order:${order.id}:paid`,
				vars: { body: [ref], button: order.publicToken },
			};
		case "STAGE":
			return {
				...base,
				stage: event.stage,
				dedupeKey: `order:${order.id}:stage:${event.stage}`,
				vars: { body: [ref, event.stageLabel], button: order.publicToken },
			};
		case "DELIVERY_BOOKED":
			return {
				...base,
				deliveryId: event.delivery.id,
				dedupeKey: `delivery:${event.delivery.id}:booked`,
				vars: {
					body: [
						ref,
						CARRIER_LABEL[event.delivery.carrierId] ?? event.delivery.carrierId,
						event.delivery.carrierOrderId,
					],
					button: event.delivery.publicToken,
				},
			};
		default:
			return {
				...base,
				deliveryId: event.delivery.id,
				dedupeKey: `delivery:${event.delivery.id}:${event.kind}`,
				vars: { body: [ref], button: event.delivery.publicToken },
			};
	}
}

const recipient = (to: string) => to.replace(/^\+/, "");

export function templatePayload(
	to: string,
	template: string,
	locale: Locale,
	vars: TemplateVars,
) {
	return {
		messaging_product: "whatsapp",
		to: recipient(to),
		type: "template",
		template: {
			name: template,
			language: { code: LANGUAGE[locale] },
			components: [
				{
					type: "body",
					parameters: vars.body.map((text) => ({ type: "text", text })),
				},
				{
					type: "button",
					sub_type: "url",
					index: "0",
					parameters: [{ type: "text", text: vars.button }],
				},
			],
		},
	};
}

/** Free-form text — only allowed inside the 24 h after the customer wrote to us. */
export const textPayload = (to: string, body: string) => ({
	messaging_product: "whatsapp",
	to: recipient(to),
	type: "text",
	text: { body },
});
```

Note: `LABEL` in `carriers.ts` is `Record<string, string>`, so `?? carrierId` is the fallback for an id not in the list.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/whatsapp/__tests__/templates.test.ts`
Expected: PASS. If the `IC-20260826-014` assertion fails, check `orderRef` — `2026-08-26T04:00:00Z` is noon in Kuala Lumpur, so the date is the 26th.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/templates.ts src/lib/whatsapp/__tests__/templates.test.ts
git commit -m "feat(whatsapp): events to Meta template payloads"
```

---

### Task 5: Send — one Cloud API call and what it means for the row

**Files:**
- Create: `src/lib/whatsapp/send.ts`
- Test: `src/lib/whatsapp/__tests__/send.test.ts`

**Interfaces:**
- Consumes: `carrierFetch`, `CarrierHttpError` (`@/lib/logistics/http`).
- Produces:
  - `whatsappConfigured(): boolean`
  - `type SendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; error: string }`
  - `classify(status: number, body: string): { retryable: boolean; error: string }`
  - `sendMessage(payload: object): Promise<SendResult>`
  - `MAX_ATTEMPTS = 5`
  - `nextState(result: SendResult, attempts: number, now: Date)` → the `data` for `prisma.notification.update`

- [ ] **Step 1: Write the failing test** — `src/lib/whatsapp/__tests__/send.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify, nextState, sendMessage } from "../send";

const metaError = (code: number, message = "boom") =>
	JSON.stringify({ error: { code, message } });

function stubFetch(status: number, body: string) {
	const fetchMock = vi.fn(async () => new Response(body, { status }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	process.env.WHATSAPP_TOKEN = "t0ken";
	process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
});
afterEach(() => {
	vi.unstubAllGlobals();
	process.env.WHATSAPP_TOKEN = undefined;
	process.env.WHATSAPP_PHONE_NUMBER_ID = undefined;
});

describe("classify", () => {
	it("retries Meta's own trouble", () => {
		expect(classify(500, "").retryable).toBe(true);
		expect(classify(429, "").retryable).toBe(true);
	});

	it("retries rate limits Meta reports as 400", () => {
		expect(classify(400, metaError(131056)).retryable).toBe(true);
		expect(classify(400, metaError(130429)).retryable).toBe(true);
	});

	it("never retries a refusal that will be refused again", () => {
		const result = classify(400, metaError(132001, "Template does not exist"));
		expect(result).toEqual({
			retryable: false,
			error: "132001: Template does not exist",
		});
	});

	it("keeps an unparseable body as the error", () => {
		expect(classify(400, "nope")).toEqual({
			retryable: false,
			error: "400: nope",
		});
	});
});

describe("sendMessage", () => {
	it("posts to the phone number's messages edge with the bearer token", async () => {
		const fetchMock = stubFetch(
			200,
			JSON.stringify({ messages: [{ id: "wamid.1" }] }),
		);
		expect(await sendMessage({ hello: 1 })).toEqual({
			ok: true,
			messageId: "wamid.1",
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toMatch(/graph\.facebook\.com\/v[\d.]+\/123\/messages$/);
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer t0ken",
		);
	});

	it("is never retried by the HTTP helper — a resend is a duplicate message", async () => {
		const fetchMock = stubFetch(503, "");
		const result = await sendMessage({});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ ok: false, retryable: true });
	});

	it("treats a dropped connection as retryable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		expect(await sendMessage({})).toEqual({
			ok: false,
			retryable: true,
			error: "fetch failed",
		});
	});
});

describe("nextState", () => {
	const now = new Date("2026-09-22T00:00:00Z");

	it("sent", () => {
		expect(nextState({ ok: true, messageId: "w" }, 1, now)).toEqual({
			status: "SENT",
			metaMessageId: "w",
			sentAt: now,
			lastError: null,
		});
	});

	it("retryable stays pending until the fifth attempt", () => {
		const fail = { ok: false as const, retryable: true, error: "503" };
		expect(nextState(fail, 4, now)).toEqual({ lastError: "503" });
		expect(nextState(fail, 5, now)).toEqual({
			status: "FAILED",
			lastError: "503",
		});
	});

	it("permanent fails at once", () => {
		expect(
			nextState({ ok: false, retryable: false, error: "x" }, 1, now),
		).toEqual({ status: "FAILED", lastError: "x" });
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/whatsapp/__tests__/send.test.ts`
Expected: FAIL — cannot resolve `../send`.

- [ ] **Step 3: Implement** — `src/lib/whatsapp/send.ts`:

```ts
import "server-only";
import { CarrierHttpError, carrierFetch } from "@/lib/logistics/http";

/**
 * One call to the WhatsApp Cloud API, and what its answer means for the row.
 *
 * Through `carrierFetch` for its timeout and trace, never its retry: sending is
 * not idempotent — a retried send is a second message on the customer's phone —
 * so retrying is the outbox's decision, on the next flush.
 *
 * ponytail: Graph API version pinned. Meta retires a version about two years
 * after release; bump this when the developer dashboard warns.
 */
const GRAPH = "https://graph.facebook.com/v23.0";

export const MAX_ATTEMPTS = 5;

export const whatsappConfigured = (): boolean =>
	Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

export type SendResult =
	| { ok: true; messageId: string }
	| { ok: false; retryable: boolean; error: string };

/**
 * Meta's throttling codes. They come back as HTTP 400, so the status alone
 * would read them as permanent and drop a message that just needed waiting for.
 */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

export function classify(
	status: number,
	body: string,
): { retryable: boolean; error: string } {
	let code: number | undefined;
	let message = body.trim().slice(0, 300);
	try {
		const parsed = JSON.parse(body) as {
			error?: { code?: number; message?: string };
		};
		code = parsed.error?.code;
		message = parsed.error?.message ?? message;
	} catch {
		// Not JSON — the raw body is the explanation.
	}
	return {
		retryable:
			status === 429 ||
			status >= 500 ||
			(code !== undefined && RATE_LIMIT_CODES.has(code)),
		error: `${code ?? status}: ${message}`,
	};
}

export async function sendMessage(payload: object): Promise<SendResult> {
	try {
		const response = await carrierFetch<{ messages?: { id: string }[] }>(
			`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
			{
				carrierId: "whatsapp",
				method: "POST",
				headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
				body: payload,
			},
		);
		const messageId = response?.messages?.[0]?.id;
		return messageId
			? { ok: true, messageId }
			: { ok: false, retryable: false, error: "no message id in response" };
	} catch (error) {
		if (error instanceof CarrierHttpError) {
			return { ok: false, ...classify(error.status, error.body) };
		}
		// Timeout or dropped connection: the message may not have gone. Retrying
		// risks a duplicate; not retrying risks silence. Silence is worse.
		return { ok: false, retryable: true, error: (error as Error).message };
	}
}

/** The row's update after a send attempt; `attempts` already counts this one. */
export function nextState(result: SendResult, attempts: number, now: Date) {
	if (result.ok) {
		return {
			status: "SENT" as const,
			metaMessageId: result.messageId,
			sentAt: now,
			lastError: null,
		};
	}
	if (result.retryable && attempts < MAX_ATTEMPTS) {
		return { lastError: result.error };
	}
	return { status: "FAILED" as const, lastError: result.error };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/whatsapp/__tests__/send.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/send.ts src/lib/whatsapp/__tests__/send.test.ts
git commit -m "feat(whatsapp): Cloud API send and error classification"
```

---

### Task 6: Outbox — enqueue, flush, retry on the cron

**Files:**
- Create: `src/lib/whatsapp/outbox.ts`
- Modify: `src/app/api/cron/track-deliveries/route.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/catalogue/db`), `Prisma` (`@/generated/prisma/client`), Task 4 (`NotificationDraft`, `TemplateVars`, `localeOf`, `templatePayload`, `textPayload`), Task 5 (`sendMessage`, `nextState`, `whatsappConfigured`), `getDictionary` (`@/lib/copy/dictionary`), `fill` (`@/lib/copy/fill`).
- Produces:
  - `enqueue(tx: Prisma.TransactionClient, drafts: (NotificationDraft | null)[]): Promise<string[]>` — ids of rows actually inserted
  - `flush(ids?: string[]): Promise<{ sent: number; failed: number }>`
  - `flushSoon(ids: string[]): void` — schedules `flush(ids)` after the response
  - `autoReply(phone: string): Promise<void>` — used by Task 10

This module is all database I/O; its decisions are the pure functions tested in Tasks 4 and 5. It is exercised end to end in Task 11's manual check.

- [ ] **Step 1: Implement** — `src/lib/whatsapp/outbox.ts`:

```ts
import "server-only";
import { after } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { nextState, sendMessage, whatsappConfigured } from "./send";
import {
	localeOf,
	type NotificationDraft,
	type TemplateVars,
	templatePayload,
	textPayload,
} from "./templates";

/**
 * The WhatsApp outbox.
 *
 * A trigger calls `enqueue` inside the transaction that changes the state it
 * reports, so "the order is paid" and "the customer must be told" commit
 * together. `flushSoon` sends after the response; the tracking cron calls
 * `flush()` to retry whatever is still pending.
 */

const EXPIRE_MS = 48 * 60 * 60 * 1000;
const SETTLE_MS = 60 * 1000;
const MAX_PER_RUN = 50;
const AUTO_REPLY_EVERY_MS = 24 * 60 * 60 * 1000;

/** Insert the drafts that are not null; a repeated `dedupeKey` is skipped. */
export async function enqueue(
	tx: Prisma.TransactionClient,
	drafts: (NotificationDraft | null)[],
): Promise<string[]> {
	const data = drafts
		.filter((draft): draft is NotificationDraft => draft !== null)
		.map((draft) => ({ ...draft, vars: draft.vars as never }));
	if (data.length === 0) return [];
	const rows = await tx.notification.createManyAndReturn({
		data,
		skipDuplicates: true,
		select: { id: true },
	});
	return rows.map((row) => row.id);
}

/**
 * Send pending rows: the given ids, or — from the cron — everything pending
 * that nobody has touched for a minute.
 *
 * Each row is claimed by bumping `attempts` conditionally before it is sent,
 * so the post-response flush and a cron run cannot both send it. The cron's
 * one-minute settle keeps it off rows a request is still flushing.
 */
export async function flush(
	ids?: string[],
): Promise<{ sent: number; failed: number }> {
	if (!whatsappConfigured()) {
		// Local dev and preview: rows wait, and expire after 48 h. Never a throw —
		// a missing token must not break checkout.
		if (ids?.length) console.warn("WHATSAPP_TOKEN unset; message left pending");
		return { sent: 0, failed: 0 };
	}

	const now = Date.now();
	await prisma.notification.updateMany({
		where: { status: "PENDING", queuedAt: { lt: new Date(now - EXPIRE_MS) } },
		data: { status: "FAILED", lastError: "expired" },
	});

	const rows = await prisma.notification.findMany({
		where: ids
			? { id: { in: ids }, status: "PENDING" }
			: { status: "PENDING", updatedAt: { lt: new Date(now - SETTLE_MS) } },
		orderBy: { queuedAt: "asc" },
		take: MAX_PER_RUN,
	});

	let sent = 0;
	let failed = 0;
	for (const row of rows) {
		const claimed = await prisma.notification.updateMany({
			where: { id: row.id, status: "PENDING", attempts: row.attempts },
			data: { attempts: { increment: 1 } },
		});
		if (claimed.count === 0) continue;

		const result = await sendMessage(
			templatePayload(
				row.to,
				row.template,
				localeOf(row.locale),
				row.vars as unknown as TemplateVars,
			),
		);
		await prisma.notification.update({
			where: { id: row.id },
			data: nextState(result, row.attempts + 1, new Date()),
		});
		if (result.ok) {
			sent++;
		} else {
			failed++;
			console.error(
				JSON.stringify({
					type: "WHATSAPP_SEND_FAILED",
					notificationId: row.id,
					retryable: result.retryable,
					message: result.error,
				}),
			);
		}
	}
	return { sent, failed };
}

/** Send these rows once the response is on its way. */
export function flushSoon(ids: string[]): void {
	if (ids.length === 0) return;
	after(() =>
		flush(ids).catch((error) =>
			console.error("WhatsApp flush failed", (error as Error).message),
		),
	);
}

/**
 * Answer someone who wrote to the updates number, at most once a day.
 *
 * Free-form text is allowed here because the customer just opened the 24 h
 * window. What they wrote is not stored — nothing reads it.
 *
 * ponytail: read-then-write throttle; two messages in the same instant can
 * both be answered. Harmless at this volume.
 */
export async function autoReply(phone: string): Promise<void> {
	const sales = process.env.WHATSAPP_SALES_NUMBER ?? "";
	if (!whatsappConfigured() || sales === "") return;

	const last = await prisma.whatsappAutoReply.findUnique({ where: { phone } });
	if (last && Date.now() - last.repliedAt.getTime() < AUTO_REPLY_EVERY_MS) {
		return;
	}
	const now = new Date();
	await prisma.whatsappAutoReply.upsert({
		where: { phone },
		create: { phone, repliedAt: now },
		update: { repliedAt: now },
	});

	const order = await prisma.order.findFirst({
		where: { customerPhone: phone },
		orderBy: { createdAt: "desc" },
		select: { locale: true },
	});
	const t = await getDictionary(localeOf(order?.locale ?? "en"));
	const result = await sendMessage(
		textPayload(
			phone,
			fill(t.whatsapp.autoReply, {
				number: `https://wa.me/${sales.replace(/\D/g, "")}`,
			}),
		),
	);
	if (!result.ok) {
		console.error(
			JSON.stringify({ type: "WHATSAPP_AUTOREPLY_FAILED", message: result.error }),
		);
	}
}
```

Check `fill`'s signature before using it: `sed -n 1,17p src/lib/copy/fill.ts`. It takes `(template: string, values: Record<string, string | number>)` — if it differs, adapt the two call sites in this file.

- [ ] **Step 2: Retry from the tracking cron.** In `src/app/api/cron/track-deliveries/route.ts`, add the import

```ts
import { flush } from "@/lib/whatsapp/outbox";
```

and replace the final

```ts
	return NextResponse.json({ ok: true, polled, failed });
```

with

```ts
	// The WhatsApp outbox's retry pass rides on this cron rather than adding a
	// second one: same cadence, same auth, and the polls above have just queued
	// whatever deliveries moved.
	const notifications = await flush().catch((error) => {
		console.error("WhatsApp retry failed", (error as Error).message);
		return null;
	});

	return NextResponse.json({ ok: true, polled, failed, notifications });
```

Also update the file's doc comment: after the paragraph starting "Webhooks are the fast path", add one line: `It also retries pending WhatsApp messages — lib/whatsapp/outbox.ts.`

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: pass. If `createManyAndReturn` is flagged as not existing, run `pnpm prisma generate` (Task 1) first.

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp/outbox.ts src/app/api/cron/track-deliveries/route.ts
git commit -m "feat(whatsapp): outbox flush, retry on the tracking cron, auto-reply"
```

---

### Task 7: Order placed — checkout opt-in and the first message

**Files:**
- Modify: `src/app/api/orders/route.ts`
- Modify: `src/components/planner/QuoteScreen.tsx`

**Interfaces:**
- Consumes: `LOCALES` (`@/lib/copy/locales`), `NOTIFY_ORDER_SELECT`, `draftFor` (Task 4), `enqueue`, `flushSoon` (Task 6), `t.quote.whatsappOptIn` (Task 2).
- Produces: `POST /api/orders` accepts `whatsappOptIn: boolean` (default `false`) and `locale: "en" | "zh" | "ms"` (default `"en"`).

- [ ] **Step 1: Accept and store the opt-in and locale.** In `src/app/api/orders/route.ts`:

Add imports:

```ts
import { LOCALES } from "@/lib/copy/locales";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import { draftFor, NOTIFY_ORDER_SELECT } from "@/lib/whatsapp/templates";
```

In `orderInputSchema`, after `remeasureAccepted: z.literal(true),` add:

```ts
	/** Unticked by default. No opt-in, no WhatsApp message — PDPA and Meta both require it. */
	whatsappOptIn: z.boolean().default(false),
	/** The site language, so messages arrive in it. */
	locale: z.enum(LOCALES).default("en"),
```

Change `const { roomId, finishId, layout, customer } = parsed.data;` to

```ts
	const { roomId, finishId, layout, customer, whatsappOptIn, locale } =
		parsed.data;
```

Replace the whole `const order = await prisma.order.create({ … });` statement and the `return` after it with:

```ts
	const price = priceOrder(layout, finishId, published.data);
	const { order, notificationIds } = await prisma.$transaction(async (tx) => {
		const order = await tx.order.create({
			data: {
				customerName: customer.name,
				customerPhone: phone,
				customerEmail: customer.email,
				siteAddress: customer.siteAddress,
				addressNotes: customer.addressNotes || null,
				roomId,
				finishId,
				design: { schemaVersion: ORDER_DESIGN_VERSION, layout } as never,
				catalogueVersionId: published.id,
				breakdown: price.breakdown as never,
				cabinetsRm: price.cabinetsRm,
				deliveryRm: price.deliveryRm,
				totalRm: price.totalRm,
				paymentProvider: PAYMENT_PROVIDER,
				userId: user?.id ?? null,
				whatsappOptIn,
				whatsappOptInAt: whatsappOptIn ? new Date() : null,
				locale,
			},
			select: NOTIFY_ORDER_SELECT,
		});
		const notificationIds = await enqueue(tx, [
			draftFor({ kind: "ORDER_PLACED", order }),
		]);
		return { order, notificationIds };
	});
	flushSoon(notificationIds);

	return NextResponse.json({ token: order.publicToken }, { status: 201 });
```

(The existing `const price = priceOrder(…)` line moves inside this replacement — make sure it appears once.)

- [ ] **Step 2: The checkbox.** In `src/components/planner/QuoteScreen.tsx`, directly after the re-measure `<label className="mt-1 flex items-start gap-2">…</label>` block, add:

```tsx
						<label className="flex items-start gap-2">
							<input
								name="whatsappOptIn"
								type="checkbox"
								disabled={busy}
								className="mt-0.5"
							/>
							<span className="text-[12px] text-neutral-500 leading-4">
								{t.quote.whatsappOptIn}
							</span>
						</label>
```

In `placeOrder`, the body currently ends with `remeasureAccepted: true,`. After it add:

```tsx
				whatsappOptIn: new FormData(form).get("whatsappOptIn") === "on",
				locale,
```

(`locale` is already in scope from `const locale = useLocale();`.)

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: pass.

Manual: `pnpm dev`, place an order with the box ticked (with `AUTH_ENABLED=false` locally). Then:

```bash
pnpm prisma studio
```

Expected: the order has `whatsappOptIn = true`, `locale` = the URL's language, and one `Notification` row `ORDER_PLACED`, `PENDING` (no token locally, so it stays pending). Place a second order unticked: no `Notification` row.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/orders/route.ts src/components/planner/QuoteScreen.tsx
git commit -m "feat(whatsapp): checkout opt-in and order-placed message"
```

---

### Task 8: Payment confirmed, delivery booked, delivery progress

**Files:**
- Modify: `src/app/api/admin/orders/[id]/paid/route.ts`
- Modify: `src/app/api/admin/deliveries/[id]/book/route.ts`
- Modify: `src/lib/logistics/store.ts` (`applyTrackingUpdate`)

**Interfaces:**
- Consumes: `NOTIFY_ORDER_SELECT`, `draftFor`, `deliveryKindFor` (Task 4), `enqueue`, `flushSoon` (Task 6).

- [ ] **Step 1: Payment confirmed.** In `src/app/api/admin/orders/[id]/paid/route.ts` add imports:

```ts
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import { draftFor, NOTIFY_ORDER_SELECT } from "@/lib/whatsapp/templates";
```

Replace

```ts
		const { count } = await prisma.order.updateMany({
			where: { id, status: "AWAITING_PAYMENT" },
			data: {
				status: "PAID",
				paidAt: new Date(),
				paidByUserId: user.id === BYPASS_USER.id ? null : user.id,
				paymentRef: parsed.data.paymentRef,
			},
		});
		if (count === 1) return NextResponse.json({ ok: true });
```

with

```ts
		const notificationIds = await prisma.$transaction(async (tx) => {
			const { count } = await tx.order.updateMany({
				where: { id, status: "AWAITING_PAYMENT" },
				data: {
					status: "PAID",
					paidAt: new Date(),
					paidByUserId: user.id === BYPASS_USER.id ? null : user.id,
					paymentRef: parsed.data.paymentRef,
				},
			});
			if (count !== 1) return null;
			const order = await tx.order.findUniqueOrThrow({
				where: { id },
				select: NOTIFY_ORDER_SELECT,
			});
			return enqueue(tx, [draftFor({ kind: "PAYMENT_CONFIRMED", order })]);
		});
		if (notificationIds) {
			flushSoon(notificationIds);
			return NextResponse.json({ ok: true });
		}
```

- [ ] **Step 2: Delivery booked — outside the booking write.** In `src/app/api/admin/deliveries/[id]/book/route.ts` add imports:

```ts
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import { draftFor, NOTIFY_ORDER_SELECT } from "@/lib/whatsapp/templates";
```

Directly after the `const booked = await prisma.delivery.update({ … });` statement and before `return NextResponse.json({ delivery: booked }, { status: 201 });`, add:

```ts
			// Deliberately not in the booking write's transaction: that write
			// records money already spent at the carrier, and a failed insert here
			// must never roll it back — the row would look unbooked and a retry
			// would buy a second lorry.
			if (booked.orderId) {
				try {
					const ids = await prisma.$transaction(async (tx) => {
						const order = await tx.order.findUniqueOrThrow({
							where: { id: booked.orderId as string },
							select: NOTIFY_ORDER_SELECT,
						});
						return enqueue(tx, [
							draftFor({
								kind: "DELIVERY_BOOKED",
								order,
								delivery: {
									id: booked.id,
									publicToken: booked.publicToken,
									carrierId,
									carrierOrderId: booking.carrierOrderId,
								},
							}),
						]);
					});
					flushSoon(ids);
				} catch (error) {
					console.error(
						JSON.stringify({
							type: "WHATSAPP_ENQUEUE_FAILED",
							deliveryId: booked.id,
							message: (error as Error).message,
						}),
					);
				}
			}
```

- [ ] **Step 3: Delivery progress.** In `src/lib/logistics/store.ts` add imports:

```ts
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import {
	deliveryKindFor,
	draftFor,
	NOTIFY_ORDER_SELECT,
} from "@/lib/whatsapp/templates";
```

In `applyTrackingUpdate`, change the read to include the order:

```ts
	const current = await prisma.delivery.findUniqueOrThrow({
		where: { id: deliveryId },
		include: { order: { select: NOTIFY_ORDER_SELECT } },
	});
```

After the `const moves = …;` statement add:

```ts
	// `moves` already proved `next` is a status; TypeScript cannot see that.
	const kind = moves ? deliveryKindFor(next as DeliveryStatusName) : null;
```

Replace `const [row] = await prisma.$transaction([ …delivery.update…, …deliveryEvent.create… ]);` with an interactive transaction that keeps both writes byte-for-byte and adds the enqueue:

```ts
	const { row, notificationIds } = await prisma.$transaction(async (tx) => {
		const row = await tx.delivery.update({
			/* the existing `where` and `data` of prisma.delivery.update, unchanged */
		});
		await tx.deliveryEvent.create({
			/* the existing `data` of prisma.deliveryEvent.create, unchanged */
		});
		// A job an admin made by hand has no order, so no consent record and no
		// message. A repeated reading re-uses the dedupe key and inserts nothing.
		const notificationIds =
			kind && current.order
				? await enqueue(tx, [
						draftFor({
							kind,
							order: current.order,
							delivery: { id: deliveryId, publicToken: current.publicToken },
						}),
					])
				: [];
		return { row, notificationIds };
	});
	flushSoon(notificationIds);

	return row;
```

When editing, move the existing `where:`/`data:` object literals into the two `/* … */` slots exactly as they are; only `prisma.` becomes `tx.`.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: pass (logistics tests do not touch `applyTrackingUpdate`'s DB path).

Manual (local, no token): mark the opted-in order from Task 7 paid at `/admin/orders/[id]` → a `PAYMENT_CONFIRMED` row. Create a delivery from it and book with the `manual` carrier → a `DELIVERY_BOOKED` row. Advance it via the delivery page's manual status control to picked up, then picked up again (or poll twice) → exactly one `PICKED_UP` row.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/orders/\[id\]/paid/route.ts src/app/api/admin/deliveries/\[id\]/book/route.ts src/lib/logistics/store.ts
git commit -m "feat(whatsapp): payment, booking and delivery progress messages"
```

---

### Task 9: Production stages and the messages log — admin and customer pages

**Files:**
- Create: `src/app/api/admin/orders/[id]/stage/route.ts`
- Create: `src/app/api/admin/orders/[id]/notifications/[notificationId]/resend/route.ts`
- Modify: `src/app/admin/orders/[id]/page.tsx`
- Modify: `src/app/admin/orders/[id]/OrderDetail.tsx`
- Modify: `src/app/[lang]/order/[token]/page.tsx`

**Interfaces:**
- Consumes: `STAGES`, `stageRefusal`, `stageReached`, `nextStage` (Task 3), `draftFor`, `NOTIFY_ORDER_SELECT`, `localeOf` (Task 4), `enqueue`, `flushSoon` (Task 6), `getDictionary`, `en.order.stages` (Task 2).
- Produces: `POST /api/admin/orders/[id]/stage` body `{ stage: ProductionStage }` → `200 { ok: true }` | `404 not_found` | `409 not_paid` | `409 not_next_stage`; `POST /api/admin/orders/[id]/notifications/[notificationId]/resend` → `200 { ok: true }` | `409 not_failed`.

- [ ] **Step 1: Stage route** — `src/app/api/admin/orders/[id]/stage/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { STAGES, stageRefusal } from "@/lib/orders/stage";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import {
	draftFor,
	localeOf,
	NOTIFY_ORDER_SELECT,
} from "@/lib/whatsapp/templates";

export const runtime = "nodejs";

const bodySchema = z.object({ stage: z.enum(STAGES) });

/**
 * Advance a paid order one production stage, and tell the customer.
 *
 * The body names the stage the admin saw as next, and the update is
 * conditional on the stage it was read at — so a double-click or a stale tab
 * is refused rather than skipping a step or messaging twice. Gated like
 * marking paid: the same people run the order today.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"orders:markPaid",
	async (request, { params }) => {
		const { id } = await params;
		const parsed = bodySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid_body", issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		const { stage } = parsed.data;

		const result = await prisma.$transaction(async (tx) => {
			const order = await tx.order.findUnique({
				where: { id },
				select: { ...NOTIFY_ORDER_SELECT, status: true, productionStage: true },
			});
			if (!order) return { error: "not_found" as const };
			const refusal = stageRefusal(order, stage);
			if (refusal) return { error: refusal };

			const { count } = await tx.order.updateMany({
				where: { id, productionStage: order.productionStage },
				data: { productionStage: stage },
			});
			if (count !== 1) return { error: "not_next_stage" as const };

			const t = await getDictionary(localeOf(order.locale));
			const ids = await enqueue(tx, [
				draftFor({
					kind: "STAGE",
					order,
					stage,
					stageLabel: t.order.stages[stage],
				}),
			]);
			return { ids };
		});

		if ("error" in result) {
			return NextResponse.json(
				{ error: result.error },
				{ status: result.error === "not_found" ? 404 : 409 },
			);
		}
		flushSoon(result.ids);
		return NextResponse.json({ ok: true });
	},
);
```

- [ ] **Step 2: Resend route** — `src/app/api/admin/orders/[id]/notifications/[notificationId]/resend/route.ts`:

```ts
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { flushSoon } from "@/lib/whatsapp/outbox";

export const runtime = "nodejs";

/**
 * Put a failed WhatsApp message back in the queue.
 *
 * Only a `FAILED` row, and only one belonging to this order. Resetting
 * `queuedAt` restarts the 48 h expiry — the admin chose to send it late.
 */
export const POST = withAuth<{
	params: Promise<{ id: string; notificationId: string }>;
}>("orders:markPaid", async (_request, { params }) => {
	const { id, notificationId } = await params;
	const { count } = await prisma.notification.updateMany({
		where: { id: notificationId, orderId: id, status: "FAILED" },
		data: {
			status: "PENDING",
			attempts: 0,
			lastError: null,
			queuedAt: new Date(),
		},
	});
	if (count !== 1) {
		return NextResponse.json({ error: "not_failed" }, { status: 409 });
	}
	flushSoon([notificationId]);
	return NextResponse.json({ ok: true });
});
```

- [ ] **Step 3: Auth coverage.** Run: `pnpm vitest run src/lib/auth`
Expected: PASS — both new routes export only `withAuth`-wrapped `POST`.

- [ ] **Step 4: Admin page data.** In `src/app/admin/orders/[id]/page.tsx`, extend the `include` of `prisma.order.findUnique` with:

```ts
				notifications: {
					orderBy: { createdAt: "asc" },
					select: {
						id: true,
						kind: true,
						stage: true,
						status: true,
						lastError: true,
						createdAt: true,
					},
				},
```

and add to the `order={{ … }}` prop, after `deliveries: order.deliveries,`:

```ts
					productionStage: order.productionStage,
					whatsappOptIn: order.whatsappOptIn,
					notifications: order.notifications.map((n) => ({
						...n,
						createdAt: n.createdAt.toISOString(),
					})),
```

- [ ] **Step 5: Admin UI.** In `src/app/admin/orders/[id]/OrderDetail.tsx`:

Add imports:

```ts
import type {
	NotificationKind,
	NotificationStatus,
	ProductionStage,
} from "@/generated/prisma/enums";
import { en } from "@/lib/copy/en";
import { nextStage } from "@/lib/orders/stage";
```

Add to `OrderView`:

```ts
	productionStage: ProductionStage | null;
	whatsappOptIn: boolean;
	notifications: {
		id: string;
		kind: NotificationKind;
		stage: ProductionStage | null;
		status: NotificationStatus;
		lastError: string | null;
		createdAt: string;
	}[];
```

Add constants below `PRIMARY`:

```ts
const STAGE_LABEL = en.order.stages;

const KIND_LABEL: Record<NotificationKind, string> = {
	ORDER_PLACED: "Order placed",
	PAYMENT_CONFIRMED: "Payment confirmed",
	STAGE: "Production step",
	DELIVERY_BOOKED: "Delivery booked",
	PICKED_UP: "Picked up",
	DELIVERED: "Delivered",
	DELIVERY_FAILED: "Delivery failed",
};

const MESSAGE_STATUS: Record<NotificationStatus, string> = {
	PENDING: "Queued",
	SENT: "Sent",
	DELIVERED: "Delivered",
	READ: "Read",
	FAILED: "Failed",
};
```

Widen `busy`'s type to `useState<string | null>(null)` and add two handlers below `act`:

```tsx
	async function post(url: string, body: unknown, key: string) {
		setBusy(key);
		setError(null);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		setBusy(null);
		if (!res.ok) {
			const payload = await res.json().catch(() => null);
			setError(
				payload?.error === "not_next_stage"
					? "Someone else moved this order on. Reload to see where it is."
					: "Could not update this order.",
			);
			return;
		}
		router.refresh();
	}

	const upcoming = nextStage(order.productionStage);
```

In the JSX, directly after the Payment `</section>`, add the Production card:

```tsx
					{paid && (
						<section className={CARD}>
							<h2 className={EYEBROW}>Production</h2>
							<p className="text-[13px] text-neutral-600">
								{order.productionStage
									? `Now at: ${STAGE_LABEL[order.productionStage]}`
									: "Not started."}
								{order.whatsappOptIn
									? " Each step is sent to the customer on WhatsApp."
									: ""}
							</p>
							{upcoming && (
								<button
									type="button"
									className={PRIMARY}
									disabled={busy !== null}
									onClick={() =>
										post(
											`/api/admin/orders/${order.id}/stage`,
											{ stage: upcoming },
											"stage",
										)
									}
								>
									{busy === "stage"
										? "Saving…"
										: `Advance to: ${STAGE_LABEL[upcoming]}`}
								</button>
							)}
						</section>
					)}
```

In the `<aside>`, after the Customer `</section>`, add the WhatsApp card:

```tsx
					<section className={CARD}>
						<h2 className={EYEBROW}>WhatsApp</h2>
						{!order.whatsappOptIn ? (
							<p className="text-[12px] text-neutral-500">
								Customer did not opt in to WhatsApp.
							</p>
						) : order.notifications.length === 0 ? (
							<p className="text-[12px] text-neutral-500">No messages yet.</p>
						) : (
							<ul className="flex flex-col gap-2">
								{order.notifications.map((n) => (
									<li key={n.id} className="flex flex-col gap-0.5 text-[12px]">
										<span className="text-neutral-700">
											{KIND_LABEL[n.kind]}
											{n.stage ? ` · ${STAGE_LABEL[n.stage]}` : ""}
										</span>
										<span
											className={
												n.status === "FAILED"
													? "text-[#7a2c1c]"
													: "text-[#8a857c]"
											}
										>
											{MESSAGE_STATUS[n.status]} · {shortTime(n.createdAt)}
											{n.lastError ? ` · ${n.lastError}` : ""}
										</span>
										{n.status === "FAILED" && (
											<button
												type="button"
												className={`${CHIP} self-start`}
												disabled={busy !== null}
												onClick={() =>
													post(
														`/api/admin/orders/${order.id}/notifications/${n.id}/resend`,
														{},
														n.id,
													)
												}
											>
												{busy === n.id ? "Resending…" : "Resend"}
											</button>
										)}
									</li>
								))}
							</ul>
						)}
					</section>
```

Update the component's doc comment: "its admin moves — mark it paid, advance production, create its delivery".

- [ ] **Step 6: Customer order page stage strip.** In `src/app/[lang]/order/[token]/page.tsx`:

Add import:

```ts
import { STAGES, stageReached } from "@/lib/orders/stage";
```

Add `productionStage: true,` to the `select`.

Replace the "What happens next" array (Task 2's temporary version) with:

```tsx
								{[
									{ label: o.stagePaid, done: true },
									...STAGES.map((stage) => ({
										label: o.stages[stage],
										detail:
											stage === "MEASURE" ? o.stageMeasureDetail : undefined,
										done: stageReached(order.productionStage, stage),
									})),
									{ label: o.stageDelivery },
								].map((stage) => (
```

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: pass.

Manual: on the paid, opted-in order: "Advance to: Site re-measure" → card shows "Now at: Site re-measure", WhatsApp card lists "Production step · Site re-measure · Queued". Open two tabs, advance in one, then click in the other → "Someone else moved this order on." The customer page `/en/order/<token>` ticks Payment received and Site re-measure. In Prisma Studio set one notification to `FAILED` → Resend button appears; pressing it returns it to Queued.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/admin/orders src/app/admin/orders src/app/\[lang\]/order
git commit -m "feat(orders): admin-advanced production stages and WhatsApp log"
```

---

### Task 10: Meta webhook — status updates and auto-reply

**Files:**
- Create: `src/lib/whatsapp/webhook.ts`
- Test: `src/lib/whatsapp/__tests__/webhook.test.ts`
- Create: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: `secretsMatch` (`@/lib/secretsMatch`), `NotificationStatus` enum, `autoReply` (Task 6).
- Produces:
  - `signatureValid(raw: string, header: string | null, secret: string): boolean`
  - `parseWebhook(body: unknown): { statuses: { messageId: string; status: "SENT" | "DELIVERED" | "READ" | "FAILED"; error: string | null }[]; senders: string[] }`
  - `statusAdvances(current: NotificationStatus, incoming: NotificationStatus): boolean`

- [ ] **Step 1: Write the failing test** — `src/lib/whatsapp/__tests__/webhook.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWebhook, signatureValid, statusAdvances } from "../webhook";

const sign = (raw: string, secret: string) =>
	`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

describe("signatureValid", () => {
	const raw = '{"entry":[]}';

	it("accepts Meta's HMAC of the raw body", () => {
		expect(signatureValid(raw, sign(raw, "s3cret"), "s3cret")).toBe(true);
	});

	it("rejects a wrong secret, a changed body and a missing header", () => {
		expect(signatureValid(raw, sign(raw, "other"), "s3cret")).toBe(false);
		expect(signatureValid(`${raw} `, sign(raw, "s3cret"), "s3cret")).toBe(
			false,
		);
		expect(signatureValid(raw, null, "s3cret")).toBe(false);
	});

	it("rejects everything when the secret is unset", () => {
		expect(signatureValid(raw, sign(raw, ""), "")).toBe(false);
	});
});

describe("parseWebhook", () => {
	const body = {
		object: "whatsapp_business_account",
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							statuses: [
								{ id: "wamid.1", status: "delivered" },
								{
									id: "wamid.2",
									status: "failed",
									errors: [{ code: 131026, title: "Message undeliverable" }],
								},
								{ id: "wamid.3", status: "deleted" },
							],
							messages: [
								{ from: "60123456789", type: "text" },
								{ from: "60123456789", type: "image" },
							],
						},
					},
				],
			},
		],
	};

	it("reads statuses, ignoring ones we do not track", () => {
		expect(parseWebhook(body).statuses).toEqual([
			{ messageId: "wamid.1", status: "DELIVERED", error: null },
			{
				messageId: "wamid.2",
				status: "FAILED",
				error: "131026: Message undeliverable",
			},
		]);
	});

	it("reads each sender once, as E.164", () => {
		expect(parseWebhook(body).senders).toEqual(["+60123456789"]);
	});

	it("returns nothing for a shape it does not know", () => {
		expect(parseWebhook({ hello: 1 })).toEqual({ statuses: [], senders: [] });
	});
});

describe("statusAdvances", () => {
	it("moves forward only", () => {
		expect(statusAdvances("SENT", "DELIVERED")).toBe(true);
		expect(statusAdvances("DELIVERED", "READ")).toBe(true);
		expect(statusAdvances("READ", "DELIVERED")).toBe(false);
		expect(statusAdvances("SENT", "SENT")).toBe(false);
	});

	it("fails a sent message, but never one already delivered or read", () => {
		expect(statusAdvances("SENT", "FAILED")).toBe(true);
		expect(statusAdvances("DELIVERED", "FAILED")).toBe(false);
		expect(statusAdvances("FAILED", "READ")).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/whatsapp/__tests__/webhook.test.ts`
Expected: FAIL — cannot resolve `../webhook`.

- [ ] **Step 3: Implement** — `src/lib/whatsapp/webhook.ts`:

```ts
import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { NotificationStatus } from "@/generated/prisma/enums";
import { secretsMatch } from "@/lib/secretsMatch";

/**
 * Meta's webhook: who sent it, what it says.
 *
 * Unlike EasyParcel (Known issue 3), Meta signs every POST — an HMAC-SHA256
 * of the raw body with the app secret — so this is a real check.
 */
export function signatureValid(
	raw: string,
	header: string | null,
	secret: string,
): boolean {
	if (header === null || secret === "") return false;
	const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
	return secretsMatch(header, expected);
}

const payloadSchema = z.object({
	entry: z.array(
		z.object({
			changes: z.array(
				z.object({
					value: z.object({
						statuses: z
							.array(
								z.object({
									id: z.string(),
									status: z.string(),
									errors: z
										.array(
											z.object({
												code: z.number().optional(),
												title: z.string().optional(),
											}),
										)
										.optional(),
								}),
							)
							.optional(),
						messages: z.array(z.object({ from: z.string() })).optional(),
					}),
				}),
			),
		}),
	),
});

const TRACKED = {
	sent: "SENT",
	delivered: "DELIVERED",
	read: "READ",
	failed: "FAILED",
} as const;

export function parseWebhook(body: unknown): {
	statuses: {
		messageId: string;
		status: (typeof TRACKED)[keyof typeof TRACKED];
		error: string | null;
	}[];
	senders: string[];
} {
	const parsed = payloadSchema.safeParse(body);
	if (!parsed.success) return { statuses: [], senders: [] };
	const values = parsed.data.entry.flatMap((e) => e.changes.map((c) => c.value));

	const statuses = values.flatMap((value) =>
		(value.statuses ?? []).flatMap((s) => {
			const status = TRACKED[s.status as keyof typeof TRACKED];
			if (!status) return [];
			const first = s.errors?.[0];
			return [
				{
					messageId: s.id,
					status,
					error: first ? `${first.code ?? "?"}: ${first.title ?? ""}` : null,
				},
			];
		}),
	);
	const senders = [
		...new Set(
			values.flatMap((value) => (value.messages ?? []).map((m) => `+${m.from}`)),
		),
	];
	return { statuses, senders };
}

const RANK: Record<NotificationStatus, number> = {
	PENDING: 0,
	SENT: 1,
	DELIVERED: 2,
	READ: 3,
	FAILED: -1,
};

/**
 * Meta's callbacks arrive out of order. A status only moves forward, and a
 * failure only lands on a message not yet delivered.
 */
export function statusAdvances(
	current: NotificationStatus,
	incoming: NotificationStatus,
): boolean {
	if (current === "FAILED") return false;
	if (incoming === "FAILED") return RANK[current] < RANK.DELIVERED;
	return RANK[incoming] > RANK[current];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/whatsapp/__tests__/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: The route** — `src/app/api/whatsapp/webhook/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { secretsMatch } from "@/lib/secretsMatch";
import { autoReply } from "@/lib/whatsapp/outbox";
import {
	parseWebhook,
	signatureValid,
	statusAdvances,
} from "@/lib/whatsapp/webhook";

export const runtime = "nodejs";

/**
 * Meta's WhatsApp webhook. Public prefix — `proxy.ts` gates only `/admin` —
 * so it authenticates itself: the verify token on the subscription handshake,
 * the app-secret signature on every event.
 */

/** Subscription handshake: echo the challenge when the token is ours. */
export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const ok =
		params.get("hub.mode") === "subscribe" &&
		secretsMatch(
			params.get("hub.verify_token") ?? "",
			process.env.WHATSAPP_VERIFY_TOKEN ?? "",
		);
	return ok
		? new Response(params.get("hub.challenge") ?? "", { status: 200 })
		: NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function POST(request: Request) {
	// Raw text, not .json(): the signature is over the exact bytes Meta sent.
	const raw = await request.text();
	if (
		!signatureValid(
			raw,
			request.headers.get("x-hub-signature-256"),
			process.env.WHATSAPP_APP_SECRET ?? "",
		)
	) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return NextResponse.json({ error: "invalid_body" }, { status: 400 });
	}
	const { statuses, senders } = parseWebhook(body);

	for (const update of statuses) {
		const row = await prisma.notification.findUnique({
			where: { metaMessageId: update.messageId },
			select: { id: true, status: true },
		});
		if (!row || !statusAdvances(row.status, update.status)) continue;
		await prisma.notification.update({
			where: { id: row.id },
			data: {
				status: update.status,
				...(update.error ? { lastError: update.error } : {}),
			},
		});
	}

	for (const phone of senders) await autoReply(phone);

	// 200 whatever we did with it — Meta retries anything else for days.
	return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: Verify the route locally**

```bash
# needs WHATSAPP_VERIFY_TOKEN in .env.local and exported in this shell
pnpm dev
curl -s "http://localhost:3000/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=42"
# expected: 42
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/whatsapp/webhook -d '{}'
# expected: 401
```

Then run: `pnpm typecheck && pnpm lint && pnpm test` — expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp/webhook.ts src/lib/whatsapp/__tests__/webhook.test.ts src/app/api/whatsapp
git commit -m "feat(whatsapp): signed Meta webhook for status and auto-reply"
```

---

### Task 11: Privacy paragraph, ping script, docs

**Files:**
- Modify: `src/app/[lang]/privacy/page.tsx`
- Create: `scripts/whatsapp-ping.mjs`
- Modify: `package.json`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-22-whatsapp-notifications-design.md` (status line)

- [ ] **Step 1: Privacy section.** In `src/app/[lang]/privacy/page.tsx`, in the sections array, after `[p.whereHeading, p.where],` add:

```ts
		[p.whatsappHeading, p.whatsapp],
```

- [ ] **Step 2: Ping script** — `scripts/whatsapp-ping.mjs`:

```js
#!/usr/bin/env node
/**
 * Send one real WhatsApp message, without the app in the way.
 *
 * CI proves the payloads match what we believe Meta's API is; this proves the
 * token, the phone number id and Meta's API agree. It sends Meta's built-in
 * `hello_world` template, which every WhatsApp Business account has approved
 * from day one, so it works before any of our templates are approved.
 *
 *   pnpm whatsapp:ping +60123456789
 *
 * Not in CI: it needs live credentials and messages a real phone.
 */

const TOKEN = process.env.WHATSAPP_TOKEN ?? "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
const to = (process.argv[2] ?? "").replace(/\D/g, "");

if (TOKEN === "" || PHONE_NUMBER_ID === "") {
	console.error(
		"Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.local.",
	);
	process.exit(1);
}
if (to === "") {
	console.error("Usage: pnpm whatsapp:ping +60123456789");
	process.exit(1);
}

const response = await fetch(
	`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
	{
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to,
			type: "template",
			template: { name: "hello_world", language: { code: "en_US" } },
		}),
	},
);
console.log(response.status, await response.text());
process.exit(response.ok ? 0 : 1);
```

In `package.json` `scripts`, after `"gdex:ping": …,` add:

```json
		"whatsapp:ping": "node --env-file=.env.local scripts/whatsapp-ping.mjs",
```

- [ ] **Step 3: CLAUDE.md.** Four edits:

1. **Status** paragraph: after the sentence ending "…pre-filled from the design (`lib/orders`)." add: "Opted-in customers get WhatsApp updates for the order, each admin-advanced production stage and the delivery (`lib/whatsapp`, Meta Cloud API); go-live waits on EzCabinet — see Open questions."
2. **Directory layout** — after the `lib/orders/` block add:

```text
  lib/whatsapp/          ← customer WhatsApp updates via Meta's Cloud API
    templates.ts         ← event → template name, variables, payload; pure
    send.ts              ← one API call; retryable or not
    outbox.ts            ← enqueue in the state change's transaction; flush after
    webhook.ts           ← Meta's signature, status order; pure
```

and under `lib/orders/` add a line `    stage.ts             ← production stages, forward-only, one at a time`.
3. **Non-negotiables** — add: "- **A WhatsApp message is queued in the same transaction as the change it reports**, deduplicated by `dedupeKey` — except delivery booked, which queues after the booking commits so a failed insert can never roll back money spent at a carrier. Preview deployments never get `WHATSAPP_TOKEN`."
4. **Phasing** row 4: append "Factory Tracker pushes production stages onto `POST /api/admin/orders/[id]/stage` (today an admin presses it)."

- [ ] **Step 4: Spec status.** In the spec, change `Status: approved in brainstorming, awaiting spec review` to `Status: implemented — go-live waits on docs/ops/whatsapp-ezcabinet-setup.md`.

- [ ] **Step 5: Final gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all pass. (`pnpm build` needs `BETTER_AUTH_SECRET` in the environment — set any value locally.)

- [ ] **Step 6: Commit**

```bash
git add src/app/\[lang\]/privacy/page.tsx scripts/whatsapp-ping.mjs package.json CLAUDE.md docs/superpowers/specs/2026-09-22-whatsapp-notifications-design.md
git commit -m "docs(whatsapp): privacy paragraph, ping script, architecture notes"
```

---

## Environment (set in Vercel **Production only** once EzCabinet delivers item 3 of the checklist)

| Variable | Source |
| --- | --- |
| `WHATSAPP_TOKEN` | EzCabinet's system-user permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Manager → phone number → ID |
| `WHATSAPP_APP_SECRET` | Meta app → Settings → Basic |
| `WHATSAPP_VERIFY_TOKEN` | generate: `openssl rand -hex 24` |
| `WHATSAPP_SALES_NUMBER` | EzCabinet sales, E.164 |

Then subscribe the webhook in the Meta app (Callback URL `https://<prod domain>/api/whatsapp/webhook`, the verify token above, field `messages`).
