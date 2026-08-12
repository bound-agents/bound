import type { Database } from "bun:sqlite";
import type {
	BackendCapabilities,
	CapabilityRequirements,
	ChatParams,
	LLMBackend,
	ModelRouter,
} from "@bound/llm";

import { listAllHostModels, listRemoteHostModels, listRemoteHostsWithModels } from "@bound/core";
import type { HostModelEntry } from "@bound/shared";

import { type EligibleHost, findAnyRemoteModel, findEligibleHostsByModel } from "./relay-router";

export type ModelResolution =
	| {
			kind: "local";
			backend: LLMBackend;
			modelId: string;
			reResolved?: boolean;
			// Carries provider-native thinking config; tool mode resolves to explicit
			// disabled native reasoning so drivers never fall back to their default.
			thinkingConfig?: ChatParams["thinking"];
			/** Expose Bound's synthetic think tool for this backend. */
			thinkingTool?: boolean;
			// Top-level output_config.effort — depth control for Opus 4.7.
			effort?: ChatParams["effort"];
			// Per-backend cap on `maxOutputTokens`. When set, the agent-loop
			// takes `min(maxOutputTokens, configuredMax)` so
			// backends with tight limits (e.g. Nova Pro = 10_000) don't 400
			// with "max_tokens exceeds model limit of N".
			maxOutputTokens?: number;
			// Cache TTL hint for the provider's cachePoint. "5m" or "1h".
			// See ChatParams.cache_ttl for provider support details.
			cacheTtl?: ChatParams["cache_ttl"];
			// Context window in tokens, from the backend's capabilities.
			// Populated at resolution time so consumers (prepareFrame, etc.)
			// don't need a separate getEffectiveCapabilities() call. Required:
			// a resolution that can't determine the window is a `kind: "error"`,
			// never a live resolution carrying a guessed default.
			max_context: number;
	  }
	| {
			kind: "remote";
			hosts: EligibleHost[];
			modelId: string;
			reResolved?: boolean;
			/** Mirrored from the serving host's advertised config. */
			thinkingTool?: boolean;
			thinkingConfig?: ChatParams["thinking"];
			max_context: number;
	  }
	| {
			kind: "error";
			error: string;
			// "unknown-model" is PERMANENT: the model is registered nowhere in the cluster
			// (decommissioned). The scheduler parks such tasks instead of rescheduling them
			// forever (poison-pill parking). "transient-unavailable" / "capability-mismatch"
			// are RETRYABLE: the model is real but momentarily unreachable or capability-gated.
			reason?: "capability-mismatch" | "transient-unavailable" | "unknown-model";
			unmetCapabilities?: string[];
			alternatives?: string[];
			earliestRecovery?: number;
	  };

/**
 * Target backend capabilities for a resolution, used to gate Stage 5b
 * content substitution (image→text when the backend lacks vision).
 *
 * The remote branch MUST return the serving host's advertised
 * capabilities, not `undefined`: a remote non-vision backend that resolved
 * to `undefined` here bypassed the vision substitution gate and shipped
 * raw image blocks to a text-only provider, hard-failing the turn with
 * "messages.content.type is invalid, allowed values: ['text']". This
 * mirrors the fallback that `cacheMarkerCaps` already used in the loop.
 */
export function resolveTargetCapabilities(
	resolution: ModelResolution,
	modelRouter: Pick<ModelRouter, "getEffectiveCapabilities">,
): BackendCapabilities | null {
	if (resolution.kind === "local") {
		return modelRouter.getEffectiveCapabilities(resolution.modelId);
	}
	if (resolution.kind === "remote") {
		// The wire-advertised host caps are a partial shape (all fields
		// optional, no extended_thinking). Normalize to a full
		// BackendCapabilities, defaulting vision to false when unadvertised so
		// we never ship raw image blocks to a backend we can't confirm
		// supports them.
		const caps = resolution.hosts[0]?.capabilities;
		if (!caps) return null;
		return {
			streaming: caps.streaming ?? false,
			tool_use: caps.tool_use ?? false,
			system_prompt: caps.system_prompt ?? false,
			prompt_caching: caps.prompt_caching ?? false,
			vision: caps.vision ?? false,
			extended_thinking: false,
			max_context: caps.max_context,
		};
	}
	return null;
}

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
	const rows = listRemoteHostModels(db, localSiteId);

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
 * Builds a `kind: "local"` resolution, or `null` when the backend advertises
 * no context window. A ready local backend always has one — config requires
 * `context_window` for non-umans backends, umans fetches it at warmup, and the
 * not-ready gate keeps self-configuring placeholders out of resolution — so
 * `null` here means a genuine misconfiguration. Callers surface it as
 * `kind: "error"` (or skip the candidate) rather than dispatching a real turn
 * on a guessed window.
 */
