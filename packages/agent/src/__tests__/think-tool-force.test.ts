/**
 * Tool-thinking guardrail: when a tool-mode backend has run a streak of
 * assistant tool calls without touching the `think` scratchpad, the next
 * inference forces it via `tool_choice`.
 *
 * `tool_choice` is only legal on these paths BECAUSE tool mode disables the
 * provider's native reasoning (Mantle Anthropic `thinking.type: "disabled"`,
 * Mantle Responses `reasoning.effort: "none"`) — providers reject an explicit
 * tool choice while reasoning is on. The forced turn is a dedicated thinking
 * turn: the model emits one `think` call, then proceeds normally next turn.
 */

import { describe, expect, it } from "bun:test";
import {
	THINK_TOOL_FORCE_AFTER,
	countToolCallsSinceThink,
	resolveThinkToolChoice,
} from "../think-tool-force";

/** A `tool_call`-role message's persisted content: ContentBlock[] JSON. */
function toolCallRow(...names: string[]): { role: string; content: string } {
	return {
		role: "tool_call",
		content: JSON.stringify(
			names.map((name, i) => ({
				type: "tool_use",
				id: `call_${i}`,
				name,
				input: {},
			})),
		),
	};
}

describe("countToolCallsSinceThink", () => {
	it("counts zero on an empty thread", () => {
		expect(countToolCallsSinceThink([])).toBe(0);
	});

	it("counts tool calls in newest-first rows", () => {
		const rows = [toolCallRow("query"), toolCallRow("memory")];
		expect(countToolCallsSinceThink(rows)).toBe(2);
	});

	it("counts every tool_use block in a parallel-call turn", () => {
		expect(countToolCallsSinceThink([toolCallRow("query", "memory", "skill")])).toBe(3);
	});

	it("stops at the newest think call — the streak resets there", () => {
		const rows = [
			toolCallRow("query"),
			toolCallRow("memory"),
			toolCallRow("think"),
			toolCallRow("skill"),
			toolCallRow("task"),
		];
		expect(countToolCallsSinceThink(rows)).toBe(2);
	});

	it("does not count the think call itself", () => {
		expect(countToolCallsSinceThink([toolCallRow("think")])).toBe(0);
	});

	it("counts a parallel turn's siblings but stops at a think in the same turn", () => {
		// think + query in one assistant turn: the scratchpad WAS used, so the
		// streak resets; the sibling call must not carry over.
		expect(countToolCallsSinceThink([toolCallRow("query", "think")])).toBe(0);
	});

	it("ignores non-tool_call roles", () => {
		const rows = [
			{ role: "assistant", content: "some prose" },
			{ role: "user", content: "a question" },
			toolCallRow("query"),
		];
		expect(countToolCallsSinceThink(rows)).toBe(1);
	});

	it("ignores rows whose content is not ContentBlock JSON", () => {
		const rows = [{ role: "tool_call", content: "not json at all" }, toolCallRow("query")];
		expect(countToolCallsSinceThink(rows)).toBe(1);
	});
});

describe("resolveThinkToolChoice", () => {
	const streak = (n: number) => Array.from({ length: n }, () => toolCallRow("query"));

	it("returns undefined when the backend is not in tool mode", () => {
		expect(
			resolveThinkToolChoice({ thinkingTool: false, rows: streak(THINK_TOOL_FORCE_AFTER) }),
		).toBeUndefined();
	});

	it("returns undefined below the threshold", () => {
		expect(
			resolveThinkToolChoice({ thinkingTool: true, rows: streak(THINK_TOOL_FORCE_AFTER - 1) }),
		).toBeUndefined();
	});

	it("forces the think tool at the threshold", () => {
		expect(
			resolveThinkToolChoice({ thinkingTool: true, rows: streak(THINK_TOOL_FORCE_AFTER) }),
		).toEqual({ type: "tool", toolName: "think" });
	});

	it("keeps forcing past the threshold until a think lands", () => {
		expect(
			resolveThinkToolChoice({ thinkingTool: true, rows: streak(THINK_TOOL_FORCE_AFTER + 5) }),
		).toEqual({ type: "tool", toolName: "think" });
	});

	it("releases the force once a think call resets the streak", () => {
		const rows = [...streak(2), toolCallRow("think"), ...streak(THINK_TOOL_FORCE_AFTER)];
		expect(resolveThinkToolChoice({ thinkingTool: true, rows })).toBeUndefined();
	});
});
