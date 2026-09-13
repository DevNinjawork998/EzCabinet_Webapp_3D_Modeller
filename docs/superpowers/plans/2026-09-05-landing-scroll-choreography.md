# Landing scroll choreography — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/[lang]` the scroll choreography of a premium product page — a pinned hero that resolves as you scroll, and content that arrives on entry — without adding a dependency, without costing LCP, and without breaking the page when JavaScript never runs.

**Architecture:** One client island publishes a single normalised progress value `0→1` as a CSS custom property on its own subtree; server-rendered markup underneath reads it through CSS custom-property inheritance. Motion is **opt-in via a `data-beats="on"` attribute the island sets after mount**, so the default rendering — no JS, pre-hydration, reduced motion, narrow viewport — is the finished page, not an invisible one. Pinning is `position: sticky` inside a tall track. All scroll math lives in a pure, tested module; the island stays thin enough to verify in a browser.

**Tech Stack:** Next.js 16 App Router (RSC), React 19, TypeScript, Tailwind v4, vitest. **No new dependencies** — no framer-motion, no GSAP, no Lenis.

**Spec:** `~/.claude/plans/i-need-you-to-composed-forest.md` (the `scroll-choreography` skill spec) and the measured evidence gathered for it from `apple.com/my/macbook-pro/`, `21oaks.org/` and `amix-design.com/tl/web-g-threejs/`.

## Global Constraints

- **No new runtime dependency.** `package.json` has no motion library. This is a public marketing surface whose whole brief is "fast on mid-range Android in Malaysia" (`CLAUDE.md`); framer-motion is ~35 KB gzipped on the LCP path for what `calc()` already does.
- **The page must be complete without JavaScript.** Every element's default CSS is its final state. Motion is applied only under `[data-beats="on"]`, which only a mounted client island sets. This is the rule the baseline runs all broke.
- **`prefers-reduced-motion: reduce` → no listener is ever attached.** Not "faster motion", not "shorter distance". The static page is the reduced-motion experience. This is a **live** guarantee, not a point-in-time one: both media queries are re-evaluated on `change`, so a visitor who turns reduced motion on mid-session gets the static page without reloading.
- **Narrow viewports get the static page too.** Gate at `min-width: 900px`, matching the reference site's own 992px gate. Phones in Klang Valley are the target device, and they get the composition, not the choreography.
- **Only `transform`, `opacity` and `filter` are animated.** No layout properties in a scroll path.
- **`will-change` is set when a track activates and removed when it deactivates.** Never left in a stylesheet permanently.
- Copy comes from `t.landing.*` via `getDictionary(lang)`. **This plan adds no new user-facing strings**, so nothing needs translating into `zh` or `ms`.
- Existing design tokens are fixed: `ACCENT #2c5f47`, `PAPER #e9e7e3`, `RAISED #fdfcfb`, `RULE #d9d5cd`, radius 12px.
- Biome formats with tabs. Run `pnpm lint` before every commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/scroll/beats.ts` (create) | Pure scroll math: track progress, sub-range mapping, the enablement predicate. Framework-free, like `lib/planner`. |
| `src/lib/scroll/__tests__/beats.test.ts` (create) | vitest coverage for every function above. |
| `src/components/scroll/ScrollTrack.tsx` (create) | The client island. Renders the tall track + sticky stage, publishes `--p`, owns the gate and the `will-change` lifecycle. |
| `src/components/scroll/RevealOnEnter.tsx` (create) | One `IntersectionObserver` for the whole page; flips `data-revealed` on any `[data-reveal]` element once. |
| `src/app/globals.css` (modify, currently 27 lines) | The `[data-beats="on"]` and `[data-revealed]` rules that consume the published values. |
| `src/app/[lang]/page.tsx` (modify, 582 lines) | Wrap the hero section (line 243) in `ScrollTrack`, mount `RevealOnEnter` once, add `data-beat` / `data-reveal` attributes. Stays a server component. |

---

### Task 1: Pure scroll math

**Files:**
- Create: `src/lib/scroll/beats.ts`
- Test: `src/lib/scroll/__tests__/beats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `clamp01(v: number): number`, `trackProgress(rectTop: number, trackHeight: number, viewportHeight: number): number`, `beatsEnabled(env: { reducedMotion: boolean; wideEnough: boolean }): boolean`.

