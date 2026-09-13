import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

export default nextConfig;
