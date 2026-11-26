/**
 * `models.dev` fallback-registry cache (R-MC5/R-MC6, 2026-11-21-model-catalog.md §5).
 *
 * `models.dev` is a GAP-FILLING metadata fallback (layer 3 of
 * `resolve-metadata.ts`): it fills fields unset by local config and live
 * provider discovery and NEVER grants model availability. This module owns the
 * snapshot's parse/index step and the fetch+disk-cache+ETag+offline lifecycle.
 *
 * Offline resilience (R-MC6): a fetch failure NEVER throws out of `refresh()`
 * and never blocks startup — the host falls back to its on-disk cache, or to an
 * empty index when no cache exists. The cache is LOCAL-ONLY: a plain JSON file
 * on disk, deliberately outside the synced `change_log` tables (R-MC5), because
 * it is public upstream metadata, not cluster state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../is-record";
import { modelsDevNamespaceFor, normalizeModelKey } from "./normalize";
import type { MetadataLayer, PricingTier, ResolvedReasoning } from "./resolve-metadata";

const DEFAULT_URL = "https://models.dev/api.json";
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h (R-MC5)

/** Outcome of a `refresh()` call, for the caller to log (never thrown). */
export type RefreshStatus = "updated" | "not-modified" | "error" | "disabled";

/** Shape of the on-disk cache file. */
interface CacheFile {
	etag: string | null;
	fetchedAtMs: number;
	payload: unknown;
}

function asFiniteNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse a `models.dev` `cost.tiers[]` array into ascending-by-threshold
 * {@link PricingTier}s. Each tier carries its own four per-M
 * prices and a `tier: {type: "context", size: N}`; `size` becomes `threshold`.
 * Defensive: a non-array, a non-context tier type, or a tier with no finite size
 * is dropped rather than throwing, so one malformed tier never poisons the row.
 */
function parseContextTiers(raw: unknown): PricingTier[] {
	if (!Array.isArray(raw)) return [];
	const tiers: PricingTier[] = [];
	for (const t of raw) {
		if (!isRecord(t)) continue;
		const tierMeta = isRecord(t.tier) ? t.tier : undefined;
		if (tierMeta?.type !== "context") continue;
		const threshold = asFiniteNumber(tierMeta.size);
		if (threshold === undefined) continue;
		const tier: PricingTier = { threshold };
		const input = asFiniteNumber(t.input);
		if (input !== undefined) tier.input_per_m = input;
		const output = asFiniteNumber(t.output);
		if (output !== undefined) tier.output_per_m = output;
		const cacheRead = asFiniteNumber(t.cache_read);
		if (cacheRead !== undefined) tier.cache_read_per_m = cacheRead;
		const cacheWrite = asFiniteNumber(t.cache_write);
		if (cacheWrite !== undefined) tier.cache_write_5m_per_m = cacheWrite;
		tiers.push(tier);
	}
	tiers.sort((a, b) => a.threshold - b.threshold);
	return tiers;
}

/**
 * Parse a `models.dev` entry's `reasoning` boolean + `reasoning_options` array
 * into {@link ResolvedReasoning} (catalog §3.1). The published
 * shapes are `{type:"toggle"}`, `{type:"effort", values:string[]}`, and
 * `{type:"budget_tokens", min, max}`; only `toggle` and `effort` carry signal
 * a driver can act on structurally, so `budget_tokens` is noted (it still means
 * reasoning is supported) but contributes no field.
 *
 * Returns `undefined` only when the entry says NOTHING about reasoning — neither
 * the boolean nor the options array — so absence stays distinct from an explicit
 * `reasoning:false`. Defensive: a malformed options array is ignored rather than
 * throwing, so one bad row never poisons the index.
 */
function parseReasoningOptions(
	reasoning: unknown,
	rawOptions: unknown,
): ResolvedReasoning | undefined {
	const hasBool = typeof reasoning === "boolean";
	const options = Array.isArray(rawOptions) ? rawOptions : undefined;
	if (!hasBool && !options) return undefined;

	// `supported` is the boolean when present; otherwise the presence of any
	// reasoning option implies reasoning is supported.
	const supported = hasBool ? (reasoning as boolean) : true;
	const result: ResolvedReasoning = { supported };

	if (options) {
		for (const opt of options) {
			if (!isRecord(opt)) continue;
			if (opt.type === "toggle") {
				result.toggle = true;
			} else if (opt.type === "effort" && Array.isArray(opt.values)) {
				const values = opt.values.filter((v): v is string => typeof v === "string");
				if (values.length > 0) result.effort_values = values;
			}
			// `budget_tokens` carries no structural signal a driver acts on; it is
			// left out deliberately (its presence already set `supported`).
		}
	}
	return result;
}

