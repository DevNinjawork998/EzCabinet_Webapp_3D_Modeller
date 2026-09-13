# Trilingual planner — design

**Date:** 2026-09-04
**Status:** approved, ready for implementation plan

## Goal

Serve the public planner in English, Simplified Chinese and Bahasa Malaysia,
each on its own indexable URL, without adding a dependency or a burden on
EzCabinet.

## Scope

**In:** every string we wrote, on the three public routes — `/` (landing),
`/planner`, `/tutorials`.

**Out, deliberately:**

| Not translated | Why |
| --- | --- |
| Catalogue labels — family, door style, room type, finish | Client-authored rows in Postgres. `BC 600mm` and `Rhone Oak` are SKUs and decor names; Malaysian trade buyers read them in English. Translating them means a schema change, three inputs per label in the admin editor, and a forever obligation on the client for every new design. |
| Tutorial titles and descriptions | Same reason — admin-authored DB content. |
| `/admin` | Three internal users behind one shared secret. Translating a catalogue editor buys nothing. |

Locales: `en`, `zh` (Simplified — the Malaysian standard), `ms`.
Short codes, not `en-US`/`zh-Hans`, because they sit in the URL.

**Measured size of the job:** 127 distinct strings, ~653 words across all
public surfaces. Two and a half pages of prose. This number is why the design
is small: it does not need a translation pipeline, a CMS, or ICU.

## Decision: there is no native Next.js i18n to adopt

The `next.config` `i18n` key — `locales`, `defaultLocale`, `domains` — is
**Pages Router only** and does not exist for the App Router. Next.js's
official App Router guide describes a *pattern*, not an API: a `[lang]`
dynamic segment, locale negotiation in the proxy, and dictionary objects.

So the choice was never native-versus-custom. It was: follow the documented
pattern, or add `next-intl` on top of it. We follow the pattern.

**Rejected — `next-intl`:** buys ICU messages, plural rules and negotiation.
We have 127 flat strings; neither 中文 nor BM inflects for number, so the
plural machinery is unused. A dependency and a provider on the surface whose
weight `CLAUDE.md` says decides whether the lead loads the page at all.

**Rejected — copy in Postgres, editable at `/admin/site-content`:** fails the
repo's own test — *"if you could delete it and rebuild it from a `git clone`,
it belongs in the repo."* Also adds a DB read to every public page render.

## Architecture

### Native primitives we take

| Primitive | Use |
| --- | --- |
| `app/[lang]/` segment | Forwards `lang` to every layout and page |
| `next/root-params` → `lang()` | Reads the locale in any Server Component or server-side util, no prop drilling |
| `PageProps<'/[lang]'>` / `LayoutProps<'/[lang]'>` | Global typed route params |
| `generateStaticParams` | Pre-renders all three locales statically |
| `hasLocale()` + `notFound()` | `/de/planner` 404s rather than throwing |
| `Intl.NumberFormat('ms-MY')` | RM prices. No formatting library. |

Verified against the installed Next **16.3.1**: `next/root-params` ships and is
not behind an experimental flag. One implementation note — its getters are
typed from `.next/types/root-params.d.ts`, generated at build. Until
`app/[lang]/` exists and a dev or build run has happened, `next/root-params`
resolves to a bare `declare module` and `lang()` is untyped. Create the
segment and run the dev server once before relying on the types.

### The client-tree constraint that shapes everything

Next's guide states plainly: root parameter getters run in Server Components
and server-side utilities, **not in Client Components**.

Our copy sits on both sides of that line:

| Surface | Kind | How it gets copy |
| --- | --- | --- |
| `src/app/page.tsx` (591 lines, most of the copy) | Server | `getDictionary()` directly — zero bundle cost, only HTML ships |
| `tutorials/page.tsx` | Server | same |
| `StudioScreen`, `QuoteScreen`, `PlannerScene`, `DimensionField`, `Room` | `'use client'` | `CopyProvider` / `useCopy()` |

`CopyProvider` is not a preference — `root-params` explicitly does not reach
client components. It mirrors the existing `CatalogueProvider` / `useCatalogue`
in `components/planner/CatalogueContext.tsx`, deliberately.

