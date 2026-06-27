/**
 * Property tests for the loop's smaller pure utilities: relay retry gating,
 * loop-guard signature/truncation helpers, and silence-timeout scaling.
 *
 * Relay retry (P1–P3): the decision must short-circuit on abort / attempt
 *   ceiling / non-retriable result before consulting annotations, and only a
 *   "definitely not executed" result or a read-only/idempotent annotation may
 *   green-light a retry. A side-effecting call with unknown execution state is
 *   never retried.
 *
 * Loop guards (G1–G3): truncateForNudge caps length and never grows input;
 *   toolErrorSignature returns null unless EVERY result errored (a mixed turn
 *   means the model got some signal and is not spinning); toolCallSignature is
 *   stable and collision-resistant across turns.
 *
 * Silence timeout (S1–S2): scaledSilenceTimeout is monotonic non-decreasing in
 *   context size, never drops below the base, and is exactly the base at/under
 *   the 100k-token threshold.
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	type ParsedToolCall,
	type ShouldRetryRelayCallInput,
	type ToolAnnotations,
	scaledMaxRetries,
	scaledSilenceTimeout,
	shouldRetryRelayCall,
	toolCallSignature,
	toolErrorSignature,
	truncateForNudge,
} from "./index";

const annotationsArb: fc.Arbitrary<ToolAnnotations | undefined> = fc.option(
	fc.record({
		idempotent: fc.option(fc.boolean(), { nil: undefined }),
		readOnly: fc.option(fc.boolean(), { nil: undefined }),
	}),
	{ nil: undefined },
);

const retryInputArb: fc.Arbitrary<ShouldRetryRelayCallInput> = fc.record({
	waitResult: fc.record({
		content: fc.string(),
		retriable: fc.option(fc.boolean(), { nil: undefined }),
		definitely_not_executed: fc.option(fc.boolean(), { nil: undefined }),
	}),
	attempt: fc.nat(10),
	maxAttempts: fc.nat(10),
	aborted: fc.boolean(),
	annotations: annotationsArb,
});

describe("shouldRetryRelayCall (P1–P3)", () => {
	it("short-circuits to false on abort / ceiling / non-retriable (P1)", () => {
		fc.assert(
			fc.property(retryInputArb, (input) => {
				const blocked =
					input.aborted || input.attempt >= input.maxAttempts || !input.waitResult.retriable;
				if (blocked) {
					expect(shouldRetryRelayCall(input)).toBe(false);
				}
			}),
		);
	});

	it("retries only on definitely-not-executed or read-only/idempotent annotation (P2)", () => {
		fc.assert(
			fc.property(retryInputArb, (input) => {
				const result = shouldRetryRelayCall(input);
				if (result === true) {
					// A true result implies the call cleared every gate AND had a
					// safe-to-retry signal.
					expect(input.aborted).toBe(false);
					expect(input.attempt < input.maxAttempts).toBe(true);
					expect(input.waitResult.retriable).toBe(true);
					const safe =
						input.waitResult.definitely_not_executed === true ||
						input.annotations?.readOnly === true ||
						input.annotations?.idempotent === true;
					expect(safe).toBe(true);
				}
			}),
		);
	});

	it("never retries a retriable side-effecting call of unknown execution state (P3)", () => {
		fc.assert(
			fc.property(fc.nat(5), fc.string(), (attempt, content) => {
				// retriable, in-budget, not aborted, but no safe-to-retry signal at all.
				const input: ShouldRetryRelayCallInput = {
					waitResult: { content, retriable: true, definitely_not_executed: false },
					attempt,
					maxAttempts: attempt + 5,
					aborted: false,
					annotations: { readOnly: false, idempotent: false },
				};
				expect(shouldRetryRelayCall(input)).toBe(false);
			}),
		);
	});
});

describe("truncateForNudge (G1)", () => {
	it("never exceeds the cap and never grows the trimmed input", () => {
		fc.assert(
			fc.property(fc.string(), (content) => {
				const out = truncateForNudge(content);
				const trimmed = content.trim();
				// Cap is 400 chars + a 1-char ellipsis when truncation happened.
				expect(out.length).toBeLessThanOrEqual(401);
				if (trimmed.length <= 400) {
					expect(out).toBe(trimmed);
				} else {
					expect(out.endsWith("…")).toBe(true);
					expect(out.slice(0, -1)).toBe(trimmed.slice(0, 400));
				}
			}),
		);
	});
});

const errResultArb = fc.record({
	toolCall: fc.record({ name: fc.string({ minLength: 1, maxLength: 8 }) }),
	result: fc.record({
		content: fc.string(),
		exitCode: fc.integer({ min: -2, max: 2 }),
	}),
});

describe("toolErrorSignature (G2)", () => {
	it("returns null unless every result errored, non-null otherwise", () => {
		fc.assert(
			fc.property(fc.array(errResultArb), (results) => {
				const sig = toolErrorSignature(results);
				const allErrored = results.length > 0 && results.every((r) => r.result.exitCode !== 0);
				if (allErrored) {
					expect(sig).not.toBeNull();
				} else {
					expect(sig).toBeNull();
				}
			}),
		);
	});

	it("produces equal signatures for equal all-error turns (determinism)", () => {
		const allErrorArb = fc.array(
			fc.record({
				toolCall: fc.record({ name: fc.string({ minLength: 1, maxLength: 8 }) }),
				result: fc.record({
					content: fc.string(),
					exitCode: fc.integer({ min: 1, max: 5 }),
				}),
			}),
			{ minLength: 1, maxLength: 5 },
		);
		fc.assert(
			fc.property(allErrorArb, (results) => {
				expect(toolErrorSignature(results)).toBe(toolErrorSignature(results));
			}),
		);
	});
});

const toolCallArb: fc.Arbitrary<ParsedToolCall> = fc.record({
	id: fc.string(),
	name: fc.string({ minLength: 1, maxLength: 8 }),
	input: fc.constant({}),
	argsJson: fc.string(),
	truncated: fc.constant(false),
});

describe("toolCallSignature (G3)", () => {
	it("is deterministic for the same call list", () => {
		fc.assert(
			fc.property(fc.array(toolCallArb), (calls) => {
				expect(toolCallSignature(calls)).toBe(toolCallSignature(calls));
			}),
		);
	});

	it("distinguishes a single multi-call turn from two concatenated turns", () => {
		// NUL-joining means [a,b] cannot collide with a single call whose args are
		// the naive string concat of a and b — the duplicate-call breaker relies
		// on this to avoid false trips.
		fc.assert(
			fc.property(toolCallArb, toolCallArb, (a, b) => {
				const pair = toolCallSignature([a, b]);
				const fused = toolCallSignature([
					{ ...a, argsJson: `${a.argsJson}${b.name}:${b.argsJson}`, name: a.name },
				]);
				expect(pair).not.toBe(fused);
			}),
		);
	});
});

describe("scaledSilenceTimeout (S1–S2)", () => {
	it("equals the base at or below the 100k-token threshold", () => {
		fc.assert(
			fc.property(fc.nat(100_000), fc.integer({ min: 1, max: 600_000 }), (tokens, base) => {
				expect(scaledSilenceTimeout(base, tokens)).toBe(base);
			}),
		);
	});

	it("is monotonic non-decreasing in context size and never below base", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 600_000 }),
				fc.nat(2_000_000),
				fc.nat(2_000_000),
				(base, t1, t2) => {
					const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
					const tLo = scaledSilenceTimeout(base, lo);
					const tHi = scaledSilenceTimeout(base, hi);
					expect(tLo).toBeGreaterThanOrEqual(base);
					expect(tHi).toBeGreaterThanOrEqual(tLo);
				},
			),
		);
	});

	it("scaledMaxRetries is the identity on the ceiling regardless of context", () => {
		fc.assert(
			fc.property(fc.nat(2_000_000), fc.nat(20), (tokens, max) => {
				expect(scaledMaxRetries(tokens, max)).toBe(max);
			}),
		);
	});
});
