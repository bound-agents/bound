/**
 * `collect` — the DB-reading layer of the stable-prefix subsystem.
 *
 * The architectural promise of the stable-prefix package: data
 * acquisition is separated from rendering at a single seam. The
 * renderer (`compose.ts`) is provably pure and never touches DB or
 * clock; this module is the ONLY place inside `stable-prefix/` that
 * runs SQL.
 *
 * The split serves three goals:
 *
 *   1. **Property-testable rendering.** Without this seam, every
 *      property test on the renderer would need a DB harness. With
 *      it, `compose.ts`'s 100-runs-per-property fast-check suite
 *      runs in microseconds against arbitrary in-memory inputs.
 *
 *   2. **Drift-detector localization.** R-VC25's drift detector
 *      classifies "leak in compose" vs "leak in collect" by
 *      comparing input fingerprint to output hash. That
 *      classification is meaningful only when the fingerprint
 *      covers exactly the inputs the renderer reads. The narrow
 *      `StableVolatileInputs` shape, plumbed end-to-end through
 *      this layer, is what makes the classifier honest.
 *
 *   3. **Refactor safety.** Production code that builds the
 *      stable-prefix inputs ad-hoc (the historical `inline in
 *      buildVolatileContext + inline in noHistory + inline in
 *      budget-pressure rebuild` pattern) is silently divergent —
 *      a fix to one path doesn't propagate to the others. Routing
 *      every site through `projectStableVolatileInputs` collapses
 *      the three to one.
 *
 * This module has two layers:
 *
 *   - **`projectStableVolatileInputs(loaded)`** — pure projection
 *     from already-loaded DB data into the narrow
 *     `StableVolatileInputs` shape. Input is the wider shapes
 *     produced by `loadPinnedEntries` / `loadDetailEntries` /
 *     `buildParentSummaryMap` / etc.; output is the narrow view.
 *     No DB, no clock. Property-testable.
 *
 *   - **`collectStableVolatileInputs(db)`** — DB-reading wrapper
 *     that calls the existing loaders (which already exist for
 *     production reasons), then delegates to the pure projector.
 *     Integration-tested.
 */

import type { Database } from "bun:sqlite";
import { compareBytewise } from "@bound/shared";
import {
	buildParentSummaryMap,
	buildStaleChildrenMap,
	loadDetailEntries,
	loadPinnedEntries,
	loadSummaryEntries,
	resolveVc15Tunables,
} from "../summary-extraction";
import type { StageEntry, Vc15Tunables } from "../summary-extraction";
import type { ClusterModelView, StableVolatileInputs } from "./types";

/**
 * Wider shapes consumed by `projectStableVolatileInputs`. Mirrors
 * exactly what the existing production loaders return so the
 * projector can be a drop-in for the inline ad-hoc construction
 * sites in `context-assembly.ts`.
 */
export interface LoadedStableInputs {
	pinned: ReadonlyArray<StageEntry>;
	summaries: ReadonlyArray<StageEntry>;
	detailEntries: ReadonlyArray<{ key: string; last_accessed_at: string | null }>;
	parentSummaryMap: ReadonlyMap<string, string>;
	/**
	 * Per-summary stale-children map. The projector reads only
	 * `child.key` from the values — values' other fields (gloss,
	 * modified_at) are varying-side concerns.
	 */
	staleChildrenMap: ReadonlyMap<string, ReadonlyArray<{ key: string }>>;
	budgetPressure: boolean;
	activeSkills: ReadonlyArray<{ name: string; description: string }>;
	tunables: Vc15Tunables;
	/** Cluster model topology for the `<stable-context>` section. */
	clusterModels: ReadonlyArray<ClusterModelView>;
}

/**
 * Pure projection from loaded DB data into the narrow
 * `StableVolatileInputs` shape. No DB. No clock. No env.
 *
 * The transformation is:
 *
 *   - `pinned` and `summaries` keep `key` and `value`; everything
 *     else (modifiedAt, source, tier, tag, taskName, threadId,
 *     threadTitle) is intentionally dropped — those participate
 *     only in the varying side of the volatile context.
 *   - `detailEntries` keep `key` and `last_accessed_at` verbatim.
 *   - `parentSummaryMap` is structurally copied.
 *   - `staleChildrenMap` is collapsed into a flat key-set
 *     (`staleChildKeysInWorkingKnowledge`) — the renderer only
 *     needs membership, not per-summary grouping.
 *   - `activeSkills` keeps `name` and `description`.
 *   - `budgetPressure` and `tunables` pass through.
 */