Range-slicing a track's progress into individual beats is **not** a function here. The stylesheet does it inline with `clamp(0, calc((var(--p) - start) / (end - start)), 1)`, at the point of use. A TypeScript twin of that arithmetic would have no caller and would drift from the CSS that actually runs.

- [ ] **Step 1: Write the failing test**

Create `src/lib/scroll/__tests__/beats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { beatsEnabled, clamp01, trackProgress } from "../beats";

describe("clamp01", () => {
	it("passes through the unit interval and clamps outside it", () => {
		expect(clamp01(0.4)).toBe(0.4);
		expect(clamp01(-3)).toBe(0);
		expect(clamp01(9)).toBe(1);
	});
});

describe("trackProgress", () => {
	// A 2-viewport track on an 800px viewport has 800px of runway inside it:
	// progress is 0 the moment its top reaches the viewport top, 1 once the
	// page has scrolled that runway away.
	it("is 0 when the track top sits at the viewport top", () => {
		expect(trackProgress(0, 1600, 800)).toBe(0);
	});

	it("is 1 once the whole runway has been scrolled", () => {
		expect(trackProgress(-800, 1600, 800)).toBe(1);
	});

	it("is linear in between", () => {
		expect(trackProgress(-400, 1600, 800)).toBeCloseTo(0.5);
	});

	it("clamps before the track is reached and after it is left", () => {
		expect(trackProgress(500, 1600, 800)).toBe(0);
		expect(trackProgress(-5000, 1600, 800)).toBe(1);
	});

	// A track no taller than the viewport has no runway. It must not divide by
	// zero — it is simply "not started" until its top passes, then "done".
	it("degenerates safely when the track is not taller than the viewport", () => {
		expect(trackProgress(10, 800, 800)).toBe(0);
		expect(trackProgress(-10, 800, 800)).toBe(1);
	});
});

describe("beatsEnabled", () => {
	it("runs only on a wide viewport with motion allowed", () => {
		expect(beatsEnabled({ reducedMotion: false, wideEnough: true })).toBe(true);
	});

	it("stays off for reduced motion even on a wide viewport", () => {
		expect(beatsEnabled({ reducedMotion: true, wideEnough: true })).toBe(false);
	});

	it("stays off on a narrow viewport even when motion is allowed", () => {
		expect(beatsEnabled({ reducedMotion: false, wideEnough: false })).toBe(
			false,
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/scroll`
Expected: FAIL — `Failed to resolve import "../beats"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/scroll/beats.ts`:

```ts
/**
 * The scroll maths behind the landing page's choreography, as pure functions.
 *
 * Framework-free on purpose, the same way `lib/planner` is: the client island
 * that calls these is a thin shell around them, so the arithmetic that decides
 * where a beat lands is testable without a DOM.
 *
 * The model: a **track** is a tall element containing a sticky stage. Its
 * progress is one number, 0 the moment its top reaches the viewport top and 1
 * once the runway underneath the sticky stage has been scrolled away. Every
 * animated property on the page is a function of that single number — which is
 * how Apple's product pages are built, where one `--vo-scroll-*` custom
 * property feeds dozens of elements.
 */

/** The unit interval, defended. */
// `+ 0` is not decoration: `trackProgress` computes `-rectTop / runway`, which
// is `-0` when `rectTop` is 0, and `Object.is(-0, 0)` is false — so a bare
// pass-through fails `expect(...).toBe(0)` at the very top of a track.
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v + 0);

/**
 * How far through a track the page has scrolled, 0..1.
 *
 * `rectTop` is the track's `getBoundingClientRect().top` — negative once its
 * top has passed above the viewport. The runway is everything the track has
 * beyond one viewport, since the sticky stage occupies that last viewport.
 */
export function trackProgress(
	rectTop: number,
	trackHeight: number,
	viewportHeight: number,
): number {
	const runway = trackHeight - viewportHeight;
	// A track no taller than the viewport never pins, so it has no runway to
	// divide by. Treat it as a switch at the moment its top passes.
	if (runway <= 0) return rectTop <= 0 ? 1 : 0;
	return clamp01(-rectTop / runway);
}

/**
 * Whether scroll choreography may run at all.
 *
 * Two gates, both refusals rather than degradations. Reduced motion means the
 * page stays where it is; a narrow viewport means the same, because the target
 * device is a mid-range Android phone in Klang Valley and it gets the
 * composition rather than the choreography.
 */
export function beatsEnabled(env: {
	reducedMotion: boolean;
	wideEnough: boolean;
}): boolean {
	return !env.reducedMotion && env.wideEnough;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/scroll`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scroll/beats.ts src/lib/scroll/__tests__/beats.test.ts
