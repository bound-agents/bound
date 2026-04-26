/**
 * Inference subsystem: ModelRouter creation, host capability registration,
 * and post-restart summary extraction.
 */

import { extractSummaryAndMemories } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { updateRow } from "@bound/core";
import { createModelRouter } from "@bound/llm";
import type { BackendConfig, ModelBackendsConfig } from "@bound/llm";
import type {
	HostModelEntry,
	ModelBackendsConfig as SharedModelBackendsConfig,
} from "@bound/shared";
import { formatError } from "@bound/shared";

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
 * `thinking` field was the most recent casualty (2026-04-25). When adding
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
				model: b.model,
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

export async function initInference(
	appContext: AppContext,
	commandContext: Record<string, unknown> | null,
): Promise<InferenceResult> {
	// 11. LLM setup — use ModelRouter to support all configured backends
	appContext.logger.info("Initializing LLM...");
	const rawBackends = appContext.config.modelBackends;
	const routerConfig = toRouterConfig(rawBackends);

	// Map backend IDs to their provider-specific model names for chat() calls
	const backendModelMap = new Map<string, string>();
	for (const b of routerConfig.backends) {
		backendModelMap.set(b.id, b.model);
	}

	let modelRouter: ReturnType<typeof createModelRouter> | null = null;
	try {
		modelRouter = createModelRouter(routerConfig);
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
