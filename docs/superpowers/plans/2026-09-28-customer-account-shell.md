# Customer Account Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build piece A of the Claude Design "Customer Account" file: a shared header with an account menu, an account layout with side nav, richer My orders cards, and the order detail page inside that layout.

**Architecture:** A route group `src/app/[lang]/(account)/` wraps the existing `orders/` and `order/[token]/` pages (URLs unchanged) in one layout that draws `SiteHeader` and the side nav. Access stays in each page (`viewerOf` / `canViewOrder`). The account menu is a client component reading the session in the browser, so the statically rendered landing page stays static. A pure `lib/orders/card.ts` decides what each order card shows.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind, Better Auth client (`authClient.useSession`, `authClient.signOut`), Prisma 7, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-customer-account-shell-design.md`

**Deviation from the spec (ruled at planning):** the spec says the server passes the user to the header and there is no client session fetch. The landing page is statically generated (`generateStaticParams`, no request data); reading the session on the server there would make every landing view a server render. So `AccountMenu` reads the session client-side with `authClient.useSession()` everywhere — one code path, landing stays static. Task 7 updates the spec line.

## Global Constraints

- Customer sign-in is **Google only**; nothing here adds email/password auth or marketing email.
- URLs unchanged: `/[lang]/orders`, `/[lang]/order/[token]`, `/[lang]/track/[token]`.
- Access unchanged: pages call `viewerOf(lang, path)`; the order page also `canViewOrder` → `notFound()`. Layouts never decide access.
- Real production stages (`STAGES` in `lib/orders/stage.ts`, labels `t.order.stages`) and real refs (`orderRef` → `IC-YYYYMMDD-NNN`).
- Sentence case in UI copy. Prices in RM. Every new string in `en`, `ms`, `zh` (`ms`/`zh` are typed `Dictionary`; a missing key fails `tsc`).
- The landing page `src/app/[lang]/page.tsx` must not read cookies, headers or the session on the server.
- No new dependencies. Colours from the design: ink `#171717`, muted `#5c574e`, rule `#e5e5e5`, green `#1f5138`, page `#f4f3f1`.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012SCj6darnoxDRCEXATF8rX
  ```

## Review Focus

1. **Landing page stays static** — a server session read would silently make every landing view dynamic. Pinned in Task 3 (build output check).
2. **An order whose breakdown can't be read** (legacy/malformed) → title is just the room label, never "0 units". Pinned in Task 1.
3. **Signed-out visitor on the track page of a standalone delivery** → page renders with a "Sign in" button, no redirect. Pinned in Task 3 (existing track test must still pass) + browser pass.
4. **Staff opening a customer's order** → page still renders (access unchanged); side nav counts the staff member's own orders. Pinned in Task 4 (layout test + existing order page test).
5. **Phone width (390 px)** → side nav stacks above content; card buttons wrap; menu stays on screen. Browser pass, Task 7.

---

### Task 1: Order card rules

**Files:**
- Create: `src/lib/orders/card.ts`
- Test: `src/lib/orders/__tests__/card.test.ts`

**Interfaces:**
- Consumes: `summaryLines(breakdown: unknown): { name: string; qty: number; amountRm: number }[]` from `@/lib/orders/summary`.
- Produces:
  ```ts
  type CardInput = { status: "AWAITING_PAYMENT" | "PAID" | "CANCELLED"; productionStage: ProductionStage | null; hasDelivery: boolean };
  type OrderCard = {
    badge: "paid" | "awaiting" | "cancelled";
    stage: { kind: "notStarted" } | { kind: "paid" } | { kind: "stage"; stage: ProductionStage } | { kind: "delivery" };
    canPay: boolean;
    canTrack: boolean;
  };
  orderCard(input: CardInput): OrderCard
  unitCount(breakdown: unknown): number
  ```

- [ ] **Step 1: Write the failing test**

`src/lib/orders/__tests__/card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orderCard, unitCount } from "../card";

describe("orderCard", () => {
	it("awaiting payment: pay, nothing in production, no tracking", () => {
		expect(
			orderCard({ status: "AWAITING_PAYMENT", productionStage: null, hasDelivery: false }),
		).toEqual({ badge: "awaiting", stage: { kind: "notStarted" }, canPay: true, canTrack: false });
	});

	it("cancelled: no pay, not started", () => {
		expect(
			orderCard({ status: "CANCELLED", productionStage: null, hasDelivery: false }),
		).toEqual({ badge: "cancelled", stage: { kind: "notStarted" }, canPay: false, canTrack: false });
	});

	it("paid, not started: payment received", () => {
		expect(
			orderCard({ status: "PAID", productionStage: null, hasDelivery: false }).stage,
		).toEqual({ kind: "paid" });
	});

	it("paid mid-production: the stage", () => {
		expect(
			orderCard({ status: "PAID", productionStage: "CUTTING", hasDelivery: false }),
		).toEqual({ badge: "paid", stage: { kind: "stage", stage: "CUTTING" }, canPay: false, canTrack: false });
	});

	it("a delivery wins over the stage and can be tracked", () => {
		expect(
			orderCard({ status: "PAID", productionStage: "READY", hasDelivery: true }),
		).toEqual({ badge: "paid", stage: { kind: "delivery" }, canPay: false, canTrack: true });
	});
});

