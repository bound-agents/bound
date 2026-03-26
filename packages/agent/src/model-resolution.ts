import type { Database } from "bun:sqlite";
import type { LLMBackend } from "@bound/llm";
import type { ModelRouter } from "@bound/llm";

import { type EligibleHost, findEligibleHostsByModel } from "./relay-router";

export type ModelResolution =
	| { kind: "local"; backend: LLMBackend; modelId: string }
	| { kind: "remote"; hosts: EligibleHost[]; modelId: string }
	| { kind: "error"; error: string };

/**
 * Resolves a model ID to either a local LLM backend or a list of remote eligible hosts.
 *
 * Resolution order:
 * 1. If modelId maps to a local backend in modelRouter → return local
 * 2. If modelId is found on remote hosts → return remote
 * 3. Otherwise → return error with context
 *
 * If modelId is undefined, resolves to the default local backend.
 */
export function resolveModel(
	modelId: string | undefined,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
): ModelResolution {
	const effectiveModelId = modelId ?? modelRouter.getDefaultId();

	// Check local backends first
	const localBackend = modelRouter.tryGetBackend(effectiveModelId);
	if (localBackend) {
		return { kind: "local", backend: localBackend, modelId: effectiveModelId };
	}

	// Fall back to remote hosts
	const remoteResult = findEligibleHostsByModel(db, effectiveModelId, localSiteId);
	if (remoteResult.ok) {
		return { kind: "remote", hosts: remoteResult.hosts, modelId: effectiveModelId };
	}

	// Build informative error — list all known local model IDs
	const localIds = modelRouter.listBackends().map((b) => b.id);
	return {
		kind: "error",
		error: `Unknown model "${effectiveModelId}". Local backends: [${localIds.join(", ")}]. ${remoteResult.error}`,
	};
}
