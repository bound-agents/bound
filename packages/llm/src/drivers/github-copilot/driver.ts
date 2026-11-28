/**
 * GitHub Copilot direct-API driver.
 *
 * Fronts the Copilot API (NOT the Copilot CLI/SDK) as a first-class bound
 * backend. A holder of a GitHub Copilot subscription runs Claude, GPT, Gemini,
 * grok, and the `auto` selector through bound's own GitHub App device-flow
 * token — no API key, no Copilot CLI.
 *
 * Per-model routing (verified live): each model is reached over the AI SDK
 * provider that matches its `supported_endpoints`:
 *   - "/v1/messages"   → @ai-sdk/anthropic Messages, baseURL `${api}/v1`
 *   - "/responses"     → @ai-sdk/openai .responses, baseURL `${api}`
 *   - "/chat/completions" (or legacy) → @ai-sdk/openai .chat, baseURL `${api}`
 * A model absent from the catalog falls back to a name heuristic.
 *
 * `model: "auto"` resolves a session (POST `${api}/auto`) picking a concrete
 * model, which is then called with a `Copilot-Session-Token` header over the
 * selected model's own route.
 *
 * Auth, catalog, auto-session, and header assembly live in sibling modules; this
 * driver owns message-shape conversion (via the bridge), provider construction,
 * and stream translation.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { Logger } from "@bound/shared";
import { context } from "@opentelemetry/api";
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import {
	ANTHROPIC_ENVELOPE,
	OPENAI_RESPONSES_ENVELOPE,
	PERMISSIVE_ENVELOPE,
	toModelMessages,
	toToolSet,
} from "../../bridge";
import type { DiscoveredModel } from "../../catalog/discovery";
import type { DriverFallbackSupport } from "../../fallback-policy";
import type {
	BackendCapabilities,
	BackendReadiness,
	ChatParams,
	ContentBlock,
	LLMBackend,
	LLMMessage,
	ModelDescriptor,
	StreamChunk,
} from "../../types";
import { LLMError } from "../../types";
import { buildAnthropicReasoningOptions } from "../anthropic";
import {
	type CacheFieldDecision,
	CacheFieldRecoveryState,
	withCacheFieldRecovery,
} from "../cache-field-recovery";
import { type NamespaceLineupEntry, NamespaceLineupReadiness } from "../namespace-readiness";
import {
	EMPTY_COMPLETION_MAX_RETRIES,
	bindAsyncIterable,
	buildReasoningOrigin,
	mapProviderStream,
	resolveProviderFetch,
	withEmptyRetry,
	withEncryptedReasoningRetry,
} from "../shared";
import { buildCachedSystemMessage, shouldEnableSystemCache } from "../system-cache";
import type { CopilotAccountInfo } from "./auth-core";
import { type CopilotAutoSession, CopilotAutoSessionCache } from "./auto-session";
import {
	CopilotCatalog,
	type CopilotModelEntry,
	type CopilotRoute,
	computeCopilotCostBreakdown,
	resolveRoute,
	routeFromEndpoints,
	routeFromModelName,
} from "./catalog";
import {
	type CopilotRequestContext,
	createCopilotControlFetch,
	createCopilotFetch,
	resolveInitiator,
} from "./fetch-wrapper";
import type { CopilotTokenManager } from "./token-store";
const PROVIDER_NAME = "github-copilot";

/** The literal that triggers auto-session routing. */
const AUTO_MODEL = "auto";

/** True when any message content block is an image part (drives the vision header). */
export function messagesHaveImages(messages: LLMMessage[]): boolean {
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content as ContentBlock[]) {
			if (block.type === "image") return true;
			// A document part may carry a file_ref source that resolves to an image
			// at assembly time; an image-media file_ref source is a vision request.
			if (block.type === "document") {
				const source = (block as { source?: { type?: string; media_type?: string } }).source;
				if (source?.type === "file_ref" && source.media_type?.startsWith("image/")) return true;
			}
		}
	}
	return false;
}

/** The role of the last message — drives the `x-initiator` header. */
function latestRole(messages: LLMMessage[]): string | undefined {
	return messages.at(-1)?.role;
}

