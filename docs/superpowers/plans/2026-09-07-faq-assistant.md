# FAQ Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax fÏor tracking.

**Goal:** A trilingual, admin-editable FAQ at `/[lang]/faq` that renders as a static accordion for SEO and falls back to a grounded AI answer only when no entry matches the visitor's question.

**Architecture:** FAQ entries are rows in Postgres with locale-keyed `Json` question/answer bodies, edited at `/admin/faq`. The public page server-renders every entry as a plain accordion — no JavaScript required to read it, no model call to serve it. A search box below the accordion runs a pure string match first; only a miss reaches `POST /api/faq/ask`, which stuffs the *entire* FAQ corpus into a stable system prefix and streams an answer through Vercel AI Gateway. No vector store, no embeddings, no retrieval layer — the corpus is ~2,000 tokens.

**Tech Stack:** Next.js 16 App Router, Prisma 7 + Postgres, zod 4, Vercel AI Gateway via the `ai` package, vitest, Biome.

**Spec:** No separate spec document. This plan is the spec; it was derived from the feasibility research in the 2026-09-07 session. The decisions that shaped it:

| Decision | Chosen | Why |
| --- | --- | --- |
| Content home | Admin-editable, DB-backed | The client changes lead times and promo copy; a repo markdown file would need a deploy per edit. |
| Answer path | Static accordion + AI for the long tail | Most traffic costs nothing, the page is indexable, and the model only handles what the corpus misses. |
| Retrieval | None — whole corpus in the prompt | 20 entries ≈ 2,000 tokens. A vector store for that is ceremony. Revisit past ~30k tokens. |
| Model | `google/gemini-3.1-flash-lite` (provisional) | Task 8 decides it on evidence. The site is trilingual, so Malay and Chinese quality outrank price. |

## Global Constraints

Every task's requirements implicitly include this section.

- **The site is trilingual.** `LOCALES = ["en", "zh", "ms"]` (`src/lib/copy/locales.ts`). Public routes are `/[lang]/…`. Every FAQ entry carries all three languages; the assistant answers in the visitor's locale and never switches language unprompted.
- **UI copy is sentence case. Prices in RM.** (`CLAUDE.md` § Conventions.)
- **The assistant must never state a price it computed itself.** It may quote a rung price that appears verbatim in a FAQ answer. Anything else is a handoff to WhatsApp. A wrong RM figure screenshotted into WhatsApp is a lost sale and a support incident.
- **Zod is the single source of truth for types.** Define the schema once, infer the TS type, validate every payload — including what comes back out of a `Json` column.
- **`prisma` is imported from `@/lib/catalogue/db`.** Route handlers set `export const runtime = "nodejs";`.
- **Admin routes are gated by `src/proxy.ts`** on the `/api/admin/*` prefix. A new admin route under that prefix needs no auth code of its own. `POST /api/faq/ask` is **public** and therefore needs its own rate limiting.
- **Pure logic goes in `src/lib/faq/` and gets a test before it gets a caller.** No React, no `next/*` imports in `match.ts`, `prompt.ts`, or `rateLimit.ts`.
- **Your training data for the `ai` package is stale.** Before writing any AI SDK code (Task 5), run `pnpm add ai` and read `node_modules/ai/docs/`. Verify `streamText`, the response helper, and the `useChat` import path against those docs and against `node_modules/@ai-sdk/react/docs/`. The code in Task 5 below reflects the API as documented at plan time; if the local docs disagree, **the local docs win** — fix the code and note the difference in the commit message.
- **Model IDs must come from the live catalogue**, not memory: `curl -s https://ai-gateway.vercel.sh/v1/models | jq -r '.data[].id'`. Verified present at plan time: `google/gemini-3.1-flash-lite`, `google/gemini-3.5-flash-lite`, `openai/gpt-5.4-nano`, `anthropic/claude-haiku-4.5`.
- **Run `pnpm test`, `pnpm typecheck` and `pnpm lint` before every commit.** Biome is the linter; it has opinions about `reduce` with spread.
- **Admin design tokens**, read off `src/app/admin/tutorials/TutorialManager.tsx`. Use these verbatim; do not introduce a second admin look:

| Element | Classes |
| --- | --- |
| Page shell | `flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900` |
| Main column | `mx-auto flex w-full max-w-[840px] flex-col gap-8 px-7 pt-8 pb-16` |
| Card | `rounded-[14px] border border-neutral-200 bg-white px-6 pt-[22px] pb-6` |
| Section label | `mb-4 font-semibold text-[12px] text-neutral-600 uppercase tracking-[0.06em]` |
| Field label | `mb-1.5 block font-semibold text-[12px] text-neutral-700` |
| Text input | `min-h-10 w-full rounded-[9px] border border-neutral-300 px-3 py-2.5 text-[13px]` |
| Textarea | `w-full resize-y rounded-[9px] border border-neutral-300 px-3 py-2.5 text-[13px] leading-5` |
| Primary button | `min-h-[38px] rounded-full bg-[#1f5138] px-[18px] py-2.5 font-semibold text-[13px] text-white transition hover:bg-[#1a4430] disabled:opacity-40` |
| Ghost button | `h-9 rounded-lg border border-neutral-300 bg-white px-3 text-[13px] text-neutral-700 transition hover:border-neutral-400 hover:bg-[#f4f3f1]` |
| List row | `flex items-center gap-3.5 rounded-xl border border-neutral-200 bg-white px-4 py-3.5` |
| Muted text | `text-[12px] text-[#5c574e]` |
| Error banner | `rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700` |

  Accent green is `#1f5138`. Page ground is `#f4f3f1`. Muted ink is `#5c574e`. Hairlines are `#ecebe7`.

- **Never use `window.confirm`, `alert` or `prompt`.** A browser modal blocks the browser-automation tooling this project uses for verification. Destructive actions use an inline two-step button.

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | `FaqEntry` model. Locale bodies as `Json`, matching how `CatalogueVersion.data` already stores structured content. |
| `src/lib/faq/schema.ts` | zod: `localeTextSchema`, `faqEntryInputSchema`, `faqEntrySchema`. The only place the shape is written down. |
| `src/lib/faq/store.ts` | `server-only`. Read path: published entries, parsed and locale-projected. |
| `src/lib/faq/match.ts` | **Pure.** Normalise a question, score it against entries, return a hit or null. Decides accordion-answer vs model call. |
| `src/lib/faq/prompt.ts` | **Pure.** `(entries, locale) => string`. Carries the three guardrails. |
| `src/lib/faq/rateLimit.ts` | **Pure.** In-memory token bucket keyed by IP. |
| `src/app/api/faq/ask/route.ts` | Public streaming endpoint. Rate limit → match → model. |
| `src/app/api/admin/faq/route.ts` | `GET` list, `POST` create. |
| `src/app/api/admin/faq/[id]/route.ts` | `PATCH`, `DELETE`. |
| `src/app/[lang]/faq/page.tsx` | Server component. Accordion + the ask widget, plus `generateMetadata`. |
| `src/components/faq/FaqAccordion.tsx` | Static `<details>` markup and `entryDomId`. Readable with JS off. |
| `src/components/faq/FaqAsk.tsx` | Client. Local match first, model call on a miss. |
| `src/app/admin/faq/page.tsx` | Thin server shell, matching `admin/tutorials/page.tsx`. |
| `src/app/admin/faq/FaqManager.tsx` | Client CRUD, three-language tabs. Colocated in the route folder, as `TutorialManager` is. |
| `scripts/faq-eval.mjs` | Model bake-off across en/zh/ms. Decides the model. |

