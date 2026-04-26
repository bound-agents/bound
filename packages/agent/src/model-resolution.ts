import type { Database } from "bun:sqlite";
import type {
	BackendCapabilities,
	CapabilityRequirements,
	ChatParams,
	LLMBackend,
	ModelRouter,
} from "@bound/llm";

import type { HostModelEntry } from "@bound/shared";

import { type EligibleHost, findAnyRemoteModel, findEligibleHostsByModel } from "./relay-router";

export type ModelResolution =
	| {
			kind: "local";
			backend: LLMBackend;
			modelId: string;
			reResolved?: boolean;
			// Carries both legacy `{type:"enabled", budget_tokens}` and
			// adaptive `{type:"adaptive", display?}` shapes; see ChatParams.
			thinkingConfig?: ChatParams["thinking"];
			// Top-level output_config.effort — depth control for Opus 4.7.
			effort?: ChatParams["effort"];
			// Per-backend cap on `maxOutputTokens`. When set, the agent-loop
			// takes `min(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS)` so
			// backends with tight limits (e.g. Nova Pro = 10_000) don't 400
			// with "max_tokens exceeds model limit of N".
			maxOutputTokens?: number;
	  }
	| { kind: "remote"; hosts: EligibleHost[]; modelId: string; reResolved?: boolean }
	| {
			kind: "error";
			error: string;
			reason?: "capability-mismatch" | "transient-unavailable";
			unmetCapabilities?: string[];
			alternatives?: string[];
			earliestRecovery?: number;
	  };

/**
 * Checks whether caps satisfy all requirements. Returns an array of unmet requirement
 * field names (empty if all requirements are met).
 */
function getUnmetCapabilities(
	caps: BackendCapabilities,
	requirements: CapabilityRequirements,
): string[] {
	const unmet: string[] = [];
	if (requirements.vision && !caps.vision) unmet.push("vision");
	if (requirements.tool_use && !caps.tool_use) unmet.push("tool_use");
	if (requirements.system_prompt && !caps.system_prompt) unmet.push("system_prompt");
	if (requirements.prompt_caching && !caps.prompt_caching) unmet.push("prompt_caching");
	return unmet;
}

/**
 * Resolves the tier for a model by checking the local router first, then the hosts table.
 * Returns null if the model is not found anywhere.
 */
export function resolveModelTier(
	modelId: string,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
): number | null {
	// Check local router first
	const localTier = modelRouter.getBackendTier(modelId);
	if (localTier !== null) return localTier;

	// Fall back to hosts table (remote models)
	const rows = db
		.query("SELECT models FROM hosts WHERE deleted = 0 AND site_id != ?")
		.all(localSiteId) as Array<{ models: string | null }>;

	let bestTier: number | null = null;
	for (const row of rows) {
		if (!row.models) continue;
		let rawModels: unknown;
		try {
			rawModels = JSON.parse(row.models);
		} catch {
			continue;
		}
		if (!Array.isArray(rawModels)) continue;
		for (const entry of rawModels) {
			if (entry && typeof entry === "object" && (entry as HostModelEntry).id === modelId) {
				const tier = (entry as HostModelEntry).tier;
				if (tier !== undefined && (bestTier === null || tier < bestTier)) {
					bestTier = tier;
				}
			}
		}
	}
	return bestTier;
}

/**
 * Attempts to find a same-tier fallback when the originally-requested model
 * is unavailable. Checks local backends first, then remote hosts.
 * Returns a ModelResolution if a cost-equivalent alternative exists,
 * or null if none found.
 *
 * Excludes the originally-requested model from candidates.
 */
export function resolveSameTierFallback(
	failedModelId: string,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
	tier: number,
	requirements?: CapabilityRequirements,
): ModelResolution | null {
	// Try local backends first
	const localCandidates = modelRouter.listEligibleByTier(tier, requirements);
	const localAlt = localCandidates.find((b) => b.id !== failedModelId);
	if (localAlt) {
		const backend = modelRouter.tryGetBackend(localAlt.id);
		if (backend) {
			return {
				kind: "local",
				backend,
				modelId: localAlt.id,
				reResolved: true,
				thinkingConfig: modelRouter.getThinkingConfig(localAlt.id),
				effort: modelRouter.getEffort(localAlt.id),
			};
		}
	}

	// Fall back to remote hosts with a same-tier, different model
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, models, online_at, modified_at
			 FROM hosts WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		models: string | null;
		online_at: string | null;
		modified_at: string | null;
	}>;

	const STALE_THRESHOLD_MS = 5 * 60 * 1000;
	const remoteHosts: Array<EligibleHost & { modelId: string }> = [];

	for (const row of rows) {
		if (!row.models) continue;
		const ts = row.modified_at ?? row.online_at;
		if (!ts || Date.now() - new Date(ts).getTime() > STALE_THRESHOLD_MS) continue;

		let rawModels: unknown;
		try {
			rawModels = JSON.parse(row.models);
		} catch {
			continue;
		}
		if (!Array.isArray(rawModels)) continue;

		for (const entry of rawModels) {
			if (!entry || typeof entry !== "object") continue;
			const hostEntry = entry as HostModelEntry;
			if (!hostEntry.id || hostEntry.id === failedModelId) continue;
			if (hostEntry.tier !== tier) continue;

			// Apply capability requirements if provided
			if (requirements && hostEntry.capabilities) {
				const caps = hostEntry.capabilities;
				if (requirements.vision && !caps.vision) continue;
				if (requirements.tool_use && !caps.tool_use) continue;
				if (requirements.system_prompt && !caps.system_prompt) continue;
				if (requirements.prompt_caching && !caps.prompt_caching) continue;
			}

			remoteHosts.push({
				site_id: row.site_id,
				host_name: row.host_name,
				sync_url: row.sync_url,
				online_at: row.online_at,
				tier: hostEntry.tier,
				modelId: hostEntry.id,
			});
		}
	}

	if (remoteHosts.length === 0) return null;

	// Sort by online_at (most recent first)
	remoteHosts.sort((a, b) => {
		if (!a.online_at && !b.online_at) return 0;
		if (!a.online_at) return 1;
		if (!b.online_at) return -1;
		return new Date(b.online_at).getTime() - new Date(a.online_at).getTime();
	});

	const best = remoteHosts[0];
	return {
		kind: "remote",
		hosts: remoteHosts.map(({ modelId: _, ...host }) => host),
		modelId: best.modelId,
		reResolved: true,
	};
}