describe("unitCount", () => {
	it("counts every cabinet line", () => {
		const breakdown = {
			cabinets: [
				{ label: "BC 600", doorLabel: "Slab", amountRm: 500 },
				{ label: "BC 600", doorLabel: "Slab", amountRm: 500 },
				{ label: "BC 800", doorLabel: null, amountRm: 700 },
			],
		};
		expect(unitCount(breakdown)).toBe(3);
	});

	it("is zero for a breakdown it cannot read", () => {
		expect(unitCount(null)).toBe(0);
		expect(unitCount({ nope: true })).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/orders/__tests__/card.test.ts`
Expected: FAIL — cannot resolve `../card`.

- [ ] **Step 3: Implement**

`src/lib/orders/card.ts`:

```ts
import type { ProductionStage } from "@/generated/prisma/enums";
import { summaryLines } from "./summary";

type CardInput = {
	status: "AWAITING_PAYMENT" | "PAID" | "CANCELLED";
	productionStage: ProductionStage | null;
	hasDelivery: boolean;
};

export type OrderCard = {
	badge: "paid" | "awaiting" | "cancelled";
	stage:
		| { kind: "notStarted" }
		| { kind: "paid" }
		| { kind: "stage"; stage: ProductionStage }
		| { kind: "delivery" };
	canPay: boolean;
	canTrack: boolean;
};

/**
 * What an order's card on My orders says and offers. Pure, so the list and
 * the detail page agree. A booked delivery is the furthest thing a customer
 * can follow, so it wins over the production stage.
 */
export function orderCard(order: CardInput): OrderCard {
	const paid = order.status === "PAID";
	return {
		badge: paid ? "paid" : order.status === "CANCELLED" ? "cancelled" : "awaiting",
		stage: !paid
			? { kind: "notStarted" }
			: order.hasDelivery
				? { kind: "delivery" }
				: order.productionStage
					? { kind: "stage", stage: order.productionStage }
					: { kind: "paid" },
		canPay: order.status === "AWAITING_PAYMENT",
		canTrack: order.hasDelivery,
	};
}

/** Cabinets in the stored breakdown; zero when it cannot be read. */
export const unitCount = (breakdown: unknown): number =>
	summaryLines(breakdown).reduce((sum, line) => sum + line.qty, 0);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/lib/orders/__tests__/card.test.ts`
Expected: PASS, 7 tests. Then `pnpm exec biome check --write src/lib/orders`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orders/card.ts src/lib/orders/__tests__/card.test.ts
git commit -m "feat(orders): order card rules for the account page"
```

---

### Task 2: Copy

**Files:**
- Modify: `src/lib/copy/en.ts`, `src/lib/copy/ms.ts`, `src/lib/copy/zh.ts`

**Interfaces:**
- Produces keys: `account.{navHeading,myOrders,signIn,signOut,menuLabel}`; `orders.{orderedOn,unitsOne,unitsOther,stageNotStarted,payNow,viewOrder}` and a new `orders.emptyBody` value; `order.{progressHeading,totalDue}`.

- [ ] **Step 1: Add to `en.ts`**

Add a new top-level section directly before `orders: {`:

```ts
	/** The shared header's account menu and the account side nav. */
	account: {
		navHeading: "Your account",
		myOrders: "My orders",
		signIn: "Sign in",
		signOut: "Sign out",
		menuLabel: "Account menu",
	},
```

In `orders`, replace `emptyBody` and add after `statusCancelled`:

```ts
		emptyBody:
			"When you order a design, it shows up here with its payment, production and delivery status.",
```

```ts
		orderedOn: "Ordered {date}",
		unitsOne: "{room} · 1 unit",
		unitsOther: "{room} · {count} units",
		stageNotStarted: "Not in production yet",
		payNow: "Pay now",
		viewOrder: "View order",
```

In `order`, after `trackDelivery`:

```ts
		progressHeading: "Progress",
		totalDue: "Total due",
```

- [ ] **Step 2: Add the same keys to `ms.ts`**

```ts
	account: {
		navHeading: "Akaun anda",
		myOrders: "Pesanan saya",
		signIn: "Log masuk",
		signOut: "Log keluar",
		menuLabel: "Menu akaun",
	},
```

```ts
		emptyBody:
			"Apabila anda memesan reka bentuk, ia dipaparkan di sini bersama status bayaran, pengeluaran dan penghantarannya.",
```

```ts
		orderedOn: "Dipesan {date}",
		unitsOne: "{room} · 1 unit",
		unitsOther: "{room} · {count} unit",
		stageNotStarted: "Belum masuk pengeluaran",
		payNow: "Bayar sekarang",
		viewOrder: "Lihat pesanan",
```

```ts
		progressHeading: "Kemajuan",
		totalDue: "Jumlah perlu dibayar",
```

- [ ] **Step 3: Add the same keys to `zh.ts`**

```ts
	account: {
		navHeading: "您的账户",
		myOrders: "我的订单",
		signIn: "登录",
		signOut: "退出登录",
		menuLabel: "账户菜单",
	},
```

```ts
		emptyBody: "订购设计后，订单会显示在这里，并附上付款、生产和配送状态。",
```

```ts
		orderedOn: "下单于 {date}",
		unitsOne: "{room} · 1 件",
		unitsOther: "{room} · {count} 件",
		stageNotStarted: "尚未开始生产",
		payNow: "立即付款",
		viewOrder: "查看订单",
```

```ts
		progressHeading: "进度",
		totalDue: "应付总额",
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit && pnpm exec biome check --write src/lib/copy`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copy
git commit -m "feat(copy): account menu, order cards and progress copy"
```

---

### Task 3: Shared header and account menu

**Files:**
- Create: `src/lib/initials.ts`, `src/lib/__tests__/initials.test.ts`
- Create: `src/components/AccountMenu.tsx`, `src/components/SiteHeader.tsx`
- Modify: `src/app/[lang]/track/[token]/page.tsx` (its `<header>` bar)
- Modify: `src/app/[lang]/page.tsx` (lines ~224-226 and ~289-291: the two `myOrders` links; the right-hand header group)

**Interfaces:**
- Consumes: copy keys from Task 2; `authClient` from `@/lib/auth/client`; `Dictionary` from `@/lib/copy/en`.
- Produces:
  - `initialsOf(name: string | null | undefined, email: string): string`
  - `<AccountMenu lang={string} labels={{ signIn: string; signOut: string; myOrders: string; menu: string }} />` (client)
  - `<SiteHeader lang={string} t={Dictionary} />` (no hooks; renders `AccountMenu`)

- [ ] **Step 1: Failing test for initials**

`src/lib/__tests__/initials.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialsOf } from "../initials";

describe("initialsOf", () => {
	it("takes the first and last word of the name", () => {
		expect(initialsOf("Nur Aisyah binti Kamal", "a@x.com")).toBe("NK");
	});
	it("takes one letter from a one-word name", () => {
		expect(initialsOf("aisyah", "a@x.com")).toBe("A");
	});
	it("falls back to the email when there is no name", () => {
		expect(initialsOf("", "zed@x.com")).toBe("Z");
		expect(initialsOf(null, "zed@x.com")).toBe("Z");
	});
});
```

Run: `pnpm exec vitest run src/lib/__tests__/initials.test.ts` — expected FAIL (module missing).

- [ ] **Step 2: Implement initials**

`src/lib/initials.ts`:

```ts
/** Up to two letters for an avatar: first and last word of the name, else the email. */
export function initialsOf(name: string | null | undefined, email: string): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return email.charAt(0).toUpperCase();
	const first = words[0].charAt(0);
	const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
	return (first + last).toUpperCase();
}
```

Run the test again — expected PASS, 3 tests.

- [ ] **Step 3: AccountMenu**

`src/components/AccountMenu.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { initialsOf } from "@/lib/initials";

/**
 * The header's right-hand side: an avatar menu when signed in, a Sign in
 * button when not. Reads the session in the browser so the pages it sits on
 * (the landing page above all) can stay statically rendered.
 */
export function AccountMenu({
	lang,
	labels,
}: {
	lang: string;
	labels: { signIn: string; signOut: string; myOrders: string; menu: string };
}) {
	const { data, isPending } = authClient.useSession();
	const pathname = usePathname();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Same footprint as the avatar, so the header does not jump once it loads.
	if (isPending) return <span aria-hidden className="h-10 w-[58px]" />;

	const user = data?.user;
	if (!user) {
		return (
			<Link
				href={`/${lang}/sign-in?next=${encodeURIComponent(pathname)}`}
				className="flex min-h-9 items-center rounded-lg border border-[#d4d4d4] bg-white px-3.5 font-medium text-[#171717] text-[13px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
			>
				{labels.signIn}
			</Link>
		);
	}

	const item =
		"flex min-h-[38px] items-center rounded-lg px-2.5 text-left text-[13px] text-[#171717] hover:bg-[#f4f3f1] active:bg-[#ecebe7]";

	return (
		<div ref={root} className="relative">
			<button
				ref={trigger}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={labels.menu}
				onClick={() => setOpen((v) => !v)}
				className="flex min-h-10 items-center gap-2 rounded-full border border-[#e5e5e5] bg-white py-[3px] pr-2.5 pl-[3px] text-[#171717] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
			>
				<span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1f5138] font-semibold text-[12px] text-white">
					{initialsOf(user.name, user.email)}
				</span>
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
					<path d="M2.5 4 5 6.5 7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
			{open && (
				<div
					role="menu"
					aria-label={labels.menu}
					className="absolute top-[calc(100%+6px)] right-0 z-20 flex w-60 flex-col rounded-xl border border-[#e5e5e5] bg-white p-1.5 shadow-[0_12px_32px_rgba(23,23,23,.12)]"
				>
					<div className="mb-1 border-[#ecebe7] border-b px-2.5 pt-2.5 pb-3">
						<p className="truncate font-semibold text-[13px]">{user.name}</p>
						<p className="truncate text-[#5c574e] text-[12px]">{user.email}</p>
					</div>
					<Link role="menuitem" href={`/${lang}/orders`} className={item} onClick={() => setOpen(false)}>
						{labels.myOrders}
					</Link>
					<button
						type="button"
						role="menuitem"
						className={`${item} mt-1 rounded-t-none border-[#ecebe7] border-t text-[#5c574e] hover:text-[#171717]`}
						onClick={async () => {
							setOpen(false);
							await authClient.signOut();
							router.push(`/${lang}`);
							router.refresh();
						}}
					>
						{labels.signOut}
					</button>
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 4: SiteHeader**

`src/components/SiteHeader.tsx`:

```tsx
import Link from "next/link";
import type { Dictionary } from "@/lib/copy/en";
import { AccountMenu } from "./AccountMenu";

const NAV =
	"flex min-h-9 items-center rounded-lg px-2.5 font-medium text-[#404040] text-[13px] hover:bg-[#f4f3f1] hover:text-[#171717]";

/** The design's header for the account pages and the track page. */
export function SiteHeader({ lang, t }: { lang: string; t: Dictionary }) {
	return (
		<header className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-[#e5e5e5] border-b bg-white px-4 py-2.5 sm:px-7">
			<div className="flex items-center gap-5">
				<Link href={`/${lang}`} className="px-0.5 py-1.5 font-bold text-[#171717] text-[14px]">
					{t.common.brand}
				</Link>
				<nav aria-label="Main" className="hidden gap-1 sm:flex">
					<Link href={`/${lang}/planner`} className={NAV}>
						{t.planner.crumbs.roomPlanner}
					</Link>
					<Link href={`/${lang}/tutorials`} className={NAV}>
						{t.landing.nav.tutorials}
					</Link>
				</nav>
			</div>
			<AccountMenu
				lang={lang}
				labels={{
					signIn: t.account.signIn,
					signOut: t.account.signOut,
					myOrders: t.account.myOrders,
					menu: t.account.menuLabel,
				}}
			/>
		</header>
	);
}
```

- [ ] **Step 5: Use it on the track page**

In `src/app/[lang]/track/[token]/page.tsx`, add `import { SiteHeader } from "@/components/SiteHeader";` and replace the page's top `<header …>…</header>` element (the breadcrumb bar) with:

```tsx
			<SiteHeader lang={lang} t={t} />
```

Leave everything else on the page as it is.

- [ ] **Step 6: Use the menu on the landing page**

In `src/app/[lang]/page.tsx`:
1. Delete both `<Link href={`/${lang}/orders`} className={navLink}>{t.landing.nav.myOrders}</Link>` elements (desktop nav and mobile disclosure).
2. Add `import { AccountMenu } from "@/components/AccountMenu";`
3. In the header's right-hand `<div className="flex shrink-0 items-center gap-4">`, insert before the "Start planning" CTA link:

```tsx
						<AccountMenu
							lang={lang}
							labels={{
								signIn: t.account.signIn,
								signOut: t.account.signOut,
								myOrders: t.account.myOrders,
								menu: t.account.menuLabel,
							}}
						/>
```

4. Remove `myOrders` from `landing.nav` in `en.ts`, `ms.ts` and `zh.ts` (grep first: `grep -rn "landing.nav.myOrders" src` must return nothing).

- [ ] **Step 7: Verify, including that the landing page is still static**

Run: `pnpm exec tsc --noEmit && pnpm exec biome check --write src/components src/lib/initials.ts src/app && pnpm test`
Expected: exit 0; all tests pass (the track page tests still pass — the header needs no data). If the track page tests now fail at import because `@/lib/auth/client` cannot load under Node, add `vi.mock("@/lib/auth/client", () => ({ authClient: {} }));` to that test file — never change the component to suit the test.

Run: `pnpm build 2>&1 | grep -E "\[lang\]\s*$|/\[lang\] "`
Expected: the `/[lang]` route is marked `●` (SSG), not `ƒ` (dynamic). If it shows `ƒ`, something in the landing page now reads request data — fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/initials.ts src/lib/__tests__/initials.test.ts src/components/AccountMenu.tsx src/components/SiteHeader.tsx "src/app/[lang]/track/[token]/page.tsx" "src/app/[lang]/page.tsx" src/lib/copy
git commit -m "feat(account): shared header with account menu"
```

---

### Task 4: Account route group, layout and side nav

**Files:**
- Move: `src/app/[lang]/orders/` → `src/app/[lang]/(account)/orders/`
- Move: `src/app/[lang]/order/` → `src/app/[lang]/(account)/order/`
- Create: `src/app/[lang]/(account)/layout.tsx`, `src/app/[lang]/(account)/AccountNav.tsx`
- Test: `src/app/[lang]/(account)/__tests__/layout.test.ts`
- Modify: the two moved page tests' import paths

**Interfaces:**
- Consumes: `SiteHeader` (Task 3); `currentUser()` from `@/lib/auth/session`; `prisma` from `@/lib/catalogue/db`.
- Produces: `(account)/layout.tsx` default export `AccountLayout({ children, params })`; pages render only their content (no outer wrapper, no header).

- [ ] **Step 1: Move the folders with git**

```bash
mkdir -p "src/app/[lang]/(account)"
git mv "src/app/[lang]/orders" "src/app/[lang]/(account)/orders"
git mv "src/app/[lang]/order" "src/app/[lang]/(account)/order"
```

Update the two dynamic imports in the moved tests:
- `(account)/orders/__tests__/page.test.ts`: `await import("@/app/[lang]/(account)/orders/page")`
- `(account)/order/[token]/__tests__/page.test.ts`: `await import("@/app/[lang]/(account)/order/[token]/page")`

Run: `pnpm exec vitest run "src/app/[lang]/(account)"` — expected PASS (only paths changed).

- [ ] **Step 2: Failing layout test**

`src/app/[lang]/(account)/__tests__/layout.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/session";

const currentUser = vi.hoisted(() => vi.fn<() => Promise<AuthUser | null>>());
vi.mock("@/lib/auth/session", () => ({ currentUser }));

const count = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalogue/db", () => ({ prisma: { order: { count } } }));

const { default: AccountLayout } = await import("@/app/[lang]/(account)/layout");

const open = () =>
	AccountLayout({ children: null, params: Promise.resolve({ lang: "en" }) });

beforeEach(() => {
	count.mockReset();
	count.mockResolvedValue(2);
});

describe("account layout", () => {
	it("counts only the signed-in account's orders for the side nav", async () => {
		currentUser.mockResolvedValue({
			id: "staff-1", email: "s@x.com", name: "S", image: null,
			role: "ADMIN", disabled: false, mustChangePassword: false,
		});
		await open();
		expect(count).toHaveBeenCalledWith({ where: { userId: "staff-1" } });
	});

	it("does not query when nobody is signed in (the page redirects)", async () => {
		currentUser.mockResolvedValue(null);
		await open();
		expect(count).not.toHaveBeenCalled();
	});
});
```

Run it — expected FAIL (layout missing). If, once the layout exists, the import fails because `@/lib/auth/client` cannot load under Node, add `vi.mock("@/lib/auth/client", () => ({ authClient: {} }));` to this test.

- [ ] **Step 3: AccountNav**

`src/app/[lang]/(account)/AccountNav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The design's "Your account" side nav. Current = this page or one under it. */
export function AccountNav({
	heading,
	items,
}: {
	heading: string;
	items: { href: string; label: string; count: number; matches: string[] }[];
}) {
	const pathname = usePathname();
	return (
		<nav aria-label={heading} className="flex flex-[0_0_200px] flex-col gap-0.5 md:sticky md:top-6">
			<p className="mb-2 ml-2.5 font-semibold text-[#5c574e] text-[12px] uppercase tracking-[.06em]">
				{heading}
			</p>
			{items.map((item) => {
				const current = item.matches.some((m) => pathname.startsWith(m));
				return (
					<Link
						key={item.href}
						href={item.href}
						aria-current={current ? "page" : undefined}
						className={`flex min-h-10 items-center justify-between gap-2 rounded-lg px-2.5 text-[13px] hover:bg-[#ecebe7] hover:text-[#171717] ${
							current
								? "bg-white font-semibold text-[#171717] shadow-[0_0_0_1px_#e5e5e5]"
								: "font-medium text-[#404040]"
						}`}
					>
						<span>{item.label}</span>
						<span className="font-medium text-[#5c574e] text-[12px] tabular-nums">{item.count}</span>
					</Link>
				);
			})}
		</nav>
	);
}
```

- [ ] **Step 4: The layout**

`src/app/[lang]/(account)/layout.tsx`:

```tsx
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale } from "@/lib/copy/locales";
import { AccountNav } from "./AccountNav";

/**
 * The customer account frame: the shared header and the "Your account" side
 * nav around My orders and each order. It decides nothing about access — a
 * layout is not given the URL, so it cannot send a visitor to sign-in and
 * back; each page does that with `viewerOf`.
 */
export const metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const [user, t] = await Promise.all([currentUser(), getDictionary(lang)]);
	const orders = user
		? await prisma.order.count({ where: { userId: user.id } })
		: 0;

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-[#171717]">
			<SiteHeader lang={lang} t={t} />
			<div className="flex flex-1 justify-center px-4 pt-8 pb-16 sm:px-7">
				<div className="flex w-full max-w-[1040px] flex-wrap items-start gap-7">
					<AccountNav
						heading={t.account.navHeading}
						items={[
							{
								href: `/${lang}/orders`,
								label: t.account.myOrders,
								count: orders,
								matches: [`/${lang}/orders`, `/${lang}/order/`],
							},
						]}
					/>
					<main className="flex min-w-0 flex-[1_1_520px] flex-col gap-[18px]">
						{children}
					</main>
				</div>
			</div>
		</div>
	);
}
```

- [ ] **Step 5: Strip the pages' own frames**

In both moved pages, remove the outer `<div className="flex min-h-screen …">`, its `<header>…</header>` and the `<main …>` wrapper, returning a fragment `<>…</>` of the inner content (Tasks 5 and 6 replace that content; here it only has to render inside the layout). Remove the pages' own `export const metadata` (the layout carries `noindex`).

- [ ] **Step 6: Verify**

Run: `pnpm exec vitest run "src/app/[lang]/(account)" && pnpm exec tsc --noEmit && pnpm exec biome check --write "src/app/[lang]/(account)"`
Expected: all pass, including the moved access tests unchanged apart from import paths.

- [ ] **Step 7: Commit**

```bash
git add -A "src/app/[lang]/(account)" "src/app/[lang]/orders" "src/app/[lang]/order"
git commit -m "feat(account): account layout and side nav around the order pages"
```

---

### Task 5: My orders cards

**Files:**
- Create: `src/app/[lang]/(account)/PaymentBadge.tsx`
- Modify: `src/app/[lang]/(account)/orders/page.tsx`
- Test: `src/app/[lang]/(account)/orders/__tests__/page.test.ts` (unchanged assertions must still pass)

**Interfaces:**
- Consumes: `orderCard`, `unitCount` (Task 1); copy (Task 2); layout (Task 4).
- Produces: `<PaymentBadge badge={"paid" | "awaiting" | "cancelled"} label={string} />`; `orderTitle` is local to each page (below).

- [ ] **Step 1: PaymentBadge**

`src/app/[lang]/(account)/PaymentBadge.tsx`:

```tsx
import type { OrderCard } from "@/lib/orders/card";

const STYLE: Record<OrderCard["badge"], string> = {
	paid: "bg-[#e8f0eb] text-[#17402c]",
	awaiting: "bg-[#f7f3e6] text-[#4a4120]",
	cancelled: "bg-[#ecebe7] text-[#5c574e]",
};

export function PaymentBadge({ badge, label }: { badge: OrderCard["badge"]; label: string }) {
	return (
		<span className={`inline-flex min-h-6 items-center rounded-full px-2.5 font-semibold text-[12px] ${STYLE[badge]}`}>
			{label}
		</span>
	);
}
```

- [ ] **Step 2: Rewrite the page body**

Replace `src/app/[lang]/(account)/orders/page.tsx` with:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { isLocale } from "@/lib/copy/locales";
import { viewerOf } from "@/lib/orders/access";
import { orderCard, unitCount } from "@/lib/orders/card";
import { orderRef } from "@/lib/orders/ref";
import { ROOM_TYPES } from "@/lib/planner/catalogue";
import { PaymentBadge } from "../PaymentBadge";

/**
 * A signed-in customer's own orders, newest first. The query is scoped to the
 * session's user id and takes nothing from the URL, so there is no parameter
 * to point at somebody else's orders. Staff see only orders they placed
 * themselves; every order is at /admin/orders.
 */

const rm = (amount: number) =>
	`RM ${amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ponytail: room names are the catalogue's English labels; localise when rooms get copy keys.
const roomLabel = (id: string) => ROOM_TYPES.find((room) => room.id === id)?.label ?? id;

const BUTTON =
	"flex min-h-9 items-center rounded-lg border border-[#d4d4d4] bg-white px-3.5 font-medium text-[#171717] text-[12px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]";

export default async function OrdersPage({ params }: { params: Promise<{ lang: string }> }) {
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
				breakdown: true,
				deliveries: { select: { publicToken: true }, orderBy: { createdAt: "desc" }, take: 1 },
			},
		}),
		getDictionary(lang),
	]);
	const s = t.orders;
	const badgeLabel = { paid: s.statusPaid, awaiting: s.statusAwaiting, cancelled: s.statusCancelled };

	return (
		<>
			<h1 className="font-semibold text-[22px]">{s.heading}</h1>
			{orders.length === 0 ? (
				<div className="flex flex-col items-center gap-2.5 rounded-[14px] border border-[#e5e5e5] bg-white px-6 py-10 text-center">
					<p className="font-semibold text-[15px]">{s.empty}</p>
					<p className="max-w-[340px] text-[#5c574e] text-[13px] leading-[19px]">{s.emptyBody}</p>
					<Link
						href={`/${lang}/planner`}
						className="mt-1.5 flex min-h-[42px] items-center rounded-[10px] bg-[#171717] px-[18px] font-semibold text-[13px] text-white hover:bg-[#262626]"
					>
						{s.startPlanning}
					</Link>
				</div>
			) : (
				orders.map((order) => {
					const delivery = order.deliveries[0] ?? null;
					const card = orderCard({
						status: order.status,
						productionStage: order.productionStage,
						hasDelivery: delivery !== null,
					});
					const units = unitCount(order.breakdown);
					const room = roomLabel(order.roomId);
					const title =
						units === 0
							? room
							: fill(units === 1 ? s.unitsOne : s.unitsOther, { room, count: units });
					const stage =
						card.stage.kind === "notStarted"
							? s.stageNotStarted
							: card.stage.kind === "paid"
								? t.order.stagePaid
								: card.stage.kind === "delivery"
									? t.order.stageDelivery
									: t.order.stages[card.stage.stage];
					const orderHref = `/${lang}/order/${order.publicToken}`;
					return (
						<article
							key={order.publicToken}
							className="flex flex-col gap-2.5 rounded-[14px] border border-[#e5e5e5] bg-white p-4"
						>
							<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
								<div className="min-w-0">
									<h2 className="font-semibold text-[15px]">{title}</h2>
									<p className="mt-0.5 text-[#5c574e] text-[12px]">
										<span className="font-mono">{orderRef(order.number, order.createdAt)}</span>
										{" · "}
										{fill(s.orderedOn, {
											date: order.createdAt.toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" }),
										})}
									</p>
								</div>
								<p className="font-semibold text-[16px] tabular-nums">{rm(order.totalRm)}</p>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<PaymentBadge badge={card.badge} label={badgeLabel[card.badge]} />
								<span className="text-[#404040] text-[12px]">{stage}</span>
							</div>
							<div className="mt-0.5 flex flex-wrap gap-2">
								{card.canPay && (
									<Link
										href={orderHref}
										className="flex min-h-9 items-center rounded-lg bg-[#171717] px-3.5 font-semibold text-[12px] text-white hover:bg-[#262626]"
									>
										{s.payNow}
									</Link>
								)}
								<Link href={orderHref} className={BUTTON}>
									{s.viewOrder}
								</Link>
								{card.canTrack && delivery && (
									<Link href={`/${lang}/track/${delivery.publicToken}`} className={BUTTON}>
										{t.order.trackDelivery}
									</Link>
								)}
							</div>
						</article>
					);
				})
			)}
		</>
	);
}
```

Remove the now-unused `orders.breadcrumb` and `orders.placedOn` keys from `en.ts`, `ms.ts`, `zh.ts` (confirm with `grep -rn "orders.placedOn\|s.placedOn\|s.breadcrumb" src` first).

- [ ] **Step 3: Verify**

Run: `pnpm exec vitest run "src/app/[lang]/(account)" && pnpm exec tsc --noEmit && pnpm exec biome check --write "src/app/[lang]/(account)" src/lib/copy`
Expected: pass. The orders page test's `where: { userId }` assertions are unchanged.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[lang]/(account)" src/lib/copy
git commit -m "feat(account): order cards with payment badge, stage and actions"
```

