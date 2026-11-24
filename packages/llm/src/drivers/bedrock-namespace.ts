/**
 * Bedrock self-configuring namespace driver (2026-11-21-model-catalog.md §2.1,
 * requirement 1/2). A `bedrock` config entry with NO `model` is a namespace for
 * its (profile, region): its `readiness` fetches `ListFoundationModels` +
 * `ListInferenceProfiles` from the control plane (the same two endpoints the
 * concrete `BedrockDriver.discoverModels()` already hits), runs the pure
 * `selectBedrockLineup` filter, and registers one concrete per-model backend per
 * lineup entry — a Converse `BedrockDriver` for a `converse` model, a Responses
 * driver (bedrock-runtime, SigV4) for an `openAiResponses` model.
 *
 * It mirrors `CopilotLineupReadiness` / `UmansReadiness`: it owns the disposed
 * flag + pending-retry handle so a fetch that lands after `dispose()` is a no-op,
 * and retries on an empty/failed lineup. The per-model protocol choice and the
 * callable id come from published control-plane fields only — no model-ID branch
 * (R-MC1). The Responses leg reuses the Mantle Responses request builder/bridge
 * (`BedrockMantleDriver` in `openai_responses` mode) rather than duplicating it;
 * only the base URL differs (bedrock-runtime vs the mantle host). That reuse
 * rests on a live probe (R2) showing bedrock-runtime Responses accepts
 * `prompt_cache_options.ttl` identically to Mantle, and the Converse Claude leg
 * on a second probe (R3) showing adaptive thinking + a 1h cachePoint are
 * accepted; both are recorded with their requests and HTTP responses in
 * `./bedrock-probe-evidence.md`.
 */

import type { Logger } from "@bound/shared";
import {
	type BedrockLineupEntry,
	selectBedrockLineup,
	selectMantleLineupWithExclusions,
} from "../catalog/bedrock-lineup";
import type { DiscoveredModel } from "../catalog/discovery";
import {
	parseBedrockFoundationModels,
	parseBedrockInferenceProfiles,
	parseOpenAIModelsList,
} from "../catalog/discovery-fetch";
import type { DriverFallbackSupport } from "../fallback-policy";
import type {
	BackendCapabilities,
	BackendReadiness,
	ChatParams,
	LLMBackend,
	ModelDescriptor,
	ModelRegistrar,
	StreamChunk,
} from "../types";
import { resolveAwsCredentials } from "./aws-credential-cache";
import { BedrockDriver } from "./bedrock";
import { BedrockMantleDriver } from "./bedrock-mantle";
import { createSigV4Fetch } from "./sigv4-fetch";

const LINEUP_RETRY_BASE_MS = 2_000;
const LINEUP_RETRY_MAX_MS = 60_000;

/**
 * The bedrock-runtime OpenAI Responses base URL for a region (the AI SDK's
 * OpenAI provider appends `/responses`). Distinct from the mantle host, which is
 * `bedrock-mantle.{region}.api.aws/openai/v1`. Both sign SigV4 service `bedrock`.
 */