/** Extract the last user text, for the auto selector's `{prompt}`. */
function lastUserText(messages: LLMMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		const text = (m.content as ContentBlock[])
			.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

/** Effort levels in ascending strength; used to resolve `max` to the top advertised tier. */
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve the effective `reasoning_effort` for a turn against the model's
 * advertised levels (from the catalog's `capabilities.supports.reasoning_effort`).
 *
 *  - `thinking.type === "disabled"` maps to `"none"` when the model lists it.
 *  - an explicit `params.effort` passes through iff the model advertises it.
 *  - `"max"` maps to the highest of the advertised tiers (xhigh/high/…) when
 *    `"max"` itself is absent but a weaker ceiling is listed.
 *  - when the model advertises no list at all, pass only the canonical
 *    low/medium/high values through; drop anything else.
 *  - anything unresolved returns `undefined` (the field is omitted on the wire).
 */
export function resolveReasoningEffort(
	params: Pick<ChatParams, "effort" | "thinking">,
	efforts: string[] | undefined,
): string | undefined {
	const disabled = params.thinking?.type === "disabled";
	if (disabled && efforts?.includes("none")) return "none";

	const requested = params.effort;
	if (!requested) return undefined;

	// No advertised list: accept only the canonical trio, drop the rest.
	if (!efforts || efforts.length === 0) {
		return requested === "low" || requested === "medium" || requested === "high"
			? requested
			: undefined;
	}

	if (efforts.includes(requested)) return requested;

	// `max` with no explicit `max` tier collapses to the strongest listed level.
	if (requested === "max") {
		for (let i = EFFORT_RANK.length - 1; i >= 0; i--) {
			const level = EFFORT_RANK[i];
			if (level !== "max" && efforts.includes(level)) return level;
		}
	}
	return undefined;
}

/** A 4xx that names a model/session problem the user can act on. */
function isSessionError(err: unknown): boolean {
	if (!(err instanceof LLMError)) return false;
	const s = err.statusCode;
	return s !== undefined && s >= 400 && s < 500;
}

/**
 * Wrap a fetch so each Chat Completions SSE `data:` line's non-standard
 * `delta.reasoning_opaque` is accumulated into `collected`. Some models reached
 * over the chat route (verified live: Gemini via Copilot) carry their reasoning
 * in this field, which @ai-sdk/openai .chat has no schema for and drops. We tap
 * the response body here (the only place the raw field survives), accumulate the
 * blob, and leave the stream otherwise untouched — the SDK still parses the
 * standard `content`/`tool_calls` deltas from the teed copy. Non-SSE responses
 * (errors) pass through unmodified.
 */
/**
 * Per-attempt capture of chat-route `reasoning_opaque` deltas. `scan` is the
 * in-flight tee scanner, awaited before injection so the blob is complete even
 * when the SDK's branch reaches `done` first.
 */
interface ReasoningOpaqueCapture {
	reasoningOpaque: string;
	scan: Promise<void> | null;
	/** Chars seen after the blob passed {@link MAX_REASONING_OPAQUE_CHARS}; 0 when within budget. */
	droppedChars?: number;
}

/**
 * Cap on one turn's accumulated chat-route `reasoning_opaque`. Observed Copilot
 * Gemini blobs average ~5.5K chars and top out near 111K; a blob past this cap is
 * a model looping inside its reasoning until the output budget runs out (#340),
 * not state worth persisting. Past the cap the whole blob is dropped.
 */
export const MAX_REASONING_OPAQUE_CHARS = 256 * 1024;

/** Origin stamped on chat-route opaque reasoning. It matches no Responses deployment's
 * origin, so the bridge drops the blob instead of replaying it to a provider that can't
 * decrypt it. */
const CHAT_OPAQUE_ORIGIN_SUFFIX = "chat-reasoning-opaque";

function captureReasoningOpaque(
	baseFetch: typeof fetch,
	collected: ReasoningOpaqueCapture,
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await baseFetch(input, init);
		const contentType = res.headers.get("content-type") ?? "";
		if (!res.body || !contentType.includes("text/event-stream")) return res;
		// Tee: one branch is scanned for reasoning_opaque, the other is handed to
		// the SDK. A TransformStream scanner keeps the SDK's branch streaming.
		const [forSdk, forScan] = res.body.tee();
		collected.scan = scanReasoningOpaque(forScan, collected);
		return new Response(forSdk, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	}) as typeof fetch;
}

/**
 * Append one `reasoning_opaque` delta, enforcing {@link MAX_REASONING_OPAQUE_CHARS}.
 * A blob that crosses the cap is discarded whole (a truncated opaque blob cannot be
 * replayed) and later deltas are only counted.
 */
export function appendReasoningOpaque(collected: ReasoningOpaqueCapture, opaque: string): void {
	if (collected.droppedChars !== undefined && collected.droppedChars > 0) {
		collected.droppedChars += opaque.length;
		return;
	}
	if (collected.reasoningOpaque.length + opaque.length > MAX_REASONING_OPAQUE_CHARS) {
		collected.droppedChars = collected.reasoningOpaque.length + opaque.length;
		collected.reasoningOpaque = "";
		return;
	}
	collected.reasoningOpaque += opaque;
}

/** Scan an SSE byte stream for `delta.reasoning_opaque` and accumulate it. */
async function scanReasoningOpaque(
	stream: ReadableStream<Uint8Array>,
	collected: ReasoningOpaqueCapture,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			// biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitter loop
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "" || payload === "[DONE]") continue;
				try {
					const parsed = JSON.parse(payload) as {
						choices?: Array<{ delta?: { reasoning_opaque?: unknown } }>;
					};
					const opaque = parsed.choices?.[0]?.delta?.reasoning_opaque;
					if (typeof opaque === "string" && opaque.length > 0) {
						appendReasoningOpaque(collected, opaque);
					}
				} catch {
					// A non-JSON data line is not ours to interpret; skip it.
				}
			}
		}
	} catch {
		// A scan failure must never affect the SDK's branch — swallow and stop.
	} finally {
		reader.releaseLock();
	}
}

/**
 * Emit the accumulated chat-route `reasoning_opaque` blob as a thinking chunk
 * just before the terminal `done`, so a turn whose output was all reasoning the
 * SDK dropped surfaces visible thinking (and the loop's degenerate guard sees
 * it). The blob is opaque per-provider state; it rides `reasoning_encrypted_content`
 * and carries no `reasoning_origin`, so the PERMISSIVE replay path (chat route sets
 * no `reasoningProviderOptions`) drops it on the next turn rather than replaying
 * an un-decryptable blob. Emits nothing when no reasoning_opaque was seen.
 */
export async function* injectReasoningOpaque(
	stream: AsyncIterable<StreamChunk>,
	collected: ReasoningOpaqueCapture,
	reasoningOrigin: string,
	logger?: Pick<Logger, "warn">,
): AsyncIterable<StreamChunk> {
	let injected = false;
	for await (const chunk of stream) {
		if (chunk.type === "done" && !injected) {
			if (collected.scan) await collected.scan;
			const dropped = collected.droppedChars ?? 0;
			if (dropped > 0) {
				injected = true;
				logger?.warn("[copilot] Dropped oversized chat-route reasoning_opaque blob", {
					chars: dropped,
					maxChars: MAX_REASONING_OPAQUE_CHARS,
					finishReason: chunk.finish_reason ?? null,
				});
				// Keep a visible thinking marker so the loop's degenerate guard still
				// sees that this turn's output went to reasoning.
				yield {
					type: "thinking",
					content: `[reasoning dropped: ${dropped} chars exceeded the ${MAX_REASONING_OPAQUE_CHARS}-char cap]`,
				};
			} else if (collected.reasoningOpaque.length > 0) {
				injected = true;
				yield {
					type: "thinking",
					content: "",
					reasoning_encrypted_content: collected.reasoningOpaque,
					reasoning_origin: reasoningOrigin,
				};
			}
		}
		yield chunk;
	}
}

