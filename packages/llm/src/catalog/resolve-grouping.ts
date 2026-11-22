/**
 * Logical-model grouping precedence + confidence predicate (slice 6, R-MC8/R-MC9,
 * 2026-11-21-model-catalog.md §6).
 *
 * PURE resolution: given one backend's `(provider, providerModelId)`, its synced
 * alias override, its local config `logical_model`, and the set of currently-known
 * canonical keys (`models.dev` entries + already-confirmed cluster logical models),
 * decide its `logical_model` and record which precedence tier won.
 *
 * Precedence (§6.1):
 *   1. synced `model_aliases` override — including an explicit `null` to keep a
 *      backend deliberately ungrouped;
 *   2. local config `logical_model`;
 *   3. structural normalization — only when the confidence predicate (§6.2) holds.
 *
 * Confidence predicate (§6.2) — normalization auto-groups IFF BOTH hold:
 *   (1) the backend is in a recognized hosted/discovered provider namespace (or a
 *       vendor-qualified `openai-compatible` family), and
 *   (2) its normalized canonical key matches a `models.dev` entry OR an
 *       already-confirmed cluster logical model.
 * Otherwise the backend is advertised `logical_model: null` — never silently
 * pooled — and surfaces under Unassigned backends (§6.2, R-MC9).
 */

import { normalizeModelKey } from "./normalize";

/** Which precedence tier decided the logical model. */
export type GroupingSource = "alias" | "config" | "normalization" | "unassigned";

export interface ResolveGroupingArgs {
	provider: string;
	providerModelId: string;
	/**
	 * Synced `model_aliases` value for this `provider_key`, if any. `undefined`
	 * = no alias row; `null` = an explicit operator mapping to "keep ungrouped";
	 * a string = the operator's chosen logical model.
	 */
	aliasOverride: string | null | undefined;
	/** Local config `logical_model` on the backend entry, if declared. */
	configLogicalModel: string | undefined;
	/** Canonical keys present in the cached `models.dev` snapshot. */
	modelsDevKeys: ReadonlySet<string>;
	/**
	 * Canonical keys of logical models already confirmed in the cluster (from
	 * static config or `model_aliases`), so a second backend can attach to one
	 * confirmed by a higher-precedence tier.
	 */
	confirmedLogicalKeys: ReadonlySet<string>;
}

export interface ResolveGroupingResult {
	/** Resolved logical model, or null when the backend stays unassigned. */
	logicalModel: string | null;
	source: GroupingSource;
}

/**
 * Resolve a backend's logical model by the §6.1 precedence, auto-grouping via
 * normalization only when the §6.2 confidence predicate holds.
 */
export function resolveLogicalModel(args: ResolveGroupingArgs): ResolveGroupingResult {
	// 1. Synced alias override — including explicit null (keep ungrouped).
	if (args.aliasOverride !== undefined) {
		return { logicalModel: args.aliasOverride, source: "alias" };
	}

	// 2. Local config logical_model.
	if (args.configLogicalModel !== undefined) {
		return { logicalModel: args.configLogicalModel, source: "config" };
	}

	// 3. Structural normalization, gated by the confidence predicate.
	const { key, recognizedNamespace } = normalizeModelKey(args.provider, args.providerModelId);
	const matches = args.modelsDevKeys.has(key) || args.confirmedLogicalKeys.has(key);
	if (recognizedNamespace && matches) {
		return { logicalModel: key, source: "normalization" };
	}

	return { logicalModel: null, source: "unassigned" };
}
