/**
 * Type-level declaration of every input allowed to influence the
 * **R-VC24 volatile stable subsection** byte content.
 *
 * The R-VC24 stable prefix is composed of:
 *
 *   1. Static prefix bits — environment paragraph, persona, orientation,
 *      `## Database Schema`, skill body. These are loaded once per
 *      assembly from files / config / static schema and don't depend on
 *      wall-clock time. Intentionally **not** modeled here — they're
 *      stable for unrelated reasons.
 *
 *   2. **This subsection**: Working Knowledge bodies + Discoverable
 *      Archive titles + skill index. These three are rendered from
 *      `semantic_memory` / `skills` table content. They were the
 *      historical leak surface: first relative-time `Nm/h/d ago`
 *      strings, then the `(accessed YYYY-MM-DD)` calendar suffix and
 *      `last_accessed_at`-ordered DA lines. Both `last_accessed_at`
 *      leaks were removed — DA titles now render bare `- <key>` in
 *      key-sorted order (see `sortDetailEntriesForRender` /
 *      `formatDetailLine` in `summary-extraction.ts`), so the rendered
 *      bytes are a pure function of {keys, cluster structure, tier},
 *      invariant to render-time `last_accessed_at` bumps. See the spec
 *      at `docs/design/specs/2026-05-22-volatile-context.md`,
 *      "Stable-prefix purity invariant".
 *
 * The point of this type is to make the wall-clock-purity contract
 * legible at a function signature: anything that could perturb the
 * stable subsection's byte output must appear here. `nowMs`, `Date`,
 * `Date.now()`, `process.uptime()`, and any other ambient-time signal
 * are deliberately absent.
 *
 * Each `*View` shape is intentionally narrower than the underlying DB
 * row. For example, `DetailEntryView` carries `key` and
 * `last_accessed_at` (the inputs that participate in the rendered
 * line) but not `modified_at` / `created_at` (those participate only
 * in the varying side or in upstream sort/selection). The view
 * narrowing is what lets the type system enforce what was previously
 * a prose invariant.
 *
 * Read-only collection markers (`ReadonlyArray`, `ReadonlyMap`,
 * `ReadonlySet`) are not for runtime mutation defense — they signal
 * that the renderer must not splice in extra observation channels
 * mid-render. The renderer is pure; mutation would not be observable
 * outside it anyway.
 */

import type { Vc15Tunables } from "../summary-extraction";

/**
 * Working-Knowledge tier projection. Mirrors the fields read by
 * `renderWorkingKnowledge`'s stable-output path: `key` and `value` for
 * the pinned/summary line bodies, plus `modifiedAt` for the `(modified
 * YYYY-MM-DD)` capture-time prefix (#71). `modifiedAt` is a legitimate
 * stable-side wall-clock signal under R-VC25: it enters only via the
 * persisted `semantic_memory.modified_at` column, which advances solely
 * on a real body rewrite — the same event that already busts the prefix
 * cache — so rendering its calendar prefix adds provenance without
 * introducing render-time cache churn. Fields that participate only in
 * the varying side (delta markers, stale-child references) are NOT here.
 */
export interface MemoryEntryView {
	key: string;
	value: string;
	/**
	 * UTC ISO timestamp of the entry's last body rewrite
	 * (`semantic_memory.modified_at`). Rendered as a `YYYY-MM-DD` calendar
	 * prefix via `formatCalendarDate`; never parsed into a relative offset.
	 */
	modifiedAt: string;
}

/**
 * Discoverable-Archive entry projection. Carries `key` and
 * `last_accessed_at` because both feed `formatDetailLine` on the
 * stable side. Notably absent: `modified_at`, `created_at`, `tier`,
 * `source` — those are upstream sort/selection inputs (already
 * collapsed into the array order), not render inputs.
 */
export interface DetailEntryView {
	key: string;
	last_accessed_at: string | null;
}

