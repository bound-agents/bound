/**
 * Tool-thinking guardrail: force the `think` scratchpad after a streak of
 * tool calls that never used it.
 *
 * Why this is legal here and nowhere else: `tool_choice` is rejected by these
 * providers while native reasoning is on, and tool mode is exactly the
 * configuration that turns native reasoning OFF (Mantle Anthropic
 * `thinking: {type:"disabled"}`, Mantle Responses `reasoning: {effort:"none"}`).
 * So the same switch that gives us the `think` tool also unlocks the ability to
 * require it.
 *
 * Why force at all: a model that never externalizes any reasoning behaves
 * erratically on long tool chains. The forced turn is a dedicated thinking
 * turn — the model emits one `think` call and nothing else, then proceeds
 * normally on the next turn with the thought in its context.
 */

import type { ChatParams } from "@bound/llm";

/**
 * Tool calls (not assistant messages) allowed between `think` calls before the
 * next inference forces one. Counts individual `tool_use` blocks, so a
 * parallel-call turn advances the streak by its full width.
 */
export const THINK_TOOL_FORCE_AFTER = 10;

/**
 * How far back to scan the thread tail when measuring the streak. Comfortably
 * larger than {@link THINK_TOOL_FORCE_AFTER} so a run of parallel-call turns
 * (each contributing several `tool_use` blocks) plus the interleaved
 * `tool_result` / `assistant` rows still fits inside the window.
 */
export const THINK_FORCE_SCAN_LIMIT = 120;

/** The synthetic scratchpad tool's name; see THINK_TOOL_DEFINITION. */
const THINK_TOOL_NAME = "think";

/** Minimal shape of a persisted message row this module reads. */
export interface ToolStreakRow {
	role: string;
	content: string;
}

/**
 * Counts `tool_use` blocks in newest-first message rows, stopping at the most
 * recent turn that used `think`. A `think` anywhere in a turn resets the
 * streak, including that turn's parallel siblings — the scratchpad was used, so
 * the guardrail has nothing to correct.
 */
export function countToolCallsSinceThink(rows: ReadonlyArray<ToolStreakRow>): number {
	let count = 0;
	for (const row of rows) {
		if (row.role !== "tool_call") continue;
		let blocks: unknown;
		try {
			blocks = JSON.parse(row.content);
		} catch {
			// Not ContentBlock JSON — carries no tool_use blocks to count.
			continue;
		}
		if (!Array.isArray(blocks)) continue;

		const names: string[] = [];
		for (const block of blocks) {
			if (!block || typeof block !== "object") continue;
			const b = block as { type?: unknown; name?: unknown };
			if (b.type === "tool_use" && typeof b.name === "string") names.push(b.name);
		}
		if (names.includes(THINK_TOOL_NAME)) return count;
		count += names.length;
	}
	return count;
}

/**
 * Resolves `tool_choice` for the upcoming inference. Returns a forced `think`
 * choice once the streak reaches {@link THINK_TOOL_FORCE_AFTER} on a tool-mode
 * backend, and `undefined` otherwise (leaving the provider default: "auto").
 */
export function resolveThinkToolChoice(input: {
	thinkingTool: boolean;
	rows: ReadonlyArray<ToolStreakRow>;
}): ChatParams["tool_choice"] | undefined {
	if (!input.thinkingTool) return undefined;
	if (countToolCallsSinceThink(input.rows) < THINK_TOOL_FORCE_AFTER) return undefined;
	return { type: "tool", toolName: THINK_TOOL_NAME };
}