export function projectStableVolatileInputs(loaded: LoadedStableInputs): StableVolatileInputs {
	return {
		pinned: loaded.pinned.map((e) => ({ key: e.key, value: e.value, modifiedAt: e.modifiedAt })),
		summaries: loaded.summaries.map((e) => ({
			key: e.key,
			value: e.value,
			modifiedAt: e.modifiedAt,
		})),
		detailEntries: loaded.detailEntries.map((e) => ({
			key: e.key,
			last_accessed_at: e.last_accessed_at,
		})),
		parentSummaryByKey: new Map(loaded.parentSummaryMap),
		staleChildKeysInWorkingKnowledge: new Set(
			Array.from(loaded.staleChildrenMap.values())
				.flat()
				.map((e) => e.key),
		),
		budgetPressure: loaded.budgetPressure,
		tunables: { n: loaded.tunables.n, m: loaded.tunables.m },
		skillIndex: loaded.activeSkills.map((s) => ({ name: s.name, description: s.description })),
		clusterModels: loaded.clusterModels.map((m) => ({
			name: m.name,
			hosts: [...m.hosts],
			local: m.local,
		})),
	};
}

/**
 * Read cluster model topology from the synced `hosts` table and project it
 * into the `<stable-context>` shape. Pure-after-read: no clock, no env.
 *
 * Each host row carries a `models` JSON column — either `string[]` (logical
 * aliases) or `{ id: string }[]`. We invert it into a model→hosts map, sort
 * everything bytewise for determinism (locale-independent, R-VC25-safe), and
 * mark a model `local` when the current site serves it.
 *
 * Liveness (`online_at`) is deliberately NOT read: it flaps on every
 * heartbeat and would churn the cross-thread cache. Topology shifts only when
 * a host's configured model set changes, whose `hosts` `change_log` row is
 * the covering write the drift detector keys on.
 */
export function loadClusterModels(db: Database, siteId?: string): ClusterModelView[] {
	let rows: Array<{ site_id: string; host_name: string; models: string | null }>;
	try {
		rows = db
			.prepare("SELECT site_id, host_name, models FROM hosts WHERE deleted = 0")
			.all() as Array<{ site_id: string; host_name: string; models: string | null }>;
	} catch {
		// Non-fatal — match the graceful-degradation posture of the skills read.
		return [];
	}

	const hostsByModel = new Map<string, Set<string>>();
	const localModels = new Set<string>();
	for (const row of rows) {
		if (!row.models) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.models);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		for (const entry of parsed) {
			const name =
				typeof entry === "string"
					? entry
					: entry && typeof entry === "object" && "id" in entry
						? String((entry as { id: unknown }).id)
						: null;
			if (!name) continue;
			const set = hostsByModel.get(name) ?? new Set<string>();
			set.add(row.host_name);
			hostsByModel.set(name, set);
			if (siteId && row.site_id === siteId) localModels.add(name);
		}
	}

	return [...hostsByModel.entries()]
		.map(([name, set]) => ({
			name,
			hosts: [...set].sort(compareBytewise),
			local: localModels.has(name),
		}))
		.sort((a, b) => compareBytewise(a.name, b.name));
}

/**
 * Read every stable-side input from the DB and return them as a
 * `StableVolatileInputs` instance. The single entry point for the
 * stable-prefix subsystem's data acquisition.
 *
 * `budgetPressure` is a caller-provided argument because the gate
 * is computed upstream from token totals, not from DB state. The
 * caller (`context-assembly.ts`) holds it.
 *
 * Skill loading is wrapped in a try/catch matching the existing
 * production behavior in `buildVolatileContext` — an empty list
 * is the documented graceful degradation when the skills query
 * fails.
 */
export function collectStableVolatileInputs(
	db: Database,
	budgetPressure: boolean,
	siteId?: string,
): StableVolatileInputs {
	const pinned = loadPinnedEntries(db);
	const summaries = loadSummaryEntries(db, pinned.exclusionSet);
	const detailEntries = loadDetailEntries(db);

	const parentSummaryMap = buildParentSummaryMap(
		db,
		detailEntries.entries.map((e) => e.key),
	);
	const staleChildrenMap = buildStaleChildrenMap(db, summaries.entries);

	let activeSkills: Array<{ name: string; description: string }> = [];
	try {
		activeSkills = db
			.query(
				"SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC",
			)
			.all() as Array<{ name: string; description: string }>;
	} catch {
		// Non-fatal — match `buildVolatileContext`'s behavior.
	}

	return projectStableVolatileInputs({
		pinned: pinned.entries,
		summaries: summaries.entries,
		detailEntries: detailEntries.entries,
		parentSummaryMap,
		staleChildrenMap,
		budgetPressure,
		activeSkills,
		tunables: resolveVc15Tunables(),
		clusterModels: loadClusterModels(db, siteId),
	});
}