function buildLocalResolution(
	modelRouter: ModelRouter,
	backend: LLMBackend,
	modelId: string,
	reResolved: boolean,
): Extract<ModelResolution, { kind: "local" }> | null {
	const max_context = modelRouter.getEffectiveCapabilities(modelId)?.max_context;
	if (max_context === undefined) return null;
	return {
		kind: "local",
		backend,
		modelId,
		...(reResolved ? { reResolved: true } : {}),
		thinkingConfig: modelRouter.getThinkingConfig(modelId),
		thinkingTool: modelRouter.usesThinkingTool(modelId),
		effort: modelRouter.getEffort(modelId),
		maxOutputTokens: modelRouter.getMaxOutputTokens(modelId),
		cacheTtl: modelRouter.getCacheTtl(modelId),
		max_context,
	};
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
			const localResolution = buildLocalResolution(modelRouter, backend, localAlt.id, true);
			// A fallback candidate that advertises no context window is not viable;
			// fall through to remote rather than dispatch on a guessed default.
			if (localResolution) return localResolution;
		}
	}

	// Fall back to remote hosts with a same-tier, different model
	const rows = listRemoteHostsWithModels(db, localSiteId);

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

			// A same-tier fallback host that advertises no context window is not
			// viable — the loop couldn't budget against it. Skip it rather than
			// carry it to a guessed default.
			if (hostEntry.capabilities?.max_context === undefined) continue;

			remoteHosts.push({
				site_id: row.site_id,
				host_name: row.host_name,
				sync_url: row.sync_url,
				online_at: row.online_at,
				modified_at: row.modified_at,
				tier: hostEntry.tier,
				capabilities: hostEntry.capabilities,
				modelId: hostEntry.id,
			});
		}
	}

	if (remoteHosts.length === 0) return null;

	// Sort by freshness (most recent first), modified_at preferred over online_at
	remoteHosts.sort((a, b) => {
		const aTs = a.modified_at ?? a.online_at;
		const bTs = b.modified_at ?? b.online_at;
		if (!aTs && !bTs) return 0;
		if (!aTs) return 1;
		if (!bTs) return -1;
		return new Date(bTs).getTime() - new Date(aTs).getTime();
	});

	const best = remoteHosts[0];
	const max_context = best.capabilities?.max_context;
	// Defensive: the collection loop skips hosts without a window, so this is
	// non-null here. The guard keeps the type honest without a non-null assertion.
	if (max_context === undefined) return null;
	return {
		kind: "remote",
		hosts: remoteHosts.map(({ modelId: _, ...host }) => host),
		modelId: best.modelId,
		reResolved: true,
		max_context,
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

	// Phase 0: Readiness gate. A backend exposing async self-configuration
	// (`readiness`) registers a not-ready placeholder/namespace id until its
	// lineup fetch lands. `tryGetBackend` is NOT readiness-gated, so without
	// this short-circuit a not-ready umans default/named model would resolve
	// `kind:"local"` and run a real turn on guessed pricing/limits — the exact
	// thing gating must prevent. Placing the gate at the TOP (before the
	// requirements branch) also covers no-requirements callers like
	// `acquireSummaryBackend`. The resolution is retryable: a sub-second warmup
	// later resolves locally. Provider-agnostic — no umans names.
	if (effectiveModelId && modelRouter.isNotReady(effectiveModelId)) {
		const earliestRecovery = modelRouter.getEarliestCapableRecovery(requirements);
		return {
			kind: "error",
			error: `Model "${effectiveModelId}" is not ready yet (self-configuring backend warming up)`,
			reason: "transient-unavailable",
			...(earliestRecovery !== null ? { earliestRecovery } : {}),
		};
	}

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
						const altResolution = buildLocalResolution(modelRouter, altBackend, altId, true);
						// No advertised window → not a viable alternative; fall through
						// to the transient/capability error paths below.
						if (altResolution) return altResolution;
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
		const localResolution = buildLocalResolution(
			modelRouter,
			localBackend,
			effectiveModelId,
			false,
		);
		if (localResolution) return localResolution;
		// A ready local backend that advertises no context window is a
		// misconfiguration — surface it rather than dispatch on a guessed window.
		return {
			kind: "error",
			error: `Model "${effectiveModelId}" resolved to a local backend that advertises no context window`,
			reason: "transient-unavailable",
		};
	}

	// Hub-only mode: if effectiveModelId is empty (no local backends, no user-specified model),
	// fall back to discovering any available remote model in the cluster.
	if (!effectiveModelId) {
		const anyRemote = findAnyRemoteModel(db, localSiteId);
		if (anyRemote.ok) {
			const max_context = anyRemote.hosts[0]?.capabilities?.max_context;
			if (max_context === undefined) {
				return {
					kind: "error",
					error: `Remote model "${anyRemote.modelId}" resolved but the host advertises no context window`,
					reason: "transient-unavailable",
				};
			}
			return {
				kind: "remote",
				hosts: anyRemote.hosts,
				modelId: anyRemote.modelId,
				thinkingTool: anyRemote.hosts[0]?.thinkingMode === "tool",
				thinkingConfig:
					anyRemote.hosts[0]?.thinkingMode === "tool" ? { type: "disabled" } : undefined,
				max_context,
			};
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
		const max_context = remoteResult.hosts[0]?.capabilities?.max_context;
		if (max_context === undefined) {
			return {
				kind: "error",
				error: `Model "${effectiveModelId}" resolved to a remote host that advertises no context window`,
				reason: "transient-unavailable",
			};
		}
		return {
			kind: "remote",
			hosts: remoteResult.hosts,
			modelId: effectiveModelId,
			thinkingTool: remoteResult.hosts[0]?.thinkingMode === "tool",
			thinkingConfig:
				remoteResult.hosts[0]?.thinkingMode === "tool" ? { type: "disabled" } : undefined,
			max_context,
		};
	}

	// Phase 3: Error (not found anywhere)
	const localIds = modelRouter.listBackends().map((b) => b.id);
	// Distinguish a decommissioned model (registered NOWHERE → permanent → park) from a
	// model that is real but transiently unreachable (registered on an offline/stale host
	// → retry). Liveness is deliberately ignored here: an offline host that still
	// advertises the model means the model may return when the host reconnects.
	const knownInCluster = isModelRegisteredInCluster(effectiveModelId, modelRouter, db);
	return {
		kind: "error",
		error: `Unknown model "${effectiveModelId}". Local backends: [${localIds.join(", ")}]. ${remoteResult.error}`,
		reason: knownInCluster ? "transient-unavailable" : "unknown-model",
	};
}

/**
 * Checks whether a model id is registered anywhere in the cluster — local router
 * backends OR any host's advertised models — WITHOUT any staleness filter.
 *
 * This is the permanent-vs-transient discriminator for resolution failures. A model
 * registered on some (possibly offline) host is transiently unavailable and should be
 * retried; a model registered nowhere is decommissioned and the owning task should be
 * parked rather than rescheduled forever (poison-pill parking).
 *
 * Deliberately ignores host liveness (online_at / modified_at) and includes the local
 * site's own hosts row: only genuine absence from every host's config and the local
 * router counts as "unknown". This conservatism is intentional — a false "unknown"
 * would park a real model's task, which is strictly worse than an extra retry.
 */
function isModelRegisteredInCluster(
	modelId: string,
	modelRouter: ModelRouter,
	db: Database,
): boolean {
	// Live/configured local router backends.
	if (modelRouter.listBackends().some((b) => b.id === modelId)) return true;

	// Any host's advertised models, staleness-ignored, all sites included.
	const rows = listAllHostModels(db);
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
			if (typeof entry === "string") {
				if (entry === modelId) return true;
			} else if (entry && typeof entry === "object" && (entry as HostModelEntry).id === modelId) {
				return true;
			}
		}
	}
	return false;
}
