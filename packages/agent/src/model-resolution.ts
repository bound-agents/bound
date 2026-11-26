import type { Database } from "bun:sqlite";
import {
	type BackendCapabilities,
	type CapabilityRequirements,
	type ChatParams,
	DEFAULT_BACKEND_CAPABILITIES,
	type LLMBackend,
	type ModelRouter,
	normalizeModelKey,
} from "@bound/llm";

import {
	computeEffectiveCacheWindowMs,
	findClusterConfigValueByKey,
	findLatestOkTurnRouteByThread,
	listAllHostModels,
} from "@bound/core";
import {
	type ClusterModelRoles,
	type HostModelEntry,
	ROUTING_MODEL_ROLES_KEY,
	hintMatchesLogicalModel,
	resolveModelRoleTarget,
} from "@bound/shared";
import {
	cacheTtlToMs,
	loadDrainedRouteIds,
	loadRouteOrder,
	resolveStickyRoute,
} from "./routing-preferences";

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
			systemPromptSuffix?: string;
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
			maxOutputTokens?: number;
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
		const d = DEFAULT_BACKEND_CAPABILITIES;
		return {
			streaming: caps.streaming ?? d.streaming,
			tool_use: caps.tool_use ?? d.tool_use,
			system_prompt: caps.system_prompt ?? d.system_prompt,
			prompt_caching: caps.prompt_caching ?? d.prompt_caching,
			vision: caps.vision ?? d.vision,
			extended_thinking: d.extended_thinking,
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
		systemPromptSuffix: modelRouter.getSystemPromptSuffix(modelId),
		cacheTtl: modelRouter.getCacheTtl(modelId),
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
const MODEL_RECONNECT_POLL_INTERVAL_MS = 1_000;
export const MAX_MODEL_RECONNECT_WAIT_MS = 120_000;

export interface WaitForModelResolutionOptions {
	initial: ModelResolution;
	resolve: () => ModelResolution;
	timeoutMs: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
}

/**
 * Wait for a model which is known to exist but is temporarily unavailable, such
 * as one advertised by a remote host whose heartbeat has gone stale. This is
 * intentionally separate from resolveModel(): model listing and configuration
 * validation must remain instantaneous; inference callers opt into the wait.
 */
export async function waitForModelResolution({
	initial,
	resolve,
	timeoutMs,
	pollIntervalMs = MODEL_RECONNECT_POLL_INTERVAL_MS,
	signal,
}: WaitForModelResolutionOptions): Promise<ModelResolution> {
	if (initial.kind !== "error" || initial.reason !== "transient-unavailable" || timeoutMs <= 0) {
		return initial;
	}

	let latest: ModelResolution = initial;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !signal?.aborted) {
		await new Promise<void>((resolveSleep) => {
			const finish = () => {
				signal?.removeEventListener("abort", abort);
				resolveSleep();
			};
			const abort = () => {
				clearTimeout(timeout);
				finish();
			};
			const timeout = setTimeout(finish, Math.min(pollIntervalMs, deadline - Date.now()));
			if (signal) signal.addEventListener("abort", abort, { once: true });
		});
		if (signal?.aborted) break;
		latest = resolve();
		if (latest.kind !== "error" || latest.reason !== "transient-unavailable") return latest;
	}
	return latest;
}

export interface ResolveModelPrefs {
	/**
	 * The thread whose latest ok turn drives stickiness (§5.3). When absent,
	 * stickiness is skipped and resolution behaves as pure ranked selection.
	 */
	threadId?: string;
	/**
	 * A hard route pin (§5.4). When present, candidate selection considers ONLY
	 * this RouteId and failover/substitution are disabled — the caller enforces
	 * the raw-error surface. resolveModel restricts to the pinned route here.
	 */
	pin?: { routeId: string } | null;
	/** `now` in ms for the sticky cache-window test; defaults to `Date.now()`. */
	nowMs?: number;
}

