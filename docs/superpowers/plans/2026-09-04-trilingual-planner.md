# Trilingual planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the public planner in English, Simplified Chinese and Bahasa Malaysia, each on its own indexable URL.

**Architecture:** Next.js App Router's documented i18n pattern — an `app/[lang]/` segment, locale negotiation in `src/proxy.ts`, and one typed dictionary module per locale. Server components read the dictionary directly and cost nothing on the wire; the planner's client components receive it through a `CopyProvider` that mirrors the existing `CatalogueProvider`.

**Tech Stack:** Next.js 16.3.1 (App Router), TypeScript, Tailwind v4, vitest. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-04-trilingual-planner-design.md`

## Global Constraints

- Locales are exactly `en`, `zh`, `ms`. `en` is the default. Short codes, because they appear in the URL.
- `zh` is **Simplified** Chinese (the Malaysian standard).
- Translate only strings **we** wrote. Never translate catalogue labels (family, door style, room type, finish) or tutorial titles/descriptions — they are client-authored Postgres rows.
- `/admin`, `/api`, `_next` and static files stay **outside** `[lang]` and are never locale-redirected.
- Every dictionary value is a **plain string**. The dictionary crosses the RSC boundary into a client provider, so functions would throw at runtime. Interpolation uses `{token}` placeholders plus `fill()`.
- `en.ts` is the source of truth. `zh.ts` and `ms.ts` are typed against it so a missing key is a **compile error**.
- No new npm packages. No CJK webfont. No message-formatting library.
- Sentence case in UI copy. Prices in RM.
- The 396 existing tests must stay green — this work does not touch `lib/planner`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/copy/locales.ts` | The locale vocabulary and `Accept-Language` negotiation. Pure, no React, no Next. |
| `src/lib/copy/fill.ts` | `{token}` interpolation. Pure. |
| `src/lib/copy/en.ts` | The English dictionary and the `Dictionary` type others are gated against. |
| `src/lib/copy/zh.ts` | Simplified Chinese, typed `Dictionary`. |
| `src/lib/copy/ms.ts` | Bahasa Malaysia, typed `Dictionary`. |
| `src/lib/copy/dictionary.ts` | `getDictionary(locale)` — server-only dynamic import. |
| `src/lib/copy/__tests__/` | vitest: negotiation, parity, leakage, fill. |
| `src/components/planner/CopyContext.tsx` | `CopyProvider` / `useCopy` for the client tree. Mirrors `CatalogueContext.tsx`. |
| `src/components/LanguageSwitcher.tsx` | Three links, preserving the current path. |
| `src/app/[lang]/layout.tsx` | Root layout: `<html lang>`, `hreflang` alternates, `generateStaticParams`, per-locale metadata. |
| `src/app/[lang]/page.tsx` | Landing (moved). |
| `src/app/[lang]/planner/page.tsx` | Planner (moved). |
| `src/app/[lang]/tutorials/page.tsx` | Tutorials (moved). |
| `src/proxy.ts` | Gains locale negotiation alongside the existing admin gate. |
| `src/app/globals.css` | CJK fallback appended to `--font-sans`. |

---

### Task 1: Locale vocabulary and negotiation

Pure functions, no framework. Everything downstream depends on these names.

**Files:**
- Create: `src/lib/copy/locales.ts`
- Test: `src/lib/copy/__tests__/locales.test.ts`

**Interfaces:**
- Produces: `LOCALES: readonly ["en","zh","ms"]`, `type Locale`, `DEFAULT_LOCALE: Locale`, `isLocale(v: string): v is Locale`, `negotiateLocale(header: string | null | undefined): Locale`, `htmlLang(locale: Locale): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/copy/__tests__/locales.test.ts
import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	htmlLang,
	isLocale,
	LOCALES,
	negotiateLocale,
} from "../locales";

describe("isLocale", () => {
	it("accepts the three we serve and nothing else", () => {
		expect(LOCALES).toEqual(["en", "zh", "ms"]);
		expect(isLocale("zh")).toBe(true);
		expect(isLocale("de")).toBe(false);
		expect(isLocale("")).toBe(false);
	});
});

describe("negotiateLocale", () => {
	it("falls back to English with no header", () => {
		expect(negotiateLocale(null)).toBe(DEFAULT_LOCALE);
		expect(negotiateLocale("")).toBe("en");
	});

	it("matches a region-tagged locale on its base language", () => {
		expect(negotiateLocale("zh-CN,zh;q=0.9")).toBe("zh");
		expect(negotiateLocale("ms-MY")).toBe("ms");
		expect(negotiateLocale("en-GB")).toBe("en");
	});

	it("honours q-weights rather than document order", () => {
		expect(negotiateLocale("en;q=0.3,zh;q=0.9")).toBe("zh");
	});

	it("skips languages we do not serve", () => {
		expect(negotiateLocale("de-DE,fr;q=0.8")).toBe("en");
		expect(negotiateLocale("de,ms;q=0.5")).toBe("ms");
	});

	it("ignores a q=0 language, which means 'not this one'", () => {
		expect(negotiateLocale("zh;q=0,en;q=0.5")).toBe("en");
	});
});

describe("htmlLang", () => {
	it("widens the URL code to a real BCP-47 tag", () => {
		expect(htmlLang("en")).toBe("en");
		expect(htmlLang("zh")).toBe("zh-Hans");
		expect(htmlLang("ms")).toBe("ms-MY");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copy/__tests__/locales.test.ts`
