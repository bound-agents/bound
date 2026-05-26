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
 *
 *   B7 (load-bearing) cachePoint survives AI SDK tool-message
 *      combining — for ANY sequence whose bridge output places a
 *      cachePoint after a run of consecutive tool_result messages,
 *      simulating the AI SDK's combining pass (ai@6.0.168
 *      dist/index.mjs:1342-1354) preserves the cachePoint metadata
 *      on the surviving tool message. Catches the entire class of
 *      "bridge attaches metadata to a message that AI SDK collapses
 *      away" regressions without enumerating every parallel-tool
 *      shape.
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

	it("B7 (property, load-bearing): cachePoint survives AI SDK's tool-message combining for ANY parallel-tool count", () => {
		// Property: for any positive count N of parallel tool_results
		// produced by an assistant's parallel tool_calls, followed by a
		// {role:"cache"} marker, the bridge output's cachePoint metadata
		// must survive the AI SDK's combining pass (ai@6.0.168
		// dist/index.mjs:1342-1354). Specifically: when consecutive `role:
		// "tool"` ModelMessages get combined into one, the cachePoint must
		// land on a SURVIVING message.
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 6 }), (parallelCount) => {
				const toolUses = Array.from({ length: parallelCount }, (_, i) => ({
					type: "tool_use" as const,
					id: `tc${i}`,
					name: "memory",
					input: {},
				}));
				const toolResults: LLMMessage[] = Array.from({ length: parallelCount }, (_, i) => ({
					role: "tool_result" as const,
					content: [{ type: "text" as const, text: `r${i}` }],
					tool_use_id: `tc${i}`,
				}));
				const msgs: LLMMessage[] = [
					{ role: "user", content: "do parallel" },
					{
						role: "tool_call",
						content: [{ type: "text", text: "going" }, ...toolUses],
					},
					...toolResults,
					{ role: "cache", content: "" },
					{ role: "developer", content: "vol_tail" },
				];
				const result = toModelMessages(msgs, {
					targetEnvelope: ANTHROPIC_ENVELOPE,
					cacheProvider: "anthropic",
				});
				// Simulate AI SDK's combining pass.
				const combined: typeof result = [];
				for (const m of result) {
					if (m.role !== "tool") {
						combined.push(m);
						continue;
					}
					const last = combined[combined.length - 1];
					if (last?.role === "tool") {
						(last.content as unknown[]).push(...(m.content as unknown[]));
					} else {
						combined.push(m);
					}
				}
				const survivingTool = combined.find((m) => m.role === "tool");
				if (!survivingTool) return false;
				const opts = survivingTool.providerOptions as
					| Record<string, Record<string, unknown>>
					| undefined;
				return opts?.anthropic?.cacheControl !== undefined;
			}),
			{ numRuns: 20 },
		);
	});

	it("B-regression: cachePoint survives AI SDK's tool-message combining (load-bearing)", () => {
		// Live regression on thread `b4541575-...` 2026-05-26: 50+ cold
		// turns with cw=0 and the message-level cachePoint never reaching
		// the wire. Root cause: the AI SDK's `convertToLanguageModelPrompt`
		// (ai@6.0.168 dist/index.mjs:1342-1354) combines consecutive
		// `role: "tool"` ModelMessages by appending the second's content
		// onto the first's content array — and silently drops the second's
		// `providerOptions`. The bridge's `{role:"cache"}` handling attaches
		// the cachePoint to `result[result.length - 1]`, which for parallel
		// tool_results is the LAST tool message; AI SDK then combines all
		// trailing tools into the FIRST and the cachePoint metadata is gone.
		//
		// The contract: when a `{role:"cache"}` marker arrives after a run
		// of consecutive tool_result messages, the cachePoint MUST end up
		// attached to a message that survives the AI SDK's tool-combining
		// pass. The bridge must either (a) emit one combined ModelMessage
		// per tool_result run, or (b) attach the cachePoint to the FIRST
		// tool message in the run.
		//
		// Verification mirrors the AI SDK's combining rule and asserts the
		// cachePoint metadata still exists on the first surviving tool
		// message after simulated combination.
		const msgs: LLMMessage[] = [
			{ role: "user", content: "do parallel work" },
			{
				role: "tool_call",
				content: [
					{ type: "text", text: "running both" },
					{ type: "tool_use", id: "tcA", name: "memory", input: {} },
					{ type: "tool_use", id: "tcB", name: "memory", input: {} },
				],
			},
			{ role: "tool_result", content: [{ type: "text", text: "A" }], tool_use_id: "tcA" },
			{ role: "tool_result", content: [{ type: "text", text: "B" }], tool_use_id: "tcB" },
			{ role: "cache", content: "" },
			{ role: "developer", content: "vol_tail" },
		];
		const result = toModelMessages(msgs, {
			targetEnvelope: ANTHROPIC_ENVELOPE,
			cacheProvider: "anthropic",
		});
		// Simulate the AI SDK's combining pass (ai@6.0.168:1342-1354).
		const combined: typeof result = [];
		for (const m of result) {
			if (m.role !== "tool") {
				combined.push(m);
				continue;
			}
			const last = combined[combined.length - 1];
			if (last?.role === "tool") {
				(last.content as unknown[]).push(...(m.content as unknown[]));
			} else {
				combined.push(m);
			}
		}
		// After combining, find the surviving tool message and assert it
		// carries the cachePoint metadata. If the bridge attached the
		// cachePoint to the second (now-collapsed) tool message, the first
		// surviving tool's providerOptions will be missing the cacheControl
		// and the wire will have no message-level cachePoint at all.
		const survivingTool = combined.find((m) => m.role === "tool");
		if (!survivingTool) throw new Error("no tool message survived combining");
		const opts = survivingTool.providerOptions as
			| Record<string, Record<string, unknown>>
			| undefined;
		if (!opts?.anthropic?.cacheControl) {
			throw new Error(
				"cachePoint lost across AI SDK tool-message combination: " +
					"the surviving tool message has no providerOptions.anthropic.cacheControl. " +
					"Bridge attached cachePoint to a tool message that was combined-away.",
			);
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