/**
 * Map one Copilot catalog entry to a {@link DiscoveredModel}.
 * `max_context`: the prompt budget is `maxPromptTokens`,
 * so the effective window is `min(maxContextWindowTokens, maxPromptTokens +
 * maxOutputTokens)`. When the entry lacks `maxContextWindowTokens` the window is
 * left unset (lower layers fill it); when it lacks `maxPromptTokens` the raw
 * `maxContextWindowTokens` is used as-is.
 */
function copilotEntryToDiscoveredModel(entry: CopilotModelEntry): DiscoveredModel {
	const capabilities: NonNullable<DiscoveredModel["capabilities"]> = {};
	if (entry.supportsToolCalls !== undefined) capabilities.tool_use = entry.supportsToolCalls;
	if (entry.supportsVision !== undefined) capabilities.vision = entry.supportsVision;
	const ctxWindow = entry.maxContextWindowTokens;
	if (ctxWindow !== undefined) {
		capabilities.max_context =
			entry.maxPromptTokens !== undefined
				? Math.min(ctxWindow, entry.maxPromptTokens + (entry.maxOutputTokens ?? 0))
				: ctxWindow;
	}
	// Structured reasoning metadata from the Copilot catalog's `supports` facts
	//: the advertised effort ladder and the adaptive-thinking flag.
	// Only emitted when the catalog states something, so absence stays distinct from
	// an explicit denial and lower layers (models.dev) can still fill it.
	if (entry.reasoningEfforts !== undefined || entry.adaptiveThinking !== undefined) {
		capabilities.reasoning = {
			supported: true,
			...(entry.reasoningEfforts !== undefined &&
				entry.reasoningEfforts.length > 0 && { effort_values: entry.reasoningEfforts }),
			...(entry.adaptiveThinking !== undefined && { adaptive: entry.adaptiveThinking }),
		};
	}
	const model: DiscoveredModel = {
		providerModelId: entry.id,
		...(entry.name !== undefined && entry.name.length > 0 && { displayName: entry.name }),
		...(Object.keys(capabilities).length > 0 && { capabilities }),
		...(entry.maxOutputTokens !== undefined && { maxOutputTokens: entry.maxOutputTokens }),
	};
	return model;
}

/** One catalog model, carried through the shared namespace readiness. */
interface CopilotLineupEntry extends NamespaceLineupEntry {
	entry: CopilotModelEntry;
}

/**
 * `CopilotCatalog.load()` swallows a fetch failure into an EMPTY map rather than
 * throwing, so an empty lineup is the retry signal: a reachable-but-empty
 * account and an unreachable endpoint are indistinguishable, and both retry
 * until one yields a non-empty catalog.
 */
function copilotLineupEntries(catalog: Map<string, CopilotModelEntry>): CopilotLineupEntry[] {
	return [...catalog.values()].map((entry) => ({
		id: entry.id,
		discovered: copilotEntryToDiscoveredModel(entry),
		entry,
	}));
}

/**
 * Routable iff the driver speaks one of the entry's endpoints (e.g. an
 * embeddings-only model is excluded). A model with NO endpoints listed (legacy)
 * is routed by the name heuristic, so it is kept. The provider-local `auto`
 * pseudo-model is not in the `/models` catalog; it stays a separately-configured
 * entry.
 */
function isRoutableCopilotEntry({ entry }: CopilotLineupEntry): boolean {
	return !entry.supportedEndpoints || routeFromEndpoints(entry.supportedEndpoints) !== null;
}

/**
 * Descriptor for one expanded Copilot model, id `${namespaceId}-${providerModelId}`
 * (e.g. `copilot-claude-opus-5.5`). Logical-model grouping (normalize.ts strips
 * the `copilot-` dashed prefix) collapses the expanded id and the raw
 * `providerModelId` to the same logical key, so an expanded backend pools and
 * routes exactly like a static one.
 */
function buildCopilotDescriptor(namespaceId: string, entry: CopilotLineupEntry): ModelDescriptor {
	const { discovered } = entry;
	const caps = discovered.capabilities;
	const maxContext = caps?.max_context;
	const capabilities: BackendCapabilities = {
		streaming: true,
		tool_use: caps?.tool_use ?? false,
		system_prompt: true,
		prompt_caching: true,
		vision: caps?.vision ?? false,
		extended_thinking: caps?.reasoning?.supported ?? false,
		...(maxContext !== undefined && { max_context: maxContext }),
	};
	return {
		id: `${namespaceId}-${entry.id}`,
		providerModelId: entry.id,
		discovered,
		capabilities,
		...(discovered.maxOutputTokens !== undefined && {
			maxOutputTokens: discovered.maxOutputTokens,
		}),
	};
}

