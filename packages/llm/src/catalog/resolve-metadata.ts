/**
 * Layered metadata resolution + `field_sources` (slice 6, R-MC2/R-MC3/R-MC4,
 * 2026-11-21-model-catalog.md §3).
 *
 * PURE merge layer: given the three metadata inputs for one backend — local
 * `model_backends` config overrides, live provider discovery, and the cached
 * `models.dev` snapshot — it produces the effective `ModelMetadata` and records
 * the winning `field_sources` provenance per field. It owns NOTHING about where
 * the three layers come from (discovery hooks, cache IO) or how the result is
 * advertised; those wire into it. Branching is structural, never on specific
 * model names (R-MC1).
 *
 * Precedence (highest wins per field): config (1) > provider (2) > models.dev (3).
 * A backend stays unready (R-MC4) when `capabilities.max_context` is absent from
 * all three layers — it is never dispatched on a guessed window.
 */

/** Source of a resolved metadata field, recorded for operator inspection. */
export type FieldSource = "config" | "provider" | "models_dev" | "driver_default";

export interface ResolvedCapabilities {
	streaming?: boolean;
	tool_use?: boolean;
	system_prompt?: boolean;
	prompt_caching?: boolean;
	vision?: boolean;
	extended_thinking?: boolean;
	max_context?: number;
}

export interface ResolvedPricing {
	input_per_m?: number;
	output_per_m?: number;
	cache_read_per_m?: number;
	cache_write_5m_per_m?: number;
	cache_write_1h_per_m?: number;
}

/**
 * Effective metadata shape (spec §3.1). `field_sources` is keyed by the flat
 * field name for scalars/capabilities (`max_context`, `vision`, `vendor`,
 * `logical_model`, `max_output_tokens`, `allowed_fallback_models`) and by a
 * dotted `pricing.<field>` for each pricing component.
 */
export interface ModelMetadata {
	provider_model_id: string;
	logical_model: string | null;
	vendor: string | null;
	/**
	 * User-facing model name (spec §2.1, "internal identifiers stay internal").
	 * Provider-published display name > `models.dev` name > the provider model id
	 * verbatim (version dots intact). Never a grouping key or RouteId.
	 */
	display_name: string;
	capabilities: ResolvedCapabilities;
	max_output_tokens?: number;
	pricing?: ResolvedPricing;
	allowed_fallback_models?: string[];
	field_sources: Record<string, FieldSource>;
}

/**
 * One layer's contribution. Every field optional; a layer that does not know a
 * field simply omits it and the next-lower layer fills it. `logical_model` is
 * only meaningfully set by the config layer here — provider/models.dev never
 * assert a logical grouping (that is resolved by the grouping pass, §6).
 */
export interface MetadataLayer {
	logical_model?: string | null;
	vendor?: string | null;
	/** Provider-published or registry display name for this layer, when it supplies one. */
	display_name?: string;
	capabilities?: ResolvedCapabilities;
	max_output_tokens?: number;
	pricing?: ResolvedPricing;
	allowed_fallback_models?: string[];
}

export interface ResolveMetadataArgs {
	providerModelId: string;
	config: MetadataLayer;
	provider: MetadataLayer;
	modelsDev: MetadataLayer;
}

export interface ResolveMetadataResult {
	metadata: ModelMetadata;
	/** False when `capabilities.max_context` is unresolved across all layers (R-MC4). */
	ready: boolean;
	/** Human-readable gap when `ready` is false; empty string otherwise. */
	configGap: string;
}

const CAPABILITY_KEYS: Array<keyof ResolvedCapabilities> = [
	"streaming",
	"tool_use",
	"system_prompt",
	"prompt_caching",
	"vision",
	"extended_thinking",
	"max_context",
];

const PRICING_KEYS: Array<keyof ResolvedPricing> = [
	"input_per_m",
	"output_per_m",
	"cache_read_per_m",
	"cache_write_5m_per_m",
	"cache_write_1h_per_m",
];

