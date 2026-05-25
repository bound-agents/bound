/**
 * Property tests for the cache-decision plumbing.
 *
 * These three layers sit on the warm/cold path between the agent
 * loop and the provider. A bug in any of them either thrashes the
 * cache or silently keeps it cold:
 *
 *   1. `computeToolFingerprint` — deterministic hash of the tool
 *      set. Used as the cache-invalidation key when tool set
 *      changes between turns.
 *   2. `selectCacheTtl` — picks the cache TTL string.
 *   3. `maybePlaceCacheMarker` — splices a {role: "cache"} marker
 *      at messages[length-1] when capability allows.
 *   4. `buildCacheMarkers` — produces the descriptors recorded on
 *      `context_debug.cacheMarkers`.
 *
 * Properties exercised here:
 *
 *   F1 Tool fingerprint determinism — same tool set, same hash.
 *   F2 Tool fingerprint sort-stability — fingerprint depends on
 *      tools as a SET, not as an ordered list. Reordering must
 *      not change the hash.
 *   F3 Tool fingerprint sensitivity — adding, removing, or
 *      modifying a tool changes the hash.
 *   F4 Tool fingerprint shape — output is "empty" for empty input,
 *      otherwise 16 hex chars.
 *   F5 selectCacheTtl is total — returns a valid TTL string for
 *      any interface input.
 *   F6 maybePlaceCacheMarker idempotence on capability gate —
 *      caps.prompt_caching === false always returns placed=false
 *      with reason "capability-disabled".
 *   F7 maybePlaceCacheMarker too-short gate — messages.length < 2
 *      always returns placed=false with reason "too-short".
 *   F8 maybePlaceCacheMarker insertion semantics — when placed,
 *      the result has a {role: "cache"} marker at index
 *      length-1 of the OLD array; new array is one longer.
 *   F9 buildCacheMarkers system marker is always "fixed" — even
 *      when the message marker is "rolling".
 *   F10 buildCacheMarkers position monotonicity — the message
 *       marker's positionTokens >= the system marker's.
 *   F11 buildCacheMarkers capability-disabled returns empty array.
 */

import { describe, it } from "bun:test";
import type { LLMMessage, ToolDefinition } from "@bound/llm";
import type { ContextSection } from "@bound/shared";
import fc from "fast-check";
import { type CacheMarkerCaps, buildCacheMarkers, maybePlaceCacheMarker } from "../cache-marker";
import { selectCacheTtl } from "../cache-prediction";
import { computeToolFingerprint } from "../cached-turn-state";

const HEX_16 = /^[0-9a-f]{16}$/;

function makeTool(name: string, params: Record<string, unknown> = {}): ToolDefinition {
	return {
		type: "function",
		function: { name, description: `${name} desc`, parameters: params },
	};
}

const toolNameArb = fc
	.string({ minLength: 1, maxLength: 20 })
	.filter((s) => /^[a-z][a-z0-9_]*$/.test(s));

const toolArb: fc.Arbitrary<ToolDefinition> = toolNameArb.map((name) => makeTool(name));

const toolSetArb = fc.uniqueArray(toolArb, {
	maxLength: 8,
	selector: (t) => t.function.name,
});

const llmMessageArb: fc.Arbitrary<LLMMessage> = fc.record({
	role: fc.constantFrom("user", "assistant"),
	content: fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s)),
}) as fc.Arbitrary<LLMMessage>;

