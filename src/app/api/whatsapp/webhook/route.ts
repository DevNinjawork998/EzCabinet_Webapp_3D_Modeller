import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { secretsMatch } from "@/lib/secretsMatch";
import { autoReply } from "@/lib/whatsapp/outbox";
import {
	parseWebhook,
	signatureValid,
	statusAdvances,
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

	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return NextResponse.json({ error: "invalid_body" }, { status: 400 });
	}
	const { statuses, senders } = parseWebhook(body);

	for (const update of statuses) {
		const row = await prisma.notification.findUnique({
			where: { metaMessageId: update.messageId },
			select: { id: true, status: true },
		});
		if (!row || !statusAdvances(row.status, update.status)) continue;
		await prisma.notification.update({
			where: { id: row.id },
			data: {
				status: update.status,
				...(update.error ? { lastError: update.error } : {}),
			},
		});
	}

	for (const phone of senders) await autoReply(phone);

	// 200 whatever we did with it — Meta retries anything else for days.
	return NextResponse.json({ ok: true });
}
