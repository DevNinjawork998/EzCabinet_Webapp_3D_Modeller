import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Does a caller-supplied secret match the one we expect?
 *
 * Constant-time, and length-safe — `timingSafeEqual` throws on a length
 * mismatch. An empty expected secret never matches: an unset environment
 * variable reads as `""`, and `""` equals `""`, so without that guard a
 * missing key would accept every caller who also sends nothing.
 */
export function secretsMatch(given: string, expected: string): boolean {
	if (expected === "") return false;
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}