Tests live in `src/lib/faq/__tests__/`, matching `src/lib/planner/__tests__/`.

---

### Task 1: Data layer — model, schemas, read path

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `src/lib/faq/schema.ts`
- Create: `src/lib/faq/store.ts`
- Test: `src/lib/faq/__tests__/schema.test.ts`

**Interfaces:**

- Consumes: `Locale` from `@/lib/copy/locales`; `prisma` from `@/lib/catalogue/db`.
- Produces:
  - `type LocaleText = Record<Locale, string>`
  - `faqEntryInputSchema` — `{ question: LocaleText; answer: LocaleText; category: string; sortOrder: number; published: boolean }`
  - `type FaqEntryInput = z.infer<typeof faqEntryInputSchema>`
  - `faqEntrySchema` — the input plus `{ id: string }`
  - `type FaqEntry = z.infer<typeof faqEntrySchema>`
  - `type LocalisedEntry = { id: string; question: string; answer: string; category: string }`
  - `listEntries(): Promise<FaqEntry[]>` — every entry, admin ordering
  - `publishedEntries(locale: Locale): Promise<LocalisedEntry[]>` — published only, projected to one language

- [ ] **Step 1: Write the failing test**

`src/lib/faq/__tests__/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { faqEntryInputSchema } from "../schema";

const valid = {
 question: {
  en: "How long is delivery?",
  zh: "送货需要多久？",
  ms: "Berapa lama penghantaran?",
 },
 answer: {
  en: "Four to six weeks from the confirmed design.",
  zh: "从确认设计起四到六周。",
  ms: "Empat hingga enam minggu dari reka bentuk yang disahkan.",
 },
 category: "delivery",
 sortOrder: 0,
 published: true,
};

describe("faqEntryInputSchema", () => {
 it("accepts an entry carrying all three locales", () => {
  expect(faqEntryInputSchema.parse(valid)).toEqual(valid);
 });

 it("rejects an entry missing a locale", () => {
  const { zh: _zh, ...partial } = valid.question;
  const result = faqEntryInputSchema.safeParse({
   ...valid,
   question: partial,
  });
  expect(result.success).toBe(false);
 });

 it("rejects a blank answer in any locale", () => {
  const result = faqEntryInputSchema.safeParse({
   ...valid,
   answer: { ...valid.answer, ms: "   " },
  });
  expect(result.success).toBe(false);
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/faq/__tests__/schema.test.ts`
Expected: FAIL — `Cannot find module '../schema'`

- [ ] **Step 3: Write the schema**

`src/lib/faq/schema.ts`:

```ts
import { z } from "zod";
import type { Locale } from "@/lib/copy/locales";

/**
 * A string in every language the site serves.
 *
 * The three keys are written out rather than generated from `LOCALES`, the
 * same way `HTML_LANG` in `locales.ts` is: a generated `z.object` needs a cast
 * to keep its key types, and a cast here would hide exactly the error we want
 * — a fourth locale added to `LOCALES` and forgotten here. The `satisfies`
 * below is what catches that, at compile time, with no cast.
 *
 * A blank string counts as missing: a half-translated entry rendered to a
 * Malay reader is worse than no entry at all.
 */
const nonBlank = z.string().trim().min(1);

export const localeTextSchema = z.object({
 en: nonBlank,
 zh: nonBlank,
 ms: nonBlank,
}) satisfies z.ZodType<Record<Locale, string>>;

export type LocaleText = z.infer<typeof localeTextSchema>;

export const faqEntryInputSchema = z.object({
 question: localeTextSchema,
 answer: localeTextSchema,
 /** Free text, not an enum: the vocabulary is data the client owns. Same
  * reasoning as `Tutorial.category`. */
 category: z.string().trim().min(1),
 sortOrder: z.number().int().default(0),
 published: z.boolean().default(false),
});
export type FaqEntryInput = z.infer<typeof faqEntryInputSchema>;

export const faqEntrySchema = faqEntryInputSchema.extend({
 id: z.string(),
});
export type FaqEntry = z.infer<typeof faqEntrySchema>;

/** One entry flattened to a single language, which is all a page ever needs. */
export type LocalisedEntry = {
 id: string;
 question: string;
 answer: string;
 category: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/faq/__tests__/schema.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Add the Prisma model**

Append to `prisma/schema.prisma`:

```prisma
/// One FAQ entry, in every language the site serves.
///
/// `question` and `answer` are Json rather than six columns because the set of
/// locales is data (`LOCALES` in lib/copy/locales.ts) and a fourth language
/// should not be a migration — the same reason `CatalogueVersion.data` is Json.
/// Zod parses them on the way out; nothing trusts the column shape.
model FaqEntry {
  id        String   @id @default(cuid())
  question  Json
  answer    Json
  /// Validated as a non-blank string, not a Prisma enum: the client owns this
  /// vocabulary and adding "warranty" must not need a deploy.
  category  String
  sortOrder Int      @default(0)
  published Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([published, sortOrder])
}
```

- [ ] **Step 6: Run the migration**

Run: `pnpm db:migrate --name faq_entry`
Expected: migration applied, `prisma generate` regenerates the client.

Verify the client knows the model:

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Write the read path**

`src/lib/faq/store.ts`:

```ts
import "server-only";
import { prisma } from "@/lib/catalogue/db";
import type { Locale } from "@/lib/copy/locales";
import {
 type FaqEntry,
 faqEntrySchema,
 type LocalisedEntry,
 localeTextSchema,
} from "./schema";

/**
 * Every entry, admin ordering.
 *
 * A row whose Json fails to parse is dropped rather than thrown on: one
 * malformed entry — a half-finished translation saved straight into the
 * database, say — must not take the public FAQ page down with it.
 */
export async function listEntries(): Promise<FaqEntry[]> {
 const rows = await prisma.faqEntry.findMany({
  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
 });
 return rows.flatMap((row) => {
  const parsed = faqEntrySchema.safeParse(row);
  return parsed.success ? [parsed.data] : [];
 });
}

/** Published entries, flattened to one language. What both the page and the
 * prompt read — so the model can never cite an unpublished answer. */
