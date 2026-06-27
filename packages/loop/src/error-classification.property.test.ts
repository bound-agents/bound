/**
 * Property tests for LLM error classification — the predicates that decide
 * whether a failed inference call is retried as a transport blip, escalated to
 * a backend-fallback path, or surfaced as a hard error.
 *
 * Each rule below cost a real incident to learn (intermittent bedrock-mantle
 * 5xx mid-stream, z.ai socket drops, the 35-min inactivity stall that must NOT
 * retry). The properties pin the status-code partition so a future edit can't
 * silently reclassify a whole HTTP class.
 *
 *   E1 4xx (except 429) is never transient — a malformed request fails
 *      identically on retry.
 *   E2 5xx is always transient — server faults clear on backoff.
 *   E3 429 is never "transient" (it routes through rate-limit logic instead).
 *   E4 Known transport-error message fragments are transient regardless of
 *      casing context, and the one-word "timeout" stall is NOT.
 *   R1 isRateLimitStatus fires on 429/529/402 for any message.
 *   R2 With no status, isRateLimitStatus tracks isQuotaCapMessage exactly.
 */
import { describe, expect, it } from "bun:test";
import { LLMError } from "@bound/llm";
import fc from "fast-check";
import { isQuotaCapMessage, isRateLimitStatus, isTransientLLMError } from "./error-classification";

const err = (statusCode: number | undefined, message = "boom") =>
	new LLMError(message, "test-provider", statusCode);

describe("isTransientLLMError — status-code partition (E1–E3)", () => {
	it("treats 4xx (except 429) as non-transient", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 400, max: 499 }).filter((c) => c !== 429),
				fc.string(),
				(statusCode, message) => {
					expect(isTransientLLMError(err(statusCode, message))).toBe(false);
				},
			),
		);
	});

	it("treats 5xx as transient", () => {
		fc.assert(
			fc.property(fc.integer({ min: 500, max: 599 }), fc.string(), (statusCode, message) => {
				expect(isTransientLLMError(err(statusCode, message))).toBe(true);
			}),
		);
	});

	it("never classifies 429 as transient (rate-limit logic owns it)", () => {
		fc.assert(
			fc.property(fc.string(), (message) => {
				expect(isTransientLLMError(err(429, message))).toBe(false);
			}),
		);
	});
});

describe("isTransientLLMError — message pattern matching (E4)", () => {
	const TRANSIENT_FRAGMENTS = [
		"http2",
		"ECONNRESET",
		"socket hang up",
		"socket connection was closed",
		"timed out",
		"ETIMEDOUT",
	];

	it("flags any message containing a known transient fragment (no status)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...TRANSIENT_FRAGMENTS),
				fc.string(),
				fc.string(),
				(fragment, prefix, suffix) => {
					// Plain Error (no statusCode) so only the message path runs.
					const error = new Error(`${prefix}${fragment}${suffix}`);
					expect(isTransientLLMError(error)).toBe(true);
				},
			),
		);
	});

	it("does not treat the one-word inactivity 'timeout' stall as transient", () => {
		// "LLM response timeout" is the 35-min inactivity abort — a genuine stall,
		// deliberately distinct from the two-word "timed out" transport fault.
		expect(isTransientLLMError(new Error("LLM response timeout"))).toBe(false);
	});

	it("returns false for arbitrary messages with no transient fragment", () => {
		fc.assert(
			fc.property(fc.string(), (message) => {
				const hasFragment = TRANSIENT_FRAGMENTS.some((f) => message.includes(f));
				fc.pre(!hasFragment);
				expect(isTransientLLMError(new Error(message))).toBe(false);
			}),
		);
	});
});

describe("isRateLimitStatus (R1–R2)", () => {
	it("fires on 429/529/402 regardless of message", () => {
		fc.assert(
			fc.property(fc.constantFrom(429, 529, 402), fc.string(), (statusCode, message) => {
				expect(isRateLimitStatus(statusCode, message)).toBe(true);
			}),
		);
	});

	it("tracks isQuotaCapMessage exactly when status is absent", () => {
		fc.assert(
			fc.property(fc.string(), (message) => {
				expect(isRateLimitStatus(undefined, message)).toBe(isQuotaCapMessage(message));
			}),
		);
	});

	it("is false for non-rate-limit status codes whatever the message", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 200, max: 599 }).filter((c) => c !== 429 && c !== 529 && c !== 402),
				fc.string(),
				(statusCode, message) => {
					expect(isRateLimitStatus(statusCode, message)).toBe(false);
				},
			),
		);
	});
});

describe("isQuotaCapMessage", () => {
	it("matches any message embedding a quota/billing keyword (case-insensitive)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("quota", "usage limit", "payment", "billing", "credit", "credits"),
				fc.string(),
				fc.string(),
				(keyword, prefix, suffix) => {
					// Pad with spaces so the \b word-boundary anchors fire even if the
					// random affixes are alphanumerics adjacent to the keyword.
					const message = `${prefix} ${keyword} ${suffix}`;
					expect(isQuotaCapMessage(message)).toBe(true);
				},
			),
		);
	});
});