export class GitHubCopilotDriver implements LLMBackend {
	private readonly tokenManager: CopilotTokenManager;
	/** Concrete provider model id. Empty string on a namespace instance (no model). */
	private readonly model: string;
	private readonly contextWindow: number;
	private readonly logger?: Logger;
	private readonly baseFetch?: typeof fetch;
	private readonly resolveAccount: () => Promise<CopilotAccountInfo>;
	private readonly now?: () => number;
	/**
	 * Identity of THIS Copilot deployment, `${siteId}:${PROVIDER_NAME}`, or
	 * undefined when no siteId was supplied (tests). Used only on the Responses
	 * route (the only Copilot route that mints OpenAI encrypted reasoning, via
	 * `include: ["reasoning.encrypted_content"]`): stamped onto minted encrypted
	 * reasoning and compared against each replayed block's `reasoning_origin` so a
	 * blob minted by a DIFFERENT provider/host (e.g. the bedrock-mantle or
	 * chatgpt-oauth deployment of the same model id) is dropped before it 400s the
	 * turn. Encrypted reasoning does not cross providers.
	 */
	private readonly reasoningOrigin?: string;
	// Per-route prompt-cache field recovery (R-MC14): remembers when a route
	// rejected its cache-lifetime field (Messages `cache_control`, Responses
	// `prompt_cache_options.ttl`), so later requests skip the doomed field.
	// In-memory, keyed by route; a fresh process re-learns.
	private readonly cacheRecovery = new CacheFieldRecoveryState();
	/** Per-turn request context the fetch wrapper snapshots on each send. */
	private requestContext: CopilotRequestContext = { initiator: "user", hasImages: false };
	/**
	 * Lazily-resolved per-endpoint state. The account lookup (which yields the
	 * validated API endpoint) is async, but `createBackendFromConfig` is
	 * synchronous — so the catalog + auto-session machinery is built on first
	 * chat, once the endpoint is known, and cached for the driver's lifetime.
	 */
	private endpointState: Promise<{
		apiEndpoint: string;
		catalog: CopilotCatalog;
		autoSessions: CopilotAutoSessionCache;
	}> | null = null;
	/**
	 * Self-configuration handle. Present ONLY on a namespace instance (built with
	 * no `model`): it fetches the account's Copilot catalog and registers one
	 * concrete per-model driver per chat-routable model (mirrors the umans lineup
	 * driver). A single-model instance leaves this undefined and is immediately
	 * invokable.
	 */
	readonly readiness?: BackendReadiness;
	/** True on the namespace instance; its `chat()` throws a guard. */
	private readonly isNamespace: boolean;

	constructor(config: {
		tokenManager: CopilotTokenManager;
		/**
		 * Concrete provider model id. OMITTED builds a namespace instance: it owns
		 * `readiness`, fetches the account's Copilot catalog, and registers one
		 * per-model driver per chat-routable model (self-configuring expansion,
		 * catalog §4.1). Its own `chat()` throws a guard.
		 */
		model?: string;
		contextWindow: number;
		/**
		 * Either an already-resolved account (tests, the login path) or a resolver
		 * called once on first chat. The resolver yields the VALIDATED Copilot API
		 * endpoint — see `fetchAccountInfo` + `validateCopilotApiEndpoint`.
		 */
		account?: CopilotAccountInfo;
		resolveAccount?: () => Promise<CopilotAccountInfo>;
		logger?: Logger;
		fetch?: typeof fetch;
		connectTimeoutMs?: number;
		/** Test seam: inject a clock for catalog/session TTL gating. */
		now?: () => number;
		/**
		 * This host's site id. Combined with the provider name to form the deployment
		 * identity stamped onto / compared against encrypted reasoning on the Responses
		 * route. Omitted in tests that don't exercise the cross-provider path.
		 */
		siteId?: string;
		/**
		 * The namespace entry's config `id` (e.g. `copilot`). Present ONLY on a
		 * namespace instance; expanded per-model backend ids are derived as
		 * `${namespaceId}-${providerModelId}`. Omitted on a
		 * single-model instance.
		 */
		namespaceId?: string;
		/** Namespace-lineup retry backoff base, ms (test seam; default below). */
		lineupRetryBaseMs?: number;
		/** Namespace-lineup retry backoff cap, ms (test seam; default below). */
		lineupRetryMaxMs?: number;
	}) {
		this.tokenManager = config.tokenManager;
		this.model = config.model ?? "";
		this.isNamespace = !config.model;
		this.contextWindow = config.contextWindow;
		this.logger = config.logger;
		this.baseFetch = resolveProviderFetch(PROVIDER_NAME, config);
		if (config.now) this.now = config.now;
		this.reasoningOrigin = buildReasoningOrigin({
			siteId: config.siteId,
			provider: PROVIDER_NAME,
		});
		const eager = config.account;
		this.resolveAccount =
			config.resolveAccount ??
			(eager
				? () => Promise.resolve(eager)
				: () => {
						throw new Error("GitHubCopilotDriver requires account or resolveAccount");
					});
		if (this.isNamespace) {
			// Namespace instance: own the lineup readiness. The per-model drivers it
			// builds on expansion share this instance's token manager, resolved
			// account, fetch, and siteId (so each concrete route stamps the same
			// `reasoning_origin`). The fetch is NOT started here — the wiring layer
			// calls `readiness.start(registrar)` once the registrar is bound.
			const namespaceId = config.namespaceId ?? "";
			this.readiness = new NamespaceLineupReadiness<CopilotLineupEntry>({
				providerName: "copilot",
				registrationKey: PROVIDER_NAME,
				buildPerModelBackend: ({ id: model }, contextWindow) =>
					new GitHubCopilotDriver({
						tokenManager: config.tokenManager,
						model,
						contextWindow,
						...(config.account && { account: config.account }),
						...(config.resolveAccount && { resolveAccount: config.resolveAccount }),
						...(config.logger && { logger: config.logger }),
						...(config.fetch && { fetch: config.fetch }),
						...(config.connectTimeoutMs !== undefined && {
							connectTimeoutMs: config.connectTimeoutMs,
						}),
						...(config.now && { now: config.now }),
						...(config.siteId && { siteId: config.siteId }),
					}),
				namespaceId,
				loadLineup: async () => copilotLineupEntries(await (await this.endpoint()).catalog.load()),
				include: isRoutableCopilotEntry,
				buildDescriptor: (entry) => buildCopilotDescriptor(namespaceId, entry),
				...(config.logger && { logger: config.logger }),
				...(config.lineupRetryBaseMs !== undefined && {
					retryBaseMs: config.lineupRetryBaseMs,
				}),
				...(config.lineupRetryMaxMs !== undefined && {
					retryMaxMs: config.lineupRetryMaxMs,
				}),
			});
		}
	}

	/**
	 * Provider-neutral auth-refresh hook (#285, R-RT13). A live `401` means the
	 * Copilot API rejected the current token; force a token rotation through the
	 * shared CopilotTokenManager. `true` on a successful rotation lets the loop
	 * retry without backing off; `false` (dead refresh token) makes the loop back
	 * off and raise a re-login advisory.
	 */
	async refreshAuth(): Promise<boolean> {
		return this.tokenManager.forceRefresh();
	}

