/**
 * Inference subsystem: ModelRouter creation, host capability registration,
 * and post-restart summary extraction.
 */

import { extractSummaryAndMemories } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { updateRow } from "@bound/core";
import { createModelRouter } from "@bound/llm";
import type {
	BackendConfig,
	ModelBackendsConfig,
	ModelDescriptor,
	ModelRegistrar,
} from "@bound/llm";
import type {
	HostModelEntry,
	ModelBackendsConfig as SharedModelBackendsConfig,
} from "@bound/shared";
import { createLogger, formatError } from "@bound/shared";

type SharedBackendRow = SharedModelBackendsConfig["backends"][number];

export interface InferenceResult {
	modelRouter: ReturnType<typeof createModelRouter> | null;
	routerConfig: ModelBackendsConfig;
	backendModelMap: Map<string, string>;
}

/**
 * Translates a schema-validated ModelBackendsConfig (snake_case, Zod-typed)
 * into the ModelRouter's BackendConfig shape (camelCase, loose interface).
 *
 * This is a pure, allocation-only function — extracted so that the
 * hand-off can be covered by a focused regression test. Historically any
 * field omitted here was silently dropped on the way to the router; the
 * `thinking` field was one such casualty. When adding
 * a new backend config field, update this mapping AND add a test in
 * packages/cli/src/__tests__/inference-config.test.ts asserting the field
 * is observable on the resulting router.
 */
export function toRouterConfig(rawBackends: SharedModelBackendsConfig): ModelBackendsConfig {
	return {
		backends: rawBackends.backends.map(
			(b): BackendConfig => ({
				id: b.id,
				provider: b.provider,
				providerMode: b.provider_mode,
				// umans is a self-configuring namespace with no operator-set
				// model — the lineup is fetched at runtime. Coerce to "" so the
				// loose BackendConfig.model stays a string; the umans driver
				// never reads config.model (it uses the per-model `modelId`).
				model: b.model ?? "",
				baseUrl: b.base_url,
				contextWindow: b.context_window,
				apiKey: b.api_key,
				region: b.region,
				profile: b.profile,
				capabilities: b.capabilities,
				tier: b.tier,
				pricePerMInput: b.price_per_m_input,
				thinking: b.thinking,
				effort: b.effort,
				maxOutputTokens: b.max_output_tokens,
				systemPromptSuffix: b.system_prompt_suffix,
				cacheTtl: b.cache_ttl,
				cacheWarming: b.cache_warming
					? {
							enabled: b.cache_warming.enabled,
							maxPokes: b.cache_warming.max_pokes,
						}
					: undefined,
				connectTimeoutMs: b.connect_timeout_ms,
				additionalHeaders: b.additional_headers,
			}),
		),
		default: rawBackends.default,
	};
}

/**
 * Writes the current router's backend set to hosts.models so peers learn
 * what we can serve. Idempotent — safe to call both at startup and after
 * a SIGHUP-driven router reload.
 */
export function advertiseLocalModels(
	appContext: AppContext,
	modelRouter: ReturnType<typeof createModelRouter>,
	rawBackends: SharedModelBackendsConfig,
): void {
	const modelEntries: HostModelEntry[] = modelRouter.listBackends().map((b) => {
		const rawBackend = rawBackends.backends.find((rb) => rb.id === b.id);
		return {
			id: b.id,
			tier: rawBackend?.tier,
			max_output_tokens: modelRouter.getMaxOutputTokens(b.id),
			thinking_mode:
				typeof rawBackend?.thinking === "object" && rawBackend.thinking?.type === "tool"
					? "tool"
					: undefined,
			capabilities: b.capabilities,
		};
	});

	const existingHost = appContext.db
		.query("SELECT site_id FROM hosts WHERE site_id = ?")
		.get(appContext.siteId) as { site_id: string } | null;

	if (existingHost) {
		updateRow(
			appContext.db,
			"hosts",
			appContext.siteId,
			{ models: JSON.stringify(modelEntries) },
			appContext.siteId,
		);
	}
}

/**
 * Tracks, per dynamic-provider namespace id, the model ids it last registered
 * — so a re-expansion (after a config reload) replaces the prior set rather
 * than accumulating stale rows/backends. Module-level so it survives across
 * `wireBackendReadiness` re-invocations (the registrar itself is rebuilt fresh
 * each call to capture the current live config object).
 *
 * Bounded by the number of distinct dynamic-provider namespace ids an operator
 * has ever configured this process (today: at most one, `"umans"`). An entry
 * is not eagerly cleared when a provider is removed from config across a
 * reload — it simply goes unused (the next register for that id, if any,
 * replaces it). This is intentional: the only consumer is the drop-set
 * computation on a *subsequent* register of the same id.
 */
