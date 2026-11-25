import { LLMError, LLMRefusalError } from "@bound/llm";

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

/**
 * The classification of a route failure, aligned with `RouteErrorKind` in
 * `@bound/llm` route-health. This is the single live classifier the agent loop
 * feeds into `recordRouteFailure` so route health reacts to EVERY terminal model
 * error — not only the 429/529 rate-limit path (#285, spec §6.1, R-RT11/R-RT13).
 *
 * Partition (by HTTP status first, message second):
 * - `rate_limit` — 429 / 529 / 402, or (no status) a quota/billing-cap message.
 *   402 is a payment/credit cap, which backs off like a rate limit rather than a
 *   generic server fault.
 * - `auth`       — 401 / 403. The loop attempts a token refresh before backing
 *   off and only advises the operator when refresh fails (R-RT13).
 * - `driver_bug` — any other 400. A refusal 400 is classified upstream as a model
 *   refusal (R-RT15) and never reaches route health, so a 400 arriving here is a
 *   malformed-request/driver bug: back off and raise a single advisory while
 *   half-open recovery keeps running (R-RT13).
 * - `transport`  — no HTTP status but a known transient transport signature
 *   (socket reset, TLS/DNS, relay timeout).
 * - `server`     — any 5xx, or any other non-transport fault.
 *
 * `unknown` is reserved for a genuinely unclassifiable shape; in practice every
 * terminal error lands in one of the concrete kinds above.
 */
export type RouteErrorClassification =
	"rate_limit" | "auth" | "driver_bug" | "server" | "transport" | "unknown";

export function classifyRouteError(error: unknown): RouteErrorClassification {
	const message = error instanceof Error ? error.message : String(error);
	const statusCode = getLlmStatusCode(error);

	if (isRateLimitStatus(statusCode, message)) return "rate_limit";
	if (statusCode === 401 || statusCode === 403) return "auth";
	if (statusCode === 400) return "driver_bug";
	if (statusCode !== undefined && statusCode >= 500) return "server";
	// No HTTP status: a known transport signature is a transport fault; anything
	// else that reached terminal handling is treated as a server-class failure so
	// the route still backs off rather than silently never recording.
	if (statusCode === undefined) {
		return isTransientLLMError(error) ? "transport" : "server";
	}
	// A 4xx other than 400/401/403/402/429 (e.g. 404/422) is a hard client error;
	// classify as driver_bug so it backs off and advises rather than looping.
	return "driver_bug";
}

/**
 * Whether an error is a route failure that warrants same-model failover
 * (spec §7.1): every classified kind — rate limit, 402/quota, auth, 5xx,
 * driver-bug 400, transport. A model refusal (R-RT15) is NOT a route failure:
 * the request reached the model and a safety classifier declined it, so it
 * never backs a route off or fails over.
 */
export function isRouteFailure(error: unknown): boolean {
	return !(error instanceof LLMRefusalError);
}