	/** Build (once) the endpoint-scoped catalog + auto-session machinery. */
	private endpoint(): Promise<{
		apiEndpoint: string;
		catalog: CopilotCatalog;
		autoSessions: CopilotAutoSessionCache;
	}> {
		if (!this.endpointState) {
			this.endpointState = (async () => {
				const account = await this.resolveAccount();
				const apiEndpoint = account.apiEndpoint;
				const controlFetch = createCopilotControlFetch({
					getAccessToken: () => this.tokenManager.getAccessToken(),
					baseFetch: this.baseFetch,
				});
				const catalog = new CopilotCatalog({
					fetch: controlFetch,
					apiEndpoint,
					...(this.now && { now: this.now }),
				});
				const autoSessions = new CopilotAutoSessionCache({
					fetch: controlFetch,
					apiEndpoint,
					...(this.now && { now: this.now }),
				});
				return { apiEndpoint, catalog, autoSessions };
			})().catch((err) => {
				// Reset so a transient account-lookup failure can be retried next turn.
				this.endpointState = null;
				throw err;
			});
		}
		return this.endpointState;
	}

	chat(params: ChatParams): AsyncIterable<StreamChunk> {
		return bindAsyncIterable(context.active(), this.chatStream(params));
	}

	private copilotFetch(): typeof fetch {
		return createCopilotFetch({
			getAccessToken: () => this.tokenManager.getAccessToken(),
			getRequestContext: () => this.requestContext,
			baseFetch: this.baseFetch,
		});
	}

