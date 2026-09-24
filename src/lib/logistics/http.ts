/**
 * The one outbound HTTP helper the carrier adapters share.
 *
 * The app had none — Mux ships its own SDK and everything else is same-origin.
 * A logistics partner is the first third party we call by hand, and calling it
 * with a bare `fetch` means no timeout, which on Vercel means the function
 * hangs until the platform kills it at 30s and the admin sees nothing.
 */

import { trace } from "./trace";

/**
 * How much of the carrier's reply goes in the message.
 *
 * The whole body is kept on `.body` for the event log; the message is what an
 * admin reads on a comparison row, and Lalamove puts the part that matters —
 * `ERR_INVALID_SERVICE_TYPE`, a field name — in the first line.
 */
const DETAIL_CHARS = 300;

export class CarrierHttpError extends Error {
	constructor(
		readonly carrierId: string,
		readonly status: number,
		readonly body: string,
	) {
		// The status alone was all this said for a while, and `.body` was on the
		// object but read by nobody — so a partner explaining exactly what was
		// wrong with our payload reached the admin as "lalamove responded 422".
		const detail = body.trim().slice(0, DETAIL_CHARS);
		super(
			detail === ""
				? `${carrierId} responded ${status}`
				: `${carrierId} responded ${status}: ${detail}`,
		);
		this.name = "CarrierHttpError";
	}
}

const TIMEOUT_MS = 10_000;

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
			lastError = error;
			if (attempt === attempts - 1) throw error;
		}
	}

	throw lastError;
}
