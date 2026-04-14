import type { Database } from "bun:sqlite";
import type {
	BackendCapabilities,
	CapabilityRequirements,
	LLMBackend,
	ModelRouter,
} from "@bound/llm";

import { type EligibleHost, findAnyRemoteModel, findEligibleHostsByModel } from "./relay-router";

export type ModelResolution =
	| { kind: "local"; backend: LLMBackend; modelId: string; reResolved?: boolean }
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
 * Attempts to find a same-tier local fallback when the originally-requested model
 * is unavailable. Returns a ModelResolution if a cost-equivalent alternative exists,
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
	const candidates = modelRouter.listEligibleByTier(tier, requirements);
	const alternative = candidates.find((b) => b.id !== failedModelId);
	if (!alternative) return null;

	const backend = modelRouter.tryGetBackend(alternative.id);
	if (!backend) return null;

	return { kind: "local", backend, modelId: alternative.id, reResolved: true };
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
						return { kind: "local", backend: altBackend, modelId: altId, reResolved: true };
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
		return { kind: "local", backend: localBackend, modelId: effectiveModelId };
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