const lastRegisteredByProvider = new Map<string, string[]>();

/**
 * Wires up any self-configuring (`readiness`-bearing) backends. Generic — no
 * provider-specific names. Called from `initInference` (after the router is
 * built) and from the SIGHUP `onModelBackendsChanged` handler (after
 * `reload()` + `advertiseLocalModels`).
 *
 * For each readiness backend the router reports, it calls
 * `backend.readiness.start(registrar)` with a FRESH registrar bound to the
 * CURRENT `appContext.config.modelBackends` (a SIGHUP reassigns that to a new
 * object; a startup-captured registrar would write the orphaned old array) and
 * the live `modelRouter`. The registrar — which lives in this CLI layer, where
 * the shared config + router are in scope — owns the package-boundary work the
 * router must not do: it appends snake_case pricing rows to the shared config
 * array (the source `calculateTurnCost` reads), then calls the provider-
 * agnostic router primitives to make the models selectable, removes the
 * namespace placeholder, redirects the default if it pointed at the
 * placeholder, and re-advertises. The driver only describes its models.
 */
export function wireBackendReadiness(
	appContext: AppContext,
	modelRouter: ReturnType<typeof createModelRouter>,
): void {
	const readinessBackends = modelRouter.getReadinessBackends();
	if (readinessBackends.length === 0) return;

	for (const { id: namespaceId } of readinessBackends) {
		const registrar: ModelRegistrar = {
			register(providerId, models) {
				// Capture the CURRENT live config object on each register call.
				const sharedConfig = appContext.config.modelBackends;
				const placeholder = sharedConfig.backends.find((b) => b.id === namespaceId);

				// Remove the prior per-model rows this provider registered (replace,
				// not accumulate). Also remove anything we're about to re-add.
				const priorIds = new Set(lastRegisteredByProvider.get(providerId) ?? []);
				const newIds = new Set(models.map((m) => m.descriptor.id));
				const toDrop = new Set([...priorIds, ...newIds]);
				sharedConfig.backends = sharedConfig.backends.filter((b) => !toDrop.has(b.id));

				// 1. Append one snake_case pricing/context row per model id to the
				//    LIVE shared array BEFORE making the model selectable, so the
				//    first turn resolves its own pricing (no $0 interim).
				for (const { descriptor } of models) {
					sharedConfig.backends.push(buildSharedRow(descriptor, placeholder));
				}

				// 2. Make each model selectable via the router primitives.
				for (const { descriptor, backend } of models) {
					modelRouter.addDynamicBackend(
						descriptor.id,
						backend,
						descriptor.capabilities,
						descriptor.tier,
						descriptor.maxOutputTokens,
					);
					modelRouter.clearNotReady(descriptor.id);
				}

				// 3. Remove the namespace placeholder + redirect the default.
				const preferredId = models[0]?.descriptor.id;
				if (preferredId) {
					modelRouter.redirectDefault(namespaceId, preferredId);
					// Keep the shared-config default pointing at a real id too.
					if (sharedConfig.default === namespaceId) {
						sharedConfig.default = preferredId;
					}
				}
				modelRouter.removeBackend(namespaceId);
				sharedConfig.backends = sharedConfig.backends.filter((b) => b.id !== namespaceId);

				lastRegisteredByProvider.set(providerId, [...newIds]);

				// 4. Re-advertise so peers learn the now-selectable model ids.
				advertiseLocalModels(appContext, modelRouter, appContext.config.modelBackends);

				appContext.logger.info("[llm] Dynamic backend lineup registered", {
					providerId,
					models: [...newIds],
					default: modelRouter.getDefaultId(),
				});
			},
		};

		const backend = modelRouter.tryGetBackend(namespaceId);
		backend?.readiness?.start(registrar);
	}
}

/**
 * Build a snake_case shared-config row for a registered model descriptor,
 * cloning provider/api_key/base_url from the namespace placeholder. The row
 * matches the loader's `ModelBackendsConfig` row shape so `calculateTurnCost`
 * (which reads `appContext.config.modelBackends.backends`) resolves pricing.
 * These rows are constructed in-memory and never re-validated against the
 * schema (they don't round-trip through the loader).
 */