export function resolveModel(
	modelId: string | undefined,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
	requirements?: CapabilityRequirements,
	prefs?: ResolveModelPrefs,
): ModelResolution {
	// Default-model resolution (§5.1, R-RT9/R-RT14): an omitted or "default"
	// request resolves to the synced cluster role `routing.model_roles.default`
	// first, then to the local `model_backends.default` as a bootstrap fallback.
	const defaultResolved =
		!modelId || modelId === "default" ? resolveDefaultModelId(db, modelRouter) : modelId;

	// Role/alias resolution (§2.1, #281): a hint naming any OTHER cluster role or
	// operator-named alias in `routing.model_roles` follows the mapping to its
	// target logical model, exactly as `"default"` does above. Resolution is a
	// literal-id-first order: a hint that names a registered backend or an
	// advertised entry id is left untouched (an exact id beats an alias of the same
	// name), so this only fires for a bare name that is NOT itself a live id. `@pin`
	// hints never reach here — the pin is handled below on the raw hint.
	const effectiveModelId = resolveRoleAliasModelId(defaultResolved, modelRouter, db);

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

	// Synced routing preferences (§5.2/§6.2): the per-model route_order ranks
	// candidates, and drained routes are excluded from EVERY normal candidate
	// list and half-open trial — not just the sticky pool (R-RT6/R-RT8/R-RT14).
	// Load both once so the sticky-pool builder, the local short-circuit, and
	// the remote finder all honor the same operator preferences.
	const routeOrder = loadRouteOrder(db, effectiveModelId);
	const drainedRouteIds = loadDrainedRouteIds(db);

	// disables failover/substitution. Resolve it directly to that route (local
	// backend whose RouteId matches, else the remote host advertising it). The
	// caller is responsible for surfacing any error raw (no retry/substitution).
	if (prefs?.pin) {
		return resolvePinnedRoute(prefs.pin.routeId, effectiveModelId, modelRouter, db, localSiteId);
	}

	// §5.3 thread-sticky routing: if the thread's latest ok turn ran an eligible
	// route still inside its cache window, reuse it directly even if a
	// higher-ranked route has since recovered. Skipped when no threadId is given
	// (startup/listing/validation callers) or no prior ok turn exists.
	if (prefs?.threadId) {
		const sticky = resolveStickyForThread(
			prefs.threadId,
			effectiveModelId,
			modelRouter,
			db,
			localSiteId,
			requirements,
			prefs.nowMs ?? Date.now(),
			routeOrder,
			drainedRouteIds,
		);
		if (sticky) return sticky;
	}
	// Phase 1: Identify — check local backends first. A hint that matches no local
	// backend id literally can still resolve THROUGH the logical model (#281): an
	// expanded self-configuring backend (`bedrock-use1-openai.gpt-5.6-sol`) carries
	// the logical model the old hand-written hint (`gpt-5.6-sol`) normalizes to.
	// `resolveLocalBackendIdForHint` returns the literal id when it IS registered
	// (literal precedence), else the local backend under the same logical model.
	// Every subsequent local lookup keys off this resolved id.
	const localModelId =
		modelRouter.resolveLocalBackendIdForHint(effectiveModelId) ?? effectiveModelId;
	const localBackend = modelRouter.tryGetBackend(localModelId);
	const localRouteId = localBackend ? modelRouter.getRouteId(localModelId) : null;

	// A local route no longer wins just by existing (R-RT7): when this backend
	// id is within its per-RouteId cooldown (rate-limited / backoff), skip the
	// local short-circuit so resolution falls through to a remote route serving
	// the SAME logical model. Failover never crosses to a different model. A
	// drained local route (§6.2) is likewise skipped — an operator drain removes
	// the route from normal selection on first/cold/no-prior-turn resolutions,
	// not only inside the sticky pool — so resolution falls through to a
	// non-drained remote route for the same model.
	//
	// Half-open trial gating (#285, R-RT12): when the local route is `half_open`
	// (its backoff window expired and it is selectable again) it accepts at most
	// ONE concurrent trial turn per host, and only from a NEW or cold-cache thread
	// — never a warm sticky thread (the sticky pool already excluded it via
	// isHealthyForSticky, so a warm thread arrives here only with no prior turn).
	// Claim the single per-host trial slot here; a losing claim (slot already held
	// by a concurrent trial) drops the local route from THIS resolution so it falls
	// through to a remote route for the same model. A `healthy` route needs no
	// claim. `canTrialRoute` with `claim: true` is a no-op for non-half_open routes
	// (returns false), so it is only consulted when the route is actually half_open.
	const localTrialClaimable = (() => {
		if (!localBackend) return true; // no local route; condition below handles it
		if (modelRouter.getRouteHealthState(localModelId).status !== "half_open") {
			return true; // healthy (or backoff, excluded by isRateLimited) — no claim needed
		}
		const coldOrNewThread = prefs?.threadId
			? findLatestOkTurnRouteByThread(db, prefs.threadId) === null
			: true;
		return modelRouter.canTrialRoute(localModelId, { coldOrNewThread, claim: true });
	})();
	if (
		localBackend &&
		!modelRouter.isRateLimited(localModelId) &&
		!(localRouteId && drainedRouteIds.has(localRouteId)) &&
		localTrialClaimable
	) {
		// Phase 2: Qualify (local)
		if (requirements) {
			const caps = modelRouter.getEffectiveCapabilities(localModelId);
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
		const localResolution = buildLocalResolution(modelRouter, localBackend, localModelId, false);
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
				maxOutputTokens: anyRemote.hosts[0]?.maxOutputTokens,
				max_context,
			};
		}
		return {
			kind: "error",
			error: `Hub-only mode: no remote inference backends available. ${anyRemote.error}`,
		};
	}

	// Phase 1 fallback: check remote hosts
	const remoteResult = findEligibleHostsByModel(db, effectiveModelId, localSiteId, requirements, {
		routeOrder,
		drainedRouteIds,
		normalizeKey: normalizeModelKey,
	});
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
			maxOutputTokens: remoteResult.hosts[0]?.maxOutputTokens,
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
				// A legacy advertisement carries no logical_model, so its only logical
				// identity is the id itself — match the hint through the normalized key.
				if (hintMatchesLogicalModel(modelId, entry, normalizeModelKey)) return true;
			} else if (
				entry &&
				typeof entry === "object" &&
				typeof (entry as HostModelEntry).id === "string"
			) {
				const hostEntry = entry as HostModelEntry;
				if (hostEntry.id === modelId) return true;
				// Literal id missed: a hint resolving THROUGH the logical model keeps the
				// model known-in-cluster (transient, not decommissioned), so the dangling
				// discriminator and resolution agree. Match the advertised logical_model,
				// falling back to the id when the entry carries none.
				if (
					hintMatchesLogicalModel(
						modelId,
						hostEntry.logical_model ?? hostEntry.id,
						normalizeModelKey,
					)
				) {
					return true;
				}
			}
		}
	}
	return false;
}

