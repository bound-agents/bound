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
		  }
		| null
		| undefined;
	const statusCode = e?.statusCode ?? e?.status ?? e?.$metadata?.httpStatusCode;
	const retryAfterHeader =
		e?.responseHeaders?.["retry-after"] ?? e?.responseHeaders?.["Retry-After"];
	const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;
	return new LLMError(
		`${provider} request failed: ${formatError(err)}`,
		provider,
		statusCode,
		err instanceof Error ? err : new Error(String(err)),
		retryAfterMs,
	);
}

function parseRetryAfter(header: string): number | undefined {
	const n = Number(header);
	if (!Number.isNaN(n)) return n * 1000;
	const ts = Date.parse(header);
	if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
	return undefined;
}
