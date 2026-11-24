/**
 * Inference subsystem: ModelRouter creation, host capability registration,
 * and post-restart summary extraction.
 */

import { dirname, join } from "node:path";
import { extractSummaryAndMemories } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { listModelAliases, updateRow } from "@bound/core";
import {
	ModelsDevCache,
	createModelRouter,
	makeRouteId,
	resolveCatalog,
	supportsModelDiscovery,
} from "@bound/llm";
import type { RefreshStatus } from "@bound/llm";
import type {
	BackendConfig,
	CatalogBackendInput,
	DiscoveredModel,
	MetadataLayer,
	ModelBackendsConfig,
	ModelDescriptor,
	ModelRegistrar,
	ResolvedBackend,
} from "@bound/llm";
import type {
	HostModelEntry,
	ModelBackendsConfig as SharedModelBackendsConfig,
} from "@bound/shared";
import { createLogger, formatError } from "@bound/shared";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";

type SharedBackendRow = SharedModelBackendsConfig["backends"][number];

/**
 * True when a `bun:sqlite` handle is already closed. Guards the DETACHED
 * `models.dev` refresh continuation (R-MC6): the node can tear down and close
 * its DB before an in-flight background refresh resolves, and touching a closed
 * handle throws `RangeError: Cannot use a closed database`. Probes the
 * `inTransaction` getter — it reads only connection state (throws
 * `Database has closed` when closed) and issues no SQL, so this stays out of the
 * read-centralization gate while needing no liveness flag on `AppContext`.
 */
function isDbClosed(db: AppContext["db"]): boolean {
	try {
		void db.inTransaction;
		return false;
	} catch {
		return true;
	}
}

export interface InferenceResult {
	modelRouter: ReturnType<typeof createModelRouter> | null;
	routerConfig: ModelBackendsConfig;
	backendModelMap: Map<string, string>;
	/**
	 * The detached `models.dev` background-refresh promise, when a cache was
	 * built. `initInference` does NOT await it (an unreachable registry must not
	 * block startup, R-MC6), so the node lifecycle owns it: `startNode`'s `stop()`
	 * awaits it at teardown and tests await it for determinism. Resolves to the
	 * refresh status; never rejects. Absent when no cache was built (models.dev
	 * disabled or no router).
	 */
	modelsDevRefresh?: Promise<RefreshStatus>;
	/**
	 * The local-only `models.dev` cache built for this router, when enabled. The
	 * SIGHUP config-reload path (`index.ts`) needs it to re-resolve the catalog
	 * after `reload()` rebuilds the router from scratch (which drops applied
	 * metadata), so it is surfaced here rather than re-constructed. Absent when
	 * `models.dev` is disabled or no router was built.
	 */
	modelsDevCache?: ModelsDevCache | null;
}

/** Optional seams for `initInference` — injected only by tests. */
export interface InitInferenceOptions {
	/**
	 * Injectable fetch for the `models.dev` cache (R-MC5/R-MC6). Defaults to
	 * `globalThis.fetch`. Tests inject a controllable fetch so the background
	 * refresh resolves deterministically without touching the live registry.
	 */
	modelsDevFetch?: typeof globalThis.fetch;
}