export async function publishedEntries(
 locale: Locale,
): Promise<LocalisedEntry[]> {
 const rows = await prisma.faqEntry.findMany({
  where: { published: true },
  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
 });

 return rows.flatMap((row) => {
  const question = localeTextSchema.safeParse(row.question);
  const answer = localeTextSchema.safeParse(row.answer);
  if (!question.success || !answer.success) return [];
  return [
   {
    id: row.id,
    question: question.data[locale],
    answer: answer.data[locale],
    category: row.category,
   },
  ];
 });
}
```

- [ ] **Step 8: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

```bash
git add prisma/schema.prisma prisma/migrations src/lib/faq
git commit -m "feat(faq): add FaqEntry model, locale schemas and read path"
```

---

### Task 2: Question matching

The accordion answers for free; this decides when it can. A hit returns the stored answer with no model call at all.

**Files:**

- Create: `src/lib/faq/match.ts`
- Test: `src/lib/faq/__tests__/match.test.ts`

**Interfaces:**

- Consumes: `LocalisedEntry` from `./schema`.
- Produces: `matchEntry(question: string, entries: LocalisedEntry[]): LocalisedEntry | null`, `normalise(text: string): string`, `MATCH_THRESHOLD: number`.

- [ ] **Step 1: Write the failing test**

`src/lib/faq/__tests__/match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LocalisedEntry } from "../schema";
import { matchEntry, normalise } from "../match";

const entries: LocalisedEntry[] = [
 {
  id: "a",
  question: "How long is delivery?",
  answer: "Four to six weeks.",
  category: "delivery",
 },
 {
  id: "b",
  question: "Do you install the cabinets?",
  answer: "Yes, installation is included.",
  category: "install",
 },
 {
  id: "c",
  question: "Berapa lama penghantaran?",
  answer: "Empat hingga enam minggu.",
  category: "delivery",
 },
];

describe("normalise", () => {
 it("lowercases, strips punctuation and collapses whitespace", () => {
  expect(normalise("  How LONG  is delivery??  ")).toBe("how long is delivery");
 });

 it("leaves CJK characters intact", () => {
  expect(normalise("送货需要多久？")).toBe("送货需要多久");
 });
});

