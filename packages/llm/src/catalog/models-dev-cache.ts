/**
 * `models.dev` fallback-registry cache (slice 6, R-MC5/R-MC6,
 * 2026-11-21-model-catalog.md §5).
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
import { modelsDevNamespaceFor, normalizeModelKey } from "./normalize";
import type { MetadataLayer } from "./resolve-metadata";

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

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse one raw `models.dev` model entry into a gap-filling `MetadataLayer`.
 * Defensive: any shape mismatch yields `undefined` so one malformed row never
 * poisons the index. Documented payload shape (per model id):
 *   { limit?: { context?, output? },
 *     cost?: { input?, output?, cache_read?, cache_write? },
 *     modalities?: { input?: string[] },
 *     reasoning?: boolean }
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
	// Honour `limit.input` (requirement 4, catalog §3.1). When the registry reports
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

	if (typeof entry.reasoning === "boolean") {
		capabilities.extended_thinking = entry.reasoning;
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

	if (Object.keys(capabilities).length > 0) layer.capabilities = capabilities;
	if (Object.keys(pricing).length > 0) layer.pricing = pricing;

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
			// (requirement 3) can prefer this provider's own entry over whichever
			// provider happened to win the cross-provider canonical slot. First
			// writer wins within a namespace too (models.dev is per-provider
			// dedup'd, so collisions here are vanishingly rare).
			const sk = scopedKey(providerNamespace, key);
			if (!index.has(sk)) index.set(sk, layer);
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
 * Provider-scoped lookup (requirement 3, catalog §5.2). Prefers the entry under
 * the backend's OWN `models.dev` provider namespace before the cross-provider
 * canonical index. The canonical index is first-writer-wins across all 324
 * providers, so a model id that collides across providers (e.g. `grok-4.7` on
 * both xAI and github-copilot) otherwise resolves to another provider's limits.
 * Scoping by `${modelsDevNamespace}:${canonicalKey}` picks the backend's own
 * provider's entry; when the provider has no mapped namespace, or the model is
 * absent from it, it falls back to the cross-provider canonical index.
 *
 * The canonical grouping key is unchanged — scoping affects ONLY which
 * `models.dev` metadata row fills gaps, never logical-model pooling.
 */
export function lookupModelsDevScoped(
	index: ReadonlyMap<string, MetadataLayer>,
	provider: string,
	providerModelId: string,
): MetadataLayer | undefined {
	const namespace = modelsDevNamespaceFor(provider);
	if (namespace !== undefined) {
		const { key } = normalizeModelKey(provider, providerModelId);
		const scoped = index.get(scopedKey(namespace, key));
		if (scoped !== undefined) return scoped;
	}
	return lookupModelsDev(index, provider, providerModelId);
}

export interface ModelsDevCacheOptions {
	/** Absolute path to the on-disk cache file. */
	cachePath: string;
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
	private readonly cachePath: string;
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

	/** Timestamp (epoch ms) of the last successful fetch, or null. */
	getFetchedAtMs(): number | null {
		return this.fetchedAtMs;
	}

	/** Whether a refresh is due at `nowMs` (also true when never fetched). */
	shouldRefresh(nowMs: number): boolean {
		if (this.fetchedAtMs === null) return true;
		return nowMs - this.fetchedAtMs >= this.refreshIntervalMs;
	}

	/**
	 * Read the on-disk cache (if present) into the in-memory index + ETag. Never
	 * throws: a missing or corrupt cache leaves the index empty (R-MC6).
	 */
	async load(): Promise<void> {
		if (!existsSync(this.cachePath)) return;
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
