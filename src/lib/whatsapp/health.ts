import "server-only";
import { CarrierHttpError, carrierFetch } from "@/lib/logistics/http";
import { classify, GRAPH, whatsappConfigured } from "./send";
import { LANGUAGE } from "./templates";

/**
 * Can the next order's acknowledgement actually go out?
 *
 * Checked from the cron, never at checkout: a Meta outage must not block a
 * sale, and the outbox already holds the message. This exists so a dead token
 * or an unapproved template reaches us before a customer notices the silence.
 *
 * Two reads, both free: the phone number (proves the token and the number
 * together) and `order_placed` (the one message every order sends).
 */
const TEMPLATE = "order_placed";

export type Health = { ok: true } | { ok: false; reason: string };

type TemplateRow = { name: string; status: string; language: string };

async function metaGet<T>(path: string): Promise<T> {
	return carrierFetch<T>(`${GRAPH}/${path}`, {
		carrierId: "whatsapp",
		headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
	});
}

const failure = (error: unknown): string =>
	error instanceof CarrierHttpError
		? classify(error.status, error.body).error
		: (error as Error).message;

export async function checkHealth(): Promise<Health> {
	try {
		await metaGet(
			`${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number`,
		);
	} catch (error) {
		return { ok: false, reason: `token or phone number: ${failure(error)}` };
	}

	const account = process.env.WHATSAPP_WABA_ID;
	if (!account) return { ok: false, reason: "WHATSAPP_WABA_ID is not set" };

	let rows: TemplateRow[];
	try {
		const response = await metaGet<{ data?: TemplateRow[] }>(
			`${account}/message_templates?name=${TEMPLATE}&fields=name,status,language`,
		);
		// Meta's `name` filter matches substrings; `order_placed_v2` is not ours.
		rows = (response?.data ?? []).filter((row) => row.name === TEMPLATE);
	} catch (error) {
		return { ok: false, reason: `templates: ${failure(error)}` };
	}

	for (const language of Object.values(LANGUAGE)) {
		const status = rows.find((row) => row.language === language)?.status;
		if (status !== "APPROVED") {
			return {
				ok: false,
				reason: `${TEMPLATE} (${language}) is ${status ?? "missing"}`,
			};
		}
	}
	return { ok: true };
}

/**
 * The cron's hook: check once an hour and log a line the Vercel log alert
 * matches on (`"type":"WHATSAPP_`). Never throws — a failed check must not
 * stop the delivery polls it rides with.
 */
export async function reportHealth(now = new Date()): Promise<void> {
	// The cron runs every 10 minutes; only the first run of each hour asks Meta.
	if (now.getUTCMinutes() >= 10) return;
	if (!whatsappConfigured()) {
		// Preview and local run without a token on purpose.
		if (process.env.VERCEL_ENV === "production") {
			console.error(JSON.stringify({ type: "WHATSAPP_UNCONFIGURED" }));
		}
		return;
	}
	const health = await checkHealth().catch(
		(error): Health => ({ ok: false, reason: (error as Error).message }),
	);
	if (!health.ok) {
		console.error(
			JSON.stringify({ type: "WHATSAPP_UNHEALTHY", reason: health.reason }),
		);
	}
}