describe("matchEntry", () => {
 it("matches an exact question", () => {
  expect(matchEntry("How long is delivery?", entries)?.id).toBe("a");
 });

 it("matches on shared words regardless of order or case", () => {
  expect(matchEntry("delivery how long", entries)?.id).toBe("a");
 });

 it("matches a Malay question to its Malay entry", () => {
  expect(matchEntry("berapa lama penghantaran", entries)?.id).toBe("c");
 });

 it("returns null when nothing is close enough", () => {
  expect(matchEntry("can I pay with crypto", entries)).toBeNull();
 });

 it("returns null for an empty question", () => {
  expect(matchEntry("   ", entries)).toBeNull();
 });

 it("returns null when there are no entries", () => {
  expect(matchEntry("how long is delivery", [])).toBeNull();
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/faq/__tests__/match.test.ts`
Expected: FAIL — `Cannot find module '../match'`

- [ ] **Step 3: Write the matcher**

`src/lib/faq/match.ts`:

```ts
import type { LocalisedEntry } from "./schema";

/**
 * Does this question already have a written answer?
 *
 * Deliberately dumb: token overlap, no stemming, no embeddings. The corpus is
 * twenty entries the client wrote, and the cost of a miss is one model call at
 * roughly two sen — not a wrong answer. Precision matters more than recall
 * here, so the threshold is set high enough that a near-miss falls through to
 * the model rather than confidently returning the wrong stored answer.
 */

/** Strip punctuation and case, keep letters, digits and CJK. `\p{L}` covers
 * Malay diacritics and Chinese alike, so this needs no per-language branch. */
export function normalise(text: string): string {
 return text
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, " ")
  .trim()
  .replace(/\s+/g, " ");
}

/**
 * Chinese does not put spaces between words, so splitting on whitespace gives
 * one enormous token and nothing ever overlaps. Split CJK into characters and
 * everything else on whitespace.
 */
function tokens(text: string): string[] {
 const normalised = normalise(text);
 if (!normalised) return [];
 return normalised
  .split(/\s+/)
  .flatMap((word) =>
   /[一-鿿]/.test(word) ? [...word] : [word],
  )
  .filter((token) => token !== "");
}

/** Share this fraction of the entry's words and it counts as the same question. */
export const MATCH_THRESHOLD = 0.6;

export function matchEntry(
 question: string,
 entries: LocalisedEntry[],
): LocalisedEntry | null {
 const asked = new Set(tokens(question));
 if (asked.size === 0) return null;

 let best: { entry: LocalisedEntry; score: number } | null = null;

 for (const entry of entries) {
  const entryTokens = tokens(entry.question);
  if (entryTokens.length === 0) continue;

  const shared = entryTokens.filter((token) => asked.has(token)).length;
  // Scored against the entry's own length, not the union: a visitor who
  // types a long rambling question containing the whole stored question
  // should still match it.
  const score = shared / entryTokens.length;

  if (score >= MATCH_THRESHOLD && (best === null || score > best.score)) {
   best = { entry, score };
  }
 }

 return best?.entry ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/faq/__tests__/match.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/faq/match.ts src/lib/faq/__tests__/match.test.ts
git commit -m "feat(faq): match a question against the written corpus"
```

---

### Task 3: The prompt and its guardrails

**Files:**

- Create: `src/lib/faq/prompt.ts`
- Test: `src/lib/faq/__tests__/prompt.test.ts`

**Interfaces:**

- Consumes: `LocalisedEntry` from `./schema`; `Locale` from `@/lib/copy/locales`.
- Produces: `buildSystemPrompt(entries: LocalisedEntry[], locale: Locale): string`, `MAX_QUESTION_CHARS: number`, `MAX_TURNS: number`, `WHATSAPP_URL: string`.

- [ ] **Step 1: Write the failing test**

`src/lib/faq/__tests__/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../prompt";
import type { LocalisedEntry } from "../schema";

const entries: LocalisedEntry[] = [
 {
  id: "a",
  question: "How long is delivery?",
  answer: "Four to six weeks from the confirmed design.",
  category: "delivery",
 },
];

describe("buildSystemPrompt", () => {
 it("embeds every entry's question and answer", () => {
  const prompt = buildSystemPrompt(entries, "en");
  expect(prompt).toContain("How long is delivery?");
  expect(prompt).toContain("Four to six weeks from the confirmed design.");
 });

 it("names the language to answer in", () => {
  expect(buildSystemPrompt(entries, "ms")).toContain("Malay");
  expect(buildSystemPrompt(entries, "zh")).toContain("Chinese");
 });

 it("forbids inventing a price", () => {
  expect(buildSystemPrompt(entries, "en").toLowerCase()).toContain(
   "never state a price",
  );
 });

 it("carries the WhatsApp handoff", () => {
  expect(buildSystemPrompt(entries, "en")).toContain("wa.me");
 });

 it("is stable across calls, so the prefix can be cached", () => {
  expect(buildSystemPrompt(entries, "en")).toBe(
   buildSystemPrompt(entries, "en"),
  );
 });

 it("still produces a usable prompt when the corpus is empty", () => {
  const prompt = buildSystemPrompt([], "en");
  expect(prompt).toContain("wa.me");
  expect(prompt.length).toBeGreaterThan(0);
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/faq/__tests__/prompt.test.ts`
Expected: FAIL — `Cannot find module '../prompt'`

- [ ] **Step 3: Write the prompt builder**

`src/lib/faq/prompt.ts`:

```ts
import type { Locale } from "@/lib/copy/locales";
import type { LocalisedEntry } from "./schema";

/**
 * The whole FAQ corpus, as one system prompt.
 *
 * No retrieval step: twenty entries is roughly two thousand tokens, and a
 * vector store to select from twenty rows costs more to run and more to
 * understand than sending all twenty. Revisit if the corpus passes ~30k
 * tokens, which at the client's editing pace is years away.
 *
 * Pure and deterministic, because it is also the cached prefix — a timestamp
 * or a shuffled order here would silently cost the cache hit on every request.
 */

/** Longer than this is not a FAQ question; it is someone pasting a document. */
export const MAX_QUESTION_CHARS = 500;

/** A FAQ exchange that has run this long wants a human. */
export const MAX_TURNS = 8;

export const WHATSAPP_URL = "https://wa.me/60123456789";

const LANGUAGE_NAME: Record<Locale, string> = {
 en: "English",
 zh: "Chinese (Simplified)",
 ms: "Malay (Bahasa Malaysia)",
};

export function buildSystemPrompt(
 entries: LocalisedEntry[],
 locale: Locale,
): string {
 const corpus = entries
  .map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`)
  .join("\n\n");

 return [
  "You answer questions from customers of EzCabinet Sdn Bhd, a cabinet manufacturer in Klang Valley, Malaysia.",
  "",
  `Answer in ${LANGUAGE_NAME[locale]}. Do not switch language unless the customer writes to you in a different one, in which case follow theirs.`,
  "",
  "Rules, in order of importance:",
  "",
  "1. Never state a price, a quotation, a discount or a total that is not written verbatim in the answers below. If a customer asks what something costs, tell them the planner shows a live price as they build, and offer to connect them to the sales team. Do not estimate. Do not compute. Do not give a range.",
  `2. If the answers below do not cover the question, say so plainly and give them this WhatsApp link: ${WHATSAPP_URL}. A short honest handoff is a good answer; a plausible invention is not.`,
  "3. Never promise a lead time, a material, a finish or a service that is not written below.",
  "4. Keep answers to two or three sentences. Customers read these on a phone.",
  "5. Sentence case. Prices in RM.",
  "",
  "These are the only facts you have. Everything else is a handoff.",
  "",
  corpus || "(No entries are published yet — hand every question off.)",
 ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/faq/__tests__/prompt.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/faq/prompt.ts src/lib/faq/__tests__/prompt.test.ts
git commit -m "feat(faq): build the grounded system prompt and its guardrails"
```

---

### Task 4: Rate limiting

The one thing standing between a public, login-free model endpoint and someone else's script spending the client's credits.

**Files:**

- Create: `src/lib/faq/rateLimit.ts`
- Test: `src/lib/faq/__tests__/rateLimit.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `takeToken(key: string, now?: number): boolean`, `resetBuckets(): void`, `RATE_LIMIT: { capacity: number; refillMs: number }`.

- [ ] **Step 1: Write the failing test**

`src/lib/faq/__tests__/rateLimit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMIT, resetBuckets, takeToken } from "../rateLimit";

describe("takeToken", () => {
 beforeEach(() => resetBuckets());

 it("allows up to the capacity", () => {
  for (let i = 0; i < RATE_LIMIT.capacity; i++) {
   expect(takeToken("1.1.1.1", 0)).toBe(true);
  }
 });

 it("refuses once the bucket is empty", () => {
  for (let i = 0; i < RATE_LIMIT.capacity; i++) takeToken("1.1.1.1", 0);
  expect(takeToken("1.1.1.1", 0)).toBe(false);
 });

 it("keeps buckets separate per key", () => {
  for (let i = 0; i < RATE_LIMIT.capacity; i++) takeToken("1.1.1.1", 0);
  expect(takeToken("2.2.2.2", 0)).toBe(true);
 });

 it("refills over time", () => {
  for (let i = 0; i < RATE_LIMIT.capacity; i++) takeToken("1.1.1.1", 0);
  expect(takeToken("1.1.1.1", RATE_LIMIT.refillMs)).toBe(true);
 });

 it("never refills past capacity", () => {
  takeToken("1.1.1.1", 0);
  const far = RATE_LIMIT.refillMs * 1000;
  for (let i = 0; i < RATE_LIMIT.capacity; i++) {
   expect(takeToken("1.1.1.1", far)).toBe(true);
  }
  expect(takeToken("1.1.1.1", far)).toBe(false);
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/faq/__tests__/rateLimit.test.ts`
Expected: FAIL — `Cannot find module '../rateLimit'`

- [ ] **Step 3: Write the limiter**

`src/lib/faq/rateLimit.ts`:

```ts
/**
 * Per-IP token bucket, in process memory.
 *
 * ponytail: in-memory, per-instance. On Vercel's Fluid Compute an instance is
 * reused across requests so this holds for the common case, but two instances
 * mean two buckets and a cold start means a fresh one. That is the wrong tool
 * for authorisation and the right one for cost control at this scale — under a
 * thousand sessions a month, the backstop that actually matters is the AI
 * Gateway budget cap, which is enforced server-side and returns 402. Move to
 * Upstash Redis (already a Marketplace integration) if traffic makes the
 * per-instance approximation visibly leaky.
 */

export const RATE_LIMIT = {
 /** Questions per IP before the bucket is dry. */
 capacity: 10,
 /** One token back per this many ms — six an hour once exhausted. */
 refillMs: 10 * 60 * 1000,
} as const;

type Bucket = { tokens: number; lastRefillMs: number };

const buckets = new Map<string, Bucket>();

/** Test seam. Nothing in the app calls this. */
export function resetBuckets(): void {
 buckets.clear();
}

export function takeToken(key: string, now: number = Date.now()): boolean {
 const bucket = buckets.get(key) ?? {
  tokens: RATE_LIMIT.capacity,
  lastRefillMs: now,
 };

 const elapsed = Math.max(0, now - bucket.lastRefillMs);
 const refilled = Math.floor(elapsed / RATE_LIMIT.refillMs);
 if (refilled > 0) {
  bucket.tokens = Math.min(RATE_LIMIT.capacity, bucket.tokens + refilled);
  bucket.lastRefillMs = now;
 }

 if (bucket.tokens <= 0) {
  buckets.set(key, bucket);
  return false;
 }

 bucket.tokens -= 1;
 buckets.set(key, bucket);
 return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/faq/__tests__/rateLimit.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/faq/rateLimit.ts src/lib/faq/__tests__/rateLimit.test.ts
git commit -m "feat(faq): rate limit the public ask endpoint per IP"
```

---

### Task 5: The public ask endpoint

**Files:**

- Create: `src/app/api/faq/ask/route.ts`
- Modify: `package.json` (add `ai`, `@ai-sdk/react`)
- Modify: `.env.example` (document `AI_GATEWAY_API_KEY`)

**Interfaces:**

- Consumes: `publishedEntries` (Task 1), `matchEntry` (Task 2), `buildSystemPrompt` / `MAX_QUESTION_CHARS` / `MAX_TURNS` (Task 3), `takeToken` (Task 4).
- Produces: `POST /api/faq/ask` taking `{ messages: UIMessage[]; locale: Locale }`, returning a UI message stream.

- [ ] **Step 1: Install and read the current API**

```bash
pnpm add ai @ai-sdk/react
```

Then read, do not skip:

```bash
ls node_modules/ai/docs/
grep -rl "streamText" node_modules/ai/docs/ | head
grep -rl "useChat" node_modules/@ai-sdk/react/docs/ node_modules/ai/docs/ | head
```

Confirm three things before writing code: the `streamText` options shape, the name of the helper that turns its result into a `Response`, and the import path for `useChat`. **If the local docs contradict Step 3 below, follow the docs.**

- [ ] **Step 2: Wire the gateway credential**

The AI Gateway resolves `AI_GATEWAY_API_KEY` first, then `VERCEL_OIDC_TOKEN`. For local dev:

```bash
vercel env pull .env.local
```

Add to `.env.example`:

```
# Vercel AI Gateway. Local dev normally uses the VERCEL_OIDC_TOKEN that
# `vercel env pull` writes; set this only for CI or a non-Vercel host.
AI_GATEWAY_API_KEY=
```

**Set a hard budget cap in the Vercel dashboard** under AI Gateway → Budgets before the endpoint ships. The endpoint handles the resulting 402 in Step 3; without the cap there is nothing to handle.

- [ ] **Step 3: Write the route**

`src/app/api/faq/ask/route.ts`:

```ts
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { isLocale } from "@/lib/copy/locales";
import { matchEntry } from "@/lib/faq/match";
import {
 buildSystemPrompt,
 MAX_QUESTION_CHARS,
 MAX_TURNS,
} from "@/lib/faq/prompt";
import { takeToken } from "@/lib/faq/rateLimit";
import { publishedEntries } from "@/lib/faq/store";

export const runtime = "nodejs";

/**
 * Provisional until `scripts/faq-eval.mjs` (Task 8) decides it on evidence.
 * The site is trilingual, so Malay and Chinese quality outranks price — at
 * this traffic the difference between the cheapest and dearest candidate is
 * about RM 13 a month.
 */
const MODEL = "google/gemini-3.1-flash-lite";

/** The client sends a locale; a forged one must not pick a prompt language
 * we do not publish. */
function localeOf(value: unknown) {
 return typeof value === "string" && isLocale(value) ? value : "en";
}

function lastUserText(messages: UIMessage[]): string {
 const last = messages.at(-1);
 if (!last || last.role !== "user") return "";
 return last.parts
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join(" ");
}

export async function POST(request: Request) {
 // Vercel sets x-forwarded-for; the first hop is the client. Falling back to
 // a single shared key means an unknown-IP flood shares one bucket rather
 // than getting a free pass each.
 const ip =
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

 if (!takeToken(ip)) {
  return NextResponse.json(
   { error: "rate limited" },
   { status: 429, headers: { "retry-after": "600" } },
  );
 }

 const body = await request.json().catch(() => null);
 if (!body || !Array.isArray(body.messages)) {
  return NextResponse.json({ error: "invalid request" }, { status: 400 });
 }

 const messages = body.messages as UIMessage[];
 const locale = localeOf(body.locale);

 if (messages.length > MAX_TURNS * 2) {
  return NextResponse.json({ error: "conversation too long" }, { status: 400 });
 }

 const question = lastUserText(messages);
 if (question.length === 0 || question.length > MAX_QUESTION_CHARS) {
  return NextResponse.json({ error: "invalid question" }, { status: 400 });
 }

 const entries = await publishedEntries(locale);

 // The accordion's own answer, served without a model call. The client
 // checks this too; the server checks again because the client's copy of
 // the corpus can be stale and this is where the money is spent.
 const hit = messages.length === 1 ? matchEntry(question, entries) : null;
 if (hit) {
  return NextResponse.json({ matched: hit });
 }

 try {
  const result = streamText({
   model: MODEL,
   system: buildSystemPrompt(entries, locale),
   messages: convertToModelMessages(messages),
  });
  return result.toUIMessageStreamResponse();
 } catch (error) {
  const status = (error as { statusCode?: number }).statusCode;
  // 402 is the AI Gateway budget cap. It is a business state, not a bug:
  // the customer still gets a route to a human.
  if (status === 402 || status === 429) {
   return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  throw error;
 }
}
```

- [ ] **Step 4: Verify the endpoint end to end**

Start the dev server, seed one published entry through Prisma Studio (`pnpm db:studio`), then:

```bash
curl -s -X POST http://localhost:3000/api/faq/ask \
  -H 'content-type: application/json' \
  -d '{"locale":"en","messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"do you ship to penang"}]}]}'
```

Expected: a streamed answer that either uses a published entry or hands off to WhatsApp. Then confirm the free path:

```bash
curl -s -X POST http://localhost:3000/api/faq/ask \
  -H 'content-type: application/json' \
  -d '{"locale":"en","messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"how long is delivery"}]}]}'
```

Expected: `{"matched":{…}}` with no model call — check the AI Gateway dashboard shows no new request.

Then exhaust the limiter:

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/faq/ask \
    -H 'content-type: application/json' \
    -d '{"locale":"en","messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"random question '"$i"'"}]}]}'
done
```

Expected: `200` up to the capacity, then `429`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example src/app/api/faq/ask
git commit -m "feat(faq): stream grounded answers through AI Gateway"
```

---

### Task 6: Admin CRUD

**Files:**

- Create: `src/app/api/admin/faq/route.ts`
- Create: `src/app/api/admin/faq/[id]/route.ts`
- Create: `src/app/admin/faq/page.tsx`
- Create: `src/app/admin/faq/FaqManager.tsx`
- Reference: `src/app/admin/tutorials/TutorialManager.tsx` (read before writing — it is the design language)

**Interfaces:**

- Consumes: `faqEntryInputSchema` (Task 1), `listEntries` (Task 1), `prisma`.
- Produces: `GET/POST /api/admin/faq`, `PATCH/DELETE /api/admin/faq/[id]`.

Auth is handled by `src/proxy.ts` on the `/api/admin` prefix. Do not add an auth check here — the existing tutorials routes don't, and a second one would be a second thing to keep right.

- [ ] **Step 1: Write the list and create route**

`src/app/api/admin/faq/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { faqEntryInputSchema } from "@/lib/faq/schema";
import { listEntries } from "@/lib/faq/store";

export const runtime = "nodejs";

/** Every entry, published or not, in the order the public page renders them. */
export async function GET() {
 return NextResponse.json({ entries: await listEntries() });
}

export async function POST(request: Request) {
 const parsed = faqEntryInputSchema.safeParse(await request.json());
 if (!parsed.success) {
  return NextResponse.json(
   { error: "invalid entry", issues: parsed.error.issues },
   { status: 400 },
  );
 }

 const entry = await prisma.faqEntry.create({ data: parsed.data });
 return NextResponse.json({ entry }, { status: 201 });
}
```

- [ ] **Step 2: Write the edit and delete route**

`src/app/api/admin/faq/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { faqEntryInputSchema } from "@/lib/faq/schema";

export const runtime = "nodejs";

export async function PATCH(
 request: Request,
 { params }: { params: Promise<{ id: string }> },
) {
 const { id } = await params;
 const parsed = faqEntryInputSchema.partial().safeParse(await request.json());
 if (!parsed.success) {
  return NextResponse.json(
   { error: "invalid entry", issues: parsed.error.issues },
   { status: 400 },
  );
 }

 const entry = await prisma.faqEntry.update({
  where: { id },
  data: parsed.data,
 });
 return NextResponse.json({ entry });
}

export async function DELETE(
 _request: Request,
 { params }: { params: Promise<{ id: string }> },
) {
 const { id } = await params;
 const found = await prisma.faqEntry.findUnique({ where: { id } });
 if (!found) {
  return NextResponse.json({ error: "not found" }, { status: 404 });
 }

 await prisma.faqEntry.delete({ where: { id } });
 return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Build the admin page shell**

`src/app/admin/faq/page.tsx` — thin server component, exactly the shape of `src/app/admin/tutorials/page.tsx`:

```tsx
import { AdminHeader } from "@/components/admin/AdminHeader";
import { listEntries } from "@/lib/faq/store";
import { FaqManager } from "./FaqManager";

/**
 * The FAQ the public page renders and the assistant is grounded on.
 *
 * One screen for both: an entry the accordion shows is the same row the model
 * is allowed to cite, so there is no way to publish an answer to customers
 * that the assistant does not know, or vice versa.
 */
export default async function FaqAdminPage() {
 const entries = await listEntries();

 return (
  <div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
   <AdminHeader />
   <main className="mx-auto flex w-full max-w-[840px] flex-col gap-8 px-7 pt-8 pb-16">
    <div>
     <h1 className="mb-1 font-semibold text-[22px]">FAQ</h1>
     <p className="text-neutral-500 text-[13px]">
      Published entries appear on the public FAQ page and are the only
      facts the assistant may answer from. Anything not written here is
      handed off to WhatsApp.
     </p>
    </div>
    <FaqManager initial={entries} />
   </main>
  </div>
 );
}
```

- [ ] **Step 4: Build the manager**

`src/app/admin/faq/FaqManager.tsx`. The logic is below in full; fill the markup out with the token table from Global Constraints.

```tsx
"use client";

import { useState } from "react";
import type { Locale } from "@/lib/copy/locales";
import type { FaqEntry, FaqEntryInput, LocaleText } from "@/lib/faq/schema";

const LANG_TABS: Array<{ locale: Locale; label: string }> = [
 { locale: "en", label: "English" },
 { locale: "zh", label: "中文" },
 { locale: "ms", label: "Bahasa Malaysia" },
];

const EMPTY_TEXT: LocaleText = { en: "", zh: "", ms: "" };

const blankDraft = (): FaqEntryInput => ({
 question: { ...EMPTY_TEXT },
 answer: { ...EMPTY_TEXT },
 category: "",
 sortOrder: 0,
 published: false,
});

/** Every language filled in. The server rejects a partial entry anyway; this
 * is so the admin sees a disabled button rather than decoding a 400. */
const isComplete = (draft: FaqEntryInput): boolean =>
 draft.category.trim() !== "" &&
 LANG_TABS.every(
  ({ locale }) =>
   draft.question[locale].trim() !== "" && draft.answer[locale].trim() !== "",
 );

export function FaqManager({ initial }: { initial: FaqEntry[] }) {
 const [rows, setRows] = useState(initial);
 const [draft, setDraft] = useState<FaqEntryInput>(blankDraft);
 const [editingId, setEditingId] = useState<string | null>(null);
 const [tab, setTab] = useState<Locale>("en");
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 // Inline two-step delete. No window.confirm — see Global Constraints.
 const [pendingDelete, setPendingDelete] = useState<string | null>(null);

 const setText = (
  field: "question" | "answer",
  locale: Locale,
  value: string,
 ) =>
  setDraft((d) => ({ ...d, [field]: { ...d[field], [locale]: value } }));

 async function save() {
  setBusy(true);
  setError(null);
  try {
   const url = editingId ? `/api/admin/faq/${editingId}` : "/api/admin/faq";
   const response = await fetch(url, {
    method: editingId ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
   });
   if (!response.ok) {
    setError("Could not save that entry. Check every language is filled in.");
    return;
   }
   const { entry } = (await response.json()) as { entry: FaqEntry };
   setRows((current) =>
    editingId
     ? current.map((row) => (row.id === entry.id ? entry : row))
     : [...current, entry],
   );
   setDraft(blankDraft());
   setEditingId(null);
   setTab("en");
  } finally {
   setBusy(false);
  }
 }

 async function remove(id: string) {
  setBusy(true);
  setError(null);
  try {
   const response = await fetch(`/api/admin/faq/${id}`, { method: "DELETE" });
   if (!response.ok) {
    setError("Could not delete that entry.");
    return;
   }
   setRows((current) => current.filter((row) => row.id !== id));
   if (editingId === id) {
    setDraft(blankDraft());
    setEditingId(null);
   }
  } finally {
   setBusy(false);
   setPendingDelete(null);
  }
 }

 function edit(row: FaqEntry) {
  const { id, ...rest } = row;
  setDraft(rest);
  setEditingId(id);
  setTab("en");
 }

 // Render:
 //  1. A card holding the editor. Language tabs across the top (LANG_TABS,
 //     `tab` selects). Inside: question input + answer textarea for `tab`,
 //     then category / sortOrder / published shared across all languages.
 //     Save button disabled on `!isComplete(draft) || busy`.
 //  2. `error` in the error-banner style when non-null.
 //  3. A list of `rows` sorted by sortOrder: English question, a published
 //     badge, an Edit ghost button, and the two-step delete — the button
 //     reads "Delete" until `pendingDelete === row.id`, then "Really
 //     delete?" and calls `remove(row.id)`.
 return null; // replace with the markup above
}
```

**The tab UI matters more than it looks.** An admin who fills in English and saves gets a rejection; the tabs have to make the two unfilled languages visible at a glance. Mark a tab whose question or answer is still blank — a dot, a colour change, anything — so incompleteness is seen before the save button is reached, not after.

- [ ] **Step 5: Verify by hand**

Sign in at `/admin/login`, go to `/admin/faq`, and:

1. Create an entry with all three languages. Expect a 201 and the row appears.
2. Try to save with the Malay answer blank. Expect the save button disabled.
3. Publish it, then re-run the `matched` curl from Task 5 Step 4. Expect the free path to hit it.
4. Unpublish it and re-run. Expect a model call instead.
5. Delete it — first click arms, second click removes. Expect the row to go and a second `DELETE` to 404.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/faq src/app/admin/faq
git commit -m "feat(faq): admin CRUD for FAQ entries in three languages"
```

---

### Task 7: The public page

**Files:**

- Create: `src/app/[lang]/faq/page.tsx`
- Create: `src/components/faq/FaqAccordion.tsx`
- Create: `src/components/faq/FaqAsk.tsx`
- Modify: `src/lib/copy/en.ts`, `src/lib/copy/zh.ts`, `src/lib/copy/ms.ts`

**Interfaces:**

- Consumes: `publishedEntries` (Task 1), `matchEntry` (Task 2), `POST /api/faq/ask` (Task 5), `getDictionary` from `@/lib/copy/dictionary`.
- Produces: the route `/[lang]/faq`.

- [ ] **Step 1: Add the copy keys**

Add a `faq` section to the `Dictionary` type in `src/lib/copy/en.ts` and the matching values in all three files. `en.ts` defines the type, so start there and let `pnpm typecheck` name what `zh.ts` and `ms.ts` are missing.

Keys needed: `title`, `subtitle`, `askLabel`, `askPlaceholder`, `askSubmit`, `askThinking`, `askEmpty`, `whatsappCta`.

- [ ] **Step 2: Build the accordion**

`src/components/faq/FaqAccordion.tsx` — a server component. Native `<details>`, no JavaScript: this is the SEO surface *and* the no-JS fallback, and `<details>` is the platform's own disclosure widget.

```tsx
import type { LocalisedEntry } from "@/lib/faq/schema";

/** The id `FaqAsk` scrolls to and opens on a local match. Shared so the two
 * components cannot drift apart on the naming. */
export const entryDomId = (id: string) => `faq-${id}`;

export function FaqAccordion({ entries }: { entries: LocalisedEntry[] }) {
 const categories = [...new Set(entries.map((entry) => entry.category))];

 return (
  <div className="flex flex-col gap-8">
   {categories.map((category) => (
    <section key={category}>
     <h2 className="mb-3 font-semibold text-[12px] text-neutral-600 uppercase tracking-[0.06em]">
      {category}
     </h2>
     <div className="flex flex-col gap-2.5">
      {entries
       .filter((entry) => entry.category === category)
       .map((entry) => (
        <details
         key={entry.id}
         id={entryDomId(entry.id)}
         className="rounded-xl border border-neutral-200 bg-white px-4 py-3.5 open:shadow-sm"
        >
         <summary className="cursor-pointer font-medium text-[14px] marker:content-['']">
          {entry.question}
         </summary>
         <p className="mt-2.5 text-[13px] text-[#5c574e] leading-6">
          {entry.answer}
         </p>
        </details>
       ))}
     </div>
    </section>
   ))}
  </div>
 );
}
```

- [ ] **Step 3: Build the ask widget**

`src/components/faq/FaqAsk.tsx` — `"use client"`. It receives the published entries as a prop so `matchEntry` runs locally: a question already on the page costs no network call at all.

Verify the `useChat` import path and options against `node_modules/@ai-sdk/react/docs/` before writing — see Global Constraints. The logic below is what matters:

```tsx
"use client";

import { useState } from "react";
import type { Locale } from "@/lib/copy/locales";
import { matchEntry } from "@/lib/faq/match";
import { MAX_QUESTION_CHARS, WHATSAPP_URL } from "@/lib/faq/prompt";
import type { LocalisedEntry } from "@/lib/faq/schema";
import { entryDomId } from "./FaqAccordion";

type Props = {
 entries: LocalisedEntry[];
 locale: Locale;
 copy: {
  askLabel: string;
  askPlaceholder: string;
  askSubmit: string;
  askThinking: string;
  askEmpty: string;
  whatsappCta: string;
 };
};

export function FaqAsk({ entries, locale, copy }: Props) {
 const [question, setQuestion] = useState("");
 const [answer, setAnswer] = useState("");
 const [busy, setBusy] = useState(false);
 const [failed, setFailed] = useState(false);

 async function ask() {
  const asked = question.trim();
  if (asked === "") return;

  // Already written down: open it in place rather than paying for a model
  // call, and the visitor learns the answer was on the page.
  const hit = matchEntry(asked, entries);
  if (hit) {
   const node = document.getElementById(entryDomId(hit.id));
   if (node instanceof HTMLDetailsElement) {
    node.open = true;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setQuestion("");
    return;
   }
  }

  setBusy(true);
  setFailed(false);
  setAnswer("");
  try {
   const response = await fetch("/api/faq/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
     locale,
     messages: [
      { id: "1", role: "user", parts: [{ type: "text", text: asked }] },
     ],
    }),
   });

   // 429 (rate limited) and 503 (budget cap reached) are both "you cannot
   // have a model answer right now". The customer is mid-question, so the
   // only acceptable outcome is a route to a human.
   if (!response.ok) {
    setFailed(true);
    return;
   }

   const contentType = response.headers.get("content-type") ?? "";
   if (contentType.includes("application/json")) {
    const data = (await response.json()) as {
     matched?: LocalisedEntry;
    };
    if (data.matched) {
     setAnswer(data.matched.answer);
     return;
    }
    setFailed(true);
    return;
   }

   // Streamed answer. Render tokens as they arrive — on Malaysian mobile
   // data a five-second blank box reads as broken.
   const reader = response.body?.getReader();
   if (!reader) {
    setFailed(true);
    return;
   }
   const decoder = new TextDecoder();
   while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    setAnswer((current) => current + decoder.decode(value, { stream: true }));
   }
  } catch {
   setFailed(true);
  } finally {
   setBusy(false);
  }
 }

 // Render:
 //  - `copy.askLabel`, then an input bound to `question` with
 //    maxLength={MAX_QUESTION_CHARS} so the server's 400 is unreachable,
 //    submitting on Enter and on the primary button (disabled while `busy`).
 //  - `busy` → copy.askThinking. `answer` → the answer in a white card.
 //  - `failed` → copy.askEmpty plus an <a href={WHATSAPP_URL}> styled as the
 //    primary button, labelled copy.whatsappCta. Never a bare error string.
 return null; // replace with the markup above
}
```

**Read the streaming branch carefully when you wire it.** The `content-type` check is what separates a `{ matched }` JSON reply (the server's own free path) from a token stream. If `toUIMessageStreamResponse` frames its chunks — check the local docs — decode that framing rather than appending raw bytes, or the visitor sees protocol noise.

- [ ] **Step 4: Build the page**

`src/app/[lang]/faq/page.tsx`, following `src/app/[lang]/tutorials/page.tsx` — read it for the nav chrome and copy that, rather than inventing a second public header:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FaqAccordion } from "@/components/faq/FaqAccordion";
import { FaqAsk } from "@/components/faq/FaqAsk";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale, LOCALES } from "@/lib/copy/locales";
import { publishedEntries } from "@/lib/faq/store";

export async function generateMetadata({
 params,
}: {
 params: Promise<{ lang: string }>;
}): Promise<Metadata> {
 const { lang } = await params;
 if (!isLocale(lang)) return {};
 const t = await getDictionary(lang);

 return {
  title: t.faq.title,
  description: t.faq.subtitle,
  alternates: {
   canonical: `/${lang}/faq`,
   languages: Object.fromEntries(
    LOCALES.map((locale) => [locale, `/${locale}/faq`]),
   ),
  },
 };
}

/**
 * The public FAQ.
 *
 * A server component so every answer is in the first HTML — this page exists
 * to be indexed, and a crawler that gets an empty box indexes nothing. The
 * assistant below it is the long tail only; it never renders the answers the
 * accordion already holds.
 */
export default async function FaqPage({
 params,
}: {
 params: Promise<{ lang: string }>;
}) {
 const { lang } = await params;
 if (!isLocale(lang)) notFound();

 const [entries, t] = await Promise.all([
  publishedEntries(lang),
  getDictionary(lang),
 ]);

 return (
  <div className="flex min-h-screen flex-col bg-[#e9e7e3] text-neutral-900">
   {/* Nav — lift the sticky header from [lang]/tutorials/page.tsx */}
   <main className="mx-auto flex w-full max-w-[840px] flex-col gap-9 px-7 pt-10 pb-16">
    <div>
     <h1 className="mb-1 font-semibold text-[26px]">{t.faq.title}</h1>
     <p className="text-[14px] text-[#5c574e]">{t.faq.subtitle}</p>
    </div>
    <FaqAccordion entries={entries} />
    <FaqAsk entries={entries} locale={lang} copy={t.faq} />
   </main>
  </div>
 );
}
```

- [ ] **Step 5: Verify**

```bash
pnpm dev
```

Check, in order:

1. `/en/faq`, `/ms/faq`, `/zh/faq` each render every published entry in that language.
2. With JavaScript disabled in devtools, the accordion still opens and closes.
3. Typing a question that matches an entry scrolls to it and makes no network request (Network tab stays empty).
4. Typing something off-corpus streams an answer that ends in the WhatsApp link.
5. `curl -s localhost:3000/en/faq | grep -c '<details'` returns the published entry count — the answers are in the HTML, not fetched.

- [ ] **Step 6: Commit**

```bash
git add src/app/\[lang\]/faq src/components/faq src/lib/copy
git commit -m "feat(faq): trilingual FAQ page with accordion and grounded assistant"
```

---

### Task 8: Model bake-off

The site publishes in three languages. Model choice is a quality decision, and at this traffic the price spread across every candidate is about RM 13 a month — so decide it on answers, not on rates.

**Files:**

- Create: `scripts/faq-eval.mjs`
- Modify: `package.json` (add `faq:eval` script)
- Modify: `src/app/api/faq/ask/route.ts` (set `MODEL` to the winner)
- Create: `docs/faq-model-eval.md` (the result, so the next person does not redo it)

- [ ] **Step 1: Write the question set**

Thirty questions inside `scripts/faq-eval.mjs`: ten English, ten Malay, ten Chinese. Include, deliberately:

- four questions the corpus answers directly, one per language plus one paraphrase
- four the corpus does **not** answer (must produce a handoff, not an invention)
- three that ask for a price (must refuse to compute)
- two in Manglish (`"eh boss, this one can deliver to JB or not?"`)
- one code-switched (`"delivery berapa lama ya?"`)

Store the expected behaviour per question as one of `answer` / `handoff` / `refuse-price`.

- [ ] **Step 2: Write the runner**

The script loads the published corpus straight from the database, builds the prompt with `buildSystemPrompt`, and asks each candidate model each question:

```
google/gemini-3.1-flash-lite    $0.25 / $1.50
google/gemini-3.5-flash-lite    $0.30 / $2.50
openai/gpt-5.4-nano             $0.20 / $1.25
anthropic/claude-haiku-4.5      $1.00 / $5.00
```

Write every answer to `docs/faq-model-eval.md` as a table, grouped by question, with the actual token usage per call from the response's `usage` field.

- [ ] **Step 3: Grade by hand**

Three checks per answer. They are not equally weighted — the first is a veto:

1. **Did it invent a price or a promise?** Any yes disqualifies the model outright.
2. Is the language natural to a Malaysian reader? (Malay that reads as Indonesian is a fail. Traditional characters are a fail — the site publishes Simplified.)
3. Did it hand off when it should have?

- [ ] **Step 4: Record and set the model**

Write the verdict at the top of `docs/faq-model-eval.md`: the chosen model, the date, the measured cost per conversation in RM, and which candidates were disqualified and why. Then set `MODEL` in `src/app/api/faq/ask/route.ts`.

- [ ] **Step 5: Commit**

```bash
git add scripts/faq-eval.mjs package.json docs/faq-model-eval.md src/app/api/faq/ask/route.ts
git commit -m "feat(faq): pick the answering model against a trilingual eval"
```

---

## Cost expectations

Measured shape: ~2,600-token stable prefix (guardrails + 20-entry corpus), 4-turn average, ~120-token answers. USD/MYR 4.05.

| Model | Per conversation | 300 conversations/month |
| --- | --- | --- |
| `openai/gpt-5.4-nano` | RM 0.012 | RM 3.50 |
| `google/gemini-3.1-flash-lite` | RM 0.015 | RM 4.40 |
| `google/gemini-3.5-flash-lite` | RM 0.019 | RM 5.70 |
| `anthropic/claude-haiku-4.5` | RM 0.057 | RM 17 |

The accordion serves most traffic for nothing, so the real bill sits below these. AI Gateway takes **zero markup** — you pay provider list price out of prepaid credits.

**Two billing facts worth knowing before the first top-up:**

- The **$5/month free tier covers a model subset only** — `minimax/*`, `perplexity/sonar*`, `fish-audio/*`, `inclusionai/*`, `poolside/*`. None of the four candidates above are on it. Budget from day one.
- **The first credit purchase ends the monthly free credit permanently.**

## Blocking before this goes public

- **`WHATSAPP_URL` in `src/lib/faq/prompt.ts` is a placeholder** (`https://wa.me/60123456789`). It is the single exit route for every question the corpus does not answer, and it is also text the model reads aloud to customers. Get the real sales number from EzCabinet before Task 7 ships. This joins `WORKSHOP_PHONE` on `CLAUDE.md`'s open-questions list, and it fails louder: a wrong logistics number reaches an admin, a wrong WhatsApp number reaches every customer who asks something off-corpus.
- **Set the AI Gateway budget cap** (Task 5 Step 2). Without it the 402 branch in the route is unreachable and the endpoint has no ceiling.
- **At least one published entry per language.** An empty corpus makes the assistant hand off every single question, which is safe but reads as broken.

## What this plan does not do

Stated so nobody assumes otherwise:

- **No lead capture.** The handoff is a `wa.me` link, not a form. Phase 3 lead capture is separate work.
- **No conversation storage.** Nothing is written to Postgres, so there is no PDPA question about transcripts holding phone numbers. Adding analytics later means answering that question first.
- **No layout generation.** The "describe your kitchen → starter layout" idea was researched in the same session and deferred; the blocker is catalogue vocabulary (no sink base, no hob unit, no oven housing), not model capability.
- **No embeddings, no vector store.** See the corpus size.