/**
 * Parse one raw `models.dev` model entry into a gap-filling `MetadataLayer`.
 * Defensive: any shape mismatch yields `undefined` so one malformed row never
 * poisons the index. Documented payload shape (per model id):
 *   { limit?: { context?, output? },
 *     cost?: { input?, output?, cache_read?, cache_write? },
 *     modalities?: { input?: string[] },
 *     reasoning?: boolean,
 *     reasoning_options?: ({type:"toggle"} | {type:"effort", values:string[]} | {type:"budget_tokens", …})[] }
 */
function parseModelEntry(entry: unknown): MetadataLayer | undefined {
	if (!isRecord(entry)) return undefined;

	const layer: MetadataLayer = {};
	const capabilities: NonNullable<MetadataLayer["capabilities"]> = {};
	const pricing: NonNullable<MetadataLayer["pricing"]> = {};

	const limit = isRecord(entry.limit) ? entry.limit : undefined;
	const maxContext = asFiniteNumber(limit?.context);
	const maxInput = asFiniteNumber(limit?.input);
	const maxOutput = asFiniteNumber(limit?.output);
	// Honour `limit.input` (catalog §3.1). When the registry reports
	// a separate input (prompt) budget, the real prompt room is `input`, not
	// `context` (which also counts output). Resolve `max_context` so the routing
	// truncation target `computeBaseTruncationTarget = max_context - max_output`
	// lands on the real prompt budget: `max_context = min(context, input + output)`.
	// When `limit.input` is absent, `max_context` stays `limit.context` unchanged.
	if (maxContext !== undefined) {
		if (maxInput !== undefined && maxOutput !== undefined) {
			capabilities.max_context = Math.min(maxContext, maxInput + maxOutput);
		} else {
			capabilities.max_context = maxContext;
		}
	}
	if (maxOutput !== undefined) layer.max_output_tokens = maxOutput;

	const modalitiesInput =
		isRecord(entry.modalities) && Array.isArray(entry.modalities.input)
			? (entry.modalities.input as unknown[])
			: undefined;
	if (modalitiesInput) {
		if (modalitiesInput.includes("image")) capabilities.vision = true;
	}

	const reasoning = parseReasoningOptions(entry.reasoning, entry.reasoning_options);
	if (reasoning) {
		capabilities.reasoning = reasoning;
		// Keep the legacy flat `extended_thinking` boolean in sync for consumers
		// that only read it; `reasoning.supported` is the authoritative field.
		capabilities.extended_thinking = reasoning.supported;
	}

	const cost = isRecord(entry.cost) ? entry.cost : undefined;
	const input = asFiniteNumber(cost?.input);
	if (input !== undefined) pricing.input_per_m = input;
	const output = asFiniteNumber(cost?.output);
	if (output !== undefined) pricing.output_per_m = output;
	const cacheRead = asFiniteNumber(cost?.cache_read);
	if (cacheRead !== undefined) pricing.cache_read_per_m = cacheRead;
	const cacheWrite = asFiniteNumber(cost?.cache_write);
	if (cacheWrite !== undefined) pricing.cache_write_5m_per_m = cacheWrite;

	// Context-based tiers. `cost.tiers[]` carries the
	// long-context rate(s); each tier has its own four prices and
	// `tier: {type: "context", size: N}`. A sibling `cost.context_over_200k` is
	// IGNORED: across every amazon-bedrock entry in the live snapshot that carries
	// both, `tiers[0]` is byte-identical to `context_over_200k` (0 of 785
	// mismatches) and `context_over_200k` never appears without `tiers`, so it is a
	// legacy duplicate of the single context tier, not an independent signal.
	const tiers = parseContextTiers(cost?.tiers);
	if (tiers.length > 0) pricing.tiers = tiers;

	if (Object.keys(capabilities).length > 0) layer.capabilities = capabilities;
	if (Object.keys(pricing).length > 0) layer.pricing = pricing;
	// `name` is the registry's user-facing display name (catalog §2.1 display-name
	// precedence: provider > models.dev name > provider model id).
	if (typeof entry.name === "string" && entry.name.length > 0) layer.display_name = entry.name;

	// A row with zero usable fields contributes nothing — drop it.
	return Object.keys(layer).length > 0 ? layer : undefined;
}

/**
 * Compose the provider-scoped index key: `${modelsDevNamespace}\u0000${canonicalKey}`.
 * The NUL separator cannot appear in a namespace or canonical key, so a scoped
 * key never collides with a bare cross-provider canonical key in the same map.
 */
function scopedKey(namespace: string, canonicalKey: string): string {
	return `${namespace}\u0000${canonicalKey}`;
}