/**
 * Resolves a model ID through a three-phase pipeline: identify → qualify → dispatch.
 *
 * Phase 1 (identify): Check local backends first, then remote hosts.
 * Phase 2 (qualify): If requirements are provided, check the identified backend's effective
 *   capabilities. On mismatch, try to re-route to an eligible alternative. Distinguish
 *   capability-mismatch (no backend has the capability) from transient-unavailable (capable
 *   backends exist but are all rate-limited).
 * Phase 3 (dispatch): Return the qualified resolution.
 *
 * Backward-compatible: when requirements is undefined (text-only requests), the qualify
 * phase is a no-op and resolution behaves identically to before.
 */
export function resolveModel(
	modelId: string | undefined,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
	requirements?: CapabilityRequirements,
): ModelResolution {
	const effectiveModelId = !modelId || modelId === "default" ? modelRouter.getDefaultId() : modelId;

	// Phase 1: Identify — check local backends first
	const localBackend = modelRouter.tryGetBackend(effectiveModelId);

	if (localBackend) {
		// Phase 2: Qualify (local)
		if (requirements) {
			const caps = modelRouter.getEffectiveCapabilities(effectiveModelId);
			const unmet = caps ? getUnmetCapabilities(caps, requirements) : Object.keys(requirements);

			if (unmet.length > 0) {
				// Primary backend lacks required capability — try eligible alternatives
				const eligible = modelRouter.listEligible(requirements);
				if (eligible.length > 0) {
					// Re-route to first eligible alternative
					const altId = eligible[0].id;
					const altBackend = modelRouter.tryGetBackend(altId);
					if (altBackend) {
						// Phase 3: Dispatch (re-routed local)
						return {
							kind: "local",
							backend: altBackend,
							modelId: altId,
							reResolved: true,
							thinkingConfig: modelRouter.getThinkingConfig(altId),
							effort: modelRouter.getEffort(altId),
							maxOutputTokens: modelRouter.getMaxOutputTokens(altId),
						};
					}
				}

				// No eligible alternative — distinguish transient vs permanent
				const earliestRecovery = modelRouter.getEarliestCapableRecovery(requirements);
				if (earliestRecovery !== null) {
					// Capable backends exist but are all rate-limited
					return {
						kind: "error",
						error: "No backends available — all capable backends are rate-limited",
						reason: "transient-unavailable",
						unmetCapabilities: unmet,
						earliestRecovery,
					};
				}

				// No backend in cluster has the required capability
				return {
					kind: "error",
					error: `No backends support required capabilities: ${unmet.join(", ")}`,
					reason: "capability-mismatch",
					unmetCapabilities: unmet,
					alternatives: [],
				};
			}
		}

		// Phase 3: Dispatch (local, qualification passed)
		return {
			kind: "local",
			backend: localBackend,
			modelId: effectiveModelId,
			thinkingConfig: modelRouter.getThinkingConfig(effectiveModelId),
			effort: modelRouter.getEffort(effectiveModelId),
			maxOutputTokens: modelRouter.getMaxOutputTokens(effectiveModelId),
		};
	}

	// Hub-only mode: if effectiveModelId is empty (no local backends, no user-specified model),
	// fall back to discovering any available remote model in the cluster.
	if (!effectiveModelId) {
		const anyRemote = findAnyRemoteModel(db, localSiteId);
		if (anyRemote.ok) {
			return { kind: "remote", hosts: anyRemote.hosts, modelId: anyRemote.modelId };
		}
		return {
			kind: "error",
			error: `Hub-only mode: no remote inference backends available. ${anyRemote.error}`,
		};
	}

	// Phase 1 fallback: check remote hosts
	const remoteResult = findEligibleHostsByModel(db, effectiveModelId, localSiteId, requirements);
	if (remoteResult.ok) {
		// Phase 2: Qualify (remote) — remote capability filtering via requirements parameter
		return { kind: "remote", hosts: remoteResult.hosts, modelId: effectiveModelId };
	}

	// Phase 3: Error (not found anywhere)
	const localIds = modelRouter.listBackends().map((b) => b.id);
	return {
		kind: "error",
		error: `Unknown model "${effectiveModelId}". Local backends: [${localIds.join(", ")}]. ${remoteResult.error}`,
	};
}