git commit -m "feat(scroll): pure track-progress and beat maths"
```

---

### Task 2: The `ScrollTrack` island

**Files:**
- Create: `src/components/scroll/ScrollTrack.tsx`
- Modify: `src/app/globals.css` (append; currently 27 lines)

**Interfaces:**
- Consumes: `trackProgress`, `beatsEnabled` from `@/lib/scroll/beats`.
- Produces: `<ScrollTrack viewports={number} className?: string>{children}</ScrollTrack>` — a default export React client component. It renders a track `div` of height `viewports × 100svh` containing a `position: sticky` stage of `100svh`, sets `--p` on the track element, and sets `data-beats="on"` on it only while active.

The island holds no scroll arithmetic of its own; it wires the DOM to Task 1's functions. It is verified in a browser in Task 4, not by a unit test — `jsdom` is not a declared dependency of this repo and this plan does not add one.

- [ ] **Step 1: Write the island**

Create `src/components/scroll/ScrollTrack.tsx`:

```tsx
"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { beatsEnabled, trackProgress } from "@/lib/scroll/beats";

/** Below this width the page is composition only — no scroll choreography. */
const MIN_WIDTH_PX = 900;

/**
 * A tall track with a pinned stage, publishing its scroll progress as `--p`.
 *
 * Everything inside reads that one custom property through inheritance, so the
 * children stay server-rendered markup with no client cost of their own. The
 * island writes; CSS does the animating.
 *
 * Three things make this safe on a public marketing page:
 *
 *  - `data-beats` is absent until the effect runs, and every motion rule in
 *    `globals.css` is scoped under `[data-beats="on"]`. With no JavaScript, a
 *    slow hydration, reduced motion or a narrow screen, the page renders in its
 *    finished state rather than an invisible one.
 *  - The scroll listener exists only while the track is actually on screen, and
 *    is passive and rAF-throttled, so it never blocks a scroll.
 *  - `will-change` is granted on activation and taken back on deactivation.
 *    Left permanently in a stylesheet it is a memory cost on exactly the
 *    mid-range Android this app is built for.
 */
export default function ScrollTrack({
	viewports,
	className,
	children,
}: {
	viewports: number;
	className?: string;
	children: ReactNode;
}) {
	const trackRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const track = trackRef.current;
		if (!track) return;

		const enabled = beatsEnabled({
			reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
			wideEnough: matchMedia(`(min-width: ${MIN_WIDTH_PX}px)`).matches,
		});
		if (!enabled) return;

		let ticking = false;
		let listening = false;

		const write = () => {
			ticking = false;
			const p = trackProgress(
				track.getBoundingClientRect().top,
				track.offsetHeight,
				innerHeight,
			);
			track.style.setProperty("--p", p.toFixed(4));
		};

		const onScroll = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(write);
		};

		const start = () => {
			if (listening) return;
			listening = true;
			track.dataset.beats = "on";
			addEventListener("scroll", onScroll, { passive: true });
			write();
		};

		const stop = () => {
			if (!listening) return;
			listening = false;
			removeEventListener("scroll", onScroll);
			// Hold the last published value so the track keeps its end state,
			// but hand the compositor layers back.
			delete track.dataset.beats;
		};

		// Only listen while the track is anywhere near the viewport.
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) start();
				else stop();
			},
			{ rootMargin: "100% 0px" },
		);
		observer.observe(track);

		return () => {
			observer.disconnect();
			stop();
		};
	}, []);

	return (
		<div
			ref={trackRef}
			className={className}
			style={{ height: `${viewports * 100}svh` }}
		>
			<div className="sticky top-0 h-svh overflow-hidden">{children}</div>
		</div>
	);
}
```

- [ ] **Step 2: Add the rules that consume `--p`**

Append to `src/app/globals.css`:

```css
/*
 * Scroll choreography.
 *
 * Every rule here is scoped under `[data-beats="on"]`, which only a mounted
 * `ScrollTrack` island sets. The unscoped rendering — no JavaScript, before
 * hydration, reduced motion, or a viewport under 900px — is the finished page.
 * Nothing below may introduce a state the page cannot be read in.
 *
 * `--p` is the track's progress, 0..1, inherited by everything inside it.
 * A beat is a slice of it: `clamp(0, (var(--p) - start) / (end - start), 1)`.
 */

