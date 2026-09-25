/**
 * The one outbound HTTP helper the carrier adapters share.
 *
 * The app had none — Mux ships its own SDK and everything else is same-origin.
 * A logistics partner is the first third party we call by hand, and calling it
 * with a bare `fetch` means no timeout, which on Vercel means the function
 * hangs until the platform kills it at 30s and the admin sees nothing.
 */

import { LABEL } from "./carriers";
import { trace } from "./trace";

const TIMEOUT_MS = 10_000;

const nameOf = (carrierId: string) => LABEL[carrierId] ?? carrierId;

/**
 * The carrier's own sentence out of an error body, or null.
 *
 * Only a plain sentence: a bare code (`ERR_INVALID_SERVICE_TYPE`) or anything
 * that looks like more JSON explains nothing to an admin. The whole body stays
 * on `.body` and in the `LOGISTICS_DEBUG` trace for whoever debugs it.
 */
export function carrierSaid(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const first = Array.isArray(record.errors) ? record.errors[0] : undefined;
	for (const source of [first, record]) {
		if (typeof source !== "object" || source === null) continue;
		const fields = source as Record<string, unknown>;
		for (const key of [
			"message",
			"error_description",
			"Message",
			"detail",
			"error",
		]) {
			const value = fields[key];
			if (
				typeof value === "string" &&
				value.trim() !== "" &&
				value.length <= 160 &&
				!/[{[<]/.test(value)
			) {
				return value.trim();
			}
		}
	}
	return null;
}

/**
 * A carrier answered, and not with what we asked for.
 *
 * `.message` is what an admin reads — on a comparison row, a booking error, the
 * activity log — so it is a sentence, never the payload. It used to carry the
 * first 300 characters of the body, which put raw JSON on screen. The body is
 * still on `.body` and in the trace; the adapters branch on `.status`.
 */
export class CarrierHttpError extends Error {
	constructor(
		readonly carrierId: string,
		readonly status: number,
		readonly body: string,
	) {
		const name = nameOf(carrierId);
		const said = carrierSaid(body);
		super(
			status === 401 || status === 403
				? `${name} refused our sign-in — the credentials on this deployment need checking.`
				: status === 429
					? `${name} is getting too many requests from us — try again in a minute.`
					: status >= 500
						? `${name} is having problems on their side — try again in a few minutes.`
						: status < 400
							? `${name} sent back a reply we could not read — try again shortly.`
							: said === null
								? `${name} turned this request down.`
								: `${name} turned this request down. They said: "${said}"`,
		);
		this.name = "CarrierHttpError";
	}
}

/** The carrier never answered: a timeout or a dropped connection. */
export class CarrierUnreachable extends Error {
	constructor(carrierId: string, cause: unknown) {
		const name = nameOf(carrierId);
		const timedOut =
			cause instanceof Error &&
			(cause.name === "TimeoutError" || cause.name === "AbortError");
		super(
			timedOut
				? `${name} did not answer within ${TIMEOUT_MS / 1000} seconds — try again.`
				: `Could not reach ${name} — try again in a moment.`,
			{ cause },
		);
		this.name = "CarrierUnreachable";
	}
}

type Options = {
	carrierId: string;
	method?: "GET" | "POST" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	/**
	 * An object is serialised; a string is sent byte for byte. The string form
	 * exists for signed APIs — an HMAC is computed over exactly what goes on
	 * the wire, and re-serialising here would sign something else.
	 */
	body?: unknown;
	/**
	 * Whether this call is safe to send twice. Quotes and tracking reads are;
	 * **booking is not** — a retried booking buys a second lorry. Defaults to
	 * false so a new adapter has to opt in rather than forget to opt out.
	 */
	idempotent?: boolean;
	/**
	 * The request body and the response body both carry a live credential, not
	 * just a field named like one — `trace`'s redaction works by key name, and
	 * `body`/`text` are not credential-shaped keys, so an OAuth token exchange
	 * would otherwise write a working access and refresh token into the log the
	 * moment an admin turns on `LOGISTICS_DEBUG` to see why a carrier call is
	 * failing. Set on the EasyParcel and FedEx token calls only: every other
	 * carrier body is the main debugging tool for a refused quote and must
	 * stay visible.
	 */
	sensitive?: boolean;
};

/** JSON in, JSON out. Non-2xx throws with the body attached for the event log. */
export async function carrierFetch<T>(
	url: string,
	options: Options,
): Promise<T> {
	const {
		carrierId,
		method = "GET",
		headers = {},
		body,
		idempotent,
		sensitive,
	} = options;

	// One retry, only for calls that can safely be sent twice, and only for the
	// failures a retry can fix: a dropped connection or the carrier's own 5xx.
	// A 4xx is our payload being wrong and will be wrong again.
	const attempts = idempotent ? 2 : 1;
	let lastError: unknown;

	for (let attempt = 0; attempt < attempts; attempt++) {
		const sent =
			body === undefined
				? undefined
				: typeof body === "string"
					? body
					: JSON.stringify(body);
		const startedAt = Date.now();
		trace("request", {
			carrierId,
			method,
			url,
			headers,
			body: sensitive ? "[redacted]" : sent,
			attempt,
		});

		try {
			const response = await fetch(url, {
				method,
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					...headers,
				},
				body: sent,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});

			// Read once, whatever the status. The success path used to go straight
			// to `.json()`, which meant a 200 carrying something unexpected was
			// invisible — the parse threw with nothing to show for it.
			const text = await response.text().catch(() => "");
			trace("response", {
				carrierId,
				url,
				status: response.status,
				ms: Date.now() - startedAt,
				body: sensitive ? "[redacted]" : text,
			});

			if (!response.ok) {
				const error = new CarrierHttpError(carrierId, response.status, text);
				if (response.status >= 500 && attempt < attempts - 1) {
					lastError = error;
					continue;
				}
				throw error;
			}

			// A 204, or any 2xx with an empty body, is a success with nothing to
			// say — Lalamove's `DELETE /v3/orders/{id}` answers that way. Parsing
			// "" threw, so an order that really had been cancelled reached the
			// admin as "lalamove responded 204" and the row stayed booked.
			if (text.trim() === "") return undefined as T;

			try {
				return JSON.parse(text) as T;
			} catch {
				// A 2xx that is not JSON is the carrier's contract breaking, and the
				// body is the only thing that explains it.
				throw new CarrierHttpError(carrierId, response.status, text);
			}
		} catch (error) {
			if (!(error instanceof CarrierHttpError)) {
				trace("failed", {
					carrierId,
					url,
					ms: Date.now() - startedAt,
					error,
				});
			}
			// A CarrierHttpError here is a 4xx, or a 5xx on the final attempt.
			if (error instanceof CarrierHttpError) throw error;
			lastError = new CarrierUnreachable(carrierId, error);
			if (attempt === attempts - 1) throw lastError;
		}
	}

	throw lastError;
}
