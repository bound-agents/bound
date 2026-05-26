/**
 * Autonomous-task fixture — mirrors the production thread shape that
 * exercised the demons fixed in commits `476e7a6e`, `0c6cfb2d`,
 * `71ebc11e`, and `5e4a4f12`.
 *
 * Shape:
 *   - one user message (`initialUserContent`) — no follow-ups
 *   - a `thread.summary` is seeded so Stage 1.7 of context-assembly
 *     prepends a developer-role compaction stub at messages[0]
 *   - two tools available (`memory`, `query`) so the agent loop can
 *     exercise parallel tool calls within a single asst response
 *   - tool stubs return deterministic strings — same input every call
 *     yields the same output, so wire bytes are reproducible across
 *     runs of the harness against the same source code
 *
 * The cache diagnostic running this fixture should reproduce the
 * "byte-stable cumulative cache extension" pattern observed on thread
 * `6fff1513-...` after all current fixes are in place: cr climbs above
 * the system-anchor floor turn-over-turn, cw spikes once per cache-
 * invalidation boundary, `wire_diff_vs_prev` stays `stable` between
 * those boundaries.
 */

import type { HarnessFixture } from "./types";

export const autonomousTaskFixture: HarnessFixture = {
	name: "autonomous-task",
	description:
		"1 user + thread.summary + parallel tools — mirrors the autonomous-task production shape",

	initialUserContent:
		"Look up what 'cache_marker' does in this codebase, then summarize what you find.",

	threadSummary:
		"Earlier in this thread the user asked the agent to investigate cache hit rates. " +
		"The agent had previously confirmed that thread.summary is set, that the autonomous-" +
		"task pattern (single user message followed by inner-loop tool calls) is the most " +
		"common shape for these investigations, and that the cache diagnostic harness was " +
		"the right place to start iterating.",

	tools: [
		{
			type: "function",
			function: {
				name: "memory",
				description:
					"Search the agent's persistent memory for entries matching the query. Returns up to 10 matches.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search terms" },
					},
					required: ["query"],
				},
			},
		},
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
		memory: (input) => {
			const query = String(input.query ?? "");
			// Return a deterministic synthesized result. Stable byte content
			// across runs is the whole point of the harness.
			return [
				`Found 2 memory entries matching ${JSON.stringify(query)}:`,
				'- cache_marker:role-of-marker — A {role: "cache"} synthetic message tells the AI SDK bridge to attach a cachePoint to the preceding emitted message.',
				"- cache_marker:placement-rule — coldPathPlaceCacheMarker uses semantic-anchor placement at the latest user message, with a recovery rule that advances past user_1 when only developer messages precede.",
			].join("\n");
		},
		query: (input) => {
			const sql = String(input.sql ?? "");
			return [
				`Query: ${sql}`,
				"Returned 0 rows. (Harness fixture: deterministic stub — actual DB queries are not executed.)",
			].join("\n");
		},
	},
};
