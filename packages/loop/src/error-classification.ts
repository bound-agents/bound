import { LLMError } from "@bound/llm";

/**
 * Determines whether an LLM error is a transient transport issue worth retrying.
 * Returns false for client errors (4xx except 429) — these indicate a malformed
 * request that will fail identically on retry.
 */
export function isTransientLLMError(error: unknown): boolean {
	const errMsg = error instanceof Error ? error.message : String(error);

	// If we have a status code, use it as the primary signal.
	// 4xx errors (except 429 rate-limit) are client errors — not transient.
	if (error instanceof LLMError && error.statusCode !== undefined) {
		if (error.statusCode === 429) return false; // handled separately by rate-limit logic
		if (error.statusCode >= 400 && error.statusCode < 500) return false;
		// 5xx is a server fault, not a client error — the textbook transient case.
		// bedrock-mantle intermittently 500s mid-stream (server_error); the bridge
		// throws it as a 5xx LLMError (commit eda6ce6b). Retry (with backoff at the
		// call site) clears the intermittent blip — verified via probe (4/6 cold
		// attempts succeeded). withEmptyRetry already proved instant no-backoff
		// retry of this same fault does NOT clear it, so the retry path must wait.
		if (error.statusCode >= 500) return true;
	}

	// Pattern-match on known transient transport error messages.
	// "timed out" (two words) catches the runtime fetch transport's own
	// ~300s ceiling, which fires below the AI SDK and wraps as a TimeoutError
	// ("The operation timed out") with no HTTP status — a connection that
	// times out with no response is transient. Deliberately NOT "timeout"
	// (one word): message-handler's 35-min inactivity abort uses "LLM
	// response timeout" and must surface as a genuine stall, not retry.
	return (
		errMsg.includes("http2") ||
		errMsg.includes("ECONNRESET") ||
		errMsg.includes("socket hang up") ||
		// undici's message when the TCP socket drops mid-request without a
		// response — fires on z.ai and other streaming endpoints that hold
		// connections open for long completions. Distinct from "socket hang
		// up" (node http) and ECONNRESET (raw TCP reset).
		errMsg.includes("socket connection was closed") ||
		errMsg.includes("timed out") ||
		errMsg.includes("ETIMEDOUT")
	);
}

export function getLlmStatusCode(error: unknown): number | undefined {
	return typeof error === "object" && error !== null && "statusCode" in error
		? (error as { statusCode?: number }).statusCode
		: undefined;
}

export function getLlmRetryAfterMs(error: unknown): number | undefined {
	return typeof error === "object" && error !== null && "retryAfterMs" in error
		? (error as { retryAfterMs?: number }).retryAfterMs
		: undefined;
}

export function isQuotaCapMessage(message: string): boolean {
	return /\b(quota|usage limit|payment|billing|credits?)\b/i.test(message);
}

/**
 * Whether an error denotes a rate-limit / quota / payment condition that should
 * trigger a backend-fallback path rather than a plain transport retry. Mirrors
 * the inline check the Bound adapter previously carried: explicit 429/529/402
 * status codes, or — when no status is present — a message that reads as a quota
 * or billing cap.
 */
export function isRateLimitStatus(statusCode: number | undefined, message: string): boolean {
	return (
		statusCode === 429 ||
		statusCode === 529 ||
		statusCode === 402 ||
		(statusCode === undefined && isQuotaCapMessage(message))
	);
}
