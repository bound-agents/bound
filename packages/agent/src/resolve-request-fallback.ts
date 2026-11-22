/**
 * Loop-host refusal-fallback resolution for the outgoing inference request
 * (slice 5, R-RT18 step 1, 2026-11-21-model-routing.md §7.3 step 2 "Relay
 * contract"). The loop host resolves the logical model's effective fallback
 * policy and ordered candidate list, then ships them on the inference request
 * so a remote inference host knows the resolved chain without re-deriving it.
 *
 * This is the PURE policy read: it reads `model_routing_rules.fallback_policy`
 * (an absent row means `{ mode: "auto" }`) and the cluster-wide
 * `routing.default_fallback_models`, and produces the two wire fields. The
 * relay fields are optional (Invariant #16): an older inference host ignores
 * both and returns the refusal unchanged.
 */

import type { Database } from "bun:sqlite";
import { findModelRoutingRule } from "@bound/core";
import { findClusterConfigValueByKey } from "@bound/core";
import { ROUTING_DEFAULT_FALLBACK_MODELS_KEY } from "@bound/shared";

/** The two request fields carrying the resolved fallback chain (R-RT18). */
export interface RequestFallbackFields {
	/** The resolved policy mode (never the full custom list — that rides in `fallback_models`). */
	fallback_policy: { mode: "auto" | "never" | "custom" };
	/**
	 * Ordered candidate `LogicalModelId[]` the inference host may walk. Empty for
	 * `never` and for `auto` with no cluster default list. For `custom`, the
	 * operator's declared list minus the refused model. NOT yet filtered by the
	 * turn's capability requirements — the inference host applies that against
	 * its own live backend capabilities when it walks the chain.
	 */
	fallback_models: string[];
}

/** Parse the cluster default fallback list, tolerating absence and malformed JSON. */
function readDefaultFallbackModels(db: Database): string[] {
	const row = findClusterConfigValueByKey(db, ROUTING_DEFAULT_FALLBACK_MODELS_KEY);
	if (!row) return [];
	try {
		const parsed = JSON.parse(row.value);
		return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
	}
}

/** Parse a `model_routing_rules.fallback_policy` cell, tolerating malformed JSON. */
function readPolicy(raw: string | null): { mode: "auto" | "never" | "custom"; models?: string[] } {
	if (!raw) return { mode: "auto" };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && "mode" in parsed) {
			const mode = (parsed as { mode: unknown }).mode;
			if (mode === "never") return { mode: "never" };
			if (mode === "custom") {
				const models = (parsed as { models?: unknown }).models;
				return {
					mode: "custom",
					models: Array.isArray(models)
						? models.filter((m): m is string => typeof m === "string")
						: [],
				};
			}
			if (mode === "auto") return { mode: "auto" };
		}
	} catch {
		// fall through to auto
	}
	return { mode: "auto" };
}

/**
 * Resolve the fallback-chain fields to ship on an inference request for
 * `logicalModel`. See `RequestFallbackFields`.
 */
export function resolveRequestFallback(db: Database, logicalModel: string): RequestFallbackFields {
	const rule = findModelRoutingRule(db, logicalModel);
	const policy = readPolicy(rule?.fallback_policy ?? null);

	if (policy.mode === "never") {
		return { fallback_policy: { mode: "never" }, fallback_models: [] };
	}
	if (policy.mode === "custom") {
		const models = (policy.models ?? []).filter((m) => m !== logicalModel);
		return { fallback_policy: { mode: "custom" }, fallback_models: models };
	}
	// auto: ship the cluster default list; the inference host branches on its
	// own driver's DriverFallbackSupport (server-side vs. walked) when it acts.
	return {
		fallback_policy: { mode: "auto" },
		fallback_models: readDefaultFallbackModels(db).filter((m) => m !== logicalModel),
	};
}
