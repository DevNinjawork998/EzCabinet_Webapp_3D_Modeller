/**
 * Customer-journey telemetry: PostHog Cloud EU, reached through `/api/ph`.
 *
 * Client-only and lazy. `posthog-js` is imported on idle, never on the LCP
 * path, and nothing here touches `window` at module scope — components that
 * call it are also rendered on the server, where every call is a no-op.
 *
 * Consent (PDPA): until the visitor chooses, capture runs cookieless — no
 * cookies, no storage, a per-day server-side hash, no replay. That is
 * `opt_out_capturing_by_default` plus `cookieless_mode: "on_reject"`: without
 * the first, "pending" would capture *with* cookies. Accepting opts in to
 * cookies and the error-triggered replay configured in the PostHog project.
 *
 * Never pass form fields. Nothing a customer types belongs in an event.
 */
import type { PostHog } from "posthog-js";

export type JourneyEvent =
	| "screen_viewed"
	| "room_picked"
	| "planner_started"
	| "room_shape_changed"
	| "cabinet_added"
	| "cabinet_removed"
	| "cabinet_resized"
	| "cabinet_replaced"
	| "finish_changed"
	| "door_style_changed"
	| "doors_toggled"
	| "view_changed"
	| "tool_used"
	| "quote_viewed"
	| "quote_submitted";

type Props = Record<string, string | number | boolean | null>;

let client: Promise<PostHog | null> | undefined;

function load(): Promise<PostHog | null> {
	const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
	if (typeof window === "undefined" || !token) return Promise.resolve(null);
	client ??= new Promise<void>((resolve) => {
		if ("requestIdleCallback" in window) {
			window.requestIdleCallback(() => resolve(), { timeout: 3000 });
		} else {
			setTimeout(resolve, 1);
		}
	})
		.then(() => import("posthog-js"))
		.then(({ default: posthog }) => {
			posthog.init(token, {
				// The rewrites in next.config.ts point at the EU region. A project
				// created in US would need both changed — the region is fixed at
				// install, so this is not read from NEXT_PUBLIC_POSTHOG_HOST.
				api_host: "/api/ph",
				ui_host: "https://eu.posthog.com",
				defaults: "2026-05-30",
				// A 3D canvas turns every pointer move into a click candidate;
				// explicit journey events make cleaner funnels.
				autocapture: false,
				capture_pageview: "history_change",
				capture_exceptions: true,
				person_profiles: "identified_only",
				cookieless_mode: "on_reject",
				opt_out_capturing_by_default: true,
				session_recording: { maskAllInputs: true },
				disable_surveys: true,
			});
			return posthog;
		})
		// Blocked script, offline, bad deploy: telemetry must never break the
		// planner, so a failed load is just silence.
		.catch(() => null);
	return client;
}

export function track(event: JourneyEvent, props?: Props): void {
	void load().then((posthog) => posthog?.capture(event, props));
}

/** For failures that are handled — and therefore never reach autocapture. */
export function captureError(error: unknown, context?: Props): void {
	void load().then((posthog) => posthog?.captureException(error, context));
}

/** `null` when analytics is not running at all (server, no token, blocked). */
export async function consentStatus(): Promise<
	"granted" | "denied" | "pending" | null
> {
	return (await load())?.get_explicit_consent_status() ?? null;
}

export function setConsent(granted: boolean): void {
	void load().then((posthog) =>
		granted ? posthog?.opt_in_capturing() : posthog?.opt_out_capturing(),
	);
}