Expected: FAIL — cannot resolve `../locales`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/copy/locales.ts

/**
 * The locales this site serves, and how an incoming request is matched to one.
 *
 * Pure and framework-free so the proxy, the layout and the tests all share one
 * answer. Short codes because they sit in the URL: `/zh/planner` reads better
 * than `/zh-Hans/planner`, and `htmlLang` widens them where a real BCP-47 tag
 * is required.
 */

export const LOCALES = ["en", "zh", "ms"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const isLocale = (value: string): value is Locale =>
	(LOCALES as readonly string[]).includes(value);

/** `<html lang>` and `hreflang` want a real tag; the URL wants a short one.
 * Simplified Chinese and Malaysian Malay are what we actually publish. */
const HTML_LANG: Record<Locale, string> = {
	en: "en",
	zh: "zh-Hans",
	ms: "ms-MY",
};
export const htmlLang = (locale: Locale): string => HTML_LANG[locale];

/**
 * Pick a locale from an `Accept-Language` header.
 *
 * Hand-rolled rather than pulling `negotiator` and `@formatjs/intl-localematcher`:
 * two dependencies to choose between three fixed strings is not a trade worth
 * making. Matching is on the base language, so `zh-CN`, `zh-Hans` and `zh-TW`
 * all land on `zh` — a Traditional-script reader gets Simplified, which is the
 * right call for a Malaysian audience and beats falling back to English.
 */
export function negotiateLocale(
	header: string | null | undefined,
): Locale {
	if (!header) return DEFAULT_LOCALE;

	const ranked = header
		.split(",")
		.map((part) => {
			const [tag, ...params] = part.trim().split(";");
			const weight = params
				.map((p) => p.trim())
				.find((p) => p.startsWith("q="));
			const q = weight ? Number.parseFloat(weight.slice(2)) : 1;
			return { tag: tag.trim().toLowerCase(), q };
		})
		// q=0 is the header's way of saying "not this one", so it must not match.
		.filter((entry) => entry.tag !== "" && Number.isFinite(entry.q) && entry.q > 0)
		.sort((a, b) => b.q - a.q);

	for (const { tag } of ranked) {
		const base = tag.split("-")[0];
		if (isLocale(base)) return base;
	}
	return DEFAULT_LOCALE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copy/__tests__/locales.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copy/locales.ts src/lib/copy/__tests__/locales.test.ts
git commit -m "feat(i18n): locale vocabulary and Accept-Language negotiation"
```

---

### Task 2: The `fill` helper

One function. It exists because dictionary values must stay serializable strings.

**Files:**
- Create: `src/lib/copy/fill.ts`
- Test: `src/lib/copy/__tests__/fill.test.ts`

**Interfaces:**
- Produces: `fill(template: string, vars: Record<string, string | number>): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/copy/__tests__/fill.test.ts
import { describe, expect, it } from "vitest";
import { fill } from "../fill";

describe("fill", () => {
	it("substitutes a token", () => {
		expect(fill("{count} cabinets", { count: 3 })).toBe("3 cabinets");
	});

	it("substitutes every occurrence", () => {
		expect(fill("{a} and {a}", { a: "x" })).toBe("x and x");
	});

	it("leaves an unknown token visible rather than printing undefined", () => {
		// A visible {missing} is a bug report; "undefined" on a quote is a lost sale.
		expect(fill("{missing} here", {})).toBe("{missing} here");
	});

	it("returns a template with no tokens unchanged", () => {
		expect(fill("Add cabinets", { n: 1 })).toBe("Add cabinets");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copy/__tests__/fill.test.ts`
Expected: FAIL — cannot resolve `../fill`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/copy/fill.ts

/**
 * Substitute `{token}` placeholders in a dictionary string.
 *
 * Dictionary values are plain strings, not functions, because the dictionary
 * is handed from a server component into a client provider and therefore has
 * to survive serialisation. This is the whole of the interpolation machinery
 * we need — no ICU, no plural rules: neither Chinese nor Malay inflects for
 * number, and the English cases are few enough to word around.
 */
export function fill(
	template: string,
	vars: Record<string, string | number>,
): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
		key in vars ? String(vars[key]) : whole,
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copy/__tests__/fill.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copy/fill.ts src/lib/copy/__tests__/fill.test.ts
git commit -m "feat(i18n): {token} interpolation for dictionary strings"
```

---

### Task 3: Dictionary modules and the type gate

Creates all three dictionaries with the `common` and `meta` groups populated for real, plus the loader. Later tasks add one group per surface.

**Files:**
- Create: `src/lib/copy/en.ts`, `src/lib/copy/zh.ts`, `src/lib/copy/ms.ts`, `src/lib/copy/dictionary.ts`
- Test: `src/lib/copy/__tests__/dictionary.test.ts`

**Interfaces:**
- Consumes: `Locale` from Task 1
- Produces: `type Dictionary`, `en`, `zh`, `ms`, `getDictionary(locale: Locale): Promise<Dictionary>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/copy/__tests__/dictionary.test.ts
import { describe, expect, it } from "vitest";
import { en } from "../en";
import { ms } from "../ms";
import { LOCALES } from "../locales";
import { zh } from "../zh";

/** Every leaf path in a nested dictionary, e.g. "common.back". */
const paths = (value: unknown, prefix = ""): string[] =>
	typeof value === "object" && value !== null
		? Object.entries(value).flatMap(([key, child]) =>
				paths(child, prefix ? `${prefix}.${key}` : key),
			)
		: [prefix];

const at = (dict: unknown, path: string): string =>
	path.split(".").reduce<never>((v, k) => (v as never)[k], dict as never);

/** Strings that are legitimately identical across locales. */
const SHARED = new Set(["common.brand"]);

describe("dictionaries", () => {
	it("serves exactly the three locales", () => {
		expect(LOCALES).toHaveLength(3);
	});

	// The type gate already makes this a compile error. The test catches it in
	// CI, where a stray `as never` or `@ts-expect-error` cannot hide it.
	it.each([
		["zh", zh],
		["ms", ms],
	])("%s has exactly English's keys", (_name, dict) => {
		expect(paths(dict).sort()).toEqual(paths(en).sort());
	});

	it.each([
		["zh", zh],
		["ms", ms],
	])("%s has no value left in English", (_name, dict) => {
		const untranslated = paths(en).filter(
			(p) => !SHARED.has(p) && at(dict, p) === at(en, p),
		);
		expect(untranslated).toEqual([]);
	});

	it("has no empty strings", () => {
		for (const dict of [en, zh, ms]) {
			for (const path of paths(dict)) {
				expect(at(dict, path).trim()).not.toBe("");
			}
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copy/__tests__/dictionary.test.ts`
Expected: FAIL — cannot resolve `../en`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/copy/en.ts

/**
 * The English dictionary, and the shape every other locale is held to.
 *
 * Values are plain strings — never functions. The dictionary is handed from a
 * server component into `CopyProvider`, so it crosses the RSC boundary and has
 * to serialise. Strings needing a number carry a `{token}` and go through
 * `fill`.
 */
export const en = {
	meta: {
		title: "EzCabinet · Design your kitchen in 3D",
		description:
			"Drop real EzCabinet units onto a model of your own room, see it from every angle, and get an instant price. No showroom visit required.",
	},
	common: {
		brand: "EzCabinet",
		back: "Back",
		next: "Next",
		close: "Close",
		language: "Language",
	},
} as const;

export type Dictionary = {
	readonly [K in keyof typeof en]: { readonly [P in keyof (typeof en)[K]]: string };
};
```

```ts
// src/lib/copy/zh.ts
import type { Dictionary } from "./en";

/** Simplified Chinese — the Malaysian standard. Typed against `Dictionary`, so
 * a missing key is a compile error rather than a blank on a customer's screen. */
export const zh: Dictionary = {
	meta: {
		title: "EzCabinet · 三维设计您的厨房",
		description:
			"将真实的 EzCabinet 橱柜放入您自己房间的模型中，从各个角度查看，并即时获得报价。无需前往展厅。",
	},
	common: {
		brand: "EzCabinet",
		back: "返回",
		next: "下一步",
		close: "关闭",
		language: "语言",
	},
};
```

```ts
// src/lib/copy/ms.ts
import type { Dictionary } from "./en";

/** Bahasa Malaysia. Typed against `Dictionary` for the same reason as `zh`. */
export const ms: Dictionary = {
	meta: {
		title: "EzCabinet · Reka dapur anda dalam 3D",
		description:
			"Letakkan unit EzCabinet sebenar ke dalam model bilik anda sendiri, lihat dari setiap sudut, dan dapatkan harga serta-merta. Tidak perlu ke bilik pameran.",
	},
	common: {
		brand: "EzCabinet",
		back: "Kembali",
		next: "Seterusnya",
		close: "Tutup",
		language: "Bahasa",
	},
};
```

```ts
// src/lib/copy/dictionary.ts
import "server-only";
import type { Dictionary } from "./en";
import type { Locale } from "./locales";

/**
 * The dictionary for a locale, loaded on the server only.
 *
 * Dynamic imports so a request for `/ms` never parses the other two. Server
 * components await this directly and pay nothing on the wire — only the
 * rendered HTML reaches the browser. The planner's client components get it
 * as a prop through `CopyProvider`, because `next/root-params` does not reach
 * across the client boundary.
 */
const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
	en: () => import("./en").then((m) => m.en),
	zh: () => import("./zh").then((m) => m.zh),
	ms: () => import("./ms").then((m) => m.ms),
};

export const getDictionary = (locale: Locale): Promise<Dictionary> =>
	dictionaries[locale]();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copy/__tests__/dictionary.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc clean.

- [ ] **Step 5: Prove the type gate actually gates**

Temporarily delete the `back` key from `zh.ts`, run `npx tsc --noEmit`, and confirm it errors with "Property 'back' is missing". Restore the key. This is the check that the gate is real rather than decorative.

- [ ] **Step 6: Commit**

```bash
git add src/lib/copy/
git commit -m "feat(i18n): typed dictionaries for en, zh and ms"
```

---

### Task 4: Move routes under `app/[lang]/`

The structural move. Nothing is translated yet — this task is green when the three locales render the existing English pages.

**Files:**
- Move: `src/app/layout.tsx` → `src/app/[lang]/layout.tsx`
- Move: `src/app/page.tsx` → `src/app/[lang]/page.tsx`
- Move: `src/app/planner/` → `src/app/[lang]/planner/`
- Move: `src/app/tutorials/` → `src/app/[lang]/tutorials/`
- Modify: `src/app/globals.css`
- Unchanged: `src/app/admin/`, `src/app/api/`, `src/app/favicon.ico`

**Interfaces:**
- Consumes: `LOCALES`, `isLocale`, `htmlLang` (Task 1); `getDictionary` (Task 3)

- [ ] **Step 1: Move the files with git so history follows**

```bash
mkdir -p src/app/\[lang\]
git mv src/app/layout.tsx src/app/\[lang\]/layout.tsx
git mv src/app/page.tsx src/app/\[lang\]/page.tsx
git mv src/app/planner src/app/\[lang\]/planner
git mv src/app/tutorials src/app/\[lang\]/tutorials
```

`globals.css` and `favicon.ico` stay at `src/app/`. Fix the stylesheet import in the moved layout to `../globals.css`.

- [ ] **Step 2: Rewrite the root layout**

```tsx
// src/app/[lang]/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/copy/dictionary";
import { htmlLang, isLocale, LOCALES } from "@/lib/copy/locales";
import "../globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/** All three locales are prerendered — they are the SEO surface. */
export function generateStaticParams() {
	return LOCALES.map((lang) => ({ lang }));
}

/**
 * Per-locale title and description, plus the `hreflang` alternates.
 *
 * The alternates are not decoration: three indexable URLs only earn their
 * keep if Google is told they are translations of one another. Without them
 * the whole reason for putting the locale in the path goes unpaid.
 */
export async function generateMetadata({
	params,
}: LayoutProps<"/[lang]">): Promise<Metadata> {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const dict = await getDictionary(lang);

	return {
		title: dict.meta.title,
		description: dict.meta.description,
		alternates: {
			canonical: `/${lang}`,
			languages: {
				en: "/en",
				"zh-Hans": "/zh",
				"ms-MY": "/ms",
				"x-default": "/en",
			},
		},
	};
}

export default async function RootLayout({
	children,
	params,
}: LayoutProps<"/[lang]">) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();

	return (
		<html
			lang={htmlLang(lang)}
			className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
		>
			<body className="flex min-h-full flex-col font-sans">{children}</body>
		</html>
	);
}
```

- [ ] **Step 3: Add the CJK fallback to the font stack**

`Geist` is loaded with `subsets: ["latin"]`, which contains **no CJK glyphs**. Without a fallback, Chinese renders in whatever the device picks. A CJK webfont is hundreds of KB and the mobile budget rules it out, so the fallback is the system stack.

In `src/app/globals.css`, line 11:

```css
	--font-sans: var(--font-geist-sans), "PingFang SC", "Hiragino Sans GB",
		"Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
```

- [ ] **Step 4: Verify the three locales render and a bad one 404s**

```bash
npx next build
```

Expected: build succeeds and the output lists `/en`, `/zh`, `/ms` as prerendered static routes.

Then `npx next dev` and check by hand:
- `/en`, `/zh`, `/ms` all render the (still English) landing page
- `/de` returns 404
- `/admin/login` still loads
- View source on `/zh`: `<html lang="zh-Hans">` and three `hreflang` links present

Running dev once here also generates `.next/types/root-params.d.ts`, which is what makes `next/root-params` typed for later tasks.

- [ ] **Step 5: Commit**

```bash
git add -A src/app
git commit -m "feat(i18n): move public routes under [lang] with hreflang and CJK fallback"
```

---

### Task 5: Locale negotiation in the proxy

The riskiest edit in the plan: `src/proxy.ts` is the admin gate, and a redirect loop there locks out all three internal users.

**Files:**
- Modify: `src/proxy.ts`
- Test: `src/lib/copy/__tests__/proxyPaths.test.ts`

**Interfaces:**
- Consumes: `LOCALES`, `negotiateLocale` (Task 1)
- Produces: `needsLocaleRedirect(pathname: string): boolean` — exported from `src/lib/copy/locales.ts` so it is testable without booting Next

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/copy/__tests__/proxyPaths.test.ts
import { describe, expect, it } from "vitest";
import { needsLocaleRedirect } from "../locales";

describe("needsLocaleRedirect", () => {
	it("redirects a bare public path", () => {
		expect(needsLocaleRedirect("/")).toBe(true);
		expect(needsLocaleRedirect("/planner")).toBe(true);
		expect(needsLocaleRedirect("/tutorials")).toBe(true);
	});

	it("leaves a path that already carries a locale alone", () => {
		expect(needsLocaleRedirect("/en")).toBe(false);
		expect(needsLocaleRedirect("/zh/planner")).toBe(false);
		expect(needsLocaleRedirect("/ms")).toBe(false);
	});

	// The bug that would lock every admin out of the site.
	it("never touches admin or api", () => {
		expect(needsLocaleRedirect("/admin")).toBe(false);
		expect(needsLocaleRedirect("/admin/login")).toBe(false);
		expect(needsLocaleRedirect("/admin/catalogue")).toBe(false);
		expect(needsLocaleRedirect("/api/admin/login")).toBe(false);
		expect(needsLocaleRedirect("/api/cabinet-mesh/abc")).toBe(false);
	});

	it("never touches framework or static paths", () => {
		expect(needsLocaleRedirect("/_next/static/chunk.js")).toBe(false);
		expect(needsLocaleRedirect("/favicon.ico")).toBe(false);
		expect(needsLocaleRedirect("/grain.png")).toBe(false);
		expect(needsLocaleRedirect("/robots.txt")).toBe(false);
	});

	it("does not mistake a locale-prefixed word for a locale", () => {
		// "/english" starts with "en" but is not the `en` segment.
		expect(needsLocaleRedirect("/english")).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copy/__tests__/proxyPaths.test.ts`
Expected: FAIL — `needsLocaleRedirect` is not exported.

- [ ] **Step 3: Add the predicate to `locales.ts`**

```ts
/** Paths that belong to the app rather than to a reader: the admin surface,
 * every API route, Next's own assets, and anything with a file extension. */
const EXEMPT = /^\/(?:admin|api|_next)(?:\/|$)|\.[a-z0-9]+$/i;

/**
 * Whether this request should be sent to a locale-prefixed URL.
 *
 * The exemption list is the load-bearing half. `/admin` is gated by a
 * shared-secret cookie in this same proxy, and bouncing it through a locale
 * redirect would fight that gate — at best an extra hop, at worst a loop that
 * locks out all three internal users.
 */
export function needsLocaleRedirect(pathname: string): boolean {
	if (EXEMPT.test(pathname)) return false;
	const [, first] = pathname.split("/");
	return !isLocale(first);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copy/__tests__/proxyPaths.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the proxy**

The admin branch must run **first and unchanged**. The locale branch only ever sees paths the admin matcher does not claim.

```ts
// src/proxy.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_COOKIE, isValidAdminSession } from "@/lib/adminAuth";
import { needsLocaleRedirect, negotiateLocale } from "@/lib/copy/locales";

/**
 * Two jobs, deliberately kept apart.
 *
 * `/admin/*` and `/api/admin/*` are gated behind the shared-secret cookie —
 * unchanged behaviour, and it runs first. Everything else public is sent to a
 * locale-prefixed URL. `needsLocaleRedirect` exempts admin, api, `_next` and
 * files, so the two branches can never contend for the same request.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
		if (pathname === "/api/admin/login" || pathname === "/admin/login") {
			return NextResponse.next();
		}

		const session = request.cookies.get(ADMIN_COOKIE)?.value;
		if (await isValidAdminSession(session)) return NextResponse.next();

		if (pathname.startsWith("/api/admin")) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const loginUrl = new URL("/admin/login", request.url);
		loginUrl.searchParams.set("next", pathname);
		return NextResponse.redirect(loginUrl);
	}

	if (needsLocaleRedirect(pathname)) {
		const locale = negotiateLocale(request.headers.get("accept-language"));
		const url = request.nextUrl.clone();
		url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
		return NextResponse.redirect(url);
	}

	return NextResponse.next();
}

export const config = {
	// Everything except Next's own assets. The predicate above does the real
	// filtering; this only keeps the function off the static path.
	matcher: ["/((?!_next/static|_next/image).*)"],
};
```

- [ ] **Step 6: Verify by hand — the admin lockout check**

```bash
npx next dev
```

- `/` redirects to `/en` (or `/zh` with a Chinese browser)
- `/planner` → `/en/planner`, query string preserved: `/planner?room=living` → `/en/planner?room=living`
- `/admin/login` loads, **no redirect loop**
- Sign in, `/admin/catalogue` loads
- `/api/cabinet-mesh/<id>` still returns bytes
- `curl -H 'Accept-Language: zh-CN' -I localhost:3000/` → `location: /zh`

- [ ] **Step 7: Commit**

```bash
git add src/proxy.ts src/lib/copy/locales.ts src/lib/copy/__tests__/proxyPaths.test.ts
git commit -m "feat(i18n): negotiate locale in the proxy without touching the admin gate"
```

---

### Task 6: `CopyProvider` for the client tree

`next/root-params` does not reach client components. This is how the planner gets its strings.

**Files:**
- Create: `src/components/planner/CopyContext.tsx`
- Modify: `src/app/[lang]/planner/page.tsx`, `src/app/[lang]/planner/PlannerApp.tsx`

**Interfaces:**
- Consumes: `Dictionary` (Task 3)
- Produces: `<CopyProvider copy={…}>`, `useCopy(): Dictionary`, `useLocale(): Locale`

- [ ] **Step 1: Write the provider, mirroring `CatalogueContext.tsx`**

```tsx
// src/components/planner/CopyContext.tsx
"use client";

import { createContext, useContext, useMemo } from "react";
import type { Dictionary } from "@/lib/copy/en";
import type { Locale } from "@/lib/copy/locales";

/**
 * The active locale's strings, handed down rather than imported.
 *
 * Client components cannot read `next/root-params`, so the dictionary is
 * resolved on the server and passed in as a prop. It is a value with one
 * owner for the same reason the catalogue is — see `CatalogueContext.tsx`:
 * a mutable module-level palette caused three bugs at once, including a
 * global mutated during React's render phase. A locale dictionary has the
 * identical failure mode.
 */
type CopyValue = { copy: Dictionary; locale: Locale };

const CopyContext = createContext<CopyValue | null>(null);

export function CopyProvider({
	copy,
	locale,
	children,
}: {
	copy: Dictionary;
	locale: Locale;
	children: React.ReactNode;
}) {
	const value = useMemo(() => ({ copy, locale }), [copy, locale]);
	return <CopyContext.Provider value={value}>{children}</CopyContext.Provider>;
}

/** Throws rather than falling back to English: a component silently rendering
 * English inside a Chinese page is the failure this context exists to prevent. */
function useCopyValue(): CopyValue {
	const value = useContext(CopyContext);
	if (!value) throw new Error("useCopy outside a CopyProvider");
	return value;
}

export const useCopy = (): Dictionary => useCopyValue().copy;
export const useLocale = (): Locale => useCopyValue().locale;
```

- [ ] **Step 2: Resolve the dictionary in the planner page and pass it down**

In `src/app/[lang]/planner/page.tsx`, take `params` alongside the existing `searchParams`, and pass `copy` and `locale` into `PlannerApp`:

```tsx
export default async function PlannerPage({
	params,
	searchParams,
}: {
	params: Promise<{ lang: string }>;
	searchParams: Promise<{ room?: string }>;
}) {
	const [{ lang }, { room }] = await Promise.all([params, searchParams]);
	if (!isLocale(lang)) notFound();
	const copy = await getDictionary(lang);
	// …existing catalogue and siteImage loading is unchanged…

	return (
		<PlannerApp
			initialRoomId={initialRoomId}
			catalogue={catalogue}
			finishTextures={finishTextures}
			copy={copy}
			locale={lang}
		/>
	);
}
```

- [ ] **Step 3: Wrap the client tree**

In `PlannerApp.tsx`, accept `copy` and `locale` and wrap the existing `CatalogueProvider` — one nesting, at the single client entry point:

```tsx
return (
	<CopyProvider copy={copy} locale={locale}>
		<CatalogueProvider catalogue={catalogue}>
			{/* existing screen switch, unchanged */}
		</CatalogueProvider>
	</CopyProvider>
);
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean, 396+ tests pass. Then `npx next dev` and confirm `/en/planner` still works end to end — place a cabinet, open the quote screen.

- [ ] **Step 5: Commit**

```bash
git add src/components/planner/CopyContext.tsx src/app/\[lang\]/planner/
git commit -m "feat(i18n): CopyProvider so the planner's client tree gets the dictionary"
```

---

### Task 7: Extract the landing page copy

The biggest single surface — `src/app/[lang]/page.tsx` is 591 lines and holds most of the 653 words. A server component, so its strings never reach the browser as JS.

**Files:**
- Modify: `src/app/[lang]/page.tsx`
- Modify: `src/lib/copy/en.ts`, `zh.ts`, `ms.ts` — add the `landing` group

- [ ] **Step 1: List every string to move**

```bash
node -e '
const src = require("fs").readFileSync("src/app/[lang]/page.tsx","utf8")
  .replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"");
const out = new Set();
for (const m of src.matchAll(/>([^<>{}()\[\];=]{3,})</g)) {
  const s = m[1].replace(/\s+/g," ").trim();
  if (/^[A-Za-z][A-Za-z0-9 ,.\x27’&%()\/?!:-]*$/.test(s)) out.add(s);
}
for (const m of src.matchAll(/"([A-Z][^"\\\n]{3,})"/g)) out.add(m[1].trim());
console.log([...out].sort().join("\n"));
'
```

Every line of that output becomes a key under `landing` in `en.ts`. Group by section (`hero`, `rooms`, `finishes`, `faq`, `cta`) so the keys read as the page does.

- [ ] **Step 2: Add the `landing` group to all three dictionaries**

`en.ts` first — the strings verbatim as they appear today, so the English page is byte-identical afterwards. Then `zh.ts` and `ms.ts`. `tsc` will not compile until both are complete, which is the gate doing its job.

- [ ] **Step 3: Replace the literals in the page**

```tsx
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale } from "@/lib/copy/locales";

export default async function LandingPage({ params }: PageProps<"/[lang]">) {
	const { lang } = await params;
	if (!isLocale(lang)) notFound();
	const t = await getDictionary(lang);
	// …then `{t.landing.hero.title}` in place of each literal…
}
```

Every internal `<Link href="/planner">` becomes `` href={`/${lang}/planner`} `` — a link that drops the locale silently bounces the reader back through the proxy and can land them in a different language than the one they are reading.

- [ ] **Step 4: Verify**

```bash
npx vitest run src/lib/copy/__tests__/dictionary.test.ts && npx tsc --noEmit
```

Expected: parity and no-leakage tests pass — proving no `zh`/`ms` value was left in English — and tsc is clean.

Then `npx next dev` and read `/en`, `/zh`, `/ms` side by side. `/en` must be visually identical to before this task.

- [ ] **Step 5: Commit**

```bash
git add src/app/\[lang\]/page.tsx src/lib/copy/
git commit -m "feat(i18n): translate the landing page"
```

---

### Task 8: Extract the planner and tutorials copy

Same method as Task 7, for the client components and the tutorials route.

**Files:**
- Modify: `src/components/planner/StartScreen.tsx`, `StudioScreen.tsx`, `QuoteScreen.tsx`, `PlannerHeader.tsx`, `MeasureOverlay.tsx`, `DimensionField.tsx`, `Room.tsx`
- Modify: `src/app/[lang]/tutorials/page.tsx`, `TutorialsBrowser.tsx`
- Modify: `src/lib/copy/en.ts`, `zh.ts`, `ms.ts` — add `planner`, `quote`, `tutorials` groups

- [ ] **Step 1: Extract the strings**

Run the Step-1 script from Task 7 against each file in turn.

**Do not translate:** anything read from the catalogue or the database — `family.label`, `doorStyle.label`, `roomType.label`, `finish.label`, and tutorial `title`/`description`/`category`. Those are client-authored rows and are explicitly out of scope. If a string comes from a prop that traces back to `catalogue` or `prisma`, leave it.

- [ ] **Step 2: Add the groups, then swap the literals**

In client components the hook replaces the import:

```tsx
const t = useCopy();
// …<button>{t.planner.addCabinets}</button>…
```

For the one-or-many strings, `fill`:

```tsx
import { fill } from "@/lib/copy/fill";
// en: cabinetCount: "{n} cabinets"
{fill(t.quote.cabinetCount, { n: modules.length })}
```

- [ ] **Step 3: Format prices through `Intl`**

Wherever RM is printed, use the locale rather than a hardcoded string:

```ts
new Intl.NumberFormat(htmlLang(locale), {
	style: "currency",
	currency: "MYR",
}).format(amount);
```

- [ ] **Step 4: Verify**

```bash
npx vitest run && npx tsc --noEmit && npx biome check src/
```

Expected: all tests pass, tsc clean, biome clean.

Then `npx next dev`: walk the full flow in each locale — pick a room, place cabinets, change a finish, open the quote. Confirm cabinet names and finish names stay in English (they are catalogue rows) while the chrome around them translates.

- [ ] **Step 5: Commit**

```bash
git add src/components/planner/ src/app/\[lang\]/tutorials/ src/lib/copy/
git commit -m "feat(i18n): translate the planner and tutorials surfaces"
```

---

### Task 9: The language switcher

**Files:**
- Create: `src/components/LanguageSwitcher.tsx`
- Modify: `src/app/[lang]/layout.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/LanguageSwitcher.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isLocale, type Locale, LOCALES } from "@/lib/copy/locales";

/** What each language calls itself — never the current locale's word for it.
 * A reader looking for Chinese scans for 中文, not for "Chinese". */
const ENDONYM: Record<Locale, string> = {
	en: "English",
	zh: "中文",
	ms: "Bahasa Malaysia",
};

export function LanguageSwitcher({ current }: { current: Locale }) {
	const pathname = usePathname();
	// Swap the locale segment and keep the reader where they are, rather than
	// sending them to the homepage of another language.
	const [, first, ...rest] = pathname.split("/");
	const tail = (isLocale(first) ? rest : [first, ...rest]).join("/");

	return (
		<nav aria-label="Language" className="flex gap-3 text-sm">
			{LOCALES.map((locale) => (
				<Link
					key={locale}
					href={`/${locale}${tail ? `/${tail}` : ""}`}
					hrefLang={locale}
					aria-current={locale === current ? "true" : undefined}
					className={locale === current ? "font-semibold underline" : "opacity-70"}
				>
					{ENDONYM[locale]}
				</Link>
			))}
		</nav>
	);
}
```

- [ ] **Step 2: Place it in the layout**

Render `<LanguageSwitcher current={lang} />` in `src/app/[lang]/layout.tsx`, inside `<body>` above `{children}`.

- [ ] **Step 3: Verify**

`npx next dev`. From `/en/planner?room=living`, switch to 中文: the URL must become `/zh/planner?room=living` — same page, same room, different language. Switching from `/ms/tutorials` must land on `/en/tutorials`, not `/en`.

- [ ] **Step 4: Commit**

```bash
git add src/components/LanguageSwitcher.tsx src/app/\[lang\]/layout.tsx
git commit -m "feat(i18n): language switcher that preserves the current path"
```

---

### Task 10: The client review list

The deliverable that closes the loop with EzCabinet.

**Files:**
- Create: `docs/translation-review.md`

- [ ] **Step 1: Write the review list**

Roughly twenty entries — not all 127. Include every string where register decides whether the page converts:

- Cabinetry trade terms in BM: *kabinet dapur*, *laminat*, *kayu solid*, *pintu*, *laci*
- The whole `quote` group — this is the money screen
- Every call to action
- Anything with a delivery or warranty claim in it

Each entry: the key, the English, the 中文, the BM, and a one-line note on what I was unsure about.

- [ ] **Step 2: Commit**

```bash
git add docs/translation-review.md
git commit -m "docs: strings for EzCabinet to review"
```

---

## Self-Review

**Spec coverage** — every section maps to a task: scope and locales → Tasks 1, 3; native primitives → Task 4; the client-tree constraint → Task 6; dictionaries and the type gate → Task 3; routing and the proxy → Tasks 4, 5; CJK glyphs → Task 4 Step 3; `hreflang` → Task 4 Step 2; translation sourcing → Tasks 7, 8, 10; the five specced tests → Tasks 1, 3, 5.

**Placeholder scan** — the only non-literal steps are the bulk string extractions in Tasks 7 and 8, which carry the exact script that produces the list and the exact rule for what not to translate. That is mechanical work with a stated method, not a deferred decision.

**Type consistency** — `Locale`, `Dictionary`, `getDictionary`, `isLocale`, `htmlLang`, `negotiateLocale`, `needsLocaleRedirect`, `fill`, `useCopy`, `useLocale` are each defined once and used under the same name throughout.

**One amendment to the spec, already applied:** the spec originally said interpolated strings take a function. Functions cannot cross the RSC boundary into `CopyProvider`, so values are plain strings with `{token}` placeholders and a `fill` helper. The spec has been corrected.

## Risk

Task 5 is the one that can hurt. `src/proxy.ts` is the admin gate for all three internal users, and a redirect loop there locks them out of the site — including whoever is fixing it. Its predicate is tested in isolation before the proxy is touched, the admin branch runs first and unchanged, and Step 6 is a manual sign-in check. Do not merge Task 5 without performing that check.