/**
 * Resolve the model hint for an omitted/"default" request (R-RT7, R-MC10).
 * A configured synced cluster role `routing.model_roles.default` is
 * authoritative: its target is returned as-is and resolved downstream through
 * the same literal-id → logical-model → cross-host route machinery as any
 * explicit hint, so a hub with no local backends reaches the remote routes for
 * that model, and an unavailable configured default surfaces as a resolution
 * error instead of silently switching to another model. The local
 * `model_backends.default` bootstrap applies only when the role is unset —
 * no roles row, malformed JSON, a non-object value, or a missing/empty/
 * non-string `default`.
 */
export function resolveDefaultModelId(db: Database, modelRouter: ModelRouter): string {
	const row = findClusterConfigValueByKey(db, ROUTING_MODEL_ROLES_KEY);
	if (row) {
		try {
			const roles: unknown = JSON.parse(row.value);
			if (roles && typeof roles === "object" && !Array.isArray(roles)) {
				const target = resolveModelRoleTarget(roles as ClusterModelRoles, "default");
				if (target !== null) return target;
			}
		} catch {
			// Malformed roles JSON — the role is unset; use the local bootstrap.
		}
	}
	return modelRouter.getDefaultId();
}

/**
 * Resolve a hint that names a cluster role or operator-named alias to its target
 * logical model (§2.1, #281). The three reserved roles and arbitrary aliases are
 * the same mechanism (`routing.model_roles`: a name → logical model). This fires
 * ONLY when the hint is not itself a live id (literal precedence, R-exact-id): if
 * the hint already names a registered local backend or an advertised cluster
 * entry id, it is returned unchanged so an exact id always beats an alias of the
 * same name. A role/alias whose target is advertised nowhere resolves to that
 * (dead) target and fails downstream exactly as a direct dead hint would — the
 * dangling advisory is the operator's signal. Pins (`<name>@<RouteId>`) never
 * reach here; they carry an `@` and are handled on the raw hint.
 */
