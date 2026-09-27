# Customer Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in customer sees a list of their own orders, and every order view (order page, order-linked tracking page) is restricted to the order's owner or staff.

**Architecture:** One module, `src/lib/orders/access.ts`, holds the pure rule `canViewOrder` and the server helper `viewerOf` (signed out → sign-in redirect). The order page, the track page and a new `/[lang]/orders` page call it; a wrong viewer gets `notFound()`. `Order.userId` becomes `NOT NULL`, and checkout refuses a request without a signed-in user in every environment.

**Tech Stack:** Next.js 16 App Router (server components), Prisma 7 + Postgres, Better Auth (Google OAuth), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-customer-orders-design.md`

## Global Constraints

- Ownership compares user **ids** only — never email.
- A viewer who is neither owner nor staff gets `notFound()` (404), never 403.
- Staff = a role for which `can(role, "orders:read")` is true (`src/lib/auth/permissions.ts`).
- Signed out → `redirect(\`/${lang}/sign-in?next=${encodeURIComponent(path)}\`)`.
- `AUTH_ENABLED=false` → page viewer is `BYPASS_USER`; **checkout still requires a real user**.
- `lib/planner` untouched. Sentence case in UI copy. Prices in RM. Copy added to `en`, `ms`, `zh` (`ms`/`zh` are typed `Dictionary`, so a missing key fails `tsc`).
- Migration is hand-written (CLAUDE.md Known issue 12). **Never apply it to preview/production** inside this plan — Task 5 stops and asks the user.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX
  ```

## Review Focus

1. **Token of an order that exists, opened by another signed-in customer** → 404 byte-identical in behaviour to an unknown token (no redirect, no different copy). Pinned in Task 3.
2. **Signed-out visitor from a WhatsApp link** → sign-in, then back to the *same* order URL (`next` is URL-encoded and relative). Pinned in Task 1 (`viewerOf` redirect target) and Task 3.
3. **Disabled account with a live session** → `currentUser()` returns null → treated as signed out, never as owner. Pinned in Task 1.
4. **Standalone delivery (`orderId` null) opened signed out** → still renders; no sign-in redirect. Pinned in Task 3.
5. **`/orders` for a staff user** → only orders whose `userId` is the staff user's own id; never all orders. Pinned in Task 4.

---

### Task 1: Access rule and viewer helper

**Files:**
- Create: `src/lib/orders/access.ts`
- Test: `src/lib/orders/__tests__/access.test.ts`

**Interfaces:**
- Consumes: `currentUser(): Promise<AuthUser | null>` (`@/lib/auth/session`), `authEnabled()` (`@/lib/auth/enabled`), `BYPASS_USER` (`@/lib/auth/requireAuth`), `can(role, permission)` (`@/lib/auth/permissions`), `redirect` (`next/navigation`).
- Produces:
  - `canViewOrder(viewer: Pick<AuthUser, "id" | "role"> | null, order: { userId: string }): boolean`
  - `viewerOf(lang: string, path: string): Promise<AuthUser>` — returns the viewer or throws Next's redirect to sign-in.

- [ ] **Step 1: Write the failing test**

`src/lib/orders/__tests__/access.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const redirect = vi.hoisted(() =>
	vi.fn((url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	}),
);
vi.mock("next/navigation", () => ({ redirect }));

const { canViewOrder, viewerOf } = await import("@/lib/orders/access");
const { BYPASS_USER } = await import("@/lib/auth/requireAuth");

const user = (over: Partial<AuthUser>): AuthUser => ({
	id: "u1",
	email: "a@b.com",
	name: "A",
	image: null,
	role: "CUSTOMER",
	disabled: false,
	mustChangePassword: false,
	...over,
});

const order = { userId: "owner" };

describe("canViewOrder", () => {
	it.each([
		["owner", user({ id: "owner" }), true],
		["another customer", user({ id: "stranger" }), false],
		["superadmin", user({ id: "s", role: "SUPERADMIN" }), true],
		["admin", user({ id: "a", role: "ADMIN" }), true],
		["signed out", null, false],
		// Same email, different account: email is never an access key.
		[
			"customer sharing the owner's email",
			user({ id: "other", email: "owner@x.com" }),
			false,
		],
	])("%s → %s", (_, viewer, expected) => {
		expect(canViewOrder(viewer, order)).toBe(expected);
	});
});

describe("viewerOf", () => {
	beforeEach(() => {
		currentUser.mockReset();
		redirect.mockClear();
		vi.stubEnv("VERCEL_ENV", undefined);
		vi.stubEnv("AUTH_ENABLED", "true");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("returns the signed-in user", async () => {
		currentUser.mockResolvedValue(user({ id: "owner" }));
		await expect(viewerOf("en", "/en/order/t1")).resolves.toMatchObject({
			id: "owner",
		});
	});

	it("sends a signed-out visitor to sign-in and back to the same page", async () => {
		currentUser.mockResolvedValue(null);
		await expect(viewerOf("ms", "/ms/order/t 1")).rejects.toThrow(
			"REDIRECT:/ms/sign-in?next=%2Fms%2Forder%2Ft%201",
		);
	});

	it("treats a disabled account (currentUser null) as signed out", async () => {
		// currentUser() already returns null for a disabled row.
		currentUser.mockResolvedValue(null);
		await expect(viewerOf("en", "/en/orders")).rejects.toThrow(/REDIRECT/);
	});

	it("is the bypass superadmin when AUTH_ENABLED is off locally", async () => {
		vi.stubEnv("AUTH_ENABLED", "false");
		await expect(viewerOf("en", "/en/orders")).resolves.toBe(BYPASS_USER);
		expect(currentUser).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/orders/__tests__/access.test.ts`
Expected: FAIL — cannot resolve `@/lib/orders/access`.

- [ ] **Step 3: Write the implementation**

`src/lib/orders/access.ts`:

```ts
import "server-only";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/enabled";
import { can } from "@/lib/auth/permissions";
import { BYPASS_USER } from "@/lib/auth/requireAuth";
import { type AuthUser, currentUser } from "@/lib/auth/session";

/**
 * Who may see an order: the account that placed it, or staff who can read
 * orders. Nobody else — holding the order's link is not enough, since that
 * link travels over WhatsApp and gets forwarded.
 *
 * Ownership is the account id, never the email: a checkout email is typed,
 * not verified. A caller that refuses must answer `notFound()`, so a
 * stranger cannot tell a real order from a made-up token.
 */
export function canViewOrder(
	viewer: Pick<AuthUser, "id" | "role"> | null,
	order: { userId: string },
): boolean {
	if (viewer === null) return false;
	return viewer.id === order.userId || can(viewer.role, "orders:read");
}

/**
 * The signed-in viewer of a customer page, or a trip through Google sign-in
 * that lands back on `path`. With AUTH_ENABLED off (local only) the viewer is
 * the bypass superadmin, as on the admin surface.
 */
export async function viewerOf(lang: string, path: string): Promise<AuthUser> {
	if (!authEnabled()) return BYPASS_USER;
	const user = await currentUser();
	if (user === null) {
		redirect(`/${lang}/sign-in?next=${encodeURIComponent(path)}`);
	}
	return user;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/orders/__tests__/access.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orders/access.ts src/lib/orders/__tests__/access.test.ts
git commit -m "feat(orders): owner-or-staff access rule for customer order pages"
```

---

### Task 2: Every order has an owner (schema, migration, checkout)

**Files:**
- Modify: `prisma/schema.prisma` (model `Order`, lines ~375-382)
- Create: `prisma/migrations/20260927000000_order_owner_required/migration.sql`
- Modify: `src/app/api/orders/route.ts:57-62` and `:117`
- Test: `src/app/api/orders/__tests__/route.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Order.userId: string` (non-null) in the generated Prisma client — Tasks 3 and 4 rely on it for `canViewOrder(viewer, { userId })`.

- [ ] **Step 1: Write the failing test**

`src/app/api/orders/__tests__/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ currentUser }));
vi.mock("botid/server", () => ({
	checkBotId: async () => ({ isBot: false }),
}));
// The 401 must come before any database work; an empty prisma proves it.
vi.mock("@/lib/catalogue/db", () => ({ prisma: {} }));

const { POST } = await import("@/app/api/orders/route");

const post = () =>
	POST(
		new Request("http://localhost/api/orders", {
			method: "POST",
			body: "{}",
		}),
	);

beforeEach(() => {
	currentUser.mockReset();
	currentUser.mockResolvedValue(null);
	vi.stubEnv("VERCEL_ENV", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/orders without a signed-in user", () => {
	it.each(["true", "false"])("401s with AUTH_ENABLED=%s", async (flag) => {
		vi.stubEnv("AUTH_ENABLED", flag);
		const response = await post();
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "sign_in_required" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/api/orders/__tests__/route.test.ts`
Expected: the `AUTH_ENABLED=false` case FAILS (gets 400 `invalid_body`, not 401). If the import itself fails on another module touching the database at import time, add a `vi.mock` for that module path with an empty object and re-run — do not change the route to suit the test.

- [ ] **Step 3: Make checkout always require a user**

In `src/app/api/orders/route.ts` replace:

```ts
	// Checkout is the one hard stop. Everything before it — browsing, planning,
	// pricing — stays anonymous, which is the conversion decision in CLAUDE.md.
	const user = authEnabled() ? await currentUser() : null;
	if (authEnabled() && !user) {
		return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
	}
```

with:

```ts
	// Checkout is the one hard stop. Everything before it — browsing, planning,
	// pricing — stays anonymous, which is the conversion decision in CLAUDE.md.
	// Every order belongs to an account, in every environment: AUTH_ENABLED=false
	// opens the admin surface but never lets an ownerless order in, because
	// an order nobody owns is an order nobody can be shown.
	const user = await currentUser();
	if (!user) {
		return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
	}
```

Replace `userId: user?.id ?? null,` with `userId: user.id,`. Remove the now-unused `import { authEnabled } from "@/lib/auth/enabled";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/api/orders/__tests__/route.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Make `userId` required in the schema**

In `prisma/schema.prisma`, model `Order`, replace:

```prisma
  /// Null on a pre-cutover or anonymous order. `publicToken` still opens it.
  userId       String?
  user         User?   @relation("OrderCustomer", fields: [userId], references: [id])
```

with:

```prisma
  /// The account that placed it — the only customer who may see it
  /// (`lib/orders/access.ts`). Restrict: an order is a money record and
  /// outlives any attempt to delete the account.
  userId       String
  user         User    @relation("OrderCustomer", fields: [userId], references: [id], onDelete: Restrict)
```

and change the model's index block from:

```prisma
  @@index([status, createdAt])
```

to:

```prisma
  @@index([status, createdAt])
  @@index([userId, createdAt])
```

- [ ] **Step 6: Write the migration by hand**

`prisma/migrations/20260927000000_order_owner_required/migration.sql`:

```sql
-- Every order belongs to an account (docs/superpowers/specs/2026-09-27-customer-orders-design.md).
-- Ownerless rows are local/test data from AUTH_ENABLED=false checkouts.
-- Notification rows cascade; Delivery.orderId is set null (existing FK), so a
-- booked delivery keeps its row.
DELETE FROM "Order" WHERE "userId" IS NULL;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "userId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
```

- [ ] **Step 7: Regenerate the client and typecheck**

Run: `pnpm exec prisma generate && pnpm typecheck`
Expected: exit 0. Any error naming `userId` is a caller still passing `null` — fix it to pass a real id (tests: use a fixture id like `"u1"`).

- [ ] **Step 8: Apply locally and verify no drift**

Confirm `DATABASE_URL` in `.env.local` points at the **local/dev** database (print only the host: `node -e 'console.log(new URL(process.env.DATABASE_URL).host)'` with the env loaded). If it is a Vercel/Prisma-hosted preview or production host, STOP and ask the user.

Run: `pnpm exec prisma migrate deploy`
Then: `pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
Expected: deploy applies `20260927000000_order_owner_required`; the diff prints an empty migration (no statements).

- [ ] **Step 9: Run the full suite**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260927000000_order_owner_required src/app/api/orders
git commit -m "feat(orders): every order belongs to an account"
```

---

### Task 3: Lock the order and tracking pages

**Files:**
- Modify: `src/app/[lang]/order/[token]/page.tsx:14-66`
- Modify: `src/app/[lang]/track/[token]/page.tsx:17-100`
- Test: `src/app/[lang]/order/[token]/__tests__/page.test.ts`
- Test: `src/app/[lang]/track/[token]/__tests__/page.test.ts`

**Interfaces:**
- Consumes: `canViewOrder`, `viewerOf` (Task 1); non-null `Order.userId` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing order-page test**

`src/app/[lang]/order/[token]/__tests__/page.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { findUnique } } }));

vi.mock("next/navigation", () => ({
	notFound: (): never => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	},
}));

const { default: OrderPage } = await import("@/app/[lang]/order/[token]/page");

const user = (id: string, role: AuthUser["role"] = "CUSTOMER"): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role,
	disabled: false,
	mustChangePassword: false,
});

const ORDER = {
	userId: "owner",
	number: 14,
	createdAt: new Date("2026-09-27T00:00:00Z"),
	status: "CANCELLED",
	siteAddress: "1 Jalan Test",
	breakdown: { cabinets: [] },
	cabinetsRm: 1000,
	deliveryRm: 85,
	totalRm: 1085,
	productionStage: null,
	deliveries: [],
};

const open = (token = "tok") =>
	OrderPage({ params: Promise.resolve({ lang: "en", token }) });

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	findUnique.mockReset();
	findUnique.mockResolvedValue(ORDER);
});

describe("order page access", () => {
	it("sends a signed-out visitor to sign-in, back to this order", async () => {
		currentUser.mockResolvedValue(null);
		await expect(open()).rejects.toThrow(
			"REDIRECT:/en/sign-in?next=%2Fen%2Forder%2Ftok",
		);
	});

	it("renders for the owner", async () => {
		currentUser.mockResolvedValue(user("owner"));
		await expect(open()).resolves.toBeTruthy();
	});

	it("renders for staff", async () => {
		currentUser.mockResolvedValue(user("staff", "ADMIN"));
		await expect(open()).resolves.toBeTruthy();
	});

	it("404s for another customer, exactly like an unknown token", async () => {
		currentUser.mockResolvedValue(user("stranger"));
		await expect(open()).rejects.toThrow("NOT_FOUND");
		findUnique.mockResolvedValue(null);
		await expect(open("nope")).rejects.toThrow("NOT_FOUND");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run "src/app/[lang]/order/[token]/__tests__/page.test.ts"`
Expected: FAIL — signed-out and stranger cases render instead of redirecting / 404ing.

- [ ] **Step 3: Gate the order page**

In `src/app/[lang]/order/[token]/page.tsx`:

1. Add imports: `import { canViewOrder, viewerOf } from "@/lib/orders/access";`
2. Replace the header comment block above `export const metadata` with:

```ts
/**
 * The page a customer lands on after checkout: what they ordered, what it
 * cost, how to pay, and — once logistics has a job — a link to follow it.
 *
 * Addressed by the order's `publicToken`, never its number, and never
 * indexed: it carries a home address. The token is an address, not a key —
 * only the account that placed the order, or staff, may open it
 * (`lib/orders/access.ts`). Anyone else gets the same 404 as a made-up token.
 */
```

3. Change the start of `OrderPage` so the viewer is resolved first and `userId` is selected:

```ts
	const { lang, token } = await params;
	if (!isLocale(lang)) notFound();
	const viewer = await viewerOf(lang, `/${lang}/order/${token}`);

	const [order, t] = await Promise.all([
		prisma.order.findUnique({
			where: { publicToken: token },
			// Short on purpose: the row also holds the phone number, the email and
			// who marked it paid, none of which this page shows.
			select: {
				userId: true,
				number: true,
```

(keep the rest of the `select` as is), and replace `if (order === null) notFound();` with:

```ts
	if (order === null || !canViewOrder(viewer, order)) notFound();
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run "src/app/[lang]/order/[token]/__tests__/page.test.ts"`
Expected: PASS, 4 tests. If "renders for the owner" throws on a missing fixture field, add that field to `ORDER` with a realistic value — do not loosen the page.

- [ ] **Step 5: Write the failing track-page test**

`src/app/[lang]/track/[token]/__tests__/page.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { delivery: { findUnique } } }));

vi.mock("next/navigation", () => ({
	notFound: (): never => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	},
}));

const { default: TrackPage } = await import("@/app/[lang]/track/[token]/page");

const customer = (id: string): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role: "CUSTOMER",
	disabled: false,
	mustChangePassword: false,
});

const delivery = (order: { userId: string } | null) => ({
	number: 3,
	siteAddress: "1 Jalan Test",
	scheduledAt: null,
	status: "DRAFT",
	carrierId: null,
	carrierOrderId: null,
	items: [],
	createdAt: new Date("2026-09-27T00:00:00Z"),
	events: [],
	order,
});

const open = () =>
	TrackPage({ params: Promise.resolve({ lang: "en", token: "d1" }) });

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	currentUser.mockReset();
	findUnique.mockReset();
});

describe("track page access", () => {
	it("keeps a standalone delivery open to the link holder, signed out", async () => {
		currentUser.mockResolvedValue(null);
		findUnique.mockResolvedValue(delivery(null));
		await expect(open()).resolves.toBeTruthy();
	});

	it("sends a signed-out visitor of an order's delivery to sign-in", async () => {
		currentUser.mockResolvedValue(null);
		findUnique.mockResolvedValue(delivery({ userId: "owner" }));
		await expect(open()).rejects.toThrow(
			"REDIRECT:/en/sign-in?next=%2Fen%2Ftrack%2Fd1",
		);
	});

	it("renders an order's delivery for its owner", async () => {
		currentUser.mockResolvedValue(customer("owner"));
		findUnique.mockResolvedValue(delivery({ userId: "owner" }));
		await expect(open()).resolves.toBeTruthy();
	});

	it("404s an order's delivery for another customer", async () => {
		currentUser.mockResolvedValue(customer("stranger"));
		findUnique.mockResolvedValue(delivery({ userId: "owner" }));
		await expect(open()).rejects.toThrow("NOT_FOUND");
	});
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm exec vitest run "src/app/[lang]/track/[token]/__tests__/page.test.ts"`
Expected: FAIL — signed-out and stranger cases on an order's delivery render.

- [ ] **Step 7: Gate the track page**

In `src/app/[lang]/track/[token]/page.tsx`:

1. Add imports: `import { canViewOrder, viewerOf } from "@/lib/orders/access";`
2. Append to the file's header comment: ``` * A delivery that belongs to an order is locked like the order page (`lib/orders/access.ts`); a standalone admin-booked one stays link-access, since its recipient has no account.```
3. Add to the delivery `select`: `order: { select: { userId: true } },`
4. Replace `if (delivery === null) notFound();` with:

```ts
	if (delivery === null) notFound();
	if (delivery.order !== null) {
		const viewer = await viewerOf(lang, `/${lang}/track/${token}`);
		if (!canViewOrder(viewer, delivery.order)) notFound();
	}
```

Note the ordering: an unknown token 404s *before* any redirect, so a signed-out stranger learns nothing either; a signed-out owner of a real order-linked delivery is redirected to sign-in.

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm exec vitest run "src/app/[lang]/track/[token]/__tests__/page.test.ts" "src/app/[lang]/order/[token]/__tests__/page.test.ts"`
Expected: PASS, 8 tests.

- [ ] **Step 9: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: exit 0.

```bash
git add "src/app/[lang]/order/[token]" "src/app/[lang]/track/[token]"
git commit -m "feat(orders): only the owner or staff can open an order or its tracking"
```

---

### Task 4: My orders page, links and copy

**Files:**
- Create: `src/app/[lang]/orders/page.tsx`
- Test: `src/app/[lang]/orders/__tests__/page.test.ts`
- Modify: `src/lib/copy/en.ts`, `src/lib/copy/ms.ts`, `src/lib/copy/zh.ts`
- Modify: `src/app/[lang]/page.tsx:222-224` and `:284-286` (desktop + mobile nav)
- Modify: `src/app/[lang]/order/[token]/page.tsx` (header breadcrumb)

**Interfaces:**
- Consumes: `viewerOf` (Task 1); `orderRef(number, createdAt)` (`@/lib/orders/ref`); `ROOM_TYPES` (`@/lib/planner/catalogue`); `getDictionary`, `isLocale`.
- Produces: route `/[lang]/orders`; copy keys `landing.nav.myOrders`, `order.myOrders`, `orders.*`.

- [ ] **Step 1: Add the copy**

`src/lib/copy/en.ts` — in `landing.nav` after `tutorials: "Tutorials",` (line 29): `myOrders: "My orders",`. In `order` after `breadcrumb: "Order confirmation",`: `myOrders: "My orders",`. Add a new top-level section before `signIn:`:

```ts
	orders: {
		breadcrumb: "My orders",
		heading: "My orders",
		empty: "No orders yet",
		emptyBody: "Plan a room and place an order — it will show up here.",
		startPlanning: "Start planning",
		placedOn: "Placed {date}",
		statusAwaiting: "Awaiting payment",
		statusPaid: "Paid",
		statusCancelled: "Cancelled",
	},
```

`src/lib/copy/ms.ts` — same keys, same places:

```ts
			myOrders: "Pesanan saya",          // landing.nav
		myOrders: "Pesanan saya",              // order
	orders: {
		breadcrumb: "Pesanan saya",
		heading: "Pesanan saya",
		empty: "Belum ada pesanan",
		emptyBody: "Reka bilik dan buat pesanan — ia akan dipaparkan di sini.",
		startPlanning: "Mula merancang",
		placedOn: "Dibuat {date}",
		statusAwaiting: "Menunggu bayaran",
		statusPaid: "Dibayar",
		statusCancelled: "Dibatalkan",
	},
```

`src/lib/copy/zh.ts`:

```ts
			myOrders: "我的订单",              // landing.nav
		myOrders: "我的订单",                  // order
	orders: {
		breadcrumb: "我的订单",
		heading: "我的订单",
		empty: "暂无订单",
		emptyBody: "规划房间并下单后，订单会显示在这里。",
		startPlanning: "开始规划",
		placedOn: "下单于 {date}",
		statusAwaiting: "待付款",
		statusPaid: "已付款",
		statusCancelled: "已取消",
	},
```

(The `// …` markers only say where each line goes; do not paste them.)

Run: `pnpm exec tsc --noEmit`
Expected: exit 0 (a key missing from `ms`/`zh` fails here).

- [ ] **Step 2: Write the failing page test**

`src/app/[lang]/orders/__tests__/page.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { findMany } } }));

vi.mock("next/navigation", () => ({
	notFound: (): never => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string): never => {
		throw new Error(`REDIRECT:${url}`);
	},
}));

const { default: OrdersPage } = await import("@/app/[lang]/orders/page");

const as = (id: string, role: AuthUser["role"]): AuthUser => ({
	id,
	email: `${id}@x.com`,
	name: id,
	image: null,
	role,
	disabled: false,
	mustChangePassword: false,
});

const open = () => OrdersPage({ params: Promise.resolve({ lang: "en" }) });

beforeEach(() => {
	vi.stubEnv("VERCEL_ENV", undefined);
	vi.stubEnv("AUTH_ENABLED", "true");
	findMany.mockReset();
	findMany.mockResolvedValue([]);
});

describe("my orders page", () => {
	it("sends a signed-out visitor to sign-in, back to the list", async () => {
		currentUser.mockResolvedValue(null);
		await expect(open()).rejects.toThrow(
			"REDIRECT:/en/sign-in?next=%2Fen%2Forders",
		);
		expect(findMany).not.toHaveBeenCalled();
	});

	it.each([
		["customer", "CUSTOMER"],
		// Staff see their own orders here too; all orders live at /admin/orders.
		["staff", "SUPERADMIN"],
	] as const)("lists only the %s's own orders", async (id, role) => {
		currentUser.mockResolvedValue(as(id, role));
		await open();
		expect(findMany).toHaveBeenCalledTimes(1);
		expect(findMany.mock.calls[0][0].where).toEqual({ userId: id });
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run "src/app/[lang]/orders/__tests__/page.test.ts"`
Expected: FAIL — cannot resolve `@/app/[lang]/orders/page`.

- [ ] **Step 4: Write the page**

`src/app/[lang]/orders/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";
import { viewerOf } from "@/lib/orders/access";
import { orderRef } from "@/lib/orders/ref";
import { ROOM_TYPES } from "@/lib/planner/catalogue";

/**
 * A signed-in customer's own orders, newest first. The query is scoped to the
 * session's user id and takes nothing from the URL, so there is no parameter
 * to point at somebody else's orders. Staff see only orders they placed
 * themselves; every order is at /admin/orders.
 */
export const metadata = { robots: { index: false, follow: false } };

const CARD =
	"flex items-center justify-between gap-4 rounded-[14px] border border-[#e5e5e5] bg-white px-[22px] py-4 text-[#171717] hover:border-[#c9c6c0]";

const rm = (amount: number) =>
	`RM ${amount.toLocaleString("en-MY", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;

// ponytail: room names are the catalogue's English labels; localise when rooms get copy keys.
const roomLabel = (id: string) =>
	ROOM_TYPES.find((room) => room.id === id)?.label ?? id;

export default async function OrdersPage({
	params,
}: {
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const viewer = await viewerOf(lang, `/${lang}/orders`);

	const [orders, t] = await Promise.all([
		prisma.order.findMany({
			where: { userId: viewer.id },
			orderBy: { createdAt: "desc" },
			select: {
				publicToken: true,
				number: true,
				createdAt: true,
				status: true,
				roomId: true,
				totalRm: true,
				productionStage: true,
			},
		}),
		getDictionary(lang),
	]);
	const s = t.orders;
	const statusLabel = (order: (typeof orders)[number]) =>
		order.status === "CANCELLED"
			? s.statusCancelled
			: order.status === "AWAITING_PAYMENT"
				? s.statusAwaiting
				: order.productionStage
					? t.order.stages[order.productionStage]
					: s.statusPaid;

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-[#171717]">
			<header className="flex shrink-0 items-center gap-1.5 border-[#e5e5e5] border-b bg-white px-7 py-3.5 text-[#6b6b6b] text-[12px]">
				<Link href={`/${lang}`} className="px-1 py-1.5 hover:text-neutral-600">
					{t.common.brand}
				</Link>
				<span>/</span>
				<span className="px-1 py-1.5 font-medium text-[#171717]">
					{s.breadcrumb}
				</span>
			</header>

			<main className="flex flex-1 justify-center px-6 py-14">
				<div className="flex w-full max-w-[560px] flex-col gap-3">
					<h1 className="mb-3 font-semibold text-[24px]">{s.heading}</h1>
					{orders.length === 0 ? (
						<div className="flex flex-col items-start gap-3 rounded-[14px] border border-[#e5e5e5] bg-white px-[22px] py-6">
							<p className="font-medium text-[15px]">{s.empty}</p>
							<p className="text-[#5c574e] text-[14px]">{s.emptyBody}</p>
							<Link
								href={`/${lang}/planner`}
								className="rounded-full bg-[#171717] px-4 py-2 font-medium text-[13px] text-white"
							>
								{s.startPlanning}
							</Link>
						</div>
					) : (
						orders.map((order) => (
							<Link
								key={order.publicToken}
								href={`/${lang}/order/${order.publicToken}`}
								className={CARD}
							>
								<div>
									<p className="font-semibold text-[14px] tracking-[.02em]">
										{orderRef(order.number, order.createdAt)}
									</p>
									<p className="text-[#8a857c] text-[12px]">
										{roomLabel(order.roomId)} ·{" "}
										{fill(s.placedOn, {
											date: order.createdAt.toLocaleDateString(lang, {
												day: "numeric",
												month: "short",
												year: "numeric",
											}),
										})}
									</p>
								</div>
								<div className="text-right">
									<p className="font-medium text-[14px] tabular-nums">
										{rm(order.totalRm)}
									</p>
									<p className="text-[#5c574e] text-[12px]">
										{statusLabel(order)}
									</p>
								</div>
							</Link>
						))
					)}
				</div>
			</main>
		</div>
	);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run "src/app/[lang]/orders/__tests__/page.test.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the entry links**

`src/app/[lang]/page.tsx` — after **both** tutorials links (desktop nav ~line 222 and mobile disclosure ~line 284), add:

```tsx
						<Link href={`/${lang}/orders`} className={navLink}>
							{t.landing.nav.myOrders}
						</Link>
```

`src/app/[lang]/order/[token]/page.tsx` — in the header, replace the breadcrumb `<span>/</span><span …>{o.breadcrumb}</span>` pair with:

```tsx
				<span>/</span>
				<Link
					href={`/${lang}/orders`}
					className="px-1 py-1.5 hover:text-neutral-600"
				>
					{o.myOrders}
				</Link>
				<span>/</span>
				<span className="px-1 py-1.5 font-medium text-[#171717]">
					{o.breadcrumb}
				</span>
```

- [ ] **Step 7: Typecheck, lint, full suite, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: exit 0, all pass.

```bash
git add "src/app/[lang]/orders" "src/app/[lang]/page.tsx" "src/app/[lang]/order/[token]/page.tsx" src/lib/copy
git commit -m "feat(orders): my orders page for signed-in customers"
```

---

### Task 5: Docs, browser check, and the pre-deploy count

**Files:**
- Modify: `CLAUDE.md` (UX flow, Auth)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update CLAUDE.md**

In **UX flow**, after the paragraph beginning "**No login to configure — but checkout now requires an account.**", add:

```markdown
**An order is its owner's.** Every order carries the account that placed it
(`Order.userId`, `NOT NULL`). `/[lang]/orders` lists the signed-in customer's
own orders; `/[lang]/order/[token]` and — for a delivery that belongs to an
order — `/[lang]/track/[token]` open only for that account or staff with
`orders:read` (`lib/orders/access.ts`). The token in the URL is an address,
not a key: signed out, it bounces through Google sign-in and back; signed in
as anyone else, it is the same 404 as a made-up token. A standalone
admin-booked delivery keeps link access — its recipient has no account.
```

In **Auth**, replace the paragraph:

```markdown
`AUTH_ENABLED=false` opens the admin surface and lets checkout take an
anonymous order, for local work.
```

with:

```markdown
`AUTH_ENABLED=false` opens the admin surface and lets you open any customer
order page, for local work. It never lets checkout take an anonymous order —
every order needs an owner, so local checkout needs a Google sign-in.
```

Commit:

```bash
git add CLAUDE.md
git commit -m "docs: customer order access in CLAUDE.md"
```

- [ ] **Step 2: Browser check (local, two Google accounts)**

Start `pnpm dev` with `AUTH_ENABLED` unset (auth on). Then:
1. Signed in as account A: place an order; open `/en/orders` → it is listed; click → order page renders.
2. Copy the order URL. Sign out. Open it → lands on `/en/sign-in?next=%2Fen%2Forder%2F…`; sign in as A → back on the order.
3. Sign in as account B → open A's order URL → 404 page.
4. `/en/orders` as B → empty state with *Start planning*.

Record the result (pass/fail per step) in the final report. If step 3 shows anything but the 404 page, stop — that is the defect this plan exists to prevent.

- [ ] **Step 3: Pre-deploy count — STOP for the user**

The migration deletes ownerless orders and cannot be undone. Do **not** run it against preview or production. Give the user this query to run against each of those databases and report the counts before deploying:

```sql
SELECT count(*) AS ownerless,
       count(*) FILTER (WHERE status = 'PAID') AS ownerless_paid
FROM "Order" WHERE "userId" IS NULL;
```

Any non-zero `ownerless_paid` is a real customer's money and must be resolved by hand before the migration runs there.
