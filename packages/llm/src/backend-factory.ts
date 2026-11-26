import type { Logger } from "@bound/shared";
import { AnthropicDriver } from "./drivers/anthropic";
import { BedrockDriver } from "./drivers/bedrock";
import { BedrockMantleDriver } from "./drivers/bedrock-mantle";
import { BedrockNamespaceDriver } from "./drivers/bedrock-namespace";
import { ChatGptOAuthDriver } from "./drivers/chatgpt-oauth/driver";
import { FileTokenStore, TokenManager } from "./drivers/chatgpt-oauth/token-store";
import { fetchAccountInfo } from "./drivers/github-copilot/auth-core";
import { GitHubCopilotDriver } from "./drivers/github-copilot/driver";
import { CopilotTokenManager, FileCopilotTokenStore } from "./drivers/github-copilot/token-store";
import { OpenAICompatibleDriver } from "./drivers/openai-compatible";
import { OpenCodeGoDriver } from "./drivers/opencode-go";
import { UmansDriver, createUmansAccount } from "./drivers/umans";
import type { BackendConfig, LLMBackend } from "./types";

/**
 * Sentinel context window handed to a driver constructed WITHOUT a resolved
 * `max_context` in local config (R-MC4). The catalog layer resolves a
 * backend's real window from config / provider discovery / `models.dev`; a
 * driver is only built here from static config, before resolution runs, so when
 * `config.contextWindow` is absent we pass `0` rather than a hardcoded guess.
 * `capabilities().max_context === 0` means "advertises no max_context", which
 * `2026-11-21-model-routing.md` R-RT2 (§5 candidate pool) already treats as
 * ineligible, and which the catalog readiness gate (`gateUnreadyBackends`)
 * surfaces as a configuration gap — so a turn is never dispatched on a guessed
 * window. A backend that sets `context_window` in config keeps its real number.
 */
const UNRESOLVED_CONTEXT_WINDOW = 0;

/** Copilot token managers keyed by token-store path; every backend over one file shares one. */
const copilotTokenManagers = new Map<string, CopilotTokenManager>();

/**
 * ChatGPT OAuth token managers keyed by token-store path. Refresh rotates the
 * refresh token (the old one dies), so every backend over one store file — a
 * namespace and its expanded siblings, or several concrete entries — shares one.
 */
const chatgptTokenManagers = new Map<string, TokenManager>();

