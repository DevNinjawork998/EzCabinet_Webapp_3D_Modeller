/**
 * The one reader of AUTH_ENABLED.
 *
 * Off, the admin surface opens and checkout accepts an anonymous order —
 * today's behaviour minus the password prompt, so the planner can be worked on
 * without signing in.
 *
 * The production guard is not a convenience. A misdeployed environment
 * variable must not be able to unlock the admin surface or the orders API, so
 * on any Vercel deployment the flag is not consulted at all — preview
 * included, since a preview is a public URL holding real carrier credentials.
 * Local development only.
 *
 * Only the exact string "false" disables it: a flag that also answered to "0",
 * "no" or "off" has more ways to be switched off by accident than on purpose.
 */
export function authEnabled(): boolean {
	if (process.env.VERCEL_ENV) return true;
	return process.env.AUTH_ENABLED !== "false";
}