describe("computeToolFingerprint — property tests", () => {
	it("F1: determinism — same tool set, same hash", () => {
		fc.assert(
			fc.property(toolSetArb, (tools) => {
				const a = computeToolFingerprint(tools);
				const b = computeToolFingerprint([...tools]); // copied — new array, same content
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("F2: sort-stability — reordering tools doesn't change the hash", () => {
		fc.assert(
			fc.property(toolSetArb, (tools) => {
				const reversed = [...tools].reverse();
				return computeToolFingerprint(tools) === computeToolFingerprint(reversed);
			}),
			{ numRuns: 100 },
		);
	});

	it("F3: sensitivity — adding a tool changes the hash", () => {
		fc.assert(
			fc.property(toolSetArb, toolNameArb, (tools, newName) => {
				if (tools.some((t) => t.function.name === newName)) return true; // skip dup
				const before = computeToolFingerprint(tools);
				const after = computeToolFingerprint([...tools, makeTool(newName)]);
				return before !== after;
			}),
			{ numRuns: 100 },
		);
	});

	it("F4: shape — 'empty' for empty input, 16 hex chars otherwise", () => {
		const empty = computeToolFingerprint([]);
		if (empty !== "empty") {
			throw new Error(`expected 'empty', got ${empty}`);
		}
		const undef = computeToolFingerprint(undefined);
		if (undef !== "empty") {
			throw new Error(`expected 'empty' for undefined, got ${undef}`);
		}
		fc.assert(
			fc.property(
				toolSetArb.filter((t) => t.length > 0),
				(tools) => {
					return HEX_16.test(computeToolFingerprint(tools));
				},
			),
			{ numRuns: 50 },
		);
	});
});

describe("selectCacheTtl — property tests", () => {
	it("F5: total over arbitrary interface strings, returns valid TTL", () => {
		fc.assert(
			fc.property(fc.string({ minLength: 0, maxLength: 30 }), (iface) => {
				const ttl = selectCacheTtl(iface);
				return ttl === "5m" || ttl === "1h";
			}),
			{ numRuns: 100 },
		);
	});
});

describe("maybePlaceCacheMarker — property tests", () => {
	it("F6: capability-disabled always returns placed=false with reason", () => {
		fc.assert(
			fc.property(
				fc.array(llmMessageArb, { minLength: 0, maxLength: 10 }),
				fc.constantFrom("fixed", "rolling"),
				(msgs, kind) => {
					const caps: CacheMarkerCaps = { prompt_caching: false };
					const result = maybePlaceCacheMarker([...msgs], kind as "fixed" | "rolling", caps);
					return result.placed === false && result.reason === "capability-disabled";
				},
			),
			{ numRuns: 100 },
		);
	});

	it("F7: too-short gate — messages.length < 2 returns placed=false with reason", () => {
		fc.assert(
			fc.property(
				fc.array(llmMessageArb, { maxLength: 1 }),
				fc.constantFrom("fixed", "rolling"),
				(msgs, kind) => {
					const result = maybePlaceCacheMarker([...msgs], kind as "fixed" | "rolling", undefined);
					return result.placed === false && result.reason === "too-short";
				},
			),
			{ numRuns: 50 },
		);
	});

	it("F8: insertion semantics — placed inserts cache marker at length-1, new length += 1", () => {
		fc.assert(
			fc.property(
				fc.array(llmMessageArb, { minLength: 2, maxLength: 10 }),
				fc.constantFrom("fixed", "rolling"),
				(msgs, kind) => {
					const arr = [...msgs];
					const oldLen = arr.length;
					const result = maybePlaceCacheMarker(arr, kind as "fixed" | "rolling", undefined);
					if (!result.placed) return false;
					if (arr.length !== oldLen + 1) return false;
					if (result.index !== oldLen - 1) return false;
					if (arr[result.index].role !== "cache") return false;
					if (result.variant !== kind) return false;
					return true;
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("buildCacheMarkers — property tests", () => {
	function sectionArb(): fc.Arbitrary<ContextSection> {
		return fc.record({
			name: fc.constantFrom(
				"system",
				"skill-context",
				"volatile-prefix",
				"history",
				"volatile-tail",
				"tools",
			),
			tokens: fc.integer({ min: 0, max: 100_000 }),
		});
	}

	const sectionsArb = fc.array(sectionArb(), { minLength: 0, maxLength: 6 });

	it("F9: system marker is always 'fixed' regardless of message variant", () => {
		fc.assert(
			fc.property(sectionsArb, fc.constantFrom("fixed", "rolling"), (sections, msgVariant) => {
				const markers = buildCacheMarkers({
					sections,
					messagePlacement: {
						placed: true,
						variant: msgVariant as "fixed" | "rolling",
						index: 0,
					},
					ttl: "1h",
				});
				const sysMarker = markers.find((m) => m.kind === "system");
				return sysMarker !== undefined && sysMarker.variant === "fixed";
			}),
			{ numRuns: 100 },
		);
	});

	it("F10: position monotonicity — message marker positionTokens >= system marker", () => {
		fc.assert(
			fc.property(sectionsArb, (sections) => {
				const markers = buildCacheMarkers({
					sections,
					messagePlacement: { placed: true, variant: "fixed", index: 0 },
					ttl: "1h",
				});
				const sys = markers.find((m) => m.kind === "system");
				const msg = markers.find((m) => m.kind === "message");
				if (!sys || !msg) return false;
				return msg.positionTokens >= sys.positionTokens;
			}),
			{ numRuns: 100 },
		);
	});

	it("F11: capability-disabled returns empty array", () => {
		fc.assert(
			fc.property(sectionsArb, (sections) => {
				const markers = buildCacheMarkers({
					sections,
					messagePlacement: {
						placed: false,
						variant: "fixed",
						index: -1,
						reason: "capability-disabled",
					},
					ttl: "1h",
				});
				return markers.length === 0;
			}),
			{ numRuns: 50 },
		);
	});
});
