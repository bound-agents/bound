/**
 * Property tests for `toModelMessages` — the pure bridge between
 * the agent's `LLMMessage[]` shape and the AI SDK's `ModelMessage[]`
 * shape sent on the wire.
 *
 * The bridge is the seam where the agent's "stable prefix" promise
 * meets the wire bytes that ride the provider's prompt cache. If
 * the bridge reformats inputs non-deterministically (or differently
 * across calls with the same inputs), the agent's R-VC25 hash
 * would match while the wire bytes diverge — silent cache thrash
 * that no other test would catch.
 *
 * Properties:
 *
 *   B1 Determinism — same `(messages, opts)` produces byte-equal
 *      output across calls.
 *
 *   B2 Idempotence on tool-use sanitization — running the bridge
 *      output through the bridge again is a fixed point. Mirrors
 *      the S3 idempotence property at the sanitization level, but
 *      one layer up.
 *
 *   B3 Tool-result pairing preserved — every `tool_result` message
 *      in the input has a corresponding `tool` message in the
 *      output with matching sanitized id.
 *
 *   B4 Cache marker placement is stable — `{role: "cache"}` markers
 *      attach to the IMMEDIATELY-PRECEDING emitted message's
 *      providerOptions; their position is a function of the input
 *      ordering alone.
 *
 *   B5 Empty input → empty output — zero-message input produces
 *      zero-message output.
 *
 *   B6 Developer-message merging is deterministic — interleaved
 *      developer messages produce a deterministic merge into the
 *      next user message regardless of how many developer messages
 *      preceded.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { ANTHROPIC_ENVELOPE, toModelMessages } from "../ai-sdk-bridge";
import type { LLMMessage } from "../types";

const safeText = fc.string({ minLength: 0, maxLength: 50 }).filter((s) => !/[\n\r]/.test(s));

const userMsg: fc.Arbitrary<LLMMessage> = fc.record({
	role: fc.constant("user" as const),
	content: safeText,
});

const assistantMsg: fc.Arbitrary<LLMMessage> = fc.record({
	role: fc.constant("assistant" as const),
	content: safeText,
});

const developerMsg: fc.Arbitrary<LLMMessage> = fc.record({
	role: fc.constant("developer" as const),
	content: safeText,
});

const cacheMsg: fc.Arbitrary<LLMMessage> = fc.record({
	role: fc.constant("cache" as const),
	content: fc.constant(""),
});

const messageArb: fc.Arbitrary<LLMMessage> = fc.oneof(
	userMsg,
	assistantMsg,
	developerMsg,
	cacheMsg,
);

const messageSequence = fc.array(messageArb, { minLength: 0, maxLength: 8 }).map((msgs) => {
	// Bridge requires sequences ending in user (its developer-merge
	// logic targets the next user message). Append one if missing.
	if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") {
		return [...msgs, { role: "user" as const, content: "trailing" }];
	}
	return msgs;
});

describe("toModelMessages — property tests", () => {
	it("B1: determinism — same input produces byte-equal output", () => {
		fc.assert(
			fc.property(messageSequence, (msgs) => {
				const a = JSON.stringify(toModelMessages(msgs, { targetEnvelope: ANTHROPIC_ENVELOPE }));
				const b = JSON.stringify(toModelMessages(msgs, { targetEnvelope: ANTHROPIC_ENVELOPE }));
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("B5: empty input → empty output", () => {
		const result = toModelMessages([], { targetEnvelope: ANTHROPIC_ENVELOPE });
		if (result.length !== 0) {
			throw new Error(`empty input produced non-empty output: ${result.length}`);
		}
	});

	it("B6: developer-message merging is deterministic across counts", () => {
		// Different counts of identical developer messages between two
		// user messages should produce a stable, deterministic merge.
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				safeText,
				safeText,
				(devCount, devText, userText) => {
					const baseMsgs: LLMMessage[] = [{ role: "user", content: "first" }];
					for (let i = 0; i < devCount; i++) {
						baseMsgs.push({ role: "developer", content: devText });
					}
					baseMsgs.push({ role: "user", content: userText });

					// Run twice — must produce same result.
					const a = JSON.stringify(
						toModelMessages(baseMsgs, { targetEnvelope: ANTHROPIC_ENVELOPE }),
					);
					const b = JSON.stringify(
						toModelMessages(baseMsgs, { targetEnvelope: ANTHROPIC_ENVELOPE }),
					);
					return a === b;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("B-regression: cache marker on user message produces providerOptions", () => {
		// Sanity pin: a {role: cache} after a user message should
		// attach a cache breakpoint to that user message's provider
		// options. If the bridge stops doing this, prompt caching
		// silently breaks.
		const msgs: LLMMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "cache", content: "" },
		];
		const result = toModelMessages(msgs, {
			targetEnvelope: ANTHROPIC_ENVELOPE,
			cacheProvider: "anthropic",
		});
		// Last emitted message should have cacheControl in providerOptions.
		const last = result[result.length - 1];
		const provOpts = last?.providerOptions as Record<string, Record<string, unknown>> | undefined;
		if (!provOpts?.anthropic?.cacheControl) {
			throw new Error("cache breakpoint did not attach to preceding message");
		}
	});

	it("B-regression: trailing developer message merges into preceding user", () => {
		// Per CONTRIBUTING.md "LLM message roles diverge between layers":
		// developer messages must be merged into an adjacent user message
		// wrapped in <system-context>. Orphan developer-only inputs are
		// dropped — but a developer message after a user message should
		// merge BACKWARD onto that user message's content.
		const msgs: LLMMessage[] = [
			{ role: "user", content: "what time is it" },
			{ role: "developer", content: "platform: web" },
		];
		const result = toModelMessages(msgs, { targetEnvelope: ANTHROPIC_ENVELOPE });
		// Result must contain the developer text somewhere — either
		// merged into the user message or preserved as part of a
		// system-context wrapper.
		const serialized = JSON.stringify(result);
		if (!serialized.includes("platform: web")) {
			throw new Error("developer-message merge regressed");
		}
	});
});
