import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

/**
 * The Content-Security-Policy, in Report-Only until a preview has run the
 * planner, a tutorial video, an admin upload and a label preview with no
 * violations in the console. The third-party hosts are the ones the browser
 * talks to directly: Mux for video and uploads, Blob for admin client uploads.
 * PostHog, Vercel Analytics and BotID are same-origin rewrites. `frame-src`
 * is `https:` because the delivery panel previews a carrier's label, whose
 * host is theirs to choose.
 *
 * `'unsafe-inline'` stays in script-src until nonces are worth making every
 * page dynamic for; dev adds `'unsafe-eval'` for React Refresh.
 */
const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https://image.mux.com",
	"font-src 'self' data:",
	"media-src 'self' blob: https://stream.mux.com",
	"connect-src 'self' https://stream.mux.com https://*.litix.io https://storage.googleapis.com https://vercel.com https://*.blob.vercel-storage.com",
	"worker-src 'self' blob:",
	"frame-src 'self' https:",
	"frame-ancestors 'self'",
	"form-action 'self' https://accounts.google.com",
	"base-uri 'self'",
	"object-src 'none'",
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy-Report-Only", value: csp },
	// Clickjacking: no other site may frame us. SAMEORIGIN, not DENY, because
	// the delivery panel frames our own GDEX label route.
	{ key: "X-Frame-Options", value: "SAMEORIGIN" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=(), payment=()",
	},
	// No `preload`: that is a commitment for every subdomain of the custom
	// domain, which is EzCabinet's call once it exists.
	{
		key: "Strict-Transport-Security",
		value: "max-age=63072000; includeSubDomains",
	},
	// Google sign-in is a redirect, not a popup, so nothing needs an opener.
	{ key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
	poweredByHeader: false,
	async headers() {
		return [{ source: "/:path*", headers: securityHeaders }];
	},
	/**
	 * PostHog (Cloud EU) through our own origin, so ad blockers that drop
	 * `posthog.com` do not undercount exactly the drop-offs we are measuring.
	 * Under `/api/` because that prefix already bypasses both the locale
	 * redirect and the admin gate in `proxy.ts`. See `src/lib/analytics.ts`.
	 */
	async rewrites() {
		return [
			{
				source: "/api/ph/static/:path*",
				destination: "https://eu-assets.i.posthog.com/static/:path*",
			},
			{
				source: "/api/ph/array/:path*",
				destination: "https://eu-assets.i.posthog.com/array/:path*",
			},
			{
				source: "/api/ph/:path*",
				destination: "https://eu.i.posthog.com/:path*",
			},
		];
	},
	// PostHog's ingestion paths end in a slash (`/e/`); a redirect breaks capture.
	skipTrailingSlashRedirect: true,
};

// BotID guards checkout (`/api/orders`) — see `src/instrumentation-client.ts`.
export default withBotId(nextConfig);
