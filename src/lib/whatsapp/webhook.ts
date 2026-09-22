import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { NotificationStatus } from "@/generated/prisma/enums";
import { secretsMatch } from "@/lib/secretsMatch";

/**
 * Meta's webhook: who sent it, what it says.
 *
 * Unlike EasyParcel (Known issue 3), Meta signs every POST — an HMAC-SHA256
 * of the raw body with the app secret — so this is a real check.
 */
export function signatureValid(
	raw: string,
	header: string | null,
	secret: string,
): boolean {
	if (header === null || secret === "") return false;
	const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
	return secretsMatch(header, expected);
}

const payloadSchema = z.object({
	entry: z.array(
		z.object({
			changes: z.array(
				z.object({
					value: z.object({
						statuses: z
							.array(
								z.object({
									id: z.string(),
									status: z.string(),
									errors: z
										.array(
											z.object({
												code: z.number().optional(),
												title: z.string().optional(),
											}),
										)
										.optional(),
								}),
							)
							.optional(),
						messages: z.array(z.object({ from: z.string() })).optional(),
					}),
				}),
			),
		}),
	),
});

const TRACKED = {
	sent: "SENT",
	delivered: "DELIVERED",
	read: "READ",
	failed: "FAILED",
} as const;

export function parseWebhook(body: unknown): {
	statuses: {
		messageId: string;
		status: (typeof TRACKED)[keyof typeof TRACKED];
		error: string | null;
	}[];
	senders: string[];
} {
	const parsed = payloadSchema.safeParse(body);
	if (!parsed.success) return { statuses: [], senders: [] };
	const values = parsed.data.entry.flatMap((e) =>
		e.changes.map((c) => c.value),
	);

	const statuses = values.flatMap((value) =>
		(value.statuses ?? []).flatMap((s) => {
			const status = TRACKED[s.status as keyof typeof TRACKED];
			if (!status) return [];
			const first = s.errors?.[0];
			return [
				{
					messageId: s.id,
					status,
					error: first ? `${first.code ?? "?"}: ${first.title ?? ""}` : null,
				},
			];
		}),
	);
	const senders = [
		...new Set(
			values.flatMap((value) =>
				(value.messages ?? []).map((m) => `+${m.from}`),
			),
		),
	];
	return { statuses, senders };
}

const RANK: Record<NotificationStatus, number> = {
	PENDING: 0,
	SENT: 1,
	DELIVERED: 2,
	READ: 3,
	FAILED: -1,
};

/**
 * Meta's callbacks arrive out of order. A status only moves forward, and a
 * failure only lands on a message not yet delivered.
 */
export function statusAdvances(
	current: NotificationStatus,
	incoming: NotificationStatus,
): boolean {
	if (current === "FAILED") return false;
	if (incoming === "FAILED") return RANK[current] < RANK.DELIVERED;
	return RANK[incoming] > RANK[current];
}
