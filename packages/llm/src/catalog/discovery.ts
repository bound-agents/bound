/**
 * Provider-discovery hook contract (slice 6, R-MC3, 2026-11-21-model-catalog.md
 * §4.1).
 *
 * A driver MAY implement `discoverModels()` to query its provider's native
 * inventory endpoint using the HOST's own local credentials and return the live
 * lineup plus whatever metadata fields the endpoint exposes. Discovery is layer
 * 2 of metadata resolution (`resolve-metadata.ts`): it never grants availability
 * that `models.dev` would otherwise withhold, and per-account entitlements are
 * respected automatically because the call runs locally with that host's creds
 * (R-MC3). A `models.dev` entry absent from a host's own discovery is never
 * advertised by that host.
 *
 * The shape is provider-neutral: the same `DiscoveredModel` describes an
 * Anthropic `/v1/models` row, an OpenAI-compatible `/v1/models` row, a Bedrock
 * `ListFoundationModels` entry, or an Ollama `/api/tags` + `/api/show` pair.
 * `allowed_fallback_models` is populated only by providers that publish it
 * (Anthropic with the fallback beta header; catalog §4.1).
 */

import type { ResolvedCapabilities, ResolvedPricing } from "./resolve-metadata";

/**
 * One live model from provider discovery. All metadata fields are optional: a
 * provider supplies what its API exposes and the lower `models.dev` layer fills
 * the rest. `providerModelId` is the raw upstream id (used for normalization +
 * `models.dev` matching); it is always present.
 */
export interface DiscoveredModel {
	providerModelId: string;
	capabilities?: ResolvedCapabilities;
	maxOutputTokens?: number;
	pricing?: ResolvedPricing;
	vendor?: string | null;
	/** Provider-published fallback targets (Anthropic fallback beta; catalog §4.1). */
	allowedFallbackModels?: string[];
}

/**
 * Optional driver discovery hook. A driver with a static, fully-known lineup
 * omits it (its metadata comes from config + `models.dev`); a driver that can
 * enumerate its provider's live inventory implements it. The call uses the
 * driver's already-configured credentials and must resolve (never throw) on a
 * reachable-but-empty provider, returning `[]`. Transport/credential failures
 * reject so the caller can fall back to config + `models.dev` without blocking
 * startup (R-MC6 parallels this for `models.dev`).
 */
export interface SupportsModelDiscovery {
	discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
}

/** Type guard: does this value implement the discovery hook? */
export function supportsModelDiscovery(value: unknown): value is SupportsModelDiscovery {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as SupportsModelDiscovery).discoverModels === "function"
	);
}