function resolveRoleAliasModelId(hint: string, modelRouter: ModelRouter, db: Database): string {
	// Literal precedence: a hint that is already a live id (local backend or any
	// advertised cluster entry) is never reinterpreted as a role/alias.
	if (modelRouter.tryGetBackend(hint)) return hint;
	if (isModelRegisteredInCluster(hint, modelRouter, db)) return hint;

	const row = findClusterConfigValueByKey(db, ROUTING_MODEL_ROLES_KEY);
	if (!row) return hint;
	try {
		const roles = JSON.parse(row.value) as ClusterModelRoles;
		if (roles && typeof roles === "object") {
			const target = resolveModelRoleTarget(roles, hint);
			if (target !== null) return target;
		}
	} catch {
		// Malformed roles JSON — leave the hint untouched.
	}
	return hint;
}

/**
 * Resolve a hard route pin (§5.4) to a single route. Considers ONLY the pinned
 * `RouteId`: a local backend whose recorded RouteId matches, else the remote
 * host advertising it. Failover and substitution are disabled — if the pinned
 * route is not currently available the result is a typed error the caller
 * surfaces raw (no fallback to another route or model). When the pinned route
 * is gone entirely the error is permanent-shaped so the caller can report
 * "pinned route no longer exists" (§6.3).
 */
function resolvePinnedRoute(
	routeId: string,
	effectiveModelId: string,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
): ModelResolution {
	// Local match: a registered backend whose recorded RouteId equals the pin.
	for (const info of modelRouter.listBackends()) {
		if (modelRouter.getRouteId(info.id) === routeId) {
			const backend = modelRouter.tryGetBackend(info.id);
			if (backend) {
				const resolution = buildLocalResolution(modelRouter, backend, info.id, false);
				if (resolution) return resolution;
			}
		}
	}

	// Remote match: a non-stale host advertising exactly this RouteId for the model.
	const remote = findEligibleHostsByModel(db, effectiveModelId, localSiteId);
	if (remote.ok) {
		const host = remote.hosts.find((h) => h.routeId === routeId);
		const max_context = host?.capabilities?.max_context;
		if (host && max_context !== undefined) {
			return {
				kind: "remote",
				hosts: [host],
				modelId: effectiveModelId,
				thinkingTool: host.thinkingMode === "tool",
				thinkingConfig: host.thinkingMode === "tool" ? { type: "disabled" } : undefined,
				maxOutputTokens: host.maxOutputTokens,
				max_context,
			};
		}
	}

	// Pinned route is not currently available. A pin disables failover, so this is
	// terminal for the caller. Distinguish "route gone from the whole cluster"
	// (permanent) from "momentarily unreachable" (retryable) using the drain/host
	// advertisement: if any host still advertises the RouteId it may return.
	const stillAdvertised = isRouteAdvertisedInCluster(routeId, modelRouter, db);
	return {
		kind: "error",
		error: stillAdvertised
			? `Pinned route "${routeId}" is momentarily unavailable`
			: `Pinned route "${routeId}" no longer exists`,
		reason: stillAdvertised ? "transient-unavailable" : "unknown-model",
	};
}