---

### Task 6: Order detail inside the account layout

**Files:**
- Modify: `src/app/[lang]/(account)/order/[token]/page.tsx`
- Test: `src/app/[lang]/(account)/order/[token]/__tests__/page.test.ts` (unchanged; must pass)

**Interfaces:**
- Consumes: `orderCard`, `unitCount` (Task 1); `PaymentBadge` (Task 5); copy (Task 2).

- [ ] **Step 1: Keep the data, replace the markup**

Keep everything in `OrderPage` from the top down to and including the `const [heading, body] = …` block unchanged, and add `roomId: true` to the `select`. Then:

1. Add imports: `import { orderCard, unitCount } from "@/lib/orders/card";`, `import { ROOM_TYPES } from "@/lib/planner/catalogue";`, `import { PaymentBadge } from "../../PaymentBadge";`. Remove `CopyOrderId`'s import only if you drop it — keep it (the spec keeps it beside the ref).
2. Delete the `StatusIcon` function at the bottom of the file.
3. After the `[heading, body]` block add:

```tsx
	const card = orderCard({
		status: order.status,
		productionStage: order.productionStage,
		hasDelivery: delivery !== null,
	});
	const units = unitCount(order.breakdown);
	const room = ROOM_TYPES.find((r) => r.id === order.roomId)?.label ?? order.roomId;
	const title =
		units === 0
			? room
			: fill(units === 1 ? t.orders.unitsOne : t.orders.unitsOther, { room, count: units });
	const badgeLabel = {
		paid: t.orders.statusPaid,
		awaiting: t.orders.statusAwaiting,
		cancelled: t.orders.statusCancelled,
	}[card.badge];
	const paid = order.status === "PAID";
	const progress = [
		{ label: o.stagePaid, detail: undefined as string | undefined, done: paid },
		...STAGES.map((stage) => ({
			label: o.stages[stage],
			detail: stage === "MEASURE" ? o.stageMeasureDetail : undefined,
			done: paid && stageReached(order.productionStage, stage),
		})),
		{ label: o.stageDelivery, detail: undefined as string | undefined, done: false },
	];
	const next = progress.findIndex((step) => !step.done);
```