/** Ordered layers, highest precedence first, paired with their source tag. */
function orderedLayers(args: ResolveMetadataArgs): Array<[MetadataLayer, FieldSource]> {
	return [
		[args.config, "config"],
		[args.provider, "provider"],
		[args.modelsDev, "models_dev"],
	];
}

/**
 * Resolve the effective metadata by merging the three layers in strict
 * precedence and recording provenance for each field that any layer supplied.
 */
export function resolveModelMetadata(args: ResolveMetadataArgs): ResolveMetadataResult {
	const layers = orderedLayers(args);
	const field_sources: Record<string, FieldSource> = {};
	const capabilities: ResolvedCapabilities = {};
	const pricing: ResolvedPricing = {};

	// Capabilities: first layer (highest precedence) that defines each key wins.
	for (const key of CAPABILITY_KEYS) {
		for (const [layer, source] of layers) {
			const v = layer.capabilities?.[key];
			if (v !== undefined) {
				// biome-ignore lint/suspicious/noExplicitAny: homogeneous capability-key copy
				(capabilities as any)[key] = v;
				field_sources[key] = source;
				break;
			}
		}
	}

	// Pricing components: same per-field precedence, recorded as `pricing.<key>`.
	for (const key of PRICING_KEYS) {
		for (const [layer, source] of layers) {
			const v = layer.pricing?.[key];
			if (v !== undefined) {
				// biome-ignore lint/suspicious/noExplicitAny: homogeneous pricing-key copy
				(pricing as any)[key] = v;
				field_sources[`pricing.${key}`] = source;
				break;
			}
		}
	}

	// Scalar fields.
	let max_output_tokens: number | undefined;
	for (const [layer, source] of layers) {
		if (layer.max_output_tokens !== undefined) {
			max_output_tokens = layer.max_output_tokens;
			field_sources.max_output_tokens = source;
			break;
		}
	}

	let vendor: string | null = null;
	for (const [layer, source] of layers) {
		if (layer.vendor !== undefined && layer.vendor !== null) {
			vendor = layer.vendor;
			field_sources.vendor = source;
			break;
		}
	}

	// logical_model: only the config layer asserts a grouping here; the grouping
	// pass (§6) resolves alias/normalization precedence separately. Default null.
	let logical_model: string | null = null;
	if (args.config.logical_model !== undefined && args.config.logical_model !== null) {
		logical_model = args.config.logical_model;
		field_sources.logical_model = "config";
	}

	// allowed_fallback_models: provider-published only (catalog §4.1). Config may
	// also carry it; precedence config > provider.
	let allowed_fallback_models: string[] | undefined;
	for (const [layer, source] of layers) {
		if (layer.allowed_fallback_models !== undefined) {
			allowed_fallback_models = layer.allowed_fallback_models;
			field_sources.allowed_fallback_models = source;
			break;
		}
	}

	// display_name: user-facing name (spec §2.1). Provider-published > models.dev
	// name > the provider model id verbatim (version dots intact). The final
	// fallback is tagged `driver_default` so the UI never shows an invented
	// string and provenance stays honest about where the name came from.
	let display_name = args.providerModelId;
	field_sources.display_name = "driver_default";
	for (const [layer, source] of layers) {
		if (layer.display_name !== undefined && layer.display_name.length > 0) {
			display_name = layer.display_name;
			field_sources.display_name = source;
			break;
		}
	}

	const metadata: ModelMetadata = {
		provider_model_id: args.providerModelId,
		logical_model,
		vendor,
		display_name,
		capabilities,
		max_output_tokens,
		pricing: Object.keys(pricing).length > 0 ? pricing : undefined,
		allowed_fallback_models,
		field_sources,
	};

	const ready = capabilities.max_context !== undefined;
	const configGap = ready
		? ""
		: `${args.providerModelId}: max_context is unresolved across local config, provider discovery, and models.dev — set context_window in model_backends to make this route ready`;

	return { metadata, ready, configGap };
}