export function deriveBedrockRuntimeResponsesBaseUrl(region: string): string {
	return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

/** Per-model override entry (camelCase, from `toRouterConfig`); requirement 5. */
type ModelOverride = NonNullable<import("../types").BackendConfig["modelOverrides"]>[string];

interface BedrockNamespaceConfig {
	/** The namespace entry's config id; expanded ids are `${namespaceId}-${providerModelId}`. */
	namespaceId: string;
	/** The region this (profile, region) namespace serves. */
	region: string;
	/**
	 * Mantle namespace (requirement 4) when true: the lineup comes from the Mantle
	 * `GET /v1/models` endpoint (joined with `ListFoundationModels` for the wire
	 * protocol), and each per-model backend is a Mantle driver on the mantle host.
	 * When false/absent this is a `bedrock` namespace: the lineup comes from
	 * `ListFoundationModels` + `ListInferenceProfiles` and models serve over
	 * bedrock-runtime (Converse / Responses).
	 */
	mantle?: boolean;
	/** Explicit AWS profile (SSO/AssumeRole); falls back to the node chain. */
	profile?: string;
	/** Preferred cross-region inference-profile scope (default `global`, decision 3). */
	crossRegion?: string;
	/** Per-model overrides keyed by provider model id OR resolved profile id (requirement 5). */
	modelOverrides?: Record<string, ModelOverride>;
	logger?: Logger;
	/** This host's site id, threaded to each concrete per-model driver. */
	siteId?: string;
	/** Per-backend connect / time-to-first-byte deadline (ms). */
	connectTimeoutMs?: number;
	/** Test seam: a fetch used verbatim for the two control-plane endpoints. */
	fetch?: typeof fetch;
	/** Lineup retry backoff base/cap (test seam). */
	retryBaseMs?: number;
	retryMaxMs?: number;
}

/**
 * Readiness handle for the namespace. Fetches the two control-plane endpoints
 * with the host's SigV4 credentials (or the injected test fetch), runs the
 * lineup filter, and registers the expanded per-model backends once. Empty or
 * failed fetches retry with capped exponential backoff, exactly as Copilot/umans
 * do, so a transient control-plane blip never strands the namespace.
 */
class BedrockNamespaceReadiness implements BackendReadiness {
	private ready = false;
	private disposed = false;
	private pendingRetry?: ReturnType<typeof setTimeout>;
	/** Mantle ids excluded for lack of a protocol-bearing fm join (requirement 4 report). */
	private excludedMantleIds: string[] = [];
	private readonly controller = new AbortController();
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;

	constructor(private readonly cfg: BedrockNamespaceConfig) {
		this.retryBaseMs = cfg.retryBaseMs ?? LINEUP_RETRY_BASE_MS;
		this.retryMaxMs = cfg.retryMaxMs ?? LINEUP_RETRY_MAX_MS;
	}

	isReady(): boolean {
		return this.ready;
	}

	dispose(): void {
		this.disposed = true;
		if (this.pendingRetry !== undefined) clearTimeout(this.pendingRetry);
		this.pendingRetry = undefined;
		this.controller.abort();
	}

	start(registrar: ModelRegistrar): void {
		void this.runFetchLoop(registrar);
	}

	/** The signed (or injected) fetch for the two control-plane endpoints. */
	private discoveryFetch(): typeof fetch {
		return (
			this.cfg.fetch ??
			createSigV4Fetch({
				credentials: () => resolveAwsCredentials(this.cfg.profile),
				service: "bedrock",
				region: this.cfg.region,
			})
		);
	}

	/** Fetch + parse the `bedrock` control-plane endpoints into one `DiscoveredModel[]`, or throw. */
	private async fetchBedrockDiscovery(): Promise<DiscoveredModel[]> {
		const host = `bedrock.${this.cfg.region}.amazonaws.com`;
		const fetchImpl = this.discoveryFetch();
		const get = async (path: string): Promise<unknown> => {
			const res = await fetchImpl(`https://${host}${path}`, {
				headers: { accept: "application/json" },
				...(this.cfg.fetch ? {} : { signal: this.controller.signal }),
			});
			if (!res.ok) throw new Error(`bedrock discovery failed: HTTP ${res.status} (${path})`);
			return res.json();
		};
		const [foundation, profiles] = await Promise.all([
			get("/foundation-models"),
			get("/inference-profiles"),
		]);
		return [
			...parseBedrockFoundationModels(foundation),
			...parseBedrockInferenceProfiles(profiles),
		];
	}

	/**
	 * Fetch the Mantle namespace lineup (requirement 4): the Mantle `GET /v1/models`
	 * listing supplies the entitled ids, and the same control plane's
	 * `ListFoundationModels` supplies each id's protocol signal. Both are signed
	 * with the host's SigV4 credentials. Returns the computed lineup + the excluded
	 * (unjoinable) ids for the operator report.
	 */
	private async fetchMantleLineup(): Promise<{
		lineup: BedrockLineupEntry[];
		excluded: string[];
	}> {
		const fetchImpl = this.discoveryFetch();
		const mantleHost = `bedrock-mantle.${this.cfg.region}.api.aws`;
		const fmHost = `bedrock.${this.cfg.region}.amazonaws.com`;
		const getJson = async (url: string): Promise<unknown> => {
			const res = await fetchImpl(url, {
				headers: { accept: "application/json" },
				...(this.cfg.fetch ? {} : { signal: this.controller.signal }),
			});
			if (!res.ok) throw new Error(`mantle discovery failed: HTTP ${res.status} (${url})`);
			return res.json();
		};
		const [models, foundation] = await Promise.all([
			getJson(`https://${mantleHost}/v1/models`),
			getJson(`https://${fmHost}/foundation-models`),
		]);
		return selectMantleLineupWithExclusions(
			parseOpenAIModelsList(models),
			parseBedrockFoundationModels(foundation),
		);
	}

	private async runFetchLoop(registrar: ModelRegistrar): Promise<void> {
		let attempt = 0;
		while (!this.disposed) {
			let lineup: BedrockLineupEntry[] = [];
			try {
				if (this.cfg.mantle) {
					const { lineup: mantleLineup, excluded } = await this.fetchMantleLineup();
					lineup = mantleLineup;
					this.excludedMantleIds = excluded;
				} else {
					const discovery = await this.fetchBedrockDiscovery();
					lineup = selectBedrockLineup(discovery, {
						region: this.cfg.region,
						...(this.cfg.crossRegion !== undefined && { crossRegion: this.cfg.crossRegion }),
					});
				}
			} catch (error) {
				if (this.controller.signal.aborted) return;
				this.cfg.logger?.warn?.("bedrock lineup fetch failed; retrying", {
					error: error instanceof Error ? error.message : String(error),
				});
				lineup = [];
			}
			if (this.disposed) return;

			if (lineup.length > 0) {
				const entries = this.buildEntries(lineup);
				if (this.disposed) return; // re-check just before the live-router write
				this.ready = true;
				registrar.register(this.cfg.namespaceId, entries);
				this.cfg.logger?.info?.("bedrock lineup ready", { models: entries.length });
				return;
			}

			attempt++;
			const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
			this.cfg.logger?.warn?.("bedrock lineup empty; retrying", { attempt, delayMs: delay });
			await new Promise<void>((resolve) => {
				this.pendingRetry = setTimeout(resolve, delay);
			});
			this.pendingRetry = undefined;
		}
	}

	/**
	 * Build one descriptor+backend per lineup model. The expanded backend id is
	 * `${namespaceId}-${providerModelId}` (requirement 6). A per-model override is
	 * matched against the bare foundation-model id OR the resolved profile id (its
	 * callable id), so an operator pins one model's controls either way
	 * (requirement 5). `prompt_caching` comes from `explicitPromptCaching` unless
	 * an override pins it (requirement 7).
	 */
	private buildEntries(
		lineup: BedrockLineupEntry[],
	): Array<{ descriptor: ModelDescriptor; backend: LLMBackend }> {
		const out: Array<{ descriptor: ModelDescriptor; backend: LLMBackend }> = [];
		for (const entry of lineup) {
			const override =
				this.cfg.modelOverrides?.[entry.providerModelId] ??
				this.cfg.modelOverrides?.[entry.callableId];
			const promptCaching = override?.promptCaching ?? entry.promptCaching;
			const capabilities: BackendCapabilities = {
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: promptCaching,
				vision: true,
				// Reasoning capability is resolved by the catalog layer from
				// models.dev / provider metadata; the descriptor carries a
				// conservative default that the catalog refines.
				extended_thinking: true,
				...(override?.contextWindow !== undefined && { max_context: override.contextWindow }),
			};
			const backendId = `${this.cfg.namespaceId}-${entry.providerModelId}`;
			const descriptor: ModelDescriptor = {
				id: backendId,
				providerModelId: entry.providerModelId,
				capabilities,
				...(override?.logicalModel !== undefined && { logicalModel: override.logicalModel }),
				...(override?.maxOutputTokens !== undefined && {
					maxOutputTokens: override.maxOutputTokens,
				}),
			};
			out.push({ descriptor, backend: this.buildPerModelDriver(entry) });
		}
		return out;
	}

	/**
	 * Construct the concrete driver for one lineup model, choosing the wire
	 * protocol from the lineup entry (requirement 2). A `responses` model is
	 * served by the Mantle Responses driver pointed at the bedrock-runtime base
	 * URL (reuse, not duplication; R2 probe proved the cache mapping is
	 * identical); a `converse` model by the Converse `BedrockDriver`. Both are fed
	 * the CALLABLE id (bare model id or inference-profile id).
	 */
	private buildPerModelDriver(entry: BedrockLineupEntry): LLMBackend {
		if (entry.protocol === "responses") {
			// A Mantle namespace serves Responses on the mantle host; a bedrock namespace
			// serves them on bedrock-runtime. Both reuse the Mantle Responses driver
			// (identical request builder/bridge; only the base URL differs). A mantle
			// base URL of `undefined` lets the driver derive its own mantle host.
			return new BedrockMantleDriver({
				region: this.cfg.region,
				model: entry.callableId,
				contextWindow: 0, // resolved by the catalog layer post-registration
				providerMode: "openai_responses",
				...(this.cfg.mantle
					? {}
					: { baseUrl: deriveBedrockRuntimeResponsesBaseUrl(this.cfg.region) }),
				...(this.cfg.profile !== undefined && { profile: this.cfg.profile }),
				...(this.cfg.logger !== undefined && { logger: this.cfg.logger }),
				...(this.cfg.siteId !== undefined && { siteId: this.cfg.siteId }),
				...(this.cfg.connectTimeoutMs !== undefined && {
					connectTimeoutMs: this.cfg.connectTimeoutMs,
				}),
			});
		}
		// A Mantle namespace's converse-only models have no bedrock-runtime Converse
		// surface analog here — Mantle serves them under the Anthropic/converse Mantle
		// routes, out of this errand's GPT+Claude-on-runtime scope. A bedrock namespace
		// serves converse models via the Converse BedrockDriver on bedrock-runtime.
		return new BedrockDriver({
			region: this.cfg.region,
			model: entry.callableId,
			contextWindow: 0, // resolved by the catalog layer post-registration
			...(this.cfg.profile !== undefined && { profile: this.cfg.profile }),
			...(this.cfg.logger !== undefined && { logger: this.cfg.logger }),
			...(this.cfg.siteId !== undefined && { siteId: this.cfg.siteId }),
			...(this.cfg.connectTimeoutMs !== undefined && {
				connectTimeoutMs: this.cfg.connectTimeoutMs,
			}),
		});
	}

	/** The Mantle ids excluded for lack of a protocol-bearing fm join (requirement 4 report). */
	excludedMantle(): readonly string[] {
		return this.excludedMantleIds;
	}
}

/**
 * The namespace instance itself. It is NOT directly invokable — its `chat()`
 * throws a guard until the readiness fetch expands it into concrete per-model
 * backends (mirrors umans/Copilot). The router removes this placeholder once the
 * lineup registers.
 */
export class BedrockNamespaceDriver implements LLMBackend {
	readonly readiness: BackendReadiness;

	constructor(cfg: BedrockNamespaceConfig) {
		this.readiness = new BedrockNamespaceReadiness(cfg);
	}

	// biome-ignore lint/correctness/useYield: a namespace stub never yields — it throws.
	async *chat(_params: ChatParams): AsyncIterable<StreamChunk> {
		throw new Error(
			"bedrock namespace backend is not directly invokable — lineup not yet resolved / backend not ready",
		);
	}

	capabilities(): BackendCapabilities {
		// Placeholder caps; the namespace is never selected (not-ready until its
		// concrete per-model backends register).
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			extended_thinking: true,
		};
	}

	fallbackSupport(): DriverFallbackSupport {
		// Same as the concrete Bedrock drivers (catalog §4.2): no server-side auto
		// fallback, no published targets, but mints/redeems fallback-credit tokens.
		return {
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: true,
		};
	}
}
