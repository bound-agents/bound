/**
 * Error mapping: unknown AI SDK error → LLMError with best-effort HTTP status.
 */

import { formatError } from "@bound/shared";
import { LLMError } from "../types";

/**
 * Wrap an unknown error from the AI SDK into an LLMError with a best-effort
 * HTTP status code. The ModelRouter relies on statusCode to drive pool
 * backoff (402 / 429 / 5xx). AI SDK errors are tagged classes (APICallError,
 * etc.) — duck-type on .statusCode / .status since we don't want to import
 * every error class.
 */
export function mapError(err: unknown, provider: string): LLMError {
	if (err instanceof LLMError) return err;
	// The AI SDK wraps the final error in a RetryError after exhausting its
	// internal retry budget (default 2 attempts). The RetryError itself carries
	// no statusCode — the HTTP status lives on its .lastError (an APICallError).
	// Unwrap before extracting so 529 Overloaded / 403 AccessDenied etc. survive
	// onto the LLMError and downstream retry logic (isTransientLLMError,
	// isRateLimitStatus) can classify them correctly.
	const source = (err as { lastError?: unknown } | null)?.lastError ?? err;
	const e = source as
		| {
				statusCode?: number;
				status?: number;
				name?: string;
				message?: string;
				$metadata?: { httpStatusCode?: number };
				responseHeaders?: Record<string, string>;
				responseBody?: unknown;
		  }
		| null
		| undefined;
	const statusCode = e?.statusCode ?? e?.status ?? e?.$metadata?.httpStatusCode;
	const retryAfterHeader =
		e?.responseHeaders?.["retry-after"] ?? e?.responseHeaders?.["Retry-After"];
	const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;
	// The AI SDK's APICallError sets `.message` to the bare HTTP status text
	// ("Bad Request") and stashes the provider's actual explanation in
	// `.responseBody` — e.g. the Codex backend's `{"detail":"Store must be set
	// to false"}`. `formatError` returns `err.message` for an Error instance, so
	// without this the useful detail never reaches the caller (and, over the
	// relay, never crosses the wire — only the opaque status text does). Surface
	// the response body when present so a remote inference failure is diagnosable
	// from the requesting host, not just the executing one's logs.
	const responseDetail = formatResponseBody(e?.responseBody);
	const baseMessage = formatError(err);
	const message =
		responseDetail && !baseMessage.includes(responseDetail)
			? `${provider} request failed: ${baseMessage} — ${responseDetail}`
			: `${provider} request failed: ${baseMessage}`;
	return new LLMError(
		message,
		provider,
		statusCode,
		err instanceof Error ? err : new Error(String(err)),
		retryAfterMs,
	);
}

/**
 * Extract a human-readable detail from an AI SDK `APICallError.responseBody`,
 * which is a raw response string (often a JSON envelope like
 * `{"detail":"…"}` or `{"error":{"message":"…"}}`). Returns undefined when
 * there is nothing useful to add.
 */
function formatResponseBody(body: unknown): string | undefined {
	if (typeof body !== "string" || body.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		const detail = formatError(parsed, "");
		if (detail) return detail;
	} catch {
		// Not JSON — fall back to the raw body, trimmed to keep the message bounded.
	}
	const trimmed = body.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function parseRetryAfter(header: string): number | undefined {
	const n = Number(header);
	if (!Number.isNaN(n)) return n * 1000;
	const ts = Date.parse(header);
	if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
	return undefined;
}