	private async *chatStream(params: ChatParams): AsyncIterable<StreamChunk> {
		// Namespace guard (defense-in-depth, mirrors umans). The namespace instance
		// owns no concrete model and must never serve inference. Some CLI-layer sites
		// call modelRouter.getDefault().chat(...) directly, bypassing the resolveModel
		// not-ready gate during the warmup window; a clear throw degrades gracefully
		// instead of a request against an empty model id.
		if (this.isNamespace) {
			throw new LLMError(
				"github-copilot namespace backend is not directly invokable — lineup not yet resolved / backend not ready",
				PROVIDER_NAME,
			);
		}
		const configuredModel = params.model || this.model;
		const { apiEndpoint, catalog, autoSessions } = await this.endpoint();

		// Resolve auto → a concrete model + a session token scoped to it.
		let modelId = configuredModel;
		let session: CopilotAutoSession | undefined;
		if (configuredModel === AUTO_MODEL) {
			session = await autoSessions.get(params.threadId, lastUserText(params.messages));
			modelId = session.selectedModelId;
			this.logger?.info?.(
				`[${PROVIDER_NAME}] auto selected ${modelId}${session.selectionReason ? ` (${session.selectionReason})` : ""}`,
			);
		}

		const entry = await catalog.getEntry(modelId);
		const route = resolveRoute(modelId, entry);

		// Snapshot the per-turn header facts the fetch wrapper reads on send.
		this.requestContext = {
			initiator: resolveInitiator(latestRole(params.messages)),
			hasImages: messagesHaveImages(params.messages),
			...(session && { sessionToken: session.sessionToken }),
		};

		yield { type: "heartbeat" };

		// The chat route taps `reasoning_opaque` SSE deltas into this ref (shared
		// with streamChat's fetch wrapper) so injectReasoningOpaque can surface the
		// accumulated blob as a thinking chunk. A fresh object per chatStream call
		// scopes capture to this turn; each withEmptyRetry re-issue rebuilds the
		// stream via the `stream` thunk, resetting the buffer below.
		const collectedReasoningOpaque: ReasoningOpaqueCapture = { reasoningOpaque: "", scan: null };

		const runAttempt = (
			stripEncryptedReasoning: boolean,
			cacheDecision: CacheFieldDecision | undefined,
		): AsyncIterable<StreamChunk> => {
			const mapped = mapProviderStream({
				providerName: PROVIDER_NAME,
				stream: () => {
					// Reset the per-attempt capture buffer: a re-issue is a clean new
					// request whose reasoning must not inherit the prior attempt's blob.
					collectedReasoningOpaque.reasoningOpaque = "";
					collectedReasoningOpaque.scan = null;
					collectedReasoningOpaque.droppedChars = 0;
					return this.streamForRoute(
						route,
						modelId,
						apiEndpoint,
						params,
						entry,
						stripEncryptedReasoning,
						collectedReasoningOpaque,
						cacheDecision,
					);
				},
				// The messages route goes to @ai-sdk/anthropic, which surfaces the
				// cache-write total (and the 1h/5m split) under providerMetadata.anthropic.
				// Tag it so the bridge extracts both; the structured
				// inputTokenDetails.cacheWriteTokens path still takes precedence for the
				// total, so this only adds the split (and a metadata-shaped total
				// fallback), never changes today's cache_write_tokens for this route.
				map: {
					estimateInputFromMessages: params.messages,
					...(route === "messages" && { usageProvider: "anthropic" as const }),
					// Only the Responses route mints OpenAI encrypted reasoning; stamp it
					// with this deployment's origin so a later request-build on a DIFFERENT
					// provider/host drops the un-replayable blob instead of 400-ing.
					...(route === "responses" &&
						this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
					// The route's wire protocol default cache lifetime, stamped so the cost
					// layer prices a reported split entry at this lifetime as a matched rate
					// (5m for the Anthropic Messages route, 30m for OpenAI Responses). Chat
					// has no cache-lifetime protocol field, so none is stamped there.
					...(route === "messages" && { cacheWriteDefaultLifetime: "5m" as const }),
					...(route === "responses" && { cacheWriteDefaultLifetime: "30m" as const }),
				},
			});
			// The chat route can carry reasoning in a non-standard delta field the SDK
			// drops; surface it as a thinking chunk so the output is visible and the
			// loop's degenerate guard sees thinking present. No-op on other routes.
			return route === "chat"
				? injectReasoningOpaque(
						mapped,
						collectedReasoningOpaque,
						`${this.reasoningOrigin ?? PROVIDER_NAME}:${CHAT_OPAQUE_ORIGIN_SUFFIX}`,
						this.logger,
					)
				: mapped;
		};

		const routedThroughAuto = configuredModel === AUTO_MODEL;
		try {
			// withEmptyRetry handles the empty-completion retry; withEncryptedReasoningRetry
			// (shared) adds the ONE strip-and-retry when the Responses endpoint rejects a
			// cross-provider encrypted-reasoning blob (minted by, e.g., the bedrock-mantle
			// or chatgpt-oauth deployment of this same model id on another host). Non-
			// Responses routes never mint or replay such blobs, so the wrapper is a no-op
			// there (the rejection classifier won't match a non-encrypted-reasoning error).
			//
			// withCacheFieldRecovery (R-MC14) wraps the whole retry stack: a cache-field
			// rejection on this route's cache-lifetime field (Messages `cache_control`,
			// Responses `prompt_cache_options.ttl`) records the per-route decision and
			// reissues ONCE with the field dropped/corrected — never a route failure.
			yield* this.stampCost(
				withCacheFieldRecovery({
					routeId: modelId,
					state: this.cacheRecovery,
					// The cache-lifetime field depends on the route: Messages sends
					// `cache_control`, Responses sends `prompt_cache_options` (`{ mode, ttl }`,
					// which providers may reject by either `prompt_cache_options.ttl` or the
					// parent `prompt_cache_options`). Chat sends none, so its field list is
					// empty and recovery never fires.
					fields:
						route === "messages"
							? ["cache_control"]
							: route === "responses"
								? ["prompt_cache_options.ttl", "prompt_cache_options"]
								: [],
					// Messages `cache_control.ttl` accepts "5m"/"1h"; Responses
					// `prompt_cache_options.ttl` accepts only "30m" (the protocol's single
					// lifetime); a rejection of the whole `prompt_cache_options` object always
					// drops it. A listed value outside the route's set is dropped.
					validValuesFor: (field) =>
						field === "prompt_cache_options.ttl"
							? ["30m"]
							: field === "prompt_cache_options"
								? []
								: ["5m", "1h"],
					onRecover: (field, decision) =>
						this.logger?.warn?.(
							`[${PROVIDER_NAME}] prompt-cache field '${field}' rejected; retrying once (${decision.kind === "use-value" ? `value=${decision.value}` : "dropped"}) and remembering for this route`,
							{ model: modelId },
						),
					run: (cacheDecision) =>
						withEncryptedReasoningRetry({
							build: (stripEncryptedReasoning) => stripEncryptedReasoning,
							run: (stripEncryptedReasoning) =>
								withEmptyRetry(() => runAttempt(stripEncryptedReasoning, cacheDecision), {
									maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
									isAborted: () => params.signal?.aborted ?? false,
									providerName: PROVIDER_NAME,
									modelId,
									logger: this.logger,
								}),
							onStrip: () =>
								this.logger?.warn?.(
									`[${PROVIDER_NAME}] encrypted-reasoning rejected (cross-provider replay); retrying once with encrypted reasoning stripped`,
									{ model: modelId },
								),
						}),
				}),
				entry,
				routedThroughAuto,
			);
		} catch (err) {
			// A 4xx session error invalidates the cached auto-session so the next
			// turn re-resolves; surface a catalog/plan 400 as actionable.
			if (session && isSessionError(err)) {
				autoSessions.invalidate(params.threadId);
			}
			throw this.mapCopilotError(err, modelId);
		}
	}

	/**
	 * Stamp `cost_usd` and its four-part `cost_breakdown` on the terminal `done`
	 * chunk from the resolved model's Copilot catalog pricing. Leaves both unset
	 * when the catalog carries no pricing for the model, so the precedence helper
	 * downstream can fall through to operator pricing or 0. The 1h cache-write
	 * split comes from `done.usage.cache_write_1h_tokens`, which the Messages
	 * route reads from Anthropic's `usage.cache_creation`.
	 */
	private async *stampCost(
		stream: AsyncIterable<StreamChunk>,
		entry: CopilotModelEntry | null,
		routedThroughAuto: boolean,
	): AsyncIterable<StreamChunk> {
		const pricing = entry?.pricing;
		for await (const chunk of stream) {
			if (chunk.type === "done" && pricing) {
				const cost_breakdown = computeCopilotCostBreakdown({
					pricing,
					usage: {
						inputTokens: chunk.usage.input_tokens,
						outputTokens: chunk.usage.output_tokens,
						cacheReadTokens: chunk.usage.cache_read_tokens ?? 0,
						cacheWriteTokens: chunk.usage.cache_write_tokens ?? 0,
						cacheWrite1hTokens: chunk.usage.cache_write_1h_tokens ?? 0,
					},
					nowMs: Date.now(),
					routedThroughAuto,
				});
				const cost_usd =
					cost_breakdown.input +
					cost_breakdown.output +
					cost_breakdown.cacheRead +
					cost_breakdown.cacheWrite;
				yield { ...chunk, cost_usd, cost_breakdown };
				continue;
			}
			yield chunk;
		}
	}

	/** Build the AI SDK stream for the resolved route. */
	private streamForRoute(
		route: CopilotRoute,
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		entry: CopilotModelEntry | null,
		stripEncryptedReasoning: boolean,
		collectedReasoningOpaque: ReasoningOpaqueCapture,
		cacheDecision: CacheFieldDecision | undefined,
	): AsyncIterable<unknown> {
		if (route === "messages")
			return this.streamMessages(modelId, apiEndpoint, params, cacheDecision);
		if (route === "responses")
			return this.streamResponses(
				modelId,
				apiEndpoint,
				params,
				entry,
				stripEncryptedReasoning,
				cacheDecision,
			);
		return this.streamChat(modelId, apiEndpoint, params, entry, collectedReasoningOpaque);
	}

	/**
	 * The `prompt_cache_options.ttl` value to send on the Responses route, or
	 * undefined to omit the field. The OpenAI Responses protocol's single cache
	 * lifetime is "30m" (the SDK's typed union admits only that value); Bound sends
	 * it when the caller signalled caching intent (`params.cache_ttl` set) and no
	 * prior rejection on this route dropped the field. A recovery `drop` omits it;
	 * a `use-value` resends the provider-listed value when it is "30m". Branches on
	 * the recovery decision and caching intent, never on a model ID (R-MC1).
	 */
	private responsesCacheTtl(
		params: ChatParams,
		cacheDecision: CacheFieldDecision | undefined,
	): "30m" | undefined {
		if (cacheDecision?.kind === "drop") return undefined;
		if (cacheDecision?.kind === "use-value")
			return cacheDecision.value === "30m" ? "30m" : undefined;
		return params.cache_ttl !== undefined ? "30m" : undefined;
	}

	/** Anthropic Messages route via @ai-sdk/anthropic, baseURL `${api}/v1`. */
	private streamMessages(
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		cacheDecision: CacheFieldDecision | undefined,
	): AsyncIterable<unknown> {
		const provider = createAnthropic({
			apiKey: "copilot", // placeholder — the fetch wrapper strips x-api-key and sets the Bearer
			baseURL: `${apiEndpoint}/v1`,
			fetch: this.copilotFetch(),
			headers: { "anthropic-version": "2023-06-01" },
		});
		// Apply any cache-field recovery decision for this route (R-MC14): `drop`
		// disables cache_control this turn, `use-value` resends the provider-listed
		// ttl. `undefined` sends the configured cache_ttl. The field is cache_control.
		const cachingDropped = cacheDecision?.kind === "drop";
		const requestedTtl: "5m" | "1h" =
			cacheDecision?.kind === "use-value" &&
			(cacheDecision.value === "5m" || cacheDecision.value === "1h")
				? cacheDecision.value
				: params.cache_ttl === "1h"
					? "1h"
					: "5m";
		const bridgeMessages = toModelMessages(params.messages, {
			cacheProvider: cachingDropped ? null : "anthropic",
			cacheTtl: requestedTtl,
			resolveFileRef: params.resolveFileRef,
			reasoningProviderOptions: "anthropic",
			targetEnvelope: ANTHROPIC_ENVELOPE,
		});
		const systemMessage = buildCachedSystemMessage("anthropic", {
			system: params.system,
			cacheEnabled:
				!cachingDropped &&
				shouldEnableSystemCache("anthropic", {
					cacheTtl:
						params.cache_ttl === "1h" || params.cache_ttl === "5m" ? params.cache_ttl : undefined,
					bridgeMessages,
				}),
			cacheTtl: requestedTtl,
		});
		const messages: ModelMessage[] = systemMessage
			? [systemMessage, ...bridgeMessages]
			: bridgeMessages;
		const tools = toToolSet(params.tools);
		const reasoning = buildAnthropicReasoningOptions(params);
		return streamText({
			model: provider.languageModel(modelId),
			messages,
			// The system prompt rides as a role:"system" ModelMessage at index 0 (see
			// buildCachedSystemMessage); ai@7 streamText rejects it unless we opt in.
			allowSystemInMessages: true,
			...(tools && { tools }),
			...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			...(params.temperature !== undefined && !reasoning && { temperature: params.temperature }),
			abortSignal: params.signal,
			...(reasoning && {
				providerOptions: { anthropic: reasoning as Record<string, unknown> as never },
			}),
		}).fullStream;
	}

	/** OpenAI Responses route via @ai-sdk/openai .responses, baseURL `${api}`. */
	private streamResponses(
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		entry: CopilotModelEntry | null,
		stripEncryptedReasoning: boolean,
		cacheDecision: CacheFieldDecision | undefined,
	): AsyncIterable<unknown> {
		const provider = createOpenAI({
			name: PROVIDER_NAME,
			apiKey: "copilot",
			baseURL: apiEndpoint,
			fetch: this.copilotFetch(),
		});
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: OPENAI_RESPONSES_ENVELOPE,
			reasoningProviderOptions: "openai",
			// Layer 1: drop replayed encrypted reasoning minted on a DIFFERENT
			// provider/host (e.g. the bedrock-mantle or chatgpt-oauth deployment of
			// this same model id) — the Copilot Responses endpoint rejects a foreign blob.
			...(this.reasoningOrigin && { reasoningOrigin: this.reasoningOrigin }),
			// Layer 2: strip ALL encrypted reasoning on the one post-rejection retry.
			...(stripEncryptedReasoning && { stripEncryptedReasoning: true }),
			midConversationSystem: true,
		});
		const tools = toToolSet(params.tools);
		const effort = resolveReasoningEffort(params, entry?.reasoningEfforts);
		// When reasoning is active, run under store:false + encrypted_content so the
		// model replays its reasoning inline rather than via item_reference ids that
		// Copilot may not retain (mirrors OpenCode and the chatgpt-oauth driver).
		// forceReasoning is required because the SDK only auto-detects gpt-5*; a
		// gpt-6.x / grok / mai-code turn would otherwise drop the reasoning fields.
		const openaiOptions: OpenAIResponsesProviderOptions = {
			...(params.threadId && { promptCacheKey: params.threadId }),
			// R-MC14 Request: when caching is intended, send the OpenAI Responses
			// protocol's OWN cache-lifetime field, `prompt_cache_options` (`{ mode, ttl }`).
			// Copilot's Responses endpoint requires `mode` whenever `prompt_cache_options`
			// is present (omitting it 400s with `Invalid value: ''. Supported values are:
			// 'implicit' and 'explicit'.`); this route sends no explicit breakpoints
			// (`cacheProvider: null`), so `mode: "implicit"` matches the wire contract.
			// The SDK's typed union accepts only "30m" for `ttl`. A prior rejection
			// recorded for this route drops the field (`drop`) or resends a
			// provider-listed value; recovery, not a per-provider special case, handles
			// models that reject `prompt_cache_options`.
			...(this.responsesCacheTtl(params, cacheDecision) && {
				promptCacheOptions: {
					mode: "implicit" as const,
					ttl: this.responsesCacheTtl(params, cacheDecision) as "30m",
				},
			}),
			...(effort && {
				forceReasoning: true,
				reasoningEffort: effort,
				reasoningSummary: "auto",
				store: false,
				include: ["reasoning.encrypted_content"],
			}),
		};
		return streamText({
			model: provider.responses(modelId),
			messages,
			allowSystemInMessages: true,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
			// Gemini and other reasoners burn the whole budget on reasoning when
			// the output budget is tiny; only forward a sane cap.
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			abortSignal: params.signal,
			...(Object.keys(openaiOptions).length > 0 && {
				providerOptions: { openai: openaiOptions },
			}),
		}).fullStream;
	}

	/**
	 * Chat Completions route via @ai-sdk/openai .chat, baseURL `${api}`.
	 *
	 * Some models reached over this route (verified live: Gemini via Copilot)
	 * carry their reasoning in a NON-STANDARD `delta.reasoning_opaque` field that
	 * @ai-sdk/openai .chat has no schema for and drops silently. A turn that
	 * spends its whole output budget on reasoning then surfaces no text and no
	 * tool call — output_tokens > 0 but nothing visible — which slips past both the
	 * driver empty-retry (keyed on output_tokens === 0) and the loop's
	 * thinking-gated degenerate guard, recording as a silent success.
	 *
	 * `captureReasoningOpaque` taps the raw SSE at the fetch layer and accumulates
	 * any `reasoning_opaque` deltas into `collected`; `injectReasoningOpaque`
	 * (applied to the mapped StreamChunk stream) emits the accumulated blob as a
	 * thinking chunk so the output is visible and the degenerate guard sees
	 * thinking present. The blob is opaque per-provider state; it rides
	 * `reasoning_encrypted_content`, which the PERMISSIVE replay path drops on the
	 * next turn (the chat route sets no `reasoningProviderOptions`), so it is
	 * surfaced for this turn without being replayed to a provider that can't use it.
	 */
	private streamChat(
		modelId: string,
		apiEndpoint: string,
		params: ChatParams,
		entry: CopilotModelEntry | null,
		collected: ReasoningOpaqueCapture,
	): AsyncIterable<unknown> {
		const provider = createOpenAI({
			name: PROVIDER_NAME,
			apiKey: "copilot",
			baseURL: apiEndpoint,
			fetch: captureReasoningOpaque(this.copilotFetch(), collected),
		});
		const messages = toModelMessages(params.messages, {
			cacheProvider: null,
			resolveFileRef: params.resolveFileRef,
			targetEnvelope: PERMISSIVE_ENVELOPE,
			midConversationSystem: true,
		});
		const tools = toToolSet(params.tools);
		const effort = resolveReasoningEffort(params, entry?.reasoningEfforts);
		return streamText({
			model: provider.chat(modelId),
			messages,
			allowSystemInMessages: true,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(tools && params.tool_choice && { toolChoice: params.tool_choice }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			...(params.temperature !== undefined && { temperature: params.temperature }),
			abortSignal: params.signal,
			...(effort && { providerOptions: { openai: { reasoningEffort: effort } } }),
		}).fullStream;
	}

	/**
	 * Map a Copilot API error into an actionable LLMError. `model_not_supported`
	 * and `no_available_model_endpoints` mean the account/plan can't call this
	 * model — surface a non-retryable, actionable message.
	 */
	private mapCopilotError(err: unknown, modelId: string): unknown {
		if (!(err instanceof LLMError)) return err;
		const msg = err.message.toLowerCase();
		if (msg.includes("model_not_supported") || msg.includes("no_available_model_endpoints")) {
			return new LLMError(
				`Copilot model "${modelId}" is unavailable for this plan. Try \`auto\` or a zero-priced model (e.g. gpt-4.1, gpt-4o, gpt-5.4-nano). Underlying error: ${err.message}`,
				PROVIDER_NAME,
				err.statusCode,
			);
		}
		return err;
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			vision: true,
			prompt_caching: true,
			// Extended thinking is the Claude (Messages) route's capability; the
			// catalog isn't available synchronously, so route from the model name.
			extended_thinking: routeFromModelName(this.model) === "messages",
			max_context: this.contextWindow,
		};
	}

	fallbackSupport(): DriverFallbackSupport {
		// GitHub Copilot exposes no refusal-fallback protocol to Bound (catalog
		// §4.2). A refusal walks the loop-host router.
		return {
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: false,
		};
	}

	/**
	 * Live provider discovery (R-MC3, catalog §4.1): query the
	 * Copilot `/models` catalog with this host's own token and map each entry to a
	 * {@link DiscoveredModel}. This is the self-configuring lineup for the
	 * account's entitlements (Free vs. Enterprise), so a models.dev entry absent
	 * from this host's Copilot catalog is never advertised here.
	 *
	 * `max_context`: the real prompt budget is
	 * `max_prompt_tokens`, so `max_context = min(max_context_window_tokens,
	 * max_prompt_tokens + max_output_tokens)` keeps the routing truncation target
	 * (`max_context - max_output`) on the real prompt room. An entry missing
	 * `max_context_window_tokens` contributes none (the lower layers fill it).
	 *
	 * Discovery failure degrades to config + models.dev (R-MC6): the catalog's
	 * `load()` swallows fetch errors into an empty map, so this resolves to `[]`
	 * rather than throwing — a reachable-but-empty lineup and an unreachable
	 * endpoint are indistinguishable here, both non-blocking.
	 */
	async discoverModels(): Promise<DiscoveredModel[]> {
		const { catalog } = await this.endpoint();
		const entries = await catalog.load();
		const out: DiscoveredModel[] = [];
		for (const entry of entries.values()) {
			out.push(copilotEntryToDiscoveredModel(entry));
		}
		return out;
	}
}
