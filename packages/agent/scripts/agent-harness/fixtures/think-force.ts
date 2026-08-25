/**
 * Think-force fixture — verifies the tool-thinking guardrail on the wire.
 *
 * Pre-seeds a thread whose tail is 10 `tool_call` turns that never touched the
 * `think` scratchpad, so `resolveThinkForce` trips on the FIRST inference of the
 * run and the request body must carry
 * `tool_choice: {type:"tool", toolName:"think"}` alongside the tool-mode
 * reasoning disable.
 *
 * The pairing under test: `tool_choice` is only legal on these providers while
 * native reasoning is OFF, which is exactly what tool mode sends
 * (Mantle Anthropic `thinking:{type:"disabled"}`, Mantle Responses
 * `reasoning:{effort:"none"}`). A 400 here means the two features don't compose
 * and the guardrail can't ship.
 *
 * Run against a tool-mode backend only:
 *   --backend opus --fixture think-force --turns 1
 */

import type { HarnessFixture, PreSeededMessage } from "./types";

/** One assistant tool-call turn plus its paired result — deterministic bytes. */
function toolTurn(index: number): PreSeededMessage[] {
	const callId = `call_seed_${index}`;
	return [
		{
			role: "tool_call",
			content: JSON.stringify([
				{
					type: "tool_use",
					id: callId,
					name: "query",
					input: { sql: `SELECT ${index}` },
				},
			]),
		},
		{
			role: "tool_result",
			// Pairs this result to its call. Without it the bridge cannot match
			// them and Anthropic 400s with "each tool_use must have a single
			// result", collapsing every seeded result onto the first id.
			tool_use_id: callId,
			content: `Query: SELECT ${index}\nReturned 0 rows. (Harness fixture: deterministic stub.)`,
		},
	];
}

/**
 * 10 think-free tool calls — exactly THINK_TOOL_FORCE_AFTER, so the streak is
 * at the threshold when the run's first inference is built.
 */
const SEEDED_STREAK: PreSeededMessage[] = [
	{ role: "user", content: "Start working through the backlog." },
	...Array.from({ length: 10 }, (_, i) => toolTurn(i + 1)).flat(),
];

export const thinkForceFixture: HarnessFixture = {
	name: "think-force",
	description:
		"Pre-seeds 10 think-free tool calls so the first inference must force the think tool via tool_choice (tool-mode backends only)",

	initialUserContent: "Summarize what you found in the rows you just queried.",

	preSeededMessages: SEEDED_STREAK,

	tools: [
		{
			type: "function",
			function: {
				name: "query",
				description:
					"Run a read-only SQL query against the local database. Returns up to 100 rows.",
				parameters: {
					type: "object",
					properties: {
						sql: { type: "string", description: "SELECT or read-only PRAGMA" },
					},
					required: ["sql"],
				},
			},
		},
	],

	toolStubs: {
		query: (input) => {
			const sql = String(input.sql ?? "");
			return [
				`Query: ${sql}`,
				"Returned 0 rows. (Harness fixture: deterministic stub — actual DB queries are not executed.)",
			].join("\n");
		},
		// The `think` tool is injected by the agent loop in tool mode and handled
		// in-loop (fixed acknowledgement, no dispatch), so it needs no stub here.
	},
};
