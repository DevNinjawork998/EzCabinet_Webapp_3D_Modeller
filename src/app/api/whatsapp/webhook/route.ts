import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { secretsMatch } from "@/lib/secretsMatch";
import { autoReply } from "@/lib/whatsapp/outbox";
import {
	parseWebhook,
	signatureValid,
	statusesBefore,
} from "@/lib/whatsapp/webhook";

export const runtime = "nodejs";

/**
 * Meta's WhatsApp webhook. Public prefix — `proxy.ts` gates only `/admin` —
 * so it authenticates itself: the verify token on the subscription handshake,
 * the app-secret signature on every event.
 */

/** Subscription handshake: echo the challenge when the token is ours. */
export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const ok =
		params.get("hub.mode") === "subscribe" &&
		secretsMatch(
			params.get("hub.verify_token") ?? "",
			process.env.WHATSAPP_VERIFY_TOKEN ?? "",
		);
	return ok
		? new Response(params.get("hub.challenge") ?? "", { status: 200 })
		: NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function POST(request: Request) {
	// Raw text, not .json(): the signature is over the exact bytes Meta sent.
	const raw = await request.text();
	if (
		!signatureValid(
			raw,
			request.headers.get("x-hub-signature-256"),
			process.env.WHATSAPP_APP_SECRET ?? "",
		)
	) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	// A verified payload always gets 200: Meta retries anything else for days,
	// and a malformed or partially-failing payload is our problem, not theirs
	// to keep resending.
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch (error) {
		logItemFailure("invalid_json", error);
		return NextResponse.json({ ok: true });
	}
	const { statuses, senders } = parseWebhook(body);

	for (const update of statuses) {
		try {
			// The advance check is part of the write, not a read-then-write:
			// Meta can send `delivered` and `read` as concurrent POSTs, and two
			// in-memory checks against the same stale read can both pass.
			await prisma.notification.updateMany({
				where: {
					metaMessageId: update.messageId,
					status: { in: statusesBefore(update.status) },
				},
				data: {
					status: update.status,
					...(update.error ? { lastError: update.error } : {}),
				},
			});
		} catch (error) {
			logItemFailure("status_update", error, update.messageId);
		}
	}

	for (const phone of senders) {
		try {
			await autoReply(phone);
		} catch (error) {
			logItemFailure("auto_reply", error, maskPhone(phone));
		}
	}

	return NextResponse.json({ ok: true });
}

/** Never log a customer's full number — only enough to find the row. */
function maskPhone(phone: string): string {
	return `…${phone.slice(-4)}`;
}

function logItemFailure(step: string, error: unknown, ref?: string): void {
	console.error(
		JSON.stringify({
			type: "WHATSAPP_WEBHOOK_ITEM_FAILED",
			step,
			ref,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
}
