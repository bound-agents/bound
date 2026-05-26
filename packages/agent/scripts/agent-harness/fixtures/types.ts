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

/**
 * Counts of synthetic memory + skill rows seeded into the harness's
 * in-memory DB before turn 1. Drives the volatile-prefix size produced by
 * `composeStableVolatileSubsection` so the harness's `tokens_in` per
 * inference lands in the production band (~67k for autonomous-task threads).
 *
 * Defaults (when `volatilePrefix` is absent on a fixture) leave the DB
 * empty — useful for fixtures that intentionally exercise the small-prefix
 * regime. Production-scale fixtures set the counts explicitly.
 */
export interface VolatilePrefixSeedSpec {
	/**
	 * `tier='pinned'` rows in `semantic_memory`. Each renders fully as
	 * `- {key}: {value}`. Production typically has 60-100 entries with
	 * avg value length ~2k chars.
	 */
	pinnedCount?: number;
	pinnedValueChars?: number;
	/**
	 * `tier='summary'` rows. Each renders as `- {key}: {value(truncated 200)}`.
	 * Production typically has 60-100 entries.
	 */
	summaryCount?: number;
	/**
	 * `tier='detail'` rows. Only the `key` is rendered (plus the
	 * `(accessed YYYY-MM-DD)` fragment when budget pressure isn't on).
	 * Production typically has 200-500 entries.
	 */
	detailCount?: number;
	/**
	 * Active `skills` rows. Each renders as a `<skill><name>...
	 * <description>...</description></skill>` block in the
	 * `<available_skills>` XML envelope.
	 */
	skillCount?: number;
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
	/**
	 * Optional volatile-prefix seed counts. When omitted, the harness's DB
	 * has no memory or skill rows and the volatile-prefix is ~empty —
	 * useful for testing the placer in the small-prefix regime but yields
	 * artificially high cache hit rates (tiny `tokens_in` denominator).
	 * Production-scale fixtures set this to drive realistic hit rates.
	 */
	volatilePrefix?: VolatilePrefixSeedSpec;
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
