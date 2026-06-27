/**
 * Property tests for the stream parser — the boundary that folds a provider's
 * raw chunk stream into the single ParsedResponse the loop acts on.
 *
 * The parser is a pure reduction over a chunk list, which makes it a clean
 * property-test target now that it lives in @bound/loop (previously inlined in
 * the agent loop). The invariants below encode the contracts the rest of the
 * loop relies on:
 *
 *   T1 Text/thinking concatenation — output is the in-order concatenation of
 *      every text/thinking chunk; empty thinking collapses to null.
 *   T2 Usage is last-`done`-wins — multiple done chunks resolve to the last.
 *   T3 Tool-call args round-trip — accumulated partial_json is reassembled
 *      verbatim into argsJson; valid JSON parses into `input`, invalid JSON
 *      sets `truncated` and leaves `input` an empty object. Empty args → "{}".
 *   T4 Duplicate tool_use ids are remapped to unique ids, preserving the
 *      args/end routed to the second occurrence.
 *
 *   D1 dropSupersededToolCallDrafts returns an order-preserving subsequence.
 *   D2 The last call is always retained.
 *   D3 Distinct tool names are never dropped (superseding requires same name).
 *   D4 Idempotence — drop(drop(x)) === drop(x).
 */
import { describe, expect, it } from "bun:test";
import type { StreamChunk } from "@bound/llm";
import fc from "fast-check";
import {
	type ParsedToolCall,
	dropSupersededToolCallDrafts,
	parseResponseChunks,
} from "./stream-parser";

function canParse(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

const doneChunk = (input: number, output: number): StreamChunk => ({
	type: "done",
	usage: {
		input_tokens: input,
		output_tokens: output,
		cache_write_tokens: null,
		cache_read_tokens: null,
		estimated: false,
	},
});

describe("parseResponseChunks — text/thinking concatenation (T1)", () => {
	it("concatenates text and thinking content in stream order", () => {
		const segment = fc.record({
			kind: fc.constantFrom("text", "thinking"),
			content: fc.string(),
		});
		fc.assert(
			fc.property(fc.array(segment), (segments) => {
				const chunks: StreamChunk[] = segments.map((s) =>
					s.kind === "text"
						? { type: "text", content: s.content }
						: { type: "thinking", content: s.content },
				);
				const parsed = parseResponseChunks(chunks);

				const expectedText = segments
					.filter((s) => s.kind === "text")
					.map((s) => s.content)
					.join("");
				const expectedThinking = segments
					.filter((s) => s.kind === "thinking")
					.map((s) => s.content)
					.join("");

				expect(parsed.textContent).toBe(expectedText);
				expect(parsed.thinking).toBe(expectedThinking === "" ? null : expectedThinking);
			}),
		);
	});

	it("keeps the last truthy thinking signature", () => {
		fc.assert(
			fc.property(fc.array(fc.option(fc.string({ minLength: 1 }), { nil: "" })), (sigs) => {
				const chunks: StreamChunk[] = sigs.map((sig) => ({
					type: "thinking",
					content: "x",
					signature: sig,
				}));
				const parsed = parseResponseChunks(chunks);

				const lastTruthy = [...sigs].reverse().find((s) => s !== "");
				expect(parsed.thinkingSignature).toBe(lastTruthy ?? null);
			}),
		);
	});
});

describe("parseResponseChunks — usage is last-done-wins (T2)", () => {
	it("resolves usage from the final done chunk", () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ input: fc.nat(1_000_000), output: fc.nat(1_000_000) }), {
					minLength: 1,
				}),
				(dones) => {
					const chunks: StreamChunk[] = dones.map((d) => doneChunk(d.input, d.output));
					const parsed = parseResponseChunks(chunks);
					const last = dones[dones.length - 1];
					expect(parsed.usage.inputTokens).toBe(last.input);
					expect(parsed.usage.outputTokens).toBe(last.output);
				},
			),
		);
	});

	it("reports zeroed usage and null finishReason when no done chunk arrives", () => {
		fc.assert(
			fc.property(fc.string(), (text) => {
				const parsed = parseResponseChunks([{ type: "text", content: text }]);
				expect(parsed.usage.inputTokens).toBe(0);
				expect(parsed.usage.outputTokens).toBe(0);
				expect(parsed.finishReason).toBeNull();
			}),
		);
	});
});

// Splits an args string into a sequence of partial_json fragments that
// concatenate back to the original. Models the provider streaming args in
// arbitrary pieces.
function splitIntoFragments(s: string): fc.Arbitrary<string[]> {
	if (s.length === 0) return fc.constant([]);
	return fc.array(fc.nat(s.length), { maxLength: s.length }).map((rawCuts) => {
		const cuts = [...new Set(rawCuts)].filter((c) => c > 0 && c < s.length).sort((a, b) => a - b);
		const fragments: string[] = [];
		let prev = 0;
		for (const cut of cuts) {
			fragments.push(s.slice(prev, cut));
			prev = cut;
		}
		fragments.push(s.slice(prev));
		return fragments;
	});
}

