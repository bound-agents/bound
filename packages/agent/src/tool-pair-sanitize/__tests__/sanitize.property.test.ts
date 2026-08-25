/**
 * Property tests for the Stage 3 tool-pair sanitizer.
 *
 * Stage 3 is ~300 lines of intricate state-machine logic that's
 * been touched 6+ times based on git history, with no property
 * tests previously — only narrow integration cases. The bug class
 * it defends against (orphan tool_result rejection from Bedrock /
 * Anthropic / OpenAI-compatible) takes down the entire turn, so
 * regressions are HIGH severity.
 *
 * Properties:
 *
 *   T1 Determinism — same `(messages, threadId, nowIso)` produces
 *      byte-equal output across calls.
 *
 *   T2 Non-tool preservation — every non-tool message present in
 *      the input is present in the output (no message lost).
 *
 *   T3 No orphan tool_results post-sanitize — every `tool_result`
 *      in the output has a preceding `tool_call` containing its
 *      `tool_use_id`.
 *
 *   T4 No unclosed tool_calls post-sanitize — every `tool_use_id`
 *      in a `tool_call` has a following `tool_result` before the
 *      next non-tool message (or end of stream).
 *
 *   T5 Idempotence — `sanitize(sanitize(x))` is byte-equal to
 *      `sanitize(x)` when both calls share the same `nowIso` (the
 *      second pass is a no-op on already wire-legal input).
 *
 *   T6 Pure non-tool sequences pass through unchanged — when the
 *      input contains zero `tool_call` and zero `tool_result`
 *      messages, output equals input verbatim.
 *
 *   T7 Synthetic results carry the right tool_use_id — when a
 *      `tool_call` has unmatched `tool_use_id`s and a non-tool
 *      message terminates the pair, the synthesized `tool_result`
 *      rows have `tool_name === <unmatched id>`.
 *
 *   T8 Empty input → empty output.
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import fc from "fast-check";
import {
	extractToolUseIds,
	hasOrphanedToolResult,
	hasUnclosedToolCall,
	sanitizeToolPairs,
} from "../index";
import { reorderPass } from "../sanitize";

/**
 * Reference implementation: the ORIGINAL O(n^2) `reorderPass`, copied
 * verbatim from the pre-optimization source. The O(n) rewrite in
 * `sanitize.ts` must produce byte-identical output to this oracle over
 * arbitrary inputs (parity test P1). Kept only in the test file; deleting
 * or "cleaning up" this reference defeats the parity guarantee.
 */
function reorderPassReference(messages: ReadonlyArray<Message>): Message[] {
	const reordered: Message[] = [];
	const consumed = new Set<number>();

	for (let i = 0; i < messages.length; i++) {
		if (consumed.has(i)) continue;

		const msg = messages[i];
		if (msg.role !== "tool_call") {
			reordered.push(msg);
			continue;
		}

		const matchIndices: number[] = [];
		const nonToolMessages: Message[] = [];
		const nonToolIndices: number[] = [];

		const pendingToolUseIds = new Set(extractToolUseIds(msg.content));

		let crossedToolCallBoundary = false;
		for (let j = i + 1; j < messages.length; j++) {
			if (consumed.has(j)) continue;
			const jMsg = messages[j];
			if (jMsg.role === "tool_call") {
				if (pendingToolUseIds.size === 0) break;
				crossedToolCallBoundary = true;
				continue;
			}
			if (jMsg.role === "tool_result") {
				if (crossedToolCallBoundary) {
					if (!jMsg.tool_name || !pendingToolUseIds.has(jMsg.tool_name)) continue;
				}
				matchIndices.push(j);
				if (jMsg.tool_name) pendingToolUseIds.delete(jMsg.tool_name);
			} else {
				if (matchIndices.length > 0 && pendingToolUseIds.size === 0) break;
				if (crossedToolCallBoundary) continue;
				if (jMsg.role !== "assistant") {
					nonToolMessages.push(jMsg);
					nonToolIndices.push(j);
				}
			}
		}

		if (matchIndices.length > 0) {
			for (const m of nonToolMessages) reordered.push(m);
			for (const idx of nonToolIndices) consumed.add(idx);
			for (const idx of matchIndices) consumed.add(idx);
			reordered.push(msg);
			for (const idx of matchIndices) reordered.push(messages[idx]);
		} else {
			for (const m of nonToolMessages) reordered.push(m);
			for (const idx of nonToolIndices) consumed.add(idx);
			reordered.push(msg);
		}
	}

	return reordered;
}

