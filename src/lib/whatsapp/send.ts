import "server-only";
import { CarrierHttpError, carrierFetch } from "@/lib/logistics/http";

/**
 * One call to the WhatsApp Cloud API, and what its answer means for the row.
 *
 * Through `carrierFetch` for its timeout and trace, never its retry: sending is
 * not idempotent — a retried send is a second message on the customer's phone —
 * so retrying is the outbox's decision, on the next flush.
 *
 * ponytail: Graph API version pinned. Meta retires a version about two years
 * after release; bump this when the developer dashboard warns.
 */
const GRAPH = "https://graph.facebook.com/v23.0";

export const MAX_ATTEMPTS = 5;

export const whatsappConfigured = (): boolean =>
	Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

export type SendResult =
	| { ok: true; messageId: string }
	| { ok: false; retryable: boolean; error: string };

/**
 * Meta's throttling codes. They come back as HTTP 400, so the status alone
 * would read them as permanent and drop a message that just needed waiting for.
 */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

export function classify(
	status: number,
	body: string,
): { retryable: boolean; error: string } {
	let code: number | undefined;
	let message = body.trim().slice(0, 300);
	try {
		const parsed = JSON.parse(body) as {
			error?: { code?: number; message?: string };
		};
		code = parsed.error?.code;
		message = parsed.error?.message ?? message;
	} catch {
		// Not JSON — the raw body is the explanation.
	}
	return {
		retryable:
			status === 429 ||
			status >= 500 ||
			(code !== undefined && RATE_LIMIT_CODES.has(code)),
		error: `${code ?? status}: ${message}`,
	};
}

export async function sendMessage(payload: object): Promise<SendResult> {
	try {
		const response = await carrierFetch<{ messages?: { id: string }[] }>(
			`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
			{
				carrierId: "whatsapp",
				method: "POST",
				headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
				body: payload,
			},
		);
		const messageId = response?.messages?.[0]?.id;
		return messageId
			? { ok: true, messageId }
			: { ok: false, retryable: false, error: "no message id in response" };
	} catch (error) {
		if (error instanceof CarrierHttpError) {
			return { ok: false, ...classify(error.status, error.body) };
		}
		// Timeout or dropped connection: the message may not have gone. Retrying
		// risks a duplicate; not retrying risks silence. Silence is worse.
		return { ok: false, retryable: true, error: (error as Error).message };
	}
}

/** The row's update after a send attempt; `attempts` already counts this one. */
export function nextState(result: SendResult, attempts: number, now: Date) {
	if (result.ok) {
		return {
			status: "SENT" as const,
			metaMessageId: result.messageId,
			sentAt: now,
			lastError: null,
		};
	}
	if (result.retryable && attempts < MAX_ATTEMPTS) {
		return { lastError: result.error };
	}
	return { status: "FAILED" as const, lastError: result.error };
}