/** Run the bounded, post-restart summary backlog under one startup lifecycle. */
export async function runStartupSummaryRecovery(
	threadIds: readonly string[],
	extract: (threadId: string) => Promise<unknown>,
	logger?: Pick<AppContext["logger"], "warn">,
): Promise<void> {
	const tracer = trace.getTracer("bound.cli");
	const recovery = tracer.startSpan("startup.summary-recovery", {
		attributes: { "startup.summary_recovery.queue_count": threadIds.length },
	});
	const recoveryContext = trace.setSpan(context.active(), recovery);
	let failedCount = 0;
	try {
		await context.with(recoveryContext, async () => {
			for (const threadId of threadIds) {
				const extraction = tracer.startSpan("startup.summary-extraction", {
					attributes: { "thread.id": threadId },
				});
				const extractionContext = trace.setSpan(context.active(), extraction);
				try {
					await context.with(extractionContext, () => extract(threadId));
					extraction.setAttribute("outcome", "success");
					extraction.setStatus({ code: SpanStatusCode.OK });
				} catch (err) {
					failedCount++;
					const message = formatError(err as Error);
					extraction.setAttribute("outcome", "error");
					extraction.recordException(err as Error);
					extraction.setStatus({ code: SpanStatusCode.ERROR, message });
					logger?.warn(`[recovery] Summary extraction failed for ${threadId}:`, { error: message });
				} finally {
					extraction.end();
				}
			}
		});
		recovery.setAttribute("startup.summary_recovery.failed_count", failedCount);
		recovery.setAttribute("outcome", failedCount === 0 ? "success" : "partial_failure");
		recovery.setStatus({ code: failedCount === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
	} catch (err) {
		const message = formatError(err as Error);
		recovery.setAttribute("outcome", "error");
		recovery.recordException(err as Error);
		recovery.setStatus({ code: SpanStatusCode.ERROR, message });
		throw err;
	} finally {
		recovery.end();
	}
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
	const defaults = rawBackends.defaults;
	return {
		backends: rawBackends.backends.map((b): BackendConfig => ({
			id: b.id,
			provider: b.provider,
			providerMode: b.provider_mode,
			// Self-configuring namespace entries (umans, github-copilot, bedrock,
			// bedrock-mantle) omit `model` so the router detects the namespace form
			// (`!config.model`) and constructs the readiness-bearing namespace driver.
			// Do NOT coerce `undefined` to `""` here.
			model: b.model,
			baseUrl: b.base_url,
			contextWindow: b.context_window,
			apiKey: b.api_key,
			tokenStorePath: b.token_store_path,
			region: b.region,
			profile: b.profile,
			crossRegion: b.cross_region,
			capabilities: b.capabilities,
			pricePerMInput: b.price_per_m_input,
			thinking: b.thinking,
			// Top-level `defaults` fill effort/cache_ttl only when this backend sets
			// none (requirement 3: a per-backend value always wins).
			effort: b.effort ?? defaults?.effort,
			maxOutputTokens: b.max_output_tokens,
			systemPromptSuffix: b.system_prompt_suffix,
			logicalModel: b.logical_model,
			cacheTtl: b.cache_ttl ?? defaults?.cache_ttl,
			cacheWarming: b.cache_warming
				? {
						enabled: b.cache_warming.enabled,
						maxPokes: b.cache_warming.max_pokes,
					}
				: undefined,
			connectTimeoutMs: b.connect_timeout_ms,
			additionalHeaders: b.additional_headers,
			// Per-model overrides for a self-configuring namespace entry (invariant #17:
			// a per-backend field must be copied here or it never reaches the
			// router/driver). Provider-agnostic across every namespace provider. The
			// `price` turn callback is intentionally NOT copied: it lives on the
			// JS-config override object and the loader compiles it into the pricing
			// registry separately, exactly as the top-level per-backend `price` does.
			// snake_case → camelCase per key.
			modelOverrides: b.model_overrides
				? Object.fromEntries(
						Object.entries(b.model_overrides).map(([modelId, ov]) => [
							modelId,
							{
								thinking: ov.thinking,
								effort: ov.effort,
								cacheTtl: ov.cache_ttl,
								logicalModel: ov.logical_model,
								maxOutputTokens: ov.max_output_tokens,
								contextWindow: ov.context_window,
								systemPromptSuffix: ov.system_prompt_suffix,
								pricePerMInput: ov.price_per_m_input,
								pricePerMOutput: ov.price_per_m_output,
								pricePerMCacheWrite: ov.price_per_m_cache_write,
								pricePerMCacheWrite1h: ov.price_per_m_cache_write_1h,
								pricePerMCacheRead: ov.price_per_m_cache_read,
								promptCaching: ov.prompt_caching,
							},
						]),
					)
				: undefined,
		})),
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
	/**
	 * Resolved per-backend catalog metadata (slice 6, R-MC2/R-MC9) keyed by
	 * backend id. When present, each advertised route carries its resolved
	 * `logical_model` (alias/config/normalization) and resolved `max_context`
	 * from the three-layer merge instead of the backend-id placeholder. Absent
	 * on early boot or when catalog resolution produced nothing (R-MC6: never
	 * blocks advertisement).
	 */
	catalog?: ReadonlyMap<string, ResolvedBackend>,
): void {
	const modelEntries: HostModelEntry[] = modelRouter.listBackends().map((b) => {
		const rawBackend = rawBackends.backends.find((rb) => rb.id === b.id);
		const resolved = catalog?.get(b.id);
		// R-RT2/R-MC9: advertise route identity + metadata; `tier` is gone (R-RT3).
		// `logical_model` comes from catalog grouping when resolved, else the
		// backend id as a conservative pre-resolution placeholder.
		const resolvedMaxContext = resolved?.metadata.capabilities.max_context;
		const entry: HostModelEntry = {
			id: b.id,
			route_id: modelRouter.getRouteId(b.id) ?? undefined,
			logical_model: resolved ? (resolved.logicalModel ?? undefined) : b.id,
			// User-facing display name resolved by the catalog (spec §2.1); absent
			// pre-resolution so a reader never shows the grouping key as a name.
			display_name: resolved?.metadata.display_name,
			provider_model_id: rawBackend?.model,
			max_output_tokens: modelRouter.getMaxOutputTokens(b.id),
			cache_ttl: modelRouter.getCacheTtl(b.id),
			thinking_mode:
				typeof rawBackend?.thinking === "object" && rawBackend.thinking?.type === "tool"
					? "tool"
					: undefined,
			capabilities:
				resolvedMaxContext !== undefined
					? { ...b.capabilities, max_context: resolvedMaxContext }
					: b.capabilities,
		};
		return entry;
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
 * R-MC4 readiness gate (slice 6, `2026-11-21-model-catalog.md` §3.2). The pure
 * `resolveCatalog` decides per backend whether `max_context` resolved across the
 * three metadata layers (`ready`) and, when it did not, a human-readable
 * `configGap`. This is the production consumer of that decision: it marks every
 * unready backend not-ready on the router — so `listBackends`/`listEligible`/
 * `resolveModel` exclude it, which in turn keeps it out of `advertiseLocalModels`
 * (R-MC4: "shall not be advertised as routable") and out of local routing — and
 * logs its gap once so an operator knows which `context_window` to set. It
 * reuses the router's existing not-ready mechanism rather than inventing a
 * parallel gate.
 *
 * Idempotent and reversible: a backend the catalog now reports as ready has its
 * not-ready flag CLEARED. This is the hinge of the first-boot trap fix — after a
 * `models.dev` refresh supplies a previously-missing `max_context`, re-resolving
 * and re-calling this flips newly-ready backends back on without a restart. Only
 * backends present in `catalog` are touched; readiness-bearing namespace
 * placeholders (umans) are absent from the catalog and keep their own
 * expansion-driven not-ready state untouched.
 *
 * Returns the set of backend ids that were newly gated unready on this call, so
 * the caller can decide whether a re-advertise is warranted.
 */
export function gateUnreadyBackends(
	modelRouter: ReturnType<typeof createModelRouter>,
	catalog: ReadonlyMap<string, ResolvedBackend>,
	logger: Pick<AppContext["logger"], "warn">,
): Set<string> {
	const newlyGated = new Set<string>();
	for (const [backendId, resolved] of catalog) {
		if (resolved.ready) {
			// A previously-gapped backend whose metadata now resolves (e.g. after a
			// models.dev refresh) becomes selectable again. No-op when already ready.
			if (modelRouter.isNotReady(backendId)) modelRouter.clearNotReady(backendId);
			continue;
		}
		// Unready: exclude from selection + advertisement and surface the gap once.
		if (!modelRouter.isNotReady(backendId)) {
			modelRouter.markNotReady(backendId);
			newlyGated.add(backendId);
			logger.warn("[llm] Backend unready — excluded from advertisement + routing (R-MC4)", {
				backend: backendId,
				configGap: resolved.configGap,
			});
		}
	}
	return newlyGated;
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
 * Backend ids currently materialized by a self-configuring namespace, mapped to
 * the provider-layer {@link DiscoveredModel} captured during namespace lineup
 * expansion (or `undefined` when the namespace supplied none). Catalog
 * resolution skips per-model `discoverModels()` calls for these (avoiding one
 * control-plane request per model per pass) while still feeding the captured
 * discovery row into the provider metadata layer — preserving provider-only
 * facts such as Copilot's `adaptive_thinking` flag.
 */
const expandedBackendDiscovery = new Map<string, DiscoveredModel | undefined>();

/**
 * A coalescing runner for an async pass. `schedule()` starts a pass on the next
 * microtask when idle, so N synchronous schedules (N namespaces registering in
 * one tick) run once; a schedule that lands while a pass is running queues
 * exactly one trailing pass, so the last state is always resolved without
 * passes ever running concurrently. A failing pass is reported through
 * `onError` and never rejects. `settled()` resolves once the queue drains.
 */
export function createCoalescedPass(
	run: () => Promise<void>,
	onError: (error: unknown) => void,
): { schedule(): void; settled(): Promise<void> } {
	let draining: Promise<void> | null = null;
	let pending = false;
	const drain = async (): Promise<void> => {
		await Promise.resolve();
		while (pending) {
			pending = false;
			try {
				await run();
			} catch (error) {
				onError(error);
			}
		}
		draining = null;
	};
	return {
		schedule() {
			pending = true;
			if (!draining) draining = drain();
		},
		settled() {
			return draining ?? Promise.resolve();
		},
	};
}

/**
 * Per-router state for the post-registration catalog pass: the `models.dev`
 * cache it resolves against (kept across SIGHUP re-wiring) and its coalesced
 * runner. Weakly keyed so a discarded router releases its state.
 */
const expandedCatalogPasses = new WeakMap<
	ReturnType<typeof createModelRouter>,
	{ cache: ModelsDevCache | null; pass: ReturnType<typeof createCoalescedPass> }
>();

/**
 * Resolves once every scheduled post-registration catalog pass for `modelRouter`
 * has finished. Node teardown awaits this before closing the DB; tests await it
 * to observe the settled advertisement.
 */
export function settleExpandedBackendPasses(
	modelRouter: ReturnType<typeof createModelRouter>,
): Promise<void> {
	return expandedCatalogPasses.get(modelRouter)?.pass.settled() ?? Promise.resolve();
}

export interface WireBackendReadinessOptions {
	/**
	 * The `models.dev` cache the post-registration catalog pass resolves
	 * against. When omitted, the cache from an earlier wiring of the same router
	 * is reused (null when there was none).
	 */
	modelsDevCache?: ModelsDevCache | null;
}

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
	options?: WireBackendReadinessOptions,
): void {
	const readinessBackends = modelRouter.getReadinessBackends();
	if (readinessBackends.length === 0) return;

	// The resolve → gate → apply → advertise pass that follows every
	// registration. register() is synchronous, so the pass is fire-and-forget
	// through a per-router coalescing runner: namespaces registering together at
	// boot share one pass, and a registration during a running pass gets one
	// trailing pass over the latest live config.
	let state = expandedCatalogPasses.get(modelRouter);
	if (!state) {
		const created = {
			cache: options?.modelsDevCache ?? null,
			pass: createCoalescedPass(
				async () => {
					if (isDbClosed(appContext.db)) return;
					const aliases = new Map<string, string | null>(
						listModelAliases(appContext.db).map((a) => [a.provider_key, a.logical_model]),
					);
					await resolveGateApplyAdvertise(
						appContext,
						modelRouter,
						appContext.config.modelBackends,
						created.cache,
						aliases,
					);
				},
				(error) =>
					appContext.logger.warn("[llm] Expanded-backend catalog pass failed", {
						error: formatError(error as Error),
					}),
			),
		};
		state = created;
		expandedCatalogPasses.set(modelRouter, state);
	} else if (options?.modelsDevCache !== undefined) {
		state.cache = options.modelsDevCache;
	}
	const catalogPass = state.pass;

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
				const rows = models.map(({ descriptor }) => buildSharedRow(descriptor, placeholder));
				sharedConfig.backends.push(...rows);

				// 2. Make each model selectable via the router primitives. Each
				//    backend's router config is derived from its shared row through
				//    `toRouterConfig` (invariant #17), the same translation a static
				//    row gets: provider, raw provider model id, request controls
				//    (model_overrides > namespace entry > top-level defaults), the
				//    output cap and the logical-model pin.
				const routerRows = toRouterConfig({
					backends: rows,
					default: "",
					defaults: sharedConfig.defaults,
				} as SharedModelBackendsConfig).backends;
				models.forEach(({ descriptor, backend }, i) => {
					modelRouter.addDynamicBackend(
						descriptor.id,
						backend,
						descriptor.capabilities,
						descriptor.maxOutputTokens,
						{
							routeId: makeRouteId(appContext.siteId, providerId, descriptor.id),
							reasoningOrigin: `${appContext.siteId}:${providerId}`,
						},
						routerRows[i],
					);
					modelRouter.clearNotReady(descriptor.id);
				});

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
				for (const id of priorIds) expandedBackendDiscovery.delete(id);
				for (const { descriptor } of models) {
					expandedBackendDiscovery.set(descriptor.id, descriptor.discovered);
				}

				// 4. Re-advertise so peers learn the now-selectable model ids at once,
				//    then resolve the catalog over the live config so the advertised
				//    rows and the router carry resolved logical model, window,
				//    pricing and reasoning, and unready models are gated (R-MC4).
				advertiseLocalModels(appContext, modelRouter, appContext.config.modelBackends);
				catalogPass.schedule();

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
 *
 * Per-model request controls the operator sets once on the namespace entry
 * (`thinking`, `effort`, `cache_ttl`, `system_prompt_suffix`) are NOT
 * catalog-derivable, so they are propagated from the placeholder to every
 * expanded row (invariant #17): an operator configures a self-configuring
 * provider's reasoning/cache behavior in one place and the whole expanded
 * lineup inherits it. A per-model override is still possible later via
 * `model_aliases`-scoped config; absence here just means "inherit the
 * namespace's choice", matching how the 12 hand-written `copilot-*` rows each
 * carried their own `thinking`/`cache_ttl` today.
 */
function buildSharedRow(
	descriptor: ModelDescriptor,
	placeholder: SharedBackendRow | undefined,
): SharedBackendRow {
	// Per-model override for this expanded backend, keyed by the raw provider
	// model id (requirement 2). A matching override's request controls win over
	// the blanket namespace-entry inheritance below, so an operator pins ONE
	// model's reasoning/cache without listing every model. Non-namespace rows
	// (`placeholder` without `model_overrides`) see an empty override.
	const override = descriptor.providerModelId
		? placeholder?.model_overrides?.[descriptor.providerModelId]
		: undefined;
	const thinking = override?.thinking ?? placeholder?.thinking;
	const effort = override?.effort ?? placeholder?.effort;
	const cacheTtl = override?.cache_ttl ?? placeholder?.cache_ttl;
	const systemPromptSuffix = override?.system_prompt_suffix ?? placeholder?.system_prompt_suffix;
	return {
		id: descriptor.id,
		provider: placeholder?.provider ?? "umans",
		// The raw provider model id, not the namespace-prefixed backend id: catalog
		// grouping and models.dev lookup normalize this field, so a prefixed id would
		// leak the namespace entry's id into every expanded model's logical key
		// (e.g. `bedrock-us-east-1-anthropic.claude-opus-5-5` grouping as
		// `us-east-1-anthropic.claude-opus-5-5`). Drivers without a raw id (umans)
		// already use the raw id as the backend id.
		model: descriptor.providerModelId ?? descriptor.id,
		base_url: placeholder?.base_url,
		api_key: placeholder?.api_key,
		context_window: descriptor.capabilities.max_context,
		price_per_m_input: descriptor.pricing?.inputPerM ?? 0,
		price_per_m_output: descriptor.pricing?.outputPerM ?? 0,
		price_per_m_cache_write: descriptor.pricing?.cacheWritePerM,
		price_per_m_cache_write_1h: descriptor.pricing?.cacheWrite1hPerM,
		price_per_m_cache_read: descriptor.pricing?.cacheReadPerM,
		// A per-model override's max_output_tokens / logical_model win over the
		// catalog-derived values; otherwise the catalog values stand.
		max_output_tokens: override?.max_output_tokens ?? descriptor.maxOutputTokens,
		...(override?.logical_model !== undefined && { logical_model: override.logical_model }),
		// Per-model request controls: the override wins, else the namespace entry's
		// blanket value is inherited (invariant #17), else absent.
		...(thinking !== undefined && { thinking }),
		...(effort !== undefined && { effort }),
		...(cacheTtl !== undefined && { cache_ttl: cacheTtl }),
		...(systemPromptSuffix !== undefined && { system_prompt_suffix: systemPromptSuffix }),
	} as SharedBackendRow;
}

/**
 * Resolve the local model catalog (slice 6, R-MC2/R-MC3/R-MC4/R-MC9) for the
 * host's statically-configured backends: merge the three metadata layers and
 * group logical models across every backend.
 *
 * This is the production consumer of the catalog pipeline. For each backend it
 * collects the config layer from `rawBackends`, runs the driver's
 * `discoverModels()` hook (layer 2) when the driver implements it, and reads the
 * cached `models.dev` snapshot (layer 3) via the shared index, then hands all
 * three to `resolveCatalog`.
 *
 * Resilience (R-MC6): a driver whose discovery fetch throws (transport /
 * credential failure) contributes an empty provider layer and never blocks
 * startup — resolution still succeeds from config + `models.dev`. Dynamic
 * (readiness-bearing) namespaces are skipped here: their concrete per-model
 * backends are resolved on expansion, not from the static config rows.
 *
 * Pure dependencies are injected: `modelRouter` supplies the live backend set +
 * drivers, `cache` supplies the `models.dev` index. Aliases come from the
 * synced `model_aliases` table (slice 3); passed in as a map so this stays
 * testable without a DB.
 */
export async function resolveLocalCatalog(
	modelRouter: ReturnType<typeof createModelRouter>,
	rawBackends: SharedModelBackendsConfig,
	cache: ModelsDevCache | null,
	aliases: ReadonlyMap<string, string | null>,
	logger?: Pick<AppContext["logger"], "warn">,
): Promise<Map<string, ResolvedBackend>> {
	const modelsDev = cache?.getIndex() ?? new Map<string, MetadataLayer>();

	// Run discovery once per backend that implements the hook. A failing fetch
	// degrades to an empty lineup for that backend (R-MC6); it never rejects out
	// of here.
	const inputs: CatalogBackendInput[] = [];
	for (const backendId of modelRouter.listAllBackendIds()) {
		// Skip not-ready namespace placeholders of DYNAMIC (readiness-bearing)
		// providers like umans: their concrete per-model backends resolve on
		// readiness expansion, not from the static config rows. A static backend
		// gated not-ready purely by the R-MC4 window gate (NO `readiness`) is NOT
		// skipped — `listAllBackendIds` deliberately includes it so a first-boot-
		// unready static backend can recover a window from a later models.dev
		// refresh; skipping it (or using the not-ready-filtered `listBackends`)
		// would strand it unready forever.
		const candidate = modelRouter.tryGetBackend(backendId);
		if (modelRouter.isNotReady(backendId) && candidate?.readiness) continue;
		const rawBackend = rawBackends.backends.find((rb) => rb.id === backendId);
		if (!rawBackend) continue;

		const backend = modelRouter.tryGetBackend(backendId);
		let discovery: DiscoveredModel[] = [];
		if (expandedBackendDiscovery.has(backendId)) {
			const cached = expandedBackendDiscovery.get(backendId);
			if (cached) discovery = [cached];
		} else if (backend && supportsModelDiscovery(backend)) {
			try {
				discovery = await backend.discoverModels();
			} catch (error) {
				logger?.warn("[llm] Provider discovery failed; falling back to config + models.dev", {
					backend: backendId,
					error: formatError(error as Error),
				});
			}
		}

		const config: MetadataLayer = {};
		const configCaps: NonNullable<MetadataLayer["capabilities"]> = {};
		if (rawBackend.context_window !== undefined) {
			configCaps.max_context = rawBackend.context_window;
		}
		if (rawBackend.capabilities?.vision !== undefined) {
			configCaps.vision = rawBackend.capabilities.vision;
		}
		if (Object.keys(configCaps).length > 0) {
			config.capabilities = configCaps;
		}
		if (rawBackend.max_output_tokens !== undefined) {
			config.max_output_tokens = rawBackend.max_output_tokens;
		}
		if (typeof rawBackend.logical_model === "string") {
			config.logical_model = rawBackend.logical_model;
		}

		inputs.push({
			backendId,
			provider: rawBackend.provider,
			providerModelId: rawBackend.model ?? "",
			config,
			discovery,
		});
	}

	return resolveCatalog({ backends: inputs, modelsDev, aliases });
}

/**
 * Resolve the catalog, gate R-MC4 unready backends, apply resolved metadata to
 * the local routing path (requirement 1), and re-advertise — the shared
 * sequence used at startup, in the `models.dev` refresh continuation, and on
 * SIGHUP config reload. Extracted so all three paths apply the resolved
 * `max_context` / `max_output_tokens` identically rather than drifting.
 *
 * Ordering is load-bearing: the readiness gate runs first (so only ready
 * backends are touched), then `applyResolvedCatalog` writes the resolved
 * metadata onto the router, then advertisement publishes the applied values to
 * peers. Returns the resolved catalog so a caller that needs it (advertisement
 * already consumed it internally) can inspect readiness.
 */
export async function resolveGateApplyAdvertise(
	appContext: AppContext,
	modelRouter: ReturnType<typeof createModelRouter>,
	rawBackends: SharedModelBackendsConfig,
	cache: ModelsDevCache | null,
	aliases: ReadonlyMap<string, string | null>,
): Promise<Map<string, ResolvedBackend>> {
	const catalog = await resolveLocalCatalog(
		modelRouter,
		rawBackends,
		cache,
		aliases,
		appContext.logger,
	);
	// Resolution is async and can straddle node teardown; never advertise into a
	// closed DB.
	if (isDbClosed(appContext.db)) return catalog;
	gateUnreadyBackends(modelRouter, catalog, appContext.logger);
	modelRouter.applyResolvedCatalog(catalog, appContext.logger);
	advertiseLocalModels(appContext, modelRouter, rawBackends, catalog);
	return catalog;
}

export async function initInference(
	appContext: AppContext,
	commandContext: Record<string, unknown> | null,
	options?: InitInferenceOptions,
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
		if (b.model !== undefined) backendModelMap.set(b.id, b.model);
	}

	// Debug-level logger that drivers use to intercept raw AI SDK request bodies.
	// Gated on LOG_LEVEL=debug inside createLoggingFetch; info-level runs pay no
	// cost beyond one `isLevelEnabled` check per request.
	const aiSdkFetchLogger = createLogger("@bound/llm", "ai-sdk-fetch");

	let modelsDevRefresh: Promise<RefreshStatus> | undefined;
	let modelsDevCache: ModelsDevCache | null = null;
	let modelRouter: ReturnType<typeof createModelRouter> | null = null;
	try {
		modelRouter = createModelRouter(routerConfig, {
			logger: aiSdkFetchLogger,
			siteId: appContext.siteId,
		});
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
		// Build the local-only `models.dev` cache (slice 6, R-MC5/R-MC6) from the
		// optional config block. Load the on-disk snapshot and kick off a
		// conditional ETag refresh; neither blocks startup — an unreachable
		// registry degrades to the cached snapshot or to config + provider
		// discovery alone (R-MC6). The cache lives beside the node's data, never in
		// a synced table.
		const modelsDevCfg = rawBackends.models_dev;
		modelsDevCache =
			modelsDevCfg?.enabled === false
				? null
				: new ModelsDevCache({
						// An in-memory DB has no data directory; dirname(":memory:") is the cwd,
						// so keep the snapshot in memory rather than writing it there.
						cachePath:
							appContext.db.filename === ":memory:" || appContext.db.filename === ""
								? null
								: join(dirname(appContext.db.filename), "models-dev-cache.json"),
						...(modelsDevCfg?.url && { url: modelsDevCfg.url }),
						...(modelsDevCfg?.refresh_interval_ms !== undefined && {
							refreshIntervalMs: modelsDevCfg.refresh_interval_ms,
						}),
						...(options?.modelsDevFetch && { fetchImpl: options.modelsDevFetch }),
					});
		if (modelsDevCache) {
			await modelsDevCache.load();
			// The refresh is DETACHED (R-MC6: an unreachable registry must not block
			// startup). Its continuation re-advertises off the node-owned DB, so it
			// MUST NOT run after the node tears down and closes that DB — a stray write
			// to a closed `bun:sqlite` handle throws `RangeError: Cannot use a closed
			// database`, which as an unhandled rejection from a detached promise crashes
			// whatever is running at that moment (under the test runner, an unrelated
			// test). The node lifecycle owns this promise: it is returned on
			// `InferenceResult.modelsDevRefresh` so `startNode`'s `stop()` awaits it, and
			// the continuation re-checks DB liveness before touching it.
			modelsDevRefresh = modelsDevCache.refresh().then(async (status) => {
				if (isDbClosed(appContext.db)) return status;
				appContext.logger.info(`[llm] models.dev cache refresh: ${status}`);
				// First-boot trap (R-MC4): a fresh host with no cache resolves against
				// an empty snapshot, so a backend that depends on models.dev for its
				// max_context starts unready. When the refresh lands a CHANGED snapshot,
				// re-resolve the catalog, flip any newly-ready backends on
				// (`gateUnreadyBackends` clears their not-ready flag), and re-advertise
				// so peers learn them — all without a restart.
				if (status !== "updated") return status;
				// The LIVE config: expanded namespace rows and a SIGHUP-reloaded config
				// replace the startup snapshot, and a first-boot-unready expanded backend
				// must be able to recover its window from this refresh too.
				const liveBackends = appContext.config.modelBackends;
				const refreshedCatalog = await resolveLocalCatalog(
					modelRouter,
					liveBackends,
					modelsDevCache,
					aliases,
					appContext.logger,
				);
				// The async re-resolution above can straddle teardown; re-check before
				// the DB-touching gate + advertise.
				if (isDbClosed(appContext.db)) return status;
				gateUnreadyBackends(modelRouter, refreshedCatalog, appContext.logger);
				// Re-apply resolved metadata to the local routing path so a backend whose
				// window/output budget now resolves from the refreshed models.dev snapshot
				// starts using the real values without a restart (requirement 1).
				modelRouter.applyResolvedCatalog(refreshedCatalog, appContext.logger);
				advertiseLocalModels(appContext, modelRouter, liveBackends, refreshedCatalog);
				return status;
			});
		}

		// Resolve the catalog, gate R-MC4 unready backends, apply resolved metadata
		// to the local routing path, and advertise — the shared sequence reused by
		// the models.dev refresh continuation and the SIGHUP reload path.
		const aliases = new Map<string, string | null>(
			listModelAliases(appContext.db).map((a) => [a.provider_key, a.logical_model]),
		);
		await resolveGateApplyAdvertise(appContext, modelRouter, rawBackends, modelsDevCache, aliases);
		// Kick off any self-configuring backends' background lineup fetch. Does
		// NOT block startup — readiness backends stay not-ready (excluded from
		// selection) until their fetch lands. Generic; umans is the first user.
		wireBackendReadiness(appContext, modelRouter, { modelsDevCache });
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
			void runStartupSummaryRecovery(
				threadsNeedingSummary.map(({ id }) => id),
				(id) =>
					extractSummaryAndMemories(appContext.db, id, modelRouter.getDefault(), appContext.siteId),
				appContext.logger,
			);
		}
	}

	return { modelRouter, routerConfig, backendModelMap, modelsDevRefresh, modelsDevCache };
}