[data-beats="on"] {
	/* Each fallback is chosen so that an unknown `--p` renders the READABLE
	   state — not a fixed number. It defends the instant before the first
	   `write()`, and any future path that sets `data-beats` without a paired
	   write. The two differ because the beats point in opposite directions:
	   the photo's is an arrival (1 = settled), the copy's is a departure
	   (0 = still here, fully legible). */
	--beat-photo: clamp(0, calc(var(--p, 1) / 0.75), 1);
	--beat-exit: clamp(0, calc((var(--p, 0) - 0.55) / 0.45), 1);
}

/* The hero copy does NOT arrive on scroll — it is the LCP element and must be
   legible the instant the page paints. It leaves instead, drifting up and out
   over the back half of the track, which is what the reference product pages
   actually do. Fading it in would reproduce, one frame later, exactly the
   blank-headline failure the no-JavaScript contract exists to prevent. */
[data-beats="on"] [data-beat="hero-copy"] {
	opacity: calc(1 - var(--beat-exit));
	transform: translate3d(0, calc(var(--beat-exit) * -32px), 0);
	will-change: transform, opacity;
}

[data-beats="on"] [data-beat="hero-photo"] {
	/* The photograph settles back as the words arrive. Transform only — the
	   image box never changes size, so nothing re-lays-out. */
	transform: scale(calc(1.08 - var(--beat-photo) * 0.08));
	will-change: transform;
}

/* Arrive-on-entry, for the sections below the pinned hero. Same contract: the
   revealed state is the default, and only a mounted observer can take it away
   and give it back. */