/**
 * Compose the EXACT index key: `${namespace}\u0000exact\u0000${rawModelId}`. Keyed
 * by the namespace and the RAW provider model id verbatim (never normalized), so
 * two ids that share a canonical key but denote different priced profiles stay
 * distinct — e.g. Bedrock CRIS `global.anthropic.claude-haiku-5-5` (list price)
 * vs in-region `anthropic.claude-haiku-5-5` (list + 10%), which
 * `normalizeModelKey` collapses by stripping the region prefix.
 * The `exact` discriminator segment keeps this key space disjoint from both the
 * bare canonical keys and the scoped-canonical keys in the same map.
 */
function exactKey(namespace: string, rawModelId: string): string {
	return `${namespace}\u0000exact\u0000${rawModelId}`;
}

/**
 * Index a raw `models.dev` api.json payload into a `Map<canonicalKey,
 * MetadataLayer>`. The payload is an object keyed by provider namespace, each
 * with a `.models` map keyed by provider model id. Keys are canonicalized with
 * `normalizeModelKey` (the SAME rule set used for grouping, §5.2) so a later
 * lookup under any region/vendor variant resolves to the same entry. Tolerant
 * of a wholly malformed payload (returns an empty map, never throws).
 */
export function indexModelsDevSnapshot(raw: unknown): Map<string, MetadataLayer> {
	const index = new Map<string, MetadataLayer>();
	if (!isRecord(raw)) return index;

	for (const [providerNamespace, providerEntry] of Object.entries(raw)) {
		if (!isRecord(providerEntry)) continue;
		const models = isRecord(providerEntry.models) ? providerEntry.models : undefined;
		if (!models) continue;
		for (const [modelId, modelEntry] of Object.entries(models)) {
			const layer = parseModelEntry(modelEntry);
			if (!layer) continue;
			const { key } = normalizeModelKey(providerNamespace, modelId);
			// First writer wins per canonical key: the registry is upstream-dedup'd
			// per provider; a cross-provider canonical collision keeps the first.
			if (!index.has(key)) index.set(key, layer);
			// Also index under the provider-scoped key so `lookupModelsDevScoped`
			// can prefer this provider's own entry over whichever
			// provider happened to win the cross-provider canonical slot. First
			// writer wins within a namespace too (models.dev is per-provider
			// dedup'd, so collisions here are vanishingly rare).
			const sk = scopedKey(providerNamespace, key);
			if (!index.has(sk)) index.set(sk, layer);
			// And index under the EXACT raw model id so two ids that
			// share a canonical key but denote differently-priced profiles stay
			// distinct. `normalizeModelKey` strips the region prefix, collapsing a
			// Bedrock CRIS `global.<vendor>.<model>` (list price) and its in-region
			// `<vendor>.<model>` sibling (list + 10%) onto one scoped/canonical key;
			// the raw-id index keeps each priced row addressable so a backend prices
			// the id it actually calls. models.dev keys models uniquely within a
			// namespace, so a collision here cannot happen (but keep first-writer for
			// symmetry with the other two maps).
			const ek = exactKey(providerNamespace, modelId);
			if (!index.has(ek)) index.set(ek, layer);
		}
	}
	return index;
}

/**
 * Look up a backend's gap-filling metadata in an indexed snapshot, normalizing
 * `(provider, providerModelId)` to the canonical key. Returns `undefined` when
 * the model is absent (brand-new release, private fine-tune, custom local
 * model) — resolution still succeeds from config + provider discovery (§5.2).
 */
export function lookupModelsDev(
	index: ReadonlyMap<string, MetadataLayer>,
	provider: string,
	providerModelId: string,
): MetadataLayer | undefined {
	const { key } = normalizeModelKey(provider, providerModelId);
	return index.get(key);
}

/**
 * Provider-scoped lookup (catalog §5.2). Resolves in three
 * steps, most specific first:
 *   1. EXACT `(namespace, raw model id)`: the row for the exact
 *      provider model id the backend calls. Distinguishes differently-priced
 *      profiles that share a canonical key — a Bedrock CRIS `global.` profile
 *      (list price) vs its in-region sibling (list + 10%), which
 *      `normalizeModelKey` collapses by stripping the region prefix.
 *   2. SCOPED canonical: the backend's OWN `models.dev` provider
 *      namespace, before the cross-provider index. The canonical index is
 *      first-writer-wins across all 324 providers, so a model id that collides
 *      across providers (e.g. `grok-4.7` on both xAI and github-copilot)
 *      otherwise resolves to another provider's row.
 *   3. CROSS-PROVIDER canonical: the bare canonical index, when the provider has
 *      no mapped namespace or the model is absent from steps 1 and 2.
 *
 * The canonical grouping key is unchanged — scoping and exact indexing affect
 * ONLY which `models.dev` metadata row fills gaps, never logical-model pooling.
 */
