import "server-only";
import { after } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/catalogue/db";
import { getDictionary } from "@/lib/copy/dictionary";
import { fill } from "@/lib/copy/fill";
import { nextState, sendMessage, whatsappConfigured } from "./send";
import {
	localeOf,
	type NotificationDraft,
	type TemplateVars,
	templatePayload,
	textPayload,
} from "./templates";

/**
 * The WhatsApp outbox.
 *
 * A trigger calls `enqueue` inside the transaction that changes the state it
 * reports, so "the order is paid" and "the customer must be told" commit
 * together. `flushSoon` sends after the response; the tracking cron calls
 * `flush()` to retry whatever is still pending.
 */

const EXPIRE_MS = 48 * 60 * 60 * 1000;
const SETTLE_MS = 60 * 1000;
const MAX_PER_RUN = 50;
const AUTO_REPLY_EVERY_MS = 24 * 60 * 60 * 1000;

/** Insert the drafts that are not null; a repeated `dedupeKey` is skipped. */
export async function enqueue(
	tx: Prisma.TransactionClient,
	drafts: (NotificationDraft | null)[],
): Promise<string[]> {
	const data = drafts
		.filter((draft): draft is NotificationDraft => draft !== null)
		.map((draft) => ({ ...draft, vars: draft.vars as never }));
	if (data.length === 0) return [];
	const rows = await tx.notification.createManyAndReturn({
		data,
		skipDuplicates: true,
		select: { id: true },
	});
	return rows.map((row) => row.id);
}

/**
 * Send pending rows: the given ids, or — from the cron — everything pending
 * that nobody has touched for a minute.
 *
 * Each row is claimed by bumping `attempts` conditionally before it is sent,
 * so the post-response flush and a cron run cannot both send it. The cron's
 * one-minute settle keeps it off rows a request is still flushing.
 */
export async function flush(
	ids?: string[],
): Promise<{ sent: number; failed: number }> {
	if (!whatsappConfigured()) {
		// Local dev and preview: rows wait indefinitely — the 48 h expiry sweep
		// below never runs while the token is unset, so nothing is marked failed
		// until a token is present and a flush actually happens. Never a throw —
		// a missing token must not break checkout.
		if (ids?.length) console.warn("WHATSAPP_TOKEN unset; message left pending");
		return { sent: 0, failed: 0 };
	}

	const now = Date.now();
	await prisma.notification.updateMany({
		where: { status: "PENDING", queuedAt: { lt: new Date(now - EXPIRE_MS) } },
		data: { status: "FAILED", lastError: "expired" },
	});

	const rows = await prisma.notification.findMany({
		where: ids
			? { id: { in: ids }, status: "PENDING" }
			: { status: "PENDING", updatedAt: { lt: new Date(now - SETTLE_MS) } },
		orderBy: { queuedAt: "asc" },
		take: MAX_PER_RUN,
	});

	let sent = 0;
	let failed = 0;
	// ponytail: a send that succeeds and is then followed by a failed DB update
	// (the `notification.update` below) leaves the row PENDING with `attempts`
	// already bumped, so the next flush re-sends it — at-least-once, not
	// exactly-once. Fine for a template message; upgrade to a two-phase claim
	// (mark SENDING before the API call, verify before re-sending) if a
	// duplicate WhatsApp message ever matters.
	for (const row of rows) {
		const claimed = await prisma.notification.updateMany({
			where: { id: row.id, status: "PENDING", attempts: row.attempts },
			data: { attempts: { increment: 1 } },
		});
		if (claimed.count === 0) continue;

		const result = await sendMessage(
			templatePayload(
				row.to,
				row.template,
				localeOf(row.locale),
				row.vars as unknown as TemplateVars,
			),
		);
		await prisma.notification.update({
			where: { id: row.id },
			data: nextState(result, row.attempts + 1, new Date()),
		});
		if (result.ok) {
			sent++;
		} else {
			failed++;
			console.error(
				JSON.stringify({
					type: "WHATSAPP_SEND_FAILED",
					notificationId: row.id,
					retryable: result.retryable,
					message: result.error,
				}),
			);
		}
	}
	return { sent, failed };
}

/** Send these rows once the response is on its way. */
export function flushSoon(ids: string[]): void {
	if (ids.length === 0) return;
	after(() =>
		flush(ids).catch((error) =>
			console.error("WhatsApp flush failed", (error as Error).message),
		),
	);
}

/**
 * Answer someone who wrote to the updates number, at most once a day.
 *
 * Free-form text is allowed here because the customer just opened the 24 h
 * window. What they wrote is not stored — nothing reads it.
 *
 * ponytail: read-then-write throttle; two messages in the same instant can
 * both be answered. Harmless at this volume.
 */
export async function autoReply(phone: string): Promise<void> {
	const sales = process.env.WHATSAPP_SALES_NUMBER ?? "";
	if (!whatsappConfigured() || sales === "") return;

	const last = await prisma.whatsappAutoReply.findUnique({ where: { phone } });
	if (last && Date.now() - last.repliedAt.getTime() < AUTO_REPLY_EVERY_MS) {
		return;
	}
	const now = new Date();
	await prisma.whatsappAutoReply.upsert({
		where: { phone },
		create: { phone, repliedAt: now },
		update: { repliedAt: now },
	});

	const order = await prisma.order.findFirst({
		where: { customerPhone: phone },
		orderBy: { createdAt: "desc" },
		select: { locale: true },
	});
	const t = await getDictionary(localeOf(order?.locale ?? "en"));
	const result = await sendMessage(
		textPayload(
			phone,
			fill(t.whatsapp.autoReply, {
				number: `https://wa.me/${sales.replace(/\D/g, "")}`,
			}),
		),
	);
	if (!result.ok) {
		console.error(
			JSON.stringify({
				type: "WHATSAPP_AUTOREPLY_FAILED",
				message: result.error,
			}),
		);
	}
}