/** Defaults for the three providers served by `OpenAICompatibleDriver`. */
const OPENAI_COMPATIBLE_FLAVORS: Record<string, { defaultBaseUrl: string; label: string }> = {
	"openai-compatible": { defaultBaseUrl: "http://localhost:8000", label: "OpenAI-compatible" },
	cerebras: { defaultBaseUrl: "https://api.cerebras.ai/v1", label: "Cerebras" },
	zai: { defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4", label: "z.AI" },
};

export function createBackendFromConfig(
	config: BackendConfig,
	logger?: Logger,
	fetch?: typeof globalThis.fetch,
	siteId?: string,
): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "bedrock": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock driver requires region in config");
			}
			const profile = config.profile as string | undefined;
			// No `model` => self-configuring namespace for this (profile, region): it owns
			// `readiness`, fetches ListFoundationModels + ListInferenceProfiles, runs the
			// lineup filter, and expands into one concrete per-model backend (Converse or
			// Responses-on-runtime) per catalog model (catalog §2.1). `model` present =>
			// a single concrete Converse backend, unchanged.
			if (!config.model) {
				return new BedrockNamespaceDriver({
					namespaceId: config.id,
					region,
					...(profile !== undefined && { profile }),
					...(config.crossRegion !== undefined && {
						crossRegion: config.crossRegion as string,
					}),
					...(config.modelOverrides !== undefined && { modelOverrides: config.modelOverrides }),
					...(logger !== undefined && { logger }),
					...(siteId !== undefined && { siteId }),
					...(config.connectTimeoutMs !== undefined && {
						connectTimeoutMs: config.connectTimeoutMs,
					}),
				});
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new BedrockDriver({
				region,
				model: config.model,
				contextWindow,
				profile,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
			});
		}

		case "anthropic": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("Anthropic driver requires apiKey in config");
			}
			// No `model` => self-configuring namespace: it owns `readiness`, fetches
			// `/v1/models`, and expands into one concrete backend per listed model
			// (catalog §2.1). Expanded ids are `${config.id}-${providerModelId}`.
			return new AnthropicDriver({
				apiKey,
				...(config.model
					? {
							model: config.model,
							contextWindow: config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW,
						}
					: {
							namespaceId: config.id,
							...(config.modelOverrides !== undefined && {
								modelOverrides: config.modelOverrides,
							}),
						}),
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				...(siteId !== undefined && { siteId }),
			});
		}

		case "openai-compatible":
		case "cerebras":
		case "zai": {
			const flavor = OPENAI_COMPATIBLE_FLAVORS[provider];
			const baseUrl = config.baseUrl ?? flavor.defaultBaseUrl;
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error(`${flavor.label} driver requires apiKey in config`);
			}
			// No `model` => self-configuring namespace over `/models` (catalog §2.1).
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				...(config.model
					? {
							model: config.model,
							contextWindow: config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW,
						}
					: {
							namespaceId: config.id,
							...(config.modelOverrides !== undefined && {
								modelOverrides: config.modelOverrides,
							}),
						}),
				providerName: provider,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				additionalHeaders: config.additionalHeaders,
			});
		}

		case "chatgpt-oauth": {
			const storePath = config.tokenStorePath ?? "config/chatgpt-auth.json";
			// One token manager per store file: refresh rotates the refresh token, so
			// N backends holding N managers over one file would race the same token.
			let tokenManager = chatgptTokenManagers.get(storePath);
			if (!tokenManager) {
				const store = new FileTokenStore(storePath);
				const tokens = store.load();
				if (!tokens) {
					throw new Error("ChatGPT OAuth is not logged in — run `bound login --chatgpt`");
				}
				tokenManager = new TokenManager(tokens, { fetch: fetch ?? globalThis.fetch }, store);
				chatgptTokenManagers.set(storePath, tokenManager);
			}
			// No `model` => self-configuring namespace over the Codex `/models`
			// inventory (catalog §2.1); expanded siblings share this TokenManager.
			return new ChatGptOAuthDriver({
				tokenManager,
				...(config.model
					? {
							model: config.model,
							contextWindow: config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW,
						}
					: {
							namespaceId: config.id,
							...(config.modelOverrides !== undefined && {
								modelOverrides: config.modelOverrides,
							}),
						}),
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		case "github-copilot": {
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			const storePath = config.tokenStorePath ?? "config/copilot-auth.json";
			const deps = { fetch: fetch ?? globalThis.fetch };
			// One token manager per store file. Refresh rotates the ghr_ token (the
			// old one dies), so N backends holding N managers over one file would
			// race the same refresh token when they expire together.
			let tokenManager = copilotTokenManagers.get(storePath);
			if (!tokenManager) {
				const store = new FileCopilotTokenStore(storePath);
				const tokens = store.load();
				if (!tokens) {
					throw new Error("GitHub Copilot is not logged in — run `bound login --copilot`");
				}
				tokenManager = new CopilotTokenManager(tokens, deps, store);
				copilotTokenManagers.set(storePath, tokenManager);
			}
			const manager = tokenManager;
			const resolveAccount = () =>
				manager.getAccessToken().then((accessToken) => fetchAccountInfo(deps, accessToken));
			// No `model` => self-configuring namespace: it owns `readiness`, fetches the
			// account's Copilot catalog, and expands into one per-model backend per
			// chat-routable model (catalog §4.1). `model` present => a single concrete
			// backend, unchanged. `model: undefined` is passed through so the driver's
			// namespace detection (`config.model === undefined`) fires.
			return new GitHubCopilotDriver({
				tokenManager: manager,
				// `model` present => a single concrete backend. `model: undefined`
				// is passed through so the driver's namespace detection
				// (`config.model === undefined`) fires and it self-configures.
				model: config.model,
				...(!config.model ? { namespaceId: config.id } : {}),
				// No `model` => namespace instance also gets its per-model override map so
				// expansion can apply each model's request controls. Expanded
				// per-model backend ids are `${config.id}-${providerModelId}`.
				...(config.model || !config.modelOverrides
					? {}
					: { modelOverrides: config.modelOverrides }),
				contextWindow,
				// The validated Copilot API endpoint is plan-specific and comes from
				// the account lookup — resolved once, lazily, on first chat.
				resolveAccount,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		case "opencode-go": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("OpenCode Go driver requires apiKey in config");
			}
			// No `model` => self-configuring namespace: it owns `readiness`, fetches the
			// `/models` listing, and expands into one concrete backend per routable chat
			// model (2026-11-21-model-catalog.md §2.1). Expanded ids are
			// `${config.id}-${providerModelId}`.
			if (!config.model) {
				return new OpenCodeGoDriver({
					apiKey,
					namespaceId: config.id,
					...(config.modelOverrides && { modelOverrides: config.modelOverrides }),
					...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
					logger,
					fetch,
					connectTimeoutMs: config.connectTimeoutMs,
					siteId,
				});
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new OpenCodeGoDriver({
				apiKey,
				model: config.model,
				contextWindow,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		case "umans": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("umans driver requires apiKey in config");
			}
			// Build the shared per-account state (provider, semaphore, usage
			// cache, injectable fetchers) and the not-ready NAMESPACE/lineup
			// driver registered under the config id. The fetch is NOT started
			// here — wireBackendReadiness calls readiness.start(registrar)
			// after construction so the registrar is bound first.
			const account = createUmansAccount({
				apiKey,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				// Optional test-injectable fetchers, threaded via the BackendConfig
				// index signature. Production config never sets these.
				metadataFetch: config.metadataFetch as
					Parameters<typeof createUmansAccount>[0]["metadataFetch"] | undefined,
				usageFetch: config.usageFetch as
					Parameters<typeof createUmansAccount>[0]["usageFetch"] | undefined,
			});
			return new UmansDriver({ account, namespaceId: config.id, logger });
		}

		case "bedrock-mantle": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock Mantle driver requires region in config");
			}
			const profile = config.profile as string | undefined;
			// No `model` => self-configuring namespace for this (profile, region). Unlike
			// a concrete Mantle entry it needs no `provider_mode`: the per-model protocol
			// is derived from the ListFoundationModels join on expansion,
			// and the Mantle lineup comes from GET /v1/models. It reuses the same
			// namespace driver as `bedrock`; the driver's own base URLs differ per
			// protocol. `model` present => a single concrete Mantle backend, unchanged.
			if (!config.model) {
				return new BedrockNamespaceDriver({
					namespaceId: config.id,
					region,
					mantle: true,
					...(profile !== undefined && { profile }),
					...(config.crossRegion !== undefined && {
						crossRegion: config.crossRegion as string,
					}),
					...(config.modelOverrides !== undefined && { modelOverrides: config.modelOverrides }),
					...(logger !== undefined && { logger }),
					...(siteId !== undefined && { siteId }),
					...(config.connectTimeoutMs !== undefined && {
						connectTimeoutMs: config.connectTimeoutMs,
					}),
				});
			}
			const providerMode = config.providerMode as "anthropic" | "openai_responses" | undefined;
			if (!providerMode) {
				throw new Error("Bedrock Mantle driver requires providerMode in config");
			}
			const contextWindow = config.contextWindow ?? UNRESOLVED_CONTEXT_WINDOW;
			return new BedrockMantleDriver({
				region,
				model: config.model,
				contextWindow,
				providerMode,
				profile,
				baseUrl: config.baseUrl,
				logger,
				fetch,
				connectTimeoutMs: config.connectTimeoutMs,
				siteId,
			});
		}

		default:
			throw new Error(`Provider not supported: ${config.provider}`);
	}
}