**Why mirror it rather than invent:** `CLAUDE.md` records that a mutable
module-level palette caused four bugs at once, including a global mutated
during React's render phase. A locale dictionary has exactly that failure
mode. The catalogue's fix — a value passed explicitly, with one owner — is the
fix here too. The dictionary is a parameter, never a global.

### Dictionaries

Three TypeScript modules under `src/lib/copy/`: `en.ts`, `zh.ts`, `ms.ts`.

`en.ts` is the source of truth. `zh` and `ms` are declared `satisfies typeof en`,
so **a missing or misspelled key is a compile error**. This is the one place we
improve on the Next.js guide, which loads JSON and would let a missing `zh` key
render as a blank on a customer's screen.

Grouped by surface (`meta`, `common`, `landing`, `planner`, `quote`,
`tutorials`).

**Every value is a plain string.** The dictionary is passed from a server
component into `CopyProvider`, so it crosses the React Server Component
boundary and must be serializable — a function value would throw at runtime.
The few strings needing a number carry a `{placeholder}` token and are
rendered through a `fill(template, vars)` helper, which is pure and tested
alongside the rest of `lib/copy`.

### Routing and the proxy

Routes move under `app/[lang]/`. `/admin`, `/api`, `_next` and static files
stay outside it.

`src/proxy.ts` currently matches only `["/admin/:path*", "/api/admin/:path*"]`.
It gains locale negotiation, and the matcher widens. **The admin gate and the
locale redirect must not interfere:** the locale branch runs only for paths
that are not `/admin`, `/api`, `_next`, or a file with an extension. Admin
behaviour must be unchanged — it is the one authenticated surface and a
redirect loop there locks out all three internal users.

Negotiation reads `Accept-Language` and matches against the three locales,
defaulting to `en`. Hand-rolled, roughly fifteen lines. Next's guide suggests
`@formatjs/intl-localematcher` + `negotiator`; two dependencies to choose
between three fixed strings is not a trade worth making.

### Two things that would otherwise be missed

**CJK glyphs.** `src/app/layout.tsx` loads Geist with `subsets: ["latin"]`.
The latin subset contains no CJK glyphs, so 中文 would silently fall back to
whatever the device has. Shipping a CJK webfont is hundreds of KB against a
budget that rules it out. Resolution: a **system CJK fallback stack** on the
font-family (`PingFang SC`, `Microsoft YaHei`, `Noto Sans CJK SC`, `sans-serif`)
— no download, correct glyphs on every device that has a Chinese font, which
on the target audience's phones is all of them. BM is latin; Geist covers it.

**`hreflang`.** Three indexable URLs only help if Google knows they are
translations of each other. The `[lang]` layout emits `alternates.languages`
for all three plus `x-default`, and `<html lang>` becomes the active locale
instead of the hardcoded `"en"`. Without this the SEO argument for URL-based
locales does not actually pay out.

## Translation sourcing

I draft all three locales. English is the source. The client reviews a flagged
short list — roughly twenty strings where register decides whether the page
converts: cabinetry trade terms (*kabinet dapur*, *laminat*, *kayu solid*), the
price breakdown, the quote CTA, anything legal-adjacent — rather than
proofreading all 127.

Because the dictionary is one file per locale, replacing wording later is a
text edit with no code change.

## Testing

`lib/copy` is pure data, so it tests like the rest of `lib/planner` — vitest,
no React.

| Test | Asserts |
| --- | --- |
| Key parity | `zh` and `ms` have exactly `en`'s key set. The type gate catches this at compile time; the test catches it in CI where a `// @ts-expect-error` cannot hide it. |
| No untranslated leakage | No `zh` or `ms` value is byte-identical to its `en` value, except an allow-list (brand name, `RM`, numerals) |
| Locale negotiation | `Accept-Language` samples → expected locale; unknown → `en` |
| Proxy isolation | `/admin/*` and `/api/*` are never locale-redirected; admin auth behaviour unchanged |
| Bad locale | `/de/planner` → 404, not a crash |

Existing 396 tests must stay green — the planner engine is untouched by this
work.

## What this does not do

- No translated catalogue or tutorial content
- No translated admin
- No CJK webfont
- No message-formatting library
- No RTL support — none of the three locales need it
