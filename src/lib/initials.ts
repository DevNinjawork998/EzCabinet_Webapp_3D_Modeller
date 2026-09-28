/** Up to two letters for an avatar: first and last word of the name, else the email. */
export function initialsOf(
	name: string | null | undefined,
	email: string,
): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return email.charAt(0).toUpperCase();
	const first = words[0].charAt(0);
	const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
	return (first + last).toUpperCase();
}