[data-reveal-armed] [data-reveal] {
	opacity: 0;
	transform: translate3d(0, 18px, 0);
	transition: opacity 620ms cubic-bezier(0.22, 0.61, 0.36, 1),
		transform 620ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

[data-reveal-armed] [data-reveal][data-revealed] {
	opacity: 1;
	transform: none;
}

@media (prefers-reduced-motion: reduce) {
	[data-reveal-armed] [data-reveal] {
		opacity: 1;
		transform: none;
		transition: none;
	}
}
```

- [ ] **Step 3: Verify the suite and the build still pass**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: PASS on all three. The island is not referenced yet, so this only proves it compiles and Biome is happy with it.

- [ ] **Step 4: Commit**

```bash
git add src/components/scroll/ScrollTrack.tsx src/app/globals.css
git commit -m "feat(scroll): pinned track island publishing progress as a CSS variable"
```

---

### Task 3: Reveal-on-entry island

**Files:**
- Create: `src/components/scroll/RevealOnEnter.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<RevealOnEnter />` — a default export React client component rendering no DOM of its own. Mounted once per page; it sets `data-reveal-armed` on `<body>` and observes every `[data-reveal]` element, setting `data-revealed` on each the first time it enters view.

One observer for the whole page, and it stops observing an element once revealed — the alternative, an observer per card, is the shape that makes a long page stutter.

- [ ] **Step 1: Write the island**

Create `src/components/scroll/RevealOnEnter.tsx`:

```tsx
"use client";

import { useEffect } from "react";

/**
 * Arms the page's `[data-reveal]` elements and reveals each one once.
 *
 * Renders nothing. It arms by setting `data-reveal-armed` on `<body>`, which is
 * what the hidden-state rule in `globals.css` is scoped to — so the elements are
 * only ever hidden while something is guaranteed to be able to show them again.
 * With no JavaScript the attribute never appears and every section is simply
 * visible.
 *
 * Reduced motion is handled in CSS rather than here: the elements still reveal,
 * they just do it without travel. Skipping the observer entirely would leave
 * them armed and hidden.
 *
 * Elements already inside the viewport when this mounts are revealed before the
 * page is armed at all, so nothing the visitor can already see ever animates.
 */
export default function RevealOnEnter() {
	useEffect(() => {
		const targets = Array.from(
			document.querySelectorAll<HTMLElement>("[data-reveal]"),
		);
		if (targets.length === 0) return;

		// Anything already on screen is revealed before the page is armed.
		// Arming first would hide it for the frame or two before
		// IntersectionObserver's first asynchronous callback lands — a flash on
		// exactly the content the visitor was already looking at. Nothing
		// already visible should animate in.
		const pending: HTMLElement[] = [];
		for (const target of targets) {
			const { top, bottom } = target.getBoundingClientRect();
			if (top < innerHeight && bottom > 0) target.dataset.revealed = "";
			else pending.push(target);
		}

		document.body.dataset.revealArmed = "";
		if (pending.length === 0) {
			return () => {
				delete document.body.dataset.revealArmed;
			};
		}

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const el = entry.target as HTMLElement;
					el.dataset.revealed = "";
					observer.unobserve(el);
				}
			},
			{ rootMargin: "0px 0px -12% 0px" },
		);

		for (const target of pending) observer.observe(target);

		return () => {
			observer.disconnect();
			delete document.body.dataset.revealArmed;
		};
	}, []);

	return null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/scroll/RevealOnEnter.tsx
git commit -m "feat(scroll): one-observer reveal-on-entry island"
```

---

### Task 4: Wire the landing page

**Files:**
- Modify: `src/app/[lang]/page.tsx` — hero `<section>` opens at line 243; the sections to mark are at lines 311 (facts `<dl>`), 334 (`#how`), 360 (gallery), 408 (`#finishes`), 457 (FAQ).

**Interfaces:**
- Consumes: `ScrollTrack` (Task 2), `RevealOnEnter` (Task 3), and the `data-beat` / `data-reveal` contract in `globals.css`.
- Produces: nothing for later tasks.

The page stays a **server component**. Only two client islands are introduced, and neither receives any of the page's data — the copy, the prices and the images are still rendered on the server.

- [ ] **Step 1: Import the islands**

At the top of `src/app/[lang]/page.tsx`, alongside the existing imports:

```tsx
import RevealOnEnter from "@/components/scroll/RevealOnEnter";
import ScrollTrack from "@/components/scroll/ScrollTrack";
```

- [ ] **Step 2: Wrap the hero in a track**

The hero section currently begins at line 243:

```tsx
<section className="relative isolate w-full overflow-hidden">
```

Wrap that entire `<section>` — through its existing closing tag — in a track, and mark the two things that move. The photo wrapper is the `<div className="absolute inset-0 -z-20 bg-neutral-900">` immediately inside it; the copy is the block containing the eyebrow, `titleBeforeAccent` / `titleAccent`, subtitle and the two CTAs.

