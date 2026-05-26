/**
 * Fixture interface for the agent-harness diagnostic.
 *
 * A fixture describes a deterministic scenario: an initial user prompt,
 * a set of available tools (with deterministic stub results), an optional
 * `thread.summary` to seed before turn 1 (exercising Stage 1.7
 * compaction-summary prepend), and an optional set of per-turn mutations
 * (e.g., "after turn 5, append a new user message").
 *
 * Fixtures are provider-agnostic by construction — they describe the
 * scenario, not the wire format. The same fixture runs against any
 * backend the operator selects via `--backend`.
 */

import type { ToolDefinition } from "@bound/llm";

/** Deterministic tool stub. Same input → same output every call. */
export type ToolStub = (input: Record<string, unknown>) => string;

/**
 * Per-turn mutation. After turn `afterTurn` completes (1-indexed), append
 * the provided user content as a new `messages` row before the next turn
 * runs. Used to exercise multi-user scenarios where the cache marker
 * advances at user-message boundaries.
 */
export interface FixtureMutation {
	afterTurn: number;
	insertUser: string;
}

export interface HarnessFixture {
	/** Unique name (matches the CLI flag value). */
	name: string;
	/** One-line description for `--help`. */
	description: string;
	/** Initial user prompt — drives turn 1. */
	initialUserContent: string;
	/**
	 * Optional `thread.summary` seeded before turn 1. When present, Stage
	 * 1.7 of context-assembly prepends a developer-role compaction stub at
	 * messages[0] containing this summary. Mirrors the production shape
	 * that triggered demons `476e7a6e` and `71ebc11e`.
	 */
	threadSummary?: string;
	/** Tools advertised to the LLM. */
	tools: ToolDefinition[];
	/**
	 * Deterministic tool stub keyed by tool name. Returns the result text
	 * for any invocation of the named tool. Same input → same output.
	 */
	toolStubs: Record<string, ToolStub>;
	/** Optional per-turn mutations. */
	perTurnMutations?: FixtureMutation[];
}