4. Replace the whole `return (…)` with:

```tsx
	return (
		<>
			{settling && <RefreshWhileSettling />}
			<Link
				href={`/${lang}/orders`}
				className="flex min-h-9 items-center gap-1.5 self-start rounded-lg border border-[#d4d4d4] bg-white px-3 font-medium text-[#171717] text-[12px] hover:border-[#a3a3a3] hover:bg-[#faf9f7]"
			>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
					<path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
				{t.account.myOrders}
			</Link>

			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">{title}</h1>
					<p className="flex items-center gap-1.5 text-[#5c574e] text-[13px]">
						<span className="font-mono">{ref}</span>
						<CopyOrderId value={ref} label={o.copyOrderId} copiedLabel={o.copied} />
						<span>
							·{" "}
							{fill(t.orders.orderedOn, {
								date: order.createdAt.toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" }),
							})}
						</span>
					</p>
				</div>
				<PaymentBadge badge={card.badge} label={badgeLabel} />
			</div>

			<p className="text-[14px] text-[#404040]" role="status">
				<span className="font-semibold text-[#171717]">{heading}.</span> {body}
			</p>

			<div className="flex flex-wrap items-start gap-[18px]">
				<section className={`${CARD} min-w-0 flex-[1_1_300px]`}>
					<h2 className={`${CARD_HEADING} mb-3.5`}>{o.progressHeading}</h2>
					<ol className="flex flex-col gap-3">
						{progress.map((step, i) => (
							<li key={step.label} className="flex items-start gap-3">
								<span
									className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] text-white ${
										step.done
											? "bg-[#1f5138]"
											: i === next
												? "border-2 border-[#1f5138] bg-white"
												: "bg-[#d4d4d4]"
									}`}
								>
									{step.done ? "✓" : ""}
								</span>
								<div>
									<p className="font-medium text-[13px]">{step.label}</p>
									{step.detail && <p className="text-[#5c574e] text-[12px]">{step.detail}</p>}
								</div>
							</li>
						))}
					</ol>
				</section>

				<div className="flex min-w-0 flex-[1_1_300px] flex-col gap-[18px]">
					{/* the existing payOnline section, unchanged */}
					{/* the existing pay (bank transfer) section, unchanged */}

					<section className={CARD}>
						{/* the existing summary section body: lines, extras, subtotal, delivery */}
						{/* total row label: */}
						{/* <span>{paid ? o.totalPaid : o.totalDue}</span> */}
					</section>

					<section className={CARD}>
						<h2 className={`${CARD_HEADING} mb-1.5`}>{o.addressHeading}</h2>
						<p className="whitespace-pre-line text-[13px] leading-5">{order.siteAddress}</p>
					</section>

					{delivery && (
						<Link
							href={`/${lang}/track/${delivery.publicToken}`}
							className="inline-flex min-h-10 items-center self-start rounded-[9px] bg-[#1f5138] px-4 font-semibold text-[13px] text-white hover:bg-[#1a4430]"
						>
							{o.trackDelivery}
						</Link>
					)}
				</div>
			</div>
		</>
	);
