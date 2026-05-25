/**
 * Type-level declaration of every input allowed to influence the
 * **R-VC24 varying tail** byte content.
 *
 * The varying tail is the developer-role message that rides AFTER
 * history in the LLM message array. It is rebuilt every turn (the
 * inner-loop `refreshVolatileTailForNextTurn` mechanism, plus the
 * cold/warm path entry) and is **not cacheable** — the bridge merges
 * it into the next user message wrapped in `<system-context>`. So the
 * stability constraints of the stable prefix do NOT apply here.
 *
 * What DOES apply (R-VC26, see `docs/design/specs/2026-05-22-volatile-context.md` §10):
 *
 *   - **Freshness**: when relevant state changes, the next varying-
 *     tail render MUST reflect it. A memorize that lands within the
 *     turn must produce a `[changed since last turn]` marker on the
 *     next assembly. Stale freshness is the failure class that
 *     produced thread `d0372be6-...`'s confabulation incident.
 *
 *   - **Source-label totality**: every Live-State line shall carry
 *     exactly one of `[thread] / [task] / [file] / [advisory] /
 *     [synthesis-backlog]`. Unlabeled lines confuse the agent about
 *     where the data came from (the `d0372be6` failure mode); double-
 *     labeled lines are a structural bug.
 *
 *   - **Subsystem ordering**: R-VC5 fixes the four Live-State
 *     subsystems in the order `thread → task → file → advisory`
 *     followed by the optional `synthesis-backlog` trailing rule.
 *     Refactor drift here would shuffle the agent's mental model.
 *
 *   - **Cap discipline under pressure**: when `budgetPressure: true`,
 *     each Live-State subsystem renders no more than 3 entries
 *     (`BUDGET_PRESSURE_SUBSYSTEM_CAP`). The `synthesis-backlog`
 *     trailing line is not capped (it's a singleton).
 *
 *   - **Determinism**: byte-stable output for fixed inputs (including
 *     `nowMs`). Required so property tests can run without flakiness
 *     and so two paths producing the same logical state produce the
 *     same wire bytes.
 *
 *   - **Time monotonicity**: given two inputs differing only in a
 *     later `nowMs`, no relative-time fragment may go backward.
 *     `5m ago` shall not become `3m ago` on a later render.
 *
 * Critically, `nowMs` IS allowed here (unlike `StableVolatileInputs`).
 * Relative-time strings (`(applied 5m ago)`) are intended on the
 * varying side because the tail is not cached. Wall-clock leakage
 * does not cost cache hits; it is informative.
 */

import type { MemoryTier } from "@bound/shared";

/**
 * Recent-memory entry projection. Mirrors the fields read by
 * `formatMemoryEntry` for `tier='default'` L2/L3 entries on the
 * varying side: key, value, modifiedAt, tier, tag, plus the
 * source/task/thread resolution fields. The `deleted` flag triggers
 * the `[forgotten]` rendering branch.
 */
export interface RecentMemoryEntryView {
	key: string;
	value: string;
	source: string | null;
	modifiedAt: string;
	tier: MemoryTier;
	tag: string;
	taskName?: string | null;
	threadId?: string | null;
	threadTitle?: string | null;
	deleted?: boolean;
}

/** Per-summary stale-child projection for the WK-updates varying block. */
export interface StaleChildView {
	key: string;
	value: string;
	/** True when this child's `key` is in the upstream `deltaKeys` set. */
	isDelta: boolean;
}

/** Cross-thread digest line (R-VC7). */
export interface CrossThreadEntryView {
	title: string;
	messageCount: number;
	/** ISO-8601 from `threads.last_message_at`. Rendered verbatim. */
	lastUpdatedAt: string;
}

/** Task-digest line (R-MV6/R-MV7/R-MV8/R-MV9). */
export interface TaskEntryView {
	taskId: string;
	taskType: string;
	runCount: number;
	/** ISO-8601 from `tasks.last_run_at`. Rendered verbatim. */
	lastRunAt: string;
	status: string;
}

/** File-modification notice (R-VC13). */
export interface FileEntryView {
	path: string;
	threadTitle: string;
}

/** Applied-advisory line (R-VC12). */
export interface AdvisoryEntryView {
	title: string;
	/** ISO-8601 of the apply-status transition. Used for relative-time fragment. */
	appliedAt: string;
}

/**
 * Working-Knowledge update markers — the keyed references that ride
 * the varying side per R-VC11. Pre-projected so the renderer doesn't
 * have to filter against a delta set; that filter belongs to the
 * collect layer.
 */
export interface WorkingKnowledgeUpdatesView {
	/** Pinned entry keys whose modified_at > baseline. */
	pinnedDeltaKeys: ReadonlyArray<string>;
	/** Summary entry keys whose modified_at > baseline. */
	summaryDeltaKeys: ReadonlyArray<string>;
	/**
	 * Summaries (in WK render order) with their stale children, used
	 * for the `[stale child of <parent>]` markers. Empty children
	 * arrays are allowed — the renderer skips them.
	 */
	summariesWithStaleChildren: ReadonlyArray<{
		summaryKey: string;
		staleChildren: ReadonlyArray<StaleChildView>;
	}>;
}

/**
 * Live-State subsystem inputs. Each subsystem is rendered in fixed
 * order (R-VC5) regardless of the order of fields here — V4 property
 * test pins this.
 */
export interface LiveStateView {
	crossThreadEntries: ReadonlyArray<CrossThreadEntryView>;
	taskEntries: ReadonlyArray<TaskEntryView>;
	fileEntries: ReadonlyArray<FileEntryView>;
	advisories: ReadonlyArray<AdvisoryEntryView>;
	/** From `renderDiscoverableArchive` output. Null when inactive. */
	synthesisBacklogCount: number | null;
}

/**
 * Complete declared input set for `composeVolatileVarying`.
 *
 * Adding a new field here is a contract change. Property tests
 * exercise the existing fields; new ones must come with new
 * properties or an explicit JSDoc note exempting them.
 */
export interface VolatileVaryingInputs {
	/**
	 * Wall-clock anchor for relative-time fragments. The ONLY allowed
	 * wall-clock ingress on the varying side. Renderer is otherwise
	 * pure in inputs alone.
	 */
	nowMs: number;
	workingKnowledgeUpdates: WorkingKnowledgeUpdatesView;
	/**
	 * `tier='default'` L2 (graph-seeded) + L3 (recency) entries that
	 * the three R-VC24 renderers (WK / DA / LS) don't surface.
	 * Filtered upstream — the renderer trusts the input.
	 */
	recentMemoryEntries: ReadonlyArray<RecentMemoryEntryView>;
	liveState: LiveStateView;
	/** R-VC14 critical-pressure flag. Caps each LS subsystem to 3 entries. */
	budgetPressure: boolean;
}
