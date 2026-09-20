/**
 * `next` is attacker-controllable. A prefix check is not enough — the URL
 * parser treats a backslash as a path separator for http(s), so `/\evil.com`
 * normalises to a different origin while looking like an absolute path.
 * Resolve it and compare origins rather than trying to enumerate escapes.
 */
export function safeNext(raw: string | null, origin: string): string {
	const fallback = "/admin/cabinet-designs";
	if (!raw) return fallback;
	try {
		const url = new URL(raw, origin);
		if (url.origin !== origin) return fallback;
		return url.pathname + url.search + url.hash;
	} catch {
		return fallback;
	}
}