```tsx
<ScrollTrack viewports={1.7}>
	<section className="relative isolate h-full w-full overflow-hidden">
		<div
			className="absolute inset-0 -z-20 bg-neutral-900"
			data-beat="hero-photo"
		>
			<Photo
				url={photo.get(HERO_SLOT) ?? null}
				alt={t.landing.hero.alt}
				fallbackSrc={DEFAULT_FINISH_TEXTURES["rhone-oak"]}
				className="h-full w-full"
			/>
		</div>

		{/* Both existing gradient overlay divs stay byte-for-byte as they are,
		    including their `aria-hidden`. They are the legibility of the
		    headline against the photograph and nothing here changes that. */}

		<div
			data-beat="hero-copy"
			className="mx-auto flex min-h-[clamp(460px,68vh,640px)] w-full max-w-[1180px] flex-col justify-center px-6 py-20 sm:px-8 sm:py-24"
		>
			<p className="mb-5 font-semibold text-[11px] text-white/70 uppercase tracking-[0.16em]">
				{t.landing.hero.eyebrow}
			</p>
			{/* The accent word is the product, not decoration — the template
			    this follows colours a noun, and the noun worth colouring
			    here is the thing nobody else in the market offers. */}
			<h1 className="max-w-[15ch] text-balance font-bold text-[clamp(38px,6vw,68px)] text-white leading-[1.02] tracking-[-0.02em]">
				{t.landing.hero.titleBeforeAccent}{" "}
				<span style={{ color: "#8fc4a8" }}>
					{t.landing.hero.titleAccent}
				</span>
			</h1>
			<p className="mt-6 max-w-[46ch] text-[17px] text-white/75 leading-7">
				{t.landing.hero.subtitle}
			</p>
			<div className="mt-9 flex flex-wrap items-center gap-3">
				<Link
					href={`/${lang}/planner`}
					className="rounded-xl bg-white px-8 py-4 font-semibold text-[15px] text-neutral-900 transition-transform active:translate-y-px"
				>
					{t.landing.hero.cta}
				</Link>
				{/* Ghost, not a second solid button: two equal buttons make the
				    customer choose, and the choice we want is the planner. */}
				<a
					href="#how"
					className="rounded-xl border border-white/30 px-8 py-4 font-medium text-[15px] text-white/90 transition-colors hover:border-white/60 active:translate-y-px"
				>
					{t.landing.hero.howItWorks}
				</a>
			</div>
		</div>
	</section>
</ScrollTrack>
```

Three things to keep right while editing:
- The inner `<section>` gains `h-full` and loses nothing else — the sticky stage already owns the viewport height.
- The copy block keeps its existing `min-h-[clamp(460px,68vh,640px)]`. Inside a `h-svh` stage that clamp is what keeps the words vertically centred at every window height; replacing it with `h-full` re-centres them against the wrong box.
- Nothing in the copy block gets an opacity or transform in its own `className`. Its default rendering must stay the finished state — that is the whole contract.

- [ ] **Step 3: Mark the sections below for reveal, and mount the observer**

Add `data-reveal` to the five section elements at lines 311, 334, 360, 408 and 457 — the attribute goes on the existing element, no wrapper, no class changes:

```tsx
<section id="how" data-reveal className="mx-auto w-full max-w-[1180px] px-6 py-20 sm:px-8">
```

Then mount the observer once, immediately before the closing element of the page's returned tree (after the `<footer>` at line 513):

```tsx
<RevealOnEnter />
```

- [ ] **Step 4: Run the checks**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: PASS on all three.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[lang]/page.tsx"
git commit -m "feat(landing): pinned hero beat and reveal-on-entry sections"
```

---

### Task 5: Verify in a browser, at both ends of the contract

**Files:** none modified — this task is the gate.

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev`
Open `http://localhost:3000/en`.

- [ ] **Step 2: Check the beats land where the plan says**

With the Playwright or Chrome MCP tools, screenshot at five scroll positions through the hero track — 0 %, 25 %, 50 %, 75 %, 100 % of its height. Expected: the eyebrow/headline/subtitle are fully legible at 0 % and stay put until roughly 55 %, then drift up and fade as the track finishes; the photograph's scale eases from 1.08 to 1.00 across 75 %; The headline must be **fully legible in the 0 % screenshot** — it is the LCP element and it starts resolved.

- [ ] **Step 3: Confirm no layout shift**

In DevTools → Performance, record a scroll through the hero. Expected: zero layout-shift entries, and no `Recalculate Style` costing more than a millisecond per frame. If a shift appears, something in the track is animating a layout property — find it and move it onto `transform`.

- [ ] **Step 4: Reduced motion**

Emulate `prefers-reduced-motion: reduce` (DevTools → Rendering). Reload. Expected: the hero renders in its finished state at every scroll position, no `--p` is ever written, `data-beats` never appears on the track in the elements panel, and the sections below still become visible.

- [ ] **Step 5: Narrow viewport**