/** True when any host (or the local router) advertises `routeId`, staleness-ignored. */
function isRouteAdvertisedInCluster(
	routeId: string,
	modelRouter: ModelRouter,
	db: Database,
): boolean {
	for (const info of modelRouter.listBackends()) {
		if (modelRouter.getRouteId(info.id) === routeId) return true;
	}
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
			if (entry && typeof entry === "object" && (entry as HostModelEntry).route_id === routeId) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Thread-sticky resolution (§5.3). Reads the thread's latest ok turn, builds the
 * set of currently-eligible routes for the requested model (local + remote,
 * drain-filtered), and reuses the prior route when it is still eligible and
 * within its cache window. Returns null to fall through to ranked selection.
 */
function resolveStickyForThread(
	threadId: string,
	effectiveModelId: string,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
	requirements: CapabilityRequirements | undefined,
	nowMs: number,
	routeOrder: string[] | null,
	drained: ReadonlySet<string>,
): ModelResolution | null {
	const prior = findLatestOkTurnRouteByThread(db, threadId);
	if (!prior || !prior.route_id) return null;

	// Build the eligible-route pool for the requested model and a RouteId -> TTL
	// lookup, spanning local backends and non-stale remote hosts (drain-filtered).
	// `drained` and `routeOrder` are the caller's single load (§5.2/§6.2).
	const eligible = new Set<string>();
	const ttlMsByRoute = new Map<string, number | null>();

	// Local: the requested backend id, when registered, ready, HEALTHY (not in
	// backoff OR half_open), not drained, and meeting the turn's capability
	// requirements. A half_open route is deliberately excluded from the sticky
	// pool (#285, R-RT12): a warm sticky thread must never be used as the trial —
	// only a new/cold-cache thread may trial it, which it does via the ranked
	// first-resolution path below where isRateLimited (backoff-only) gates.
	const localBackend = modelRouter.tryGetBackend(effectiveModelId);
	if (localBackend && modelRouter.isHealthyForSticky(effectiveModelId)) {
		const localRouteId = modelRouter.getRouteId(effectiveModelId);
		const caps = modelRouter.getEffectiveCapabilities(effectiveModelId);
		const meets =
			!requirements || (caps ? getUnmetCapabilities(caps, requirements).length === 0 : false);
		if (localRouteId && !drained.has(localRouteId) && meets) {
			eligible.add(localRouteId);
			ttlMsByRoute.set(localRouteId, cacheTtlToMs(modelRouter.getCacheTtl(effectiveModelId)));
		}
	}

	// Remote: non-stale hosts advertising the model, drain-filtered by the finder.
	const remote = findEligibleHostsByModel(db, effectiveModelId, localSiteId, requirements, {
		routeOrder,
		drainedRouteIds: drained,
		normalizeKey: normalizeModelKey,
	});
	if (remote.ok) {
		for (const host of remote.hosts) {
			if (host.routeId) {
				eligible.add(host.routeId);
				// Remote hosts advertise cache_ttl via the HostModelEntry; the finder
				// does not surface it here, so fall back to the 5m floor (null).
				if (!ttlMsByRoute.has(host.routeId)) ttlMsByRoute.set(host.routeId, null);
			}
		}
	}

	const decision = resolveStickyRoute({
		priorTurn: {
			modelId: prior.model_id,
			routeId: prior.route_id,
			substitutedFrom: prior.substituted_from,
			createdAt: prior.created_at,
		},
		requestedModel: effectiveModelId,
		eligibleRouteIds: eligible,
		// Effective cache window (R-MC16): prefer the window measured from this
		// route's turn history on the serving host; fall back to the lifetime the
		// route last requested (its configured/advertised cache_ttl) when no history
		// exists. The measured window is read only for the local route — remote
		// routes carry no local history to measure from and keep their TTL fallback.
		cacheWindowMsByRoute: (routeId) =>
			computeEffectiveCacheWindowMs(db, routeId, { nowIso: new Date(nowMs).toISOString() }) ??
			ttlMsByRoute.get(routeId) ??
			null,
		nowMs,
	});
	if (decision.kind !== "sticky") return null;

	// The sticky route is eligible — resolve it directly (pin-style, but WITHOUT
	// disabling failover: a later route failure re-resolves normally).
	return resolvePinnedRoute(decision.routeId, effectiveModelId, modelRouter, db, localSiteId);
}
