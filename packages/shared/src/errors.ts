/**
 * Render an unknown thrown value as a human-readable message.
 *
 * The non-Error branch matters more than it looks. The AI SDK emits arbitrary
 * objects on `fullStream` error events (e.g. `{ statusCode: 403 }` for a Bedrock
 * AccessDeniedException) rather than Error instances, and those values flow all
 * the way out through `/v1/responses` to external clients. A naive `String(err)`
 * renders `"[object Object]"` and a naive fallback renders `"Unknown error"` —
 * both destroy the only diagnostic the provider gave us. Polytoken surfaced
 * exactly that: `provider error server_error: [object Object]`.
 *
 * So: pull a message off the common carrier shapes first, then fall back to a
 * JSON projection, and only use `fallback` when there is genuinely nothing to
 * say.
 */
export function formatError(error: unknown, fallback = "Unknown error"): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error === null || error === undefined) return fallback;
	if (typeof error !== "object") return String(error);

	const e = error as Record<string, unknown>;

	// Nested carriers, in the order providers actually use them. `error` is the
	// OpenAI/JSON-API envelope; `cause` is the standard Error option bag.
	for (const key of ["message", "error_description", "detail", "reason"]) {
		const v = e[key];
		if (typeof v === "string" && v.length > 0) return withStatus(v, e);
	}
	for (const key of ["error", "cause"]) {
		const nested = e[key];
		if (nested !== undefined && nested !== error) {
			const inner = formatError(nested, "");
			if (inner) return withStatus(inner, e);
		}
	}

	// No message anywhere — project the object so a status code or error name at
	// least reaches the operator instead of "[object Object]".
	try {
		const json = JSON.stringify(error);
		if (json && json !== "{}") return json;
	} catch {
		// Circular or non-serializable — fall through.
	}

	const status = statusOf(e);
	if (status !== undefined) return `HTTP ${status}`;
	return fallback;
}

/**
 * Prefix a status code onto a message when the carrier has one and the message
 * doesn't already mention it. A bare "Access denied" is much less actionable
 * than "HTTP 403: Access denied".
 */
function withStatus(message: string, e: Record<string, unknown>): string {
	const status = statusOf(e);
	if (status === undefined) return message;
	if (message.includes(String(status))) return message;
	return `HTTP ${status}: ${message}`;
}

function statusOf(e: Record<string, unknown>): number | undefined {
	const direct = e.statusCode ?? e.status;
	if (typeof direct === "number") return direct;
	const meta = e.$metadata;
	if (meta && typeof meta === "object") {
		const code = (meta as Record<string, unknown>).httpStatusCode;
		if (typeof code === "number") return code;
	}
	return undefined;
}