export function lookupModelsDevScoped(
	index: ReadonlyMap<string, MetadataLayer>,
	provider: string,
	providerModelId: string,
): MetadataLayer | undefined {
	const namespace = modelsDevNamespaceFor(provider);
	if (namespace !== undefined) {
		// 1. Exact raw-id row (keeps regional/global/in-region profiles distinct).
		const exact = index.get(exactKey(namespace, providerModelId.trim()));
		if (exact !== undefined) return exact;
		// 2. Scoped canonical (own-provider entry over a cross-provider collision).
		const { key } = normalizeModelKey(provider, providerModelId);
		const scoped = index.get(scopedKey(namespace, key));
		if (scoped !== undefined) return scoped;
	}
	// 3. Cross-provider canonical fallback.
	return lookupModelsDev(index, provider, providerModelId);
}

export interface ModelsDevCacheOptions {
	/** Absolute path to the on-disk cache file; null keeps the snapshot in memory only. */
	cachePath: string | null;
	/** Registry URL (default `https://models.dev/api.json`). */
	url?: string;
	/** When false, no network fetch happens (air-gapped); default true. */
	enabled?: boolean;
	/** Background refresh cadence in ms (default 24h). */
	refreshIntervalMs?: number;
	/** Injectable fetch for tests; default `globalThis.fetch`. */
	fetchImpl?: typeof globalThis.fetch;
}

/**
 * Manages the on-disk `models.dev` snapshot: load from disk, conditional ETag
 * refresh, and the in-memory canonical index. All failures are swallowed into a
 * `RefreshStatus` so the daemon start path never blocks on the registry.
 */
export class ModelsDevCache {
	private readonly cachePath: string | null;
	private readonly url: string;
	private readonly enabled: boolean;
	private readonly refreshIntervalMs: number;
	private readonly fetchImpl: typeof globalThis.fetch;

	private etag: string | null = null;
	private fetchedAtMs: number | null = null;
	private index: Map<string, MetadataLayer> = new Map();

	constructor(opts: ModelsDevCacheOptions) {
		this.cachePath = opts.cachePath;
		this.url = opts.url ?? DEFAULT_URL;
		this.enabled = opts.enabled ?? true;
		this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	}

	/** Current in-memory canonical index. */
	getIndex(): ReadonlyMap<string, MetadataLayer> {
		return this.index;
	}

	/**
	 * Read the on-disk cache (if present) into the in-memory index + ETag. Never
	 * throws: a missing or corrupt cache leaves the index empty (R-MC6).
	 */
	async load(): Promise<void> {
		if (this.cachePath === null || !existsSync(this.cachePath)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as CacheFile;
			this.etag = typeof parsed.etag === "string" ? parsed.etag : null;
			this.fetchedAtMs =
				typeof parsed.fetchedAtMs === "number" && Number.isFinite(parsed.fetchedAtMs)
					? parsed.fetchedAtMs
					: null;
			this.index = indexModelsDevSnapshot(parsed.payload);
		} catch {
			// Corrupt cache file — proceed with an empty index.
			this.index = new Map();
		}
	}

	/**
	 * Conditionally refresh from the registry. Sends `If-None-Match` when an ETag
	 * is held. On 200 → re-index + persist; on 304 → keep; on any failure →
	 * keep + report. Resolves a `RefreshStatus`, NEVER rejects (R-MC6).
	 */
	async refresh(nowMs: number = Date.now()): Promise<RefreshStatus> {
		if (!this.enabled) return "disabled";
		try {
			const headers: Record<string, string> = { accept: "application/json" };
			if (this.etag) headers["if-none-match"] = this.etag;
			const res = await this.fetchImpl(this.url, { headers });
			if (res.status === 304) return "not-modified";
			if (!res.ok) return "error";
			const payload = (await res.json()) as unknown;
			const etag = res.headers.get("etag");
			this.index = indexModelsDevSnapshot(payload);
			this.etag = etag;
			this.fetchedAtMs = nowMs;
			this.persist(payload);
			return "updated";
		} catch {
			// Transport/parse failure — keep the prior index, surface status.
			return "error";
		}
	}

	/** Write the snapshot + ETag to disk. Swallows IO errors (local-only cache). */
	private persist(payload: unknown): void {
		if (this.cachePath === null) return;
		try {
			mkdirSync(dirname(this.cachePath), { recursive: true });
			const file: CacheFile = {
				etag: this.etag,
				fetchedAtMs: this.fetchedAtMs ?? Date.now(),
				payload,
			};
			writeFileSync(this.cachePath, JSON.stringify(file));
		} catch {
			// A non-writable cache path degrades to in-memory-only; never fatal.
		}
	}
}