/**
 * Skill-index entry projection. Mirrors `buildSkillIndex` in
 * `context-assembly.ts`: `name` + `description`. Skills are loaded
 * elsewhere (see `loadActiveSkills`); this type is the slice that
 * participates in stable output.
 */
export interface SkillIndexView {
	name: string;
	description: string;
}

/**
 * Cluster model-topology projection for the `<stable-context>` models
 * section (Kara's ask, 2026-06-16). `name` is the logical model alias;
 * `hosts` is the bytewise-sorted list of `host_name`s serving it (parsed
 * from each host row's `hosts.models` JSON); `local` is true when the
 * current host is among the serving set.
 *
 * Deliberately EXCLUDES two signals that look tempting but would defeat the
 * point of living on the stable side:
 *
 *   - **liveness** (online/offline): a host's heartbeat flaps `online_at`
 *     constantly; folding it in would churn the cross-thread cache every
 *     time a host blinks.
 *   - **current-turn model marker**: which model serves *this* turn is a
 *     varying signal — it already rides the varying prefix
 *     (`buildVaryingPrefix`'s `Current Model:` line). Putting it here would
 *     bust the prefix on every model switch.
 *
 * Model→host topology changes only when a host's configured model set
 * changes (rare), so this is a legitimate R-VC25 stable-side input. Its
 * covering write is the `hosts` table's `change_log` row — see
 * `STABLE_SIDE_TABLES` in the drift detector.
 */
export interface ClusterModelView {
	name: string;
	hosts: ReadonlyArray<string>;
	local: boolean;
}

/**
 * Complete declared input set for `composeStableVolatileSubsection`.
 *
 * **Adding a new field here is a contract change.** The drift
 * detector's "leak in compose" classification relies on
 * `stablePrefixInputFingerprint` covering every input that the
 * renderer reads. New stable-side data sources must be plumbed in
 * here so the fingerprint advances when they change, otherwise a
 * legitimate change shows up as a false-positive compose leak.
 */
export interface StableVolatileInputs {
	/** R-VC24 Working Knowledge: pinned tier (rendered in full body). */
	pinned: ReadonlyArray<MemoryEntryView>;
	/** R-VC24 Working Knowledge: summary tier (rendered with truncated gloss). */
	summaries: ReadonlyArray<MemoryEntryView>;
	/** R-VC24 Discoverable Archive: detail tier titles. Already sorted upstream. */
	detailEntries: ReadonlyArray<DetailEntryView>;
	/**
	 * Map from a detail-tier key to its parent summary key, used by the
	 * Tier-2/Tier-3 cluster compression path in
	 * `renderDiscoverableArchive`. Built upstream from `memory_edges`
	 * `summarizes` edges.
	 */
	parentSummaryByKey: ReadonlyMap<string, string>;
	/**
	 * Detail-tier keys already routed to Working Knowledge as R-HM7
	 * stale children. Excluded from DA output to prevent duplicate
	 * rendering (§6.4 dedup rule).
	 */
	staleChildKeysInWorkingKnowledge: ReadonlySet<string>;
	/**
	 * Critical-pressure flag from the upstream R-VC14 budget gate.
	 * When true, DA renders title-only (drops the
	 * "(accessed YYYY-MM-DD)" fragment). The flag is computed
	 * deterministically by the budget gate and is stable for a given
	 * input set.
	 */
	budgetPressure: boolean;
	/** Resolved at assembly time from `BOUND_VC15_N` / `BOUND_VC15_M`. */
	tunables: Vc15Tunables;
	/** Active skills, rendered into the skill-index XML. */
	skillIndex: ReadonlyArray<SkillIndexView>;
	/**
	 * Cluster model topology for the `<stable-context>` section. Pre-sorted
	 * upstream (bytewise by `name`, and `hosts` bytewise within each entry)
	 * so the rendered bytes are a pure function of the topology.
	 */
	clusterModels: ReadonlyArray<ClusterModelView>;
}