function buildSharedRow(
	descriptor: ModelDescriptor,
	placeholder: SharedBackendRow | undefined,
): SharedBackendRow {
	return {
		id: descriptor.id,
		provider: placeholder?.provider ?? "umans",
		model: descriptor.id,
		base_url: placeholder?.base_url,
		api_key: placeholder?.api_key,
		context_window: descriptor.capabilities.max_context,
		tier: descriptor.tier,
		price_per_m_input: descriptor.pricing?.inputPerM ?? 0,
		price_per_m_output: descriptor.pricing?.outputPerM ?? 0,
		price_per_m_cache_write: descriptor.pricing?.cacheWritePerM,
		price_per_m_cache_read: descriptor.pricing?.cacheReadPerM,
		max_output_tokens: descriptor.maxOutputTokens,
	} as SharedBackendRow;
}

export async function initInference(
	appContext: AppContext,
	commandContext: Record<string, unknown> | null,
): Promise<InferenceResult> {
	// 11. LLM setup — use ModelRouter to support all configured backends
	appContext.logger.info("Initializing LLM...");
	const rawBackends = appContext.config.modelBackends;
	// loadModelBackendsConfig() has already compiled and atomically published
	// the JavaScript pricing callbacks. The schema-validated rows here no longer
	// contain those functions, so compiling them again would replace the live
	// registry with an empty one.
	const routerConfig = toRouterConfig(rawBackends);

	// Map backend IDs to their provider-specific model names for chat() calls
	const backendModelMap = new Map<string, string>();
	for (const b of routerConfig.backends) {
		backendModelMap.set(b.id, b.model);
	}

	// Debug-level logger that drivers use to intercept raw AI SDK request bodies.
	// Gated on LOG_LEVEL=debug inside createLoggingFetch; info-level runs pay no
	// cost beyond one `isLevelEnabled` check per request.
	const aiSdkFetchLogger = createLogger("@bound/llm", "ai-sdk-fetch");

	let modelRouter: ReturnType<typeof createModelRouter> | null = null;
	try {
		modelRouter = createModelRouter(routerConfig, { logger: aiSdkFetchLogger });
		const ids = [...new Set(routerConfig.backends.map((b) => b.id))].join(", ");
		appContext.logger.info(
			`[llm] Model router ready — backends: ${ids} (default: ${routerConfig.default})`,
		);
	} catch (error) {
		appContext.logger.warn("[llm] Failed to create model router", {
			error: formatError(error),
		});
	}

	// Inject modelRouter into the command context so schedule/model-hint can validate
	if (modelRouter && commandContext) {
		(commandContext as Record<string, unknown>).modelRouter = modelRouter;
	}

	// Register local model capabilities in hosts.models for sync advertisement
	if (modelRouter) {
		advertiseLocalModels(appContext, modelRouter, rawBackends);
		// Kick off any self-configuring backends' background lineup fetch. Does
		// NOT block startup — readiness backends stay not-ready (excluded from
		// selection) until their fetch lands. Generic; umans is the first user.
		wireBackendReadiness(appContext, modelRouter);
	}

	// 11a. Post-restart summary extraction
	if (modelRouter && modelRouter.listBackends().length > 0) {
		const threadsNeedingSummary = appContext.db
			.query(
				`SELECT t.id FROM threads t
				 WHERE t.deleted = 0 AND t.summary IS NULL
				 AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.deleted = 0 AND m.role = 'assistant')
				 LIMIT 10`,
			)
			.all() as Array<{ id: string }>;

		if (threadsNeedingSummary.length > 0) {
			appContext.logger.info(
				`[recovery] Queued summary extraction for ${threadsNeedingSummary.length} thread(s)`,
			);
			// Process sequentially to avoid flooding the LLM backend with
			// concurrent requests that trigger rate-limiting at startup.
			(async () => {
				for (const { id } of threadsNeedingSummary) {
					try {
						await extractSummaryAndMemories(
							appContext.db,
							id,
							modelRouter.getDefault(),
							appContext.siteId,
						);
					} catch (err: unknown) {
						appContext.logger.warn(`[recovery] Summary extraction failed for ${id}:`, {
							error: formatError(err as Error),
						});
					}
				}
			})();
		}
	}

	return { modelRouter, routerConfig, backendModelMap };
}