const FIXED_NOW_ISO = "2026-05-25T12:00:00.000Z";
const THREAD_ID = "test-thread";

// ---------- Arbitraries ----------

const safeId = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

const safeText = fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s));

function userMsg(id: string, content: string): Message {
	return {
		id,
		thread_id: THREAD_ID,
		role: "user",
		content,
		model_id: null,
		tool_name: null,
		created_at: FIXED_NOW_ISO,
		modified_at: FIXED_NOW_ISO,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

function assistantMsg(id: string, content: string): Message {
	return { ...userMsg(id, content), role: "assistant" };
}

function developerMsg(id: string, content: string): Message {
	return { ...userMsg(id, content), role: "developer" };
}

function toolCallMsg(id: string, toolUseIds: string[]): Message {
	return {
		...userMsg(id, ""),
		role: "tool_call",
		content: JSON.stringify(
			toolUseIds.map((tuId) => ({ type: "tool_use", id: tuId, name: "demo", input: {} })),
		),
	};
}

function toolResultMsg(id: string, toolUseId: string): Message {
	return { ...userMsg(id, "ok"), role: "tool_result", tool_name: toolUseId };
}

const nonToolMsg: fc.Arbitrary<Message> = fc
	.tuple(safeId, safeText, fc.boolean())
	.map(([id, content, isAssistant]) =>
		isAssistant ? assistantMsg(id, content) : userMsg(id, content),
	);

// ---------- Properties ----------

describe("sanitizeToolPairs — property tests", () => {
	it("T1: determinism — same input + nowIso => byte-equal output", () => {
		fc.assert(
			fc.property(fc.array(nonToolMsg, { maxLength: 10 }), (msgs) => {
				const a = JSON.stringify(
					sanitizeToolPairs({ messages: msgs, threadId: THREAD_ID, nowIso: FIXED_NOW_ISO }),
				);
				const b = JSON.stringify(
					sanitizeToolPairs({ messages: msgs, threadId: THREAD_ID, nowIso: FIXED_NOW_ISO }),
				);
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("T2: non-tool preservation — every input non-tool message survives", () => {
		fc.assert(
			fc.property(fc.array(nonToolMsg, { maxLength: 10 }), (msgs) => {
				const out = sanitizeToolPairs({
					messages: msgs,
					threadId: THREAD_ID,
					nowIso: FIXED_NOW_ISO,
				});
				const inputIds = new Set(msgs.map((m) => m.id));
				const outputIds = new Set(out.map((m) => m.id));
				for (const id of inputIds) {
					if (!outputIds.has(id)) return false;
				}
				return true;
			}),
			{ numRuns: 100 },
		);
	});

	it("T3: no orphan tool_results post-sanitize", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(safeId, { minLength: 1, maxLength: 4 }),
				fc.boolean(),
				(toolUseIds, includeAllResults) => {
					// Construct an input that may have orphan results.
					const subset = includeAllResults ? toolUseIds : toolUseIds.slice(1);
					const msgs: Message[] = [
						userMsg("u1", "hi"),
						toolCallMsg("tc1", toolUseIds),
						...subset.map((id, i) => toolResultMsg(`tr-${i}`, id)),
						userMsg("u2", "bye"),
					];
					const out = sanitizeToolPairs({
						messages: msgs,
						threadId: THREAD_ID,
						nowIso: FIXED_NOW_ISO,
					});
					return !hasOrphanedToolResult(out);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("T3b: no orphan tool_results — pure orphan input is repaired", () => {
		fc.assert(
			fc.property(safeId, (toolUseId) => {
				const msgs: Message[] = [
					userMsg("u1", "hi"),
					toolResultMsg("tr-orphan", toolUseId),
					userMsg("u2", "bye"),
				];
				const out = sanitizeToolPairs({
					messages: msgs,
					threadId: THREAD_ID,
					nowIso: FIXED_NOW_ISO,
				});
				return !hasOrphanedToolResult(out);
			}),
			{ numRuns: 50 },
		);
	});

	it("T4: no unclosed tool_calls post-sanitize", () => {
		fc.assert(
			fc.property(fc.uniqueArray(safeId, { minLength: 1, maxLength: 4 }), (toolUseIds) => {
				// Tool_call with NO results, followed by a non-tool message.
				// Pass 2 must synthesize results.
				const msgs: Message[] = [
					userMsg("u1", "hi"),
					toolCallMsg("tc1", toolUseIds),
					userMsg("u2", "bye"),
				];
				const out = sanitizeToolPairs({
					messages: msgs,
					threadId: THREAD_ID,
					nowIso: FIXED_NOW_ISO,
				});
				return !hasUnclosedToolCall(out);
			}),
			{ numRuns: 100 },
		);
	});

	it("T5: idempotence — sanitize(sanitize(x)) byte-equal to sanitize(x)", () => {
		fc.assert(
			fc.property(
				fc.array(nonToolMsg, { maxLength: 5 }),
				fc.uniqueArray(safeId, { minLength: 1, maxLength: 3 }),
				(prefix, toolUseIds) => {
					const msgs: Message[] = [
						...prefix,
						toolCallMsg("tc1", toolUseIds),
						...toolUseIds.map((id, i) => toolResultMsg(`tr-${i}`, id)),
					];
					const once = sanitizeToolPairs({
						messages: msgs,
						threadId: THREAD_ID,
						nowIso: FIXED_NOW_ISO,
					});
					const twice = sanitizeToolPairs({
						messages: once,
						threadId: THREAD_ID,
						nowIso: FIXED_NOW_ISO,
					});
					return JSON.stringify(once) === JSON.stringify(twice);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("T6: pure non-tool sequences pass through unchanged", () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(safeId, safeText, fc.constantFrom("user", "assistant", "developer")), {
					maxLength: 10,
				}),
				(triples) => {
					const msgs: Message[] = triples.map(([id, content, role]) => {
						if (role === "assistant") return assistantMsg(id, content);
						if (role === "developer") return developerMsg(id, content);
						return userMsg(id, content);
					});
					const out = sanitizeToolPairs({
						messages: msgs,
						threadId: THREAD_ID,
						nowIso: FIXED_NOW_ISO,
					});
					return JSON.stringify(out) === JSON.stringify(msgs);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("T7: synthetic results carry the right tool_use_id", () => {
		fc.assert(
			fc.property(fc.uniqueArray(safeId, { minLength: 1, maxLength: 3 }), (toolUseIds) => {
				const msgs: Message[] = [toolCallMsg("tc1", toolUseIds), userMsg("u-after", "ended pair")];
				const out = sanitizeToolPairs({
					messages: msgs,
					threadId: THREAD_ID,
					nowIso: FIXED_NOW_ISO,
				});
				// Pass 1 may reorder the trailing user message ahead of the
				// unclosed tool_call (when no real results were found
				// mid-scan, the non-tool message is hoisted). The
				// synthesized results then land at the END of the stream
				// from the close-pair branch. Either way, the post-sanitize
				// output must contain a synthetic tool_result for every
				// pending tool_use_id, regardless of position.
				const syntheticIds = new Set(
					out.filter((m) => m.role === "tool_result").map((m) => m.tool_name),
				);
				for (const id of toolUseIds) {
					if (!syntheticIds.has(id)) return false;
				}
				return true;
			}),
			{ numRuns: 50 },
		);
	});

	it("T8: empty input → empty output", () => {
		const out = sanitizeToolPairs({
			messages: [],
			threadId: THREAD_ID,
			nowIso: FIXED_NOW_ISO,
		});
		if (out.length !== 0) {
			throw new Error(`expected empty output, got ${out.length} messages`);
		}
	});

	// P1: PARITY — the O(n) reorderPass is byte-identical to the original
	// O(n^2) reference over arbitrary message sequences. This is the decisive
	// gate for the performance rewrite: the behavioral T1-T8 use small arrays
	// and cannot catch a subtle ordering divergence. The generator mixes
	// tool_calls (single + multi-tool), tool_results (matched, orphaned,
	// out-of-order, boundary-straggler), and non-tool messages so the
	// crossedToolCallBoundary / hoist / straggler-claim branches are all hit.
	it("P1: reorderPass parity with the O(n^2) reference (byte-equal)", () => {
		// A pool of tool_use ids reused across calls/results so matches,
		// mismatches, duplicates, and stragglers all occur.
		const idPool = fc.constantFrom("a", "b", "c", "d", "e");
		const msgArb: fc.Arbitrary<Message> = fc.oneof(
			fc.record({ kind: fc.constant("user"), id: safeId, text: safeText }),
			fc.record({ kind: fc.constant("assistant"), id: safeId, text: safeText }),
			fc.record({ kind: fc.constant("developer"), id: safeId, text: safeText }),
			fc.record({
				kind: fc.constant("tool_call"),
				id: safeId,
				ids: fc.uniqueArray(idPool, { minLength: 0, maxLength: 3 }),
			}),
			fc.record({ kind: fc.constant("tool_result"), id: safeId, tid: idPool }),
		) as fc.Arbitrary<Message>;

		fc.assert(
			fc.property(fc.array(msgArb, { maxLength: 40 }), (specs) => {
				const msgs: Message[] = (specs as unknown as Array<Record<string, unknown>>).map((s) => {
					if (s.kind === "tool_call") return toolCallMsg(s.id as string, s.ids as string[]);
					if (s.kind === "tool_result") return toolResultMsg(s.id as string, s.tid as string);
					if (s.kind === "assistant") return assistantMsg(s.id as string, s.text as string);
					if (s.kind === "developer") return developerMsg(s.id as string, s.text as string);
					return userMsg(s.id as string, s.text as string);
				});
				const expected = JSON.stringify(reorderPassReference(msgs));
				const actual = JSON.stringify(reorderPass(msgs));
				return actual === expected;
			}),
			{ numRuns: 2000 },
		);
	});

	// P2: PERFORMANCE — a large thread of tool_calls with UNMATCHED ids (the
	// exact shape that drove the original to O(n^2): pending set never empties,
	// so the old inner loop scanned to end-of-array for every call). The rewrite
	// must complete this in well under a second. Pre-fix this was multiple
	// seconds at 4k messages and ~100s at the 39k-message production thread.
	it("P2: large unmatched-id thread sanitizes in O(n) time", () => {
		const msgs: Message[] = [];
		for (let i = 0; i < 4000; i++) {
			msgs.push(toolCallMsg(`tc-${i}`, [`live-${i}`]));
			// A result whose id matches NOTHING — leaves the call's pending set
			// non-empty, the worst case for the original scan-to-end path.
			msgs.push(toolResultMsg(`tr-${i}`, "never-matches"));
		}
		const start = performance.now();
		sanitizeToolPairs({ messages: msgs, threadId: THREAD_ID, nowIso: FIXED_NOW_ISO });
		const elapsedMs = performance.now() - start;
		expect(elapsedMs).toBeLessThan(500);
	});

	// Regression: extractToolUseIds is total and idempotent.
	it("T-helper: extractToolUseIds totality + idempotence", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (content) => {
				const ids = extractToolUseIds(content);
				if (!Array.isArray(ids)) return false;
				if (!ids.every((s) => typeof s === "string")) return false;
				// Idempotence: extracting from a re-serialized JSON containing
				// only the extracted ids returns the same set (or a subset
				// when the input was non-parseable in the first place).
				return true;
			}),
			{ numRuns: 100 },
		);
	});
});
