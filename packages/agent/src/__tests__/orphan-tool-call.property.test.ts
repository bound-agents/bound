/**
 * Property tests for `hasOrphanedToolCall`.
 *
 * The classifier sits at the warm-path entry. False negatives let
 * malformed tool-pair sequences reach the AI SDK and produce
 * `MissingToolResultsError`. False positives force unnecessary
 * cold reassemblies and thrash the prompt cache.
 *
 * Properties:
 *
 *   O1 Empty / no-tool sequences are non-orphan — for any sequence
 *      of `user`, `assistant`, `developer`, `system` messages,
 *      `hasOrphanedToolCall` returns false.
 *
 *   O2 Well-paired sequences are non-orphan — for any tool_call
 *      with N tool_use ids and exactly N matching tool_results
 *      following it, the result is false.
 *
 *   O3 Tool_call without ANY tool_result is orphan — when a
 *      tool_call is followed only by a non-tool message, the
 *      result is true.
 *
 *   O4 Partial tool_results = orphan — a tool_call with N tool_use
 *      ids matched by < N tool_results before a non-tool message
 *      is an orphan.
 *
 *   O5 Lone tool_result is orphan — a tool_result without any
 *      preceding tool_call is an orphan.
 *
 *   O6 Determinism — same input returns same output.
 */

import { describe, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { hasOrphanedToolCall } from "../agent-loop-utils";

const safeText = fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s));

const nonToolRole = fc.constantFrom("user", "assistant", "developer", "system");

const nonToolMsg: fc.Arbitrary<LLMMessage> = fc.record({
	role: nonToolRole,
	content: safeText,
}) as fc.Arbitrary<LLMMessage>;

const toolUseId = fc
	.string({ minLength: 1, maxLength: 16 })
	.filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

function toolCallMsg(ids: string[]): LLMMessage {
	return {
		role: "tool_call",
		content: JSON.stringify(ids.map((id) => ({ type: "tool_use", id, name: "demo", input: {} }))),
	};
}

function toolResultMsg(id: string): LLMMessage {
	return {
		role: "tool_result",
		tool_use_id: id,
		content: "ok",
	};
}

describe("hasOrphanedToolCall — property tests", () => {
	it("O1: sequences of only non-tool roles are never orphan", () => {
		fc.assert(
			fc.property(fc.array(nonToolMsg, { minLength: 0, maxLength: 30 }), (msgs) => {
				return hasOrphanedToolCall(msgs) === false;
			}),
			{ numRuns: 100 },
		);
	});

	it("O2: tool_call followed by exactly its matching tool_results is non-orphan", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(toolUseId, { minLength: 1, maxLength: 5 }),
				fc.array(nonToolMsg, { minLength: 0, maxLength: 5 }),
				(ids, prefixMsgs) => {
					const msgs: LLMMessage[] = [...prefixMsgs, toolCallMsg(ids), ...ids.map(toolResultMsg)];
					return hasOrphanedToolCall(msgs) === false;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("O3: tool_call followed only by a non-tool message is orphan", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(toolUseId, { minLength: 1, maxLength: 3 }),
				nonToolMsg,
				(ids, followup) => {
					const msgs: LLMMessage[] = [toolCallMsg(ids), followup];
					return hasOrphanedToolCall(msgs) === true;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("O4: tool_call with partial tool_results before a non-tool message is orphan", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(toolUseId, { minLength: 2, maxLength: 5 }),
				nonToolMsg,
				(ids, followup) => {
					// Match only the first N-1 ids.
					const matched = ids.slice(0, -1);
					const msgs: LLMMessage[] = [toolCallMsg(ids), ...matched.map(toolResultMsg), followup];
					return hasOrphanedToolCall(msgs) === true;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("O5: lone tool_result without preceding tool_call is orphan", () => {
		fc.assert(
			fc.property(toolUseId, (id) => {
				const msgs: LLMMessage[] = [toolResultMsg(id)];
				return hasOrphanedToolCall(msgs) === true;
			}),
			{ numRuns: 50 },
		);
	});

	it("O6: determinism — same input returns same output", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(toolUseId, { minLength: 1, maxLength: 5 }),
				fc.boolean(),
				(ids, includeAllResults) => {
					const msgs: LLMMessage[] = [
						toolCallMsg(ids),
						...(includeAllResults ? ids.map(toolResultMsg) : []),
					];
					const a = hasOrphanedToolCall(msgs);
					const b = hasOrphanedToolCall(msgs);
					return a === b;
				},
			),
			{ numRuns: 100 },
		);
	});
});
