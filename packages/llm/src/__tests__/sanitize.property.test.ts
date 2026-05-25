/**
 * Property tests for tool-use id and tool-name sanitization.
 *
 * These functions sit on the wire boundary between the agent loop
 * and the provider API. Anthropic enforces `^[a-zA-Z0-9_-]{1,64}$`
 * on both `tool_use.id` and `tool_use.name`; a single byte outside
 * that charset rejects the entire request. Historical incidents
 * (Kimi/Moonshot template-token leakage, OpenAI-compatible fallback
 * id shape `functions.<name>:<index>`) caused 6-simultaneous Bedrock
 * validation errors that disabled threads until manual rewrite.
 *
 * Properties:
 *
 *   S1 Charset totality (Anthropic envelope) — for ANY input string,
 *      the sanitized id matches `^[a-zA-Z0-9_-]+$` (or is empty when
 *      the input is empty).
 *
 *   S2 Length cap (Anthropic envelope) — output ≤ 64 chars.
 *
 *   S3 Idempotence — `sanitize(sanitize(x)) === sanitize(x)`. The
 *      output is in the legal subset, so re-running the function
 *      cannot produce a different result. This is what makes it
 *      safe to apply at multiple read points without divergence.
 *
 *   S4 Determinism — same input, same output across calls.
 *
 *   S5 No-op on already-legal inputs — strings already matching
 *      the strict regex within the length cap pass through
 *      unchanged. This is the "lossless on the wire" promise.
 *
 *   S6 sanitizeToolName never empty — for any non-empty input that
 *      sanitizes to empty (e.g. `<<<`), output is `"unknown"` (the
 *      legacy fallback).
 *
 *   S7 Bedrock-permissive envelope preserves dot/colon — the
 *      `[a-zA-Z0-9_.:-]` charset must survive the round-trip so
 *      Kimi's native `functions.<name>:<index>` fallback ids reach
 *      Bedrock unmolested when routed through the Bedrock-Converse
 *      envelope.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import {
	ANTHROPIC_ENVELOPE,
	BEDROCK_PERMISSIVE_ENVELOPE,
	MAX_TOOL_USE_ID_LENGTH,
	sanitizeToolNameForEnvelope,
	sanitizeToolUseId,
} from "../ai-sdk-bridge";
import { sanitizeToolName } from "../stream-utils";

const ANTHROPIC_LEGAL = /^[a-zA-Z0-9_-]+$/;
const BEDROCK_LEGAL = /^[a-zA-Z0-9_.:-]+$/;

describe("sanitizeToolUseId / sanitizeToolName — property tests", () => {
	it("S1: charset totality (Anthropic envelope) over arbitrary Unicode", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const out = sanitizeToolUseId(input, ANTHROPIC_ENVELOPE);
				if (out === "") return input === "";
				return ANTHROPIC_LEGAL.test(out);
			}),
			{ numRuns: 200 },
		);
	});

	it("S2: length cap (Anthropic envelope) ≤ MAX_TOOL_USE_ID_LENGTH", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (input) => {
				const out = sanitizeToolUseId(input, ANTHROPIC_ENVELOPE);
				return out.length <= MAX_TOOL_USE_ID_LENGTH;
			}),
			{ numRuns: 200 },
		);
	});

	it("S3: idempotence — sanitize(sanitize(x)) === sanitize(x)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const once = sanitizeToolUseId(input, ANTHROPIC_ENVELOPE);
				const twice = sanitizeToolUseId(once, ANTHROPIC_ENVELOPE);
				return once === twice;
			}),
			{ numRuns: 200 },
		);
	});

	it("S4: determinism — repeated calls produce same output", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const a = sanitizeToolUseId(input, ANTHROPIC_ENVELOPE);
				const b = sanitizeToolUseId(input, ANTHROPIC_ENVELOPE);
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("S5: no-op on already-legal inputs", () => {
		const legalIdArb = fc
			.string({ minLength: 1, maxLength: MAX_TOOL_USE_ID_LENGTH })
			.filter((s) => ANTHROPIC_LEGAL.test(s));
		fc.assert(
			fc.property(legalIdArb, (input) => {
				return sanitizeToolUseId(input, ANTHROPIC_ENVELOPE) === input;
			}),
			{ numRuns: 100 },
		);
	});

	it("S6: sanitizeToolName never empty — pure-illegal input falls back to 'unknown'", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const out = sanitizeToolName(input);
				return out.length > 0;
			}),
			{ numRuns: 200 },
		);
	});

	it("S6 (envelope variant): sanitizeToolNameForEnvelope never empty", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const out = sanitizeToolNameForEnvelope(input, ANTHROPIC_ENVELOPE);
				return out.length > 0;
			}),
			{ numRuns: 200 },
		);
	});

	it("S7: Bedrock-permissive envelope preserves dot/colon", () => {
		// `functions.foo:42` should survive the Bedrock envelope
		// unchanged (dots and colons are legal there).
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-zA-Z0-9_]+$/.test(s)),
				fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9_]+$/.test(s)),
				fc.integer({ min: 0, max: 99 }),
				(prefix, name, idx) => {
					const id = `${prefix}.${name}:${idx}`;
					if (id.length > MAX_TOOL_USE_ID_LENGTH) return true;
					const out = sanitizeToolUseId(id, BEDROCK_PERMISSIVE_ENVELOPE);
					return out === id && BEDROCK_LEGAL.test(out);
				},
			),
			{ numRuns: 100 },
		);
	});

	it('S-regression: pathological Kimi template-token leakage (200+ chars with <|>{}" chars)', () => {
		// Pinned regression for the historical Kimi template-token
		// leakage incident (CONTRIBUTING.md "Tool-use id sanitization at
		// AI SDK bridge"). Without sanitization, the entire 200+ char
		// template fragment lands in tool_use.id and produces 6-simultaneous
		// Bedrock validation errors.
		const pathological = `<|tool_call_argument_begin|>{"foo": "bar", "baz": ${"x".repeat(200)}}`;
		const out = sanitizeToolUseId(pathological, ANTHROPIC_ENVELOPE);
		if (!ANTHROPIC_LEGAL.test(out)) {
			throw new Error(`Charset regression: ${out}`);
		}
		if (out.length > MAX_TOOL_USE_ID_LENGTH) {
			throw new Error(`Length regression: ${out.length} > ${MAX_TOOL_USE_ID_LENGTH}`);
		}
	});
});