describe("parseResponseChunks — tool-call args round-trip and truncation (T3)", () => {
	it("reassembles fragmented args and classifies parse-ability", () => {
		// Distinct names per block ⇒ no superseded-draft dropping interferes.
		const argsArb = fc.oneof(
			fc.json(), // valid JSON strings
			fc.string(), // arbitrary strings (often unparseable → truncated)
			fc.constant(""), // empty ⇒ defaults to "{}"
		);
		fc.assert(
			fc.property(fc.array(argsArb, { minLength: 1, maxLength: 6 }), (argsList) => {
				return fc.assert(
					fc.property(fc.tuple(...argsList.map((a) => splitIntoFragments(a))), (fragmentLists) => {
						const chunks: StreamChunk[] = [];
						argsList.forEach((_args, i) => {
							const id = `id-${i}`;
							const name = `tool_${i}`;
							chunks.push({ type: "tool_use_start", id, name });
							for (const frag of fragmentLists[i]) {
								chunks.push({ type: "tool_use_args", id, partial_json: frag });
							}
							chunks.push({ type: "tool_use_end", id });
						});

						const parsed = parseResponseChunks(chunks);
						expect(parsed.toolCalls).toHaveLength(argsList.length);

						parsed.toolCalls.forEach((tc, i) => {
							const effective = argsList[i].length > 0 ? argsList[i] : "{}";
							expect(tc.argsJson).toBe(effective);
							expect(tc.name).toBe(`tool_${i}`);
							if (canParse(effective)) {
								expect(tc.truncated).toBe(false);
								expect(tc.input).toEqual(JSON.parse(effective));
							} else {
								expect(tc.truncated).toBe(true);
								expect(tc.input).toEqual({});
							}
						});
					}),
					{ numRuns: 5 },
				);
			}),
			{ numRuns: 40 },
		);
	});
});

describe("parseResponseChunks — duplicate id remapping (T4)", () => {
	it("assigns unique ids to colliding tool_use ids and preserves order", () => {
		// ids drawn from a small pool to force collisions; names are unique so no
		// draft-dropping occurs and toolCalls.length === number of blocks.
		const block = fc.record({
			id: fc.constantFrom("a", "b", "c"),
			args: fc.constant("{}"),
		});
		fc.assert(
			fc.property(fc.array(block, { minLength: 1, maxLength: 10 }), (blocks) => {
				const chunks: StreamChunk[] = [];
				blocks.forEach((b, i) => {
					chunks.push({ type: "tool_use_start", id: b.id, name: `tool_${i}` });
					chunks.push({ type: "tool_use_args", id: b.id, partial_json: b.args });
					chunks.push({ type: "tool_use_end", id: b.id });
				});

				let counter = 0;
				const parsed = parseResponseChunks(chunks, {
					// Deterministic factory — the production default uses Date.now/Math.random.
					duplicateIdFactory: (orig) => `${orig}~dup${counter++}`,
				});

				expect(parsed.toolCalls).toHaveLength(blocks.length);
				const ids = parsed.toolCalls.map((tc) => tc.id);
				expect(new Set(ids).size).toBe(ids.length); // all unique
				parsed.toolCalls.forEach((tc, i) => {
					expect(tc.name).toBe(`tool_${i}`); // order preserved
				});
			}),
		);
	});
});

// Generates ParsedToolCall arrays directly to exercise the draft-dropping
// reducer in isolation.
const parsedToolCallArb: fc.Arbitrary<ParsedToolCall> = fc
	.record({
		name: fc.constantFrom("alpha", "beta", "gamma"),
		argsJson: fc.oneof(fc.constant("{}"), fc.constant('{"q":"x"}'), fc.constant("{")),
		truncated: fc.boolean(),
	})
	.map(({ name, argsJson, truncated }) => {
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(argsJson);
		} catch {
			/* leave empty; mirrors parser behavior */
		}
		return { id: `${name}-${argsJson}`, name, input, argsJson, truncated };
	});

describe("dropSupersededToolCallDrafts (D1–D4)", () => {
	it("returns an order-preserving subsequence (D1)", () => {
		fc.assert(
			fc.property(fc.array(parsedToolCallArb, { maxLength: 12 }), (calls) => {
				const result = dropSupersededToolCallDrafts(calls);
				expect(result.length).toBeLessThanOrEqual(calls.length);
				// every result element appears in input, in order
				let searchFrom = 0;
				for (const r of result) {
					const idx = calls.indexOf(r, searchFrom);
					expect(idx).toBeGreaterThanOrEqual(0);
					searchFrom = idx + 1;
				}
			}),
		);
	});

	it("always retains the final call (D2)", () => {
		fc.assert(
			fc.property(fc.array(parsedToolCallArb, { minLength: 1, maxLength: 12 }), (calls) => {
				const result = dropSupersededToolCallDrafts(calls);
				expect(result[result.length - 1]).toBe(calls[calls.length - 1]);
			}),
		);
	});

	it("never drops calls when all tool names are distinct (D3)", () => {
		const distinctNamed = fc
			.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 8 })
			.map((names) =>
				names.map<ParsedToolCall>((name, i) => ({
					id: `id-${i}`,
					name,
					input: {},
					argsJson: "{}",
					truncated: false,
				})),
			);
		fc.assert(
			fc.property(distinctNamed, (calls) => {
				expect(dropSupersededToolCallDrafts(calls)).toEqual(calls);
			}),
		);
	});

	it("is idempotent (D4)", () => {
		fc.assert(
			fc.property(fc.array(parsedToolCallArb, { maxLength: 12 }), (calls) => {
				const once = dropSupersededToolCallDrafts(calls);
				const twice = dropSupersededToolCallDrafts(once);
				expect(twice).toEqual(once);
			}),
		);
	});
});