```

The three `{/* … */}` markers inside the right column mean: **move the existing JSX blocks there verbatim** — the `{payOnline && (<section …>…</section>)}` block, the `{pay && (<section …>…</section>)}` block, and the body of the existing summary `<section>` (heading, `lines.map`, `extras.map`, subtotal, delivery, total). In the total row change `o.total` to `o.totalDue`. Delete the markers after moving. Everything else from the old return (StatusIcon block, the "What happens next" section, the Back to planner / Back home links) is removed.

5. Remove now-unused copy keys from `en.ts`, `ms.ts`, `zh.ts`, each only after `grep -rn "o\.<key>\|order\.<key>" src` shows no use: `order.breadcrumb`, `order.myOrders`, `order.nextHeading`, `order.backToPlanner`, `order.backHome`, `order.orderId`.

- [ ] **Step 2: Verify**

Run: `pnpm exec vitest run "src/app/[lang]/(account)" && pnpm exec tsc --noEmit && pnpm exec biome check --write "src/app/[lang]/(account)" src/lib/copy && pnpm test`
Expected: all pass — the order page access tests (redirect, owner, staff, stranger 404) unchanged.

- [ ] **Step 3: Commit**

```bash
git add "src/app/[lang]/(account)" src/lib/copy
git commit -m "feat(account): order detail with progress, summary and payment in the account layout"
```

---

### Task 7: Docs and browser pass

**Files:**
- Modify: `CLAUDE.md` (UX flow: "An order is its owner's." paragraph; directory layout)
- Modify: `docs/superpowers/specs/2026-09-28-customer-account-shell-design.md` (the header paragraph's "no client session fetch")

- [ ] **Step 1: CLAUDE.md**

After the paragraph starting "**An order is its owner's.**", add:

```markdown
**The account area** is the route group `app/[lang]/(account)/` — My orders
and each order page inside one layout (`SiteHeader` + "Your account" side
nav); route groups leave URLs unchanged. The layout only reads who is signed
in; access stays in each page (`viewerOf`, `canViewOrder`). `AccountMenu`
reads the session in the browser so the statically rendered landing page,
which also shows it, stays static. Profile, WhatsApp number, saved addresses
and saved designs are later pieces of the Claude Design "Customer Account"
file; customer sign-in stays Google only.
```

- [ ] **Step 2: Spec**

In the spec's "Shared header" section replace "The server passes the user (`{ name, email } | null`) in as a prop; no client session fetch." with "`AccountMenu` reads the session in the browser (`authClient.useSession()`), so the statically rendered landing page stays static."

- [ ] **Step 3: Commit docs**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-28-customer-account-shell-design.md
git commit -m "docs: customer account area"
```

- [ ] **Step 4: Browser pass (controller or user)**

`pnpm dev`, signed in with Google, at desktop and at 390 px width, compare against the design: empty My orders; an awaiting order (Pay now → payment card on the detail page); a paid order mid-production; an order with a delivery (Track delivery on card and detail); account menu open → Escape closes and refocuses the avatar → outside click closes → Sign out lands on home signed out; signed-out header on a standalone delivery's track page shows Sign in; landing page shows the avatar when signed in. Record pass/fail per item.
