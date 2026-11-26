/**
 * Catalog orchestrator (R-MC2/R-MC3/R-MC4/R-MC8/R-MC9,
 * 2026-11-21-model-catalog.md §3–§6).
 *
 * Ties the three per-backend metadata layers — local `model_backends` config
 * overrides, live provider discovery, and the cached `models.dev` snapshot —
 * and the two-pass logical-model grouping into one `Map<backendId,
 * ResolvedBackend>` that the production start path (`cli/.../inference.ts`)
 * consumes to advertise resolved metadata and gate readiness.
 *
 * PURE over its declared inputs: the caller supplies each backend's discovery
 * results (already fetched via the driver's `discoverModels()` hook) and the
 * indexed `models.dev` snapshot, so this module performs NO IO and is fully
 * unit-testable. Branching is structural, never on specific model names (R-MC1).
 *
 * Grouping needs two passes (§6.2): a backend can auto-group onto a logical
 * model confirmed by a HIGHER-precedence tier on a DIFFERENT backend (alias or
 * config). Pass 1 resolves alias/config to collect the confirmed canonical
 * keys; pass 2 resolves every backend with that confirmed-key set available so
 * normalization can attach to a cluster-confirmed model even when the key is
 * absent from `models.dev`.
 */

import type { DiscoveredModel } from "./discovery";
import { lookupModelsDevScoped } from "./models-dev-cache";
import { resolveLogicalModel } from "./resolve-grouping";
import type { GroupingSource } from "./resolve-grouping";
import { type MetadataLayer, type ModelMetadata, resolveModelMetadata } from "./resolve-metadata";

/** One backend's inputs to catalog resolution. */
export interface CatalogBackendInput {
	/** Router backend id (the map key in the result). */
	backendId: string;
	/** Backend provider (`anthropic`, `bedrock`, `openai-compatible`, …). */
	provider: string;
	/** Raw upstream model id, used for normalization + `models.dev` matching. */
	providerModelId: string;
	/** Local `model_backends` config overrides (highest-precedence layer). */
	config: MetadataLayer;
	/**
	 * This backend's provider's live discovery lineup (the whole list from
	 * `discoverModels()`). Only the row whose id matches `providerModelId`
	 * contributes to this backend's provider layer. Empty when the driver has no
	 * discovery hook or the fetch failed (R-MC6: resolution still succeeds).
	 */
	discovery: readonly DiscoveredModel[];
}

export interface ResolveCatalogArgs {
	backends: readonly CatalogBackendInput[];
	/** Indexed `models.dev` snapshot (canonical key → gap-filling layer). */
	modelsDev: ReadonlyMap<string, MetadataLayer>;
	/**
	 * Synced `model_aliases` overrides keyed by `${provider}:${providerModelId}`.
	 * A present `null` value means "keep ungrouped"; absence means "no alias".
	 */
	aliases: ReadonlyMap<string, string | null>;
}

export interface ResolvedBackend {
	metadata: ModelMetadata;
	/** False when `max_context` is unresolved across all layers (R-MC4). */
	ready: boolean;
	/** Human-readable gap when `ready` is false; empty string otherwise. */
	configGap: string;
	/** Resolved logical model, or null when the backend stays unassigned. */
	logicalModel: string | null;
	/** Which precedence tier decided the logical model. */
	groupingSource: GroupingSource;
}

/** The provider-layer contribution for a backend: the discovery row matching its id. */
function providerLayer(input: CatalogBackendInput): MetadataLayer {
	const row = input.discovery.find((m) => m.providerModelId === input.providerModelId);
	if (!row) return {};
	const layer: MetadataLayer = {};
	if (row.displayName !== undefined) layer.display_name = row.displayName;
	if (row.capabilities) layer.capabilities = row.capabilities;
	if (row.maxOutputTokens !== undefined) layer.max_output_tokens = row.maxOutputTokens;
	if (row.pricing) layer.pricing = row.pricing;
	if (row.vendor !== undefined) layer.vendor = row.vendor;
	if (row.allowedFallbackModels !== undefined) {
		layer.allowed_fallback_models = row.allowedFallbackModels;
	}
	return layer;
}

/** Alias lookup key for a backend. */
function aliasKey(provider: string, providerModelId: string): string {
	return `${provider}:${providerModelId}`;
}

/**
 * Resolve the full catalog: merge metadata layers and group logical models
 * across every backend in two passes.
 */
export function resolveCatalog(args: ResolveCatalogArgs): Map<string, ResolvedBackend> {
	// Pass 1: collect the canonical keys confirmed by a higher-precedence tier
	// (explicit alias string or local config logical_model). These become the
	// attach targets normalization may auto-group onto in pass 2. An explicit
	// null alias confirms nothing (it is a deliberate "stay ungrouped").
	const confirmedLogicalKeys = new Set<string>();
	for (const b of args.backends) {
		const alias = args.aliases.get(aliasKey(b.provider, b.providerModelId));
		if (typeof alias === "string") {
			confirmedLogicalKeys.add(alias);
			continue;
		}
		if (alias === null) continue;
		if (b.config.logical_model !== undefined && b.config.logical_model !== null) {
			confirmedLogicalKeys.add(b.config.logical_model);
		}
	}

	const modelsDevKeys = new Set(args.modelsDev.keys());

	// Pass 2: resolve metadata + grouping for every backend.
	const result = new Map<string, ResolvedBackend>();
	for (const b of args.backends) {
		// Provider-scoped models.dev lookup: prefer the entry under
		// this backend's OWN provider namespace before the cross-provider canonical
		// index, so a model id that collides across providers resolves to its own
		// provider's limits. Falls back to the canonical index when the provider has
		// no mapped namespace or the model is absent from it.
		const modelsDev = b.providerModelId
			? (lookupModelsDevScoped(args.modelsDev, b.provider, b.providerModelId) ?? {})
			: {};

		const { metadata, ready, configGap } = resolveModelMetadata({
			providerModelId: b.providerModelId,
			config: b.config,
			provider: providerLayer(b),
			modelsDev,
		});

		const grouping = resolveLogicalModel({
			provider: b.provider,
			providerModelId: b.providerModelId,
			aliasOverride: args.aliases.get(aliasKey(b.provider, b.providerModelId)),
			configLogicalModel: b.config.logical_model === null ? undefined : b.config.logical_model,
			modelsDevKeys,
			confirmedLogicalKeys,
		});

		// The grouping result is authoritative for the advertised `logical_model`
		// (alias/config/normalization), superseding the metadata layer's
		// config-only `logical_model`.
		metadata.logical_model = grouping.logicalModel;
		if (grouping.source === "config" || grouping.source === "alias") {
			if (grouping.logicalModel !== null) metadata.field_sources.logical_model = "config";
		}

		result.set(b.backendId, {
			metadata,
			ready,
			configGap,
			logicalModel: grouping.logicalModel,
			groupingSource: grouping.source,
		});
	}
	return result;
}