Resize below 900px and reload. Expected: same as Step 4 — the track pins nothing, no listener is attached. Confirm in DevTools → Event Listeners that no `scroll` listener exists on `window`.

- [ ] **Step 6: No JavaScript**

Disable JavaScript (DevTools → Settings → Debugger → Disable JavaScript) and reload. Expected: **every headline, price, room card, finish swatch and FAQ answer is visible and readable.** No blank hero, no empty sticky void, no invisible sections. This is the check the whole design exists to pass; if it fails, the `[data-beats="on"]` / `[data-reveal-armed]` scoping has been broken somewhere.

- [ ] **Step 7: Commit anything the verification turned up**

```bash
pnpm test && pnpm lint && pnpm build
git add -A && git commit -m "fix(landing): scroll choreography verification fixes"
```

---

## Not in this plan

- **The pinned "how it works" three-step sequence.** A second track, one beat per step, is the natural follow-up once the hero pattern is proven on a real device. The machinery from Tasks 1–3 already supports it: another `ScrollTrack viewports={3}` and three more `--beat-*` slices.
- **Scrubbed video.** Apple's hero is a `<video preload="none">` scrubbed against scroll with a per-breakpoint source map and a 5-second load timeout. Worth doing when EzCabinet has a door-opening render to scrub; it needs a real asset and a byte budget, not just code.
- **A WebGL hero** using the R3F stack already in the repo. The planner owns the 3D; putting a WebGL context on the LCP path of the marketing page is a decision to make deliberately, with the `no-gl` fallback pattern, not as a side effect of this work.

---

## Verification results (2026-09-05)

Measured in a real browser at 1440×900 and 390×844 against the dev server, not inferred
from a passing build.

| `--p` | `--beat-exit` | hero copy opacity | photo scale |
| --- | --- | --- | --- |
| 0.0000 | 0 | 1 | 1.0800 |
| 0.1060 | 0 | 1 | 1.0687 |
| 0.3553 | 0 | 1 | 1.0421 |
| 0.6060 | 0.1244 | 0.8756 | 1.0154 |
| 1.0000 | 1 | 1.11e-16 | 1.0000 |

`--p` first reaches 1.0 at scrollY 805px, at which point the sticky stage still fills the
viewport (top −6.1px, bottom 990.9px of 997px) — so the copy finishes leaving while the
visitor is still looking at the hero, which is the intent.

The no-JavaScript contract was proven from the served bytes rather than by toggling
DevTools: `curl` of `/en`, `/zh` and `/ms` returns HTML already containing the headline,
the starter-kitchen price, the room headings and the FAQ text, and containing neither
`data-beats="on"` nor `data-reveal-armed` — both of which only a mounted island's effect
sets. Reduced motion and a 800px viewport were each confirmed to leave `data-beats` unset.
Zero console errors.

**One defect was found here and fixed** (`409765d`): the hero copy originally faded IN over
the first 30% of the track, so at rest the LCP headline computed to `opacity: 0`. That is
the same blank-headline failure the no-JavaScript contract exists to prevent, arriving one
frame later with JavaScript enabled. The choreography was inverted — the copy now starts
resolved and departs — and the `var(--p, …)` fallbacks now differ per beat so that an
unknown progress value always renders the readable state.

**A second was found by the final review** (`2d011bc`): the `1.7 × 100svh` track height was
unconditional while the motion was gated, giving a 390×844 phone 591px of pinned hero in
which nothing happened. The height now lives in CSS behind the same breakpoint and
reduced-motion conditions as the JavaScript gate.

### Known follow-ups, deliberately not done

- **No scroll cue.** A decorative `aria-hidden` chevron would be new geometry rather than a
  new string, so it does not violate the no-new-strings constraint. It is left out as a
  design decision for EzCabinet rather than one to make inside a motion task.
- **`viewports={1.7}`** buys ~630px of desktop runway whose first 55% holds the copy still.
  That hold is intentional; the number is worth tuning on a real screen with the client.
- **`svh` vs `innerHeight`.** The layout is sized in `svh` while `trackProgress` is fed
  `innerHeight`. They diverge only where mobile browser chrome moves, and no viewport under
  900px is armed today. Anyone lowering that gate must reconcile them first.
