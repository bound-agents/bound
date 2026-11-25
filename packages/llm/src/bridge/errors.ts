/**
 * Error mapping: unknown AI SDK error → LLMError with best-effort HTTP status.
 */

import { formatError } from "@bound/shared";
import { LLMRefusalError, classifyGeminiInteractions400 } from "../model-declined";
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
	const explicitRetryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;
	// Usage-limit reset time (#265): providers report when a cap lifts through
	// reset headers or the error body. It backs the route off until the cap
	// lifts when no Retry-After was sent, and is surfaced in the message.
	const now = Date.now();
	const resetsAt =
		parseResetHeaders(e?.responseHeaders, now) ?? parseResetFromBody(e?.responseBody, now);
	const retryAfterMs =
		explicitRetryAfterMs ?? (resetsAt !== undefined ? Math.max(0, resetsAt - now) : undefined);
	// The AI SDK's APICallError sets `.message` to the bare HTTP status text
	// ("Bad Request") and stashes the provider's actual explanation in
	// `.responseBody` — e.g. the Codex backend's `{"detail":"Store must be set
	// to false"}`. `formatError` returns `err.message` for an Error instance, so
	// without this the useful detail never reaches the caller (and, over the
	// relay, never crosses the wire — only the opaque status text does). Surface
	// the response body when present so a remote inference failure is diagnosable
	// from the requesting host, not just the executing one's logs.
	// Gemini Interactions API safety block: an HTTP 400 whose JSON body carries
	// a recognized safety `code` is a model refusal, not a route failure (R-RT15).
	// This is the only place the raw 400 body is still visible before router error
	// handling runs, so classify it here and raise an LLMRefusalError so the
	// PooledBackend propagates it immediately instead of backing off the entry and
	// retrying the same model. Any other 400 falls through to a plain LLMError.
	if (statusCode === 400) {
		const refusal = classifyGeminiInteractionsFromBody(e?.responseBody, provider);
		if (refusal) return refusal;
	}
	const responseDetail = formatResponseBody(e?.responseBody);
	const baseMessage = formatError(err);
	const detailedMessage =
		responseDetail && !baseMessage.includes(responseDetail)
			? `${provider} request failed: ${baseMessage} — ${responseDetail}`
			: `${provider} request failed: ${baseMessage}`;
	const message =
		resetsAt !== undefined
			? `${detailedMessage} (usage limit resets at ${new Date(resetsAt).toISOString()})`
			: detailedMessage;
	return new LLMError(
		message,
		provider,
		statusCode,
		err instanceof Error ? err : new Error(String(err)),
		retryAfterMs,
		resetsAt,
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

/**
 * Reset headers that report when a rate or usage window lifts. OpenAI-style
 * `x-ratelimit-reset-*` carry a duration ("6m0s", "20ms", "1.5s") or epoch
 * seconds; Anthropic's `anthropic-ratelimit-*-reset` carry an RFC 3339 instant.
 * The LATEST reset across the reported windows wins, since the route stays
 * capped until every exhausted window lifts.
 */
function parseResetHeaders(
	headers: Record<string, string> | undefined,
	now: number,
): number | undefined {
	if (!headers) return undefined;
	let latest: number | undefined;
	for (const [rawName, value] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		const isReset =
			name.startsWith("x-ratelimit-reset") ||
			(name.startsWith("anthropic-ratelimit-") && name.endsWith("-reset"));
		if (!isReset || typeof value !== "string") continue;
		const at = parseResetValue(value.trim(), now);
		if (at !== undefined && (latest === undefined || at > latest)) latest = at;
	}
	return latest;
}

function parseResetValue(value: string, now: number): number | undefined {
	if (value.length === 0) return undefined;
	const durationMs = parseGoDuration(value);
	if (durationMs !== undefined) return now + durationMs;
	const n = Number(value);
	if (!Number.isNaN(n)) return epochToMs(n, now);
	const ts = Date.parse(value);
	return Number.isNaN(ts) ? undefined : ts;
}

/** "6m0s" / "1h2m3.5s" / "20ms" → ms; undefined when not a duration string. */
function parseGoDuration(value: string): number | undefined {
	if (!/^(\d+(\.\d+)?(h|ms|m|s))+$/.test(value)) return undefined;
	const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
	let total = 0;
	for (const match of value.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) {
		total += Number(match[1]) * (units[match[2] ?? ""] ?? 0);
	}
	return total;
}

/**
 * A bare number is epoch seconds when it lands in a plausible absolute range,
 * else a relative seconds count (OpenAI sends relative values, some proxies
 * send absolute epochs).
 */
function epochToMs(n: number, now: number): number {
	if (n > 1e12) return n; // already epoch-ms
	if (n > 1e9) return n * 1000; // epoch seconds
	return now + n * 1000;
}

/**
 * Structured or textual reset in an error body: Codex `usage_limit_reached`
 * sends `resets_at` (epoch s) / `resets_in_seconds`; z.AI and OpenCode Go
 * phrase it as "... will reset at 2026-11-25 14:30:00".
 */
function parseResetFromBody(body: unknown, now: number): number | undefined {
	if (typeof body !== "string" || body.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		const found = findResetField(parsed, now, 0);
		if (found !== undefined) return found;
	} catch {
		// Not JSON — fall through to the textual pattern.
	}
	return parseResetFromText(body);
}

function findResetField(value: unknown, now: number, depth: number): number | undefined {
	if (depth > 3 || typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["resets_at", "reset_at", "resetsAt", "resetAt"]) {
		const v = record[key];
		if (typeof v === "number" && Number.isFinite(v)) return epochToMs(v, now);
		if (typeof v === "string") {
			const at = parseResetValue(v, now);
			if (at !== undefined) return at;
		}
	}
	for (const key of ["resets_in_seconds", "reset_in_seconds", "resetsInSeconds"]) {
		const v = record[key];
		if (typeof v === "number" && Number.isFinite(v)) return now + v * 1000;
	}
	for (const nested of Object.values(record)) {
		if (typeof nested === "object" && nested !== null) {
			const found = findResetField(nested, now, depth + 1);
			if (found !== undefined) return found;
		}
		if (typeof nested === "string") {
			const found = parseResetFromText(nested);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function parseResetFromText(text: string): number | undefined {
	const match =
		/\breset(?:s)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
			text,
		);
	if (!match?.[1]) return undefined;
	const ts = Date.parse(match[1].replace(" ", "T"));
	return Number.isNaN(ts) ? undefined : ts;
}

function parseRetryAfter(header: string): number | undefined {
	const n = Number(header);
	if (!Number.isNaN(n)) return n * 1000;
	const ts = Date.parse(header);
	if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
	return undefined;
}

/**
 * Classify a Gemini Interactions API HTTP 400 body as a safety block. The
 * provider returns the block code as a JSON `code` either at the top level or
 * nested under `error.code`. Returns an LLMRefusalError when the code is a
 * recognized safety block (so the router treats it as a refusal, not a route
 * failure), else undefined so the caller falls through to a plain LLMError.
 */
function classifyGeminiInteractionsFromBody(
	body: unknown,
	provider: string,
): LLMRefusalError | undefined {
	if (typeof body !== "string" || body.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const root = parsed as { code?: unknown; error?: { code?: unknown } };
	const rawCode = root.error?.code ?? root.code;
	const code = typeof rawCode === "string" ? rawCode : undefined;
	const outcome = classifyGeminiInteractions400(code);
	if (!outcome) return undefined;
	return new LLMRefusalError(
		`${provider} refused the request (Gemini Interactions safety block: ${outcome.raw_reason})`,
		provider,
		outcome,
		400,
	);
}
