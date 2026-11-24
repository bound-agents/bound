/**
 * Readiness-wiring + registrar tests (AC.3 cost path, AC.4 advertisement,
 * AC.7 reload re-gating). Drives the namespace→expanded transition through
 * the REAL `wireBackendReadiness` registrar, the REAL router primitives, and
 * the REAL `calculateTurnCost` against the shared config array. Fetchers are
 * injected (no live network).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateTurnCost } from "@bound/agent";
import { applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import { GitHubCopilotDriver, ModelsDevCache, createModelRouter } from "@bound/llm";
import type {
	CopilotAccountInfo,
	CopilotTokenManager,
	UmansModelMeta,
	UmansUsage,
} from "@bound/llm";
import type { ResolvedBackend } from "@bound/llm";
import { createLogger } from "@bound/shared";
import { BedrockNamespaceDriver } from "../../../llm/src/drivers/bedrock-namespace";
import {
	advertiseLocalModels,
	createCoalescedPass,
	gateUnreadyBackends,
	resolveLocalCatalog,
	settleExpandedBackendPasses,
	toRouterConfig,
	wireBackendReadiness,
} from "../commands/start/inference";

let db: Database;
let dbPath: string;
let siteId: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `inference-readiness-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
	siteId = randomUUID();
	// Seed a hosts row so advertiseLocalModels' UPDATE path fires.
	db.run(
		"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		[siteId, "test-host", new Date().toISOString(), new Date().toISOString()],
	);
});

afterEach(() => {
	try {
		db.close();
	} catch {}
	try {
		require("node:fs").rmSync(dbPath, { force: true });
	} catch {}
});

function lineup(): Map<string, UmansModelMeta> {
	return new Map([
		[
			"umans-coder",
			{
				id: "umans-coder",
				contextWindow: 200000,
				maxCompletionTokens: 8192,
				supportsVision: true,
				supportsTools: true,
				reasoningSupported: true,
				reasoningCanDisable: false,
				pricePerMInput: 3,
				pricePerMOutput: 15,
			},
		],
		[
			"umans-flash",
			{
				id: "umans-flash",
				contextWindow: 128000,
				maxCompletionTokens: 4096,
				supportsVision: false,
				supportsTools: true,
				reasoningSupported: false,
				reasoningCanDisable: true,
				pricePerMInput: 0.5,
				pricePerMOutput: 1.5,
			},
		],
	]);
}

function makeAppContext(backendsConfig: { backends: unknown[]; default: string }): AppContext {
	return {
		db,
		siteId,
		logger: createLogger("test", "inference-readiness"),
		config: { modelBackends: backendsConfig },
	} as unknown as AppContext;
}

function umansSharedConfig(): { backends: unknown[]; default: string } {
	return {
		backends: [{ id: "umans", provider: "umans", api_key: "sk-test" }],
		default: "umans",
	};
}

function buildRouterWithUmans(metadataFetch: unknown, usageFetch: unknown) {
	const shared = umansSharedConfig();
	// Inject fetchers via the BackendConfig index signature.
	const routerConfig = toRouterConfig(shared as never);
	routerConfig.backends[0].metadataFetch = metadataFetch;
	routerConfig.backends[0].usageFetch = usageFetch;
	const router = createModelRouter(routerConfig);
	return { router, shared };
}

describe("wireBackendReadiness expansion (AC.3 / AC.4)", () => {
	it("expands a umans namespace into per-model selectable backends with pricing reaching calculateTurnCost", async () => {
		const metadataFetch = async () => ({ ok: true as const, value: lineup() });
		const usageFetch = async () => ({
			ok: true as const,
			value: { concurrencyLimit: 4 } satisfies UmansUsage,
		});
		const { router, shared } = buildRouterWithUmans(metadataFetch, usageFetch);
		const appContext = makeAppContext(shared);

		// Pre-expansion: namespace not selectable; not advertised.
		expect(router.isNotReady("umans")).toBe(true);
		expect(router.listBackends().map((b) => b.id)).not.toContain("umans");

		wireBackendReadiness(appContext, router);
		// Let the (resolved) fetch promises + register run.
		await new Promise((r) => setTimeout(r, 50));

		// Post-expansion: concrete model ids selectable; namespace removed.
		const ids = router
			.listBackends()
			.map((b) => b.id)
			.sort();
		expect(ids).toEqual(["umans-coder", "umans-flash"]);
		expect(router.tryGetBackend("umans")).toBeNull();

		// (c) shared config carries one snake_case row per model id.
		const cfgIds = (shared.backends as Array<{ id: string }>).map((b) => b.id).sort();
		expect(cfgIds).toEqual(["umans-coder", "umans-flash"]);

		// (e) calculateTurnCost on the SHARED array is non-zero per model.
		const cost = calculateTurnCost(
			"umans-coder",
			{ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null },
			shared.backends as never,
		);
		expect(cost).toBeCloseTo(3, 5);

		// (AC.4) advertisement: hosts.models row gains both ids, not the placeholder.
		const row = db.query("SELECT models FROM hosts WHERE site_id = ?").get(siteId) as {
			models: string;
		};
		const advertised = JSON.parse(row.models) as Array<{
			id: string;
			max_output_tokens?: number;
		}>;
		const advIds = advertised.map((m) => m.id).sort();
		expect(advIds).toEqual(["umans-coder", "umans-flash"]);
		expect(advertised.find((m) => m.id === "umans-coder")?.max_output_tokens).toBe(8192);
		expect(advertised.find((m) => m.id === "umans-flash")?.max_output_tokens).toBe(4096);
		expect(advIds).not.toContain("umans");

		// (R-RT2/R-RT3, slice 2) advertised entries carry route identity + metadata
		// and NO tier. Done-when #3: hosts.models carries no tier.
		for (const entry of advertised as Array<Record<string, unknown>>) {
			expect("tier" in entry).toBe(false);
			expect(typeof entry.route_id).toBe("string");
			expect((entry.route_id as string).endsWith(`:umans:${entry.id as string}`)).toBe(true);
			// The post-registration catalog pass replaces the backend-id placeholder
			// with the catalog grouping. umans ids are neither in a recognized
			// namespace nor in models.dev, so they stay unassigned.
			expect(entry.logical_model).toBeUndefined();
		}

		// Default redirected off the placeholder to a concrete id.
		expect(["umans-coder", "umans-flash"]).toContain(router.getDefaultId());
		expect(shared.default).not.toBe("umans");
	});

	it("propagates the namespace placeholder's thinking/effort/cache_ttl to every expanded row (#17)", async () => {
		const metadataFetch = async () => ({ ok: true as const, value: lineup() });
		const usageFetch = async () => ({
			ok: true as const,
			value: { concurrencyLimit: 4 } satisfies UmansUsage,
		});
		const shared = {
			backends: [
				{
					id: "umans",
					provider: "umans",
					api_key: "sk-test",
					// Per-model request controls the operator sets once on the namespace
					// entry; they are not catalog-derivable and must reach every expanded row.
					thinking: { type: "adaptive" as const },
					effort: "medium",
					cache_ttl: "1h",
				},
			],
			default: "umans",
		};
		const routerConfig = toRouterConfig(shared as never);
		routerConfig.backends[0].metadataFetch = metadataFetch;
		routerConfig.backends[0].usageFetch = usageFetch;
		const router = createModelRouter(routerConfig);
		const appContext = makeAppContext(shared);

		wireBackendReadiness(appContext, router);
		await new Promise((r) => setTimeout(r, 50));

		const rows = shared.backends as Array<Record<string, unknown>>;
		expect(rows.map((b) => b.id).sort()).toEqual(["umans-coder", "umans-flash"]);
		for (const row of rows) {
			expect(row.thinking).toEqual({ type: "adaptive" });
			expect(row.effort).toBe("medium");
			expect(row.cache_ttl).toBe("1h");
		}
	});

	it("pins a github-copilot expanded row's logical_model from a per-model override so an old copilot-* reference survives (requirement 2 / claude divergence mitigation)", async () => {
		// The 4 Claude Copilot models are the requirement-2 exception: the raw
		// catalog id `claude-opus-5.5` normalizes to `claude-opus-5-5` (pooling with
		// the direct Bedrock Anthropic routes — a routing win) while the old
		// hand-written config id `copilot-opus-5.5` normalized to the bare family
		// `opus-5-5`. An operator bridges that gap WITHOUT changing the shared
		// structural rule by pinning the expanded row's logical model with a
		// per-model override, so threads/tasks that named `copilot-opus-5.5` keep
		// resolving. This proves the pin reaches the expanded shared-config row
		// end-to-end (schema → toRouterConfig → buildSharedRow).
		const account: CopilotAccountInfo = {
			chatEnabled: true,
			copilotPlan: "enterprise",
			apiEndpoint: "https://api.enterprise.githubcopilot.com",
		};
		const tokenManager = {
			getAccessToken: async () => "ghu_abc",
		} as unknown as CopilotTokenManager;
		const catalogFetch = (async (input: RequestInfo | URL) => {
			const url = new URL(new Request(input).url);
			if (url.pathname.endsWith("/models")) {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-opus-5.5",
								supported_endpoints: ["/v1/messages"],
								capabilities: { limits: { max_context_window_tokens: 200000 } },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		// A `github-copilot` namespace entry (no `model`) with a per-model override
		// pinning the claude model's logical id back to the old `opus-5-5` family key.
		const shared = {
			backends: [
				{
					id: "copilot",
					provider: "github-copilot",
					model_overrides: {
						"claude-opus-5.5": { logical_model: "opus-5-5" },
					},
				},
			],
			default: "copilot",
		};
		// Build the router from an EMPTY config so createModelRouter does not try to
		// construct the copilot namespace from config (the real factory needs a
		// token-store file on disk). The namespace driver is seeded directly below;
		// toRouterConfig(shared) is used only to translate the per-model override map
		// (snake_case → camelCase) the way production does, per invariant #17.
		const routerConfig = toRouterConfig(shared as never);
		const copilotOverrides = routerConfig.backends[0].modelOverrides;
		const router = createModelRouter({ backends: [], default: "copilot" });
		// Seed the namespace driver (the real factory needs a token-store file on
		// disk; this injects a resolved account + a catalog fetch instead).
		const namespace = new GitHubCopilotDriver({
			tokenManager,
			namespaceId: "copilot",
			contextWindow: 0,
			account,
			fetch: catalogFetch,
			modelOverrides: copilotOverrides,
		});
		router.addDynamicBackend("copilot", namespace, {
			streaming: true,
			tool_use: false,
			system_prompt: true,
			prompt_caching: true,
			vision: false,
			extended_thinking: false,
		});
		router.markNotReady("copilot");
		const appContext = makeAppContext(shared);

		wireBackendReadiness(appContext, router);
		await new Promise((r) => setTimeout(r, 50));

		const rows = shared.backends as Array<Record<string, unknown>>;
		const expanded = rows.find((b) => b.id === "copilot-claude-opus-5.5");
		expect(expanded).toBeDefined();
		// The per-model override pinned the expanded row's logical_model to the old
		// family key, so a `copilot-opus-5.5` reference (which normalizes to
		// `opus-5-5`) resolves to this same logical model.
		expect(expanded?.logical_model).toBe("opus-5-5");
		// The shared row carries the raw provider model id, not the namespace-prefixed
		// backend id, so catalog grouping and models.dev lookup never see the
		// namespace entry's id.
		expect(expanded?.model).toBe("claude-opus-5.5");
	});
});

describe("reload re-gating + no duplicate rows (AC.7)", () => {
	it("re-expands after reload and does not duplicate per-model rows", async () => {
		const metadataFetch = async () => ({ ok: true as const, value: lineup() });
		const usageFetch = async () => ({
			ok: true as const,
			value: { concurrencyLimit: 3 } satisfies UmansUsage,
		});
		const { router, shared } = buildRouterWithUmans(metadataFetch, usageFetch);
		const appContext = makeAppContext(shared);

		wireBackendReadiness(appContext, router);
		await new Promise((r) => setTimeout(r, 50));
		const firstCount = (shared.backends as unknown[]).length;
		expect(firstCount).toBe(2);

		// Reload with a fresh umans namespace (mirrors SIGHUP). The shared
		// config is reset to the namespace form (as the loader would produce).
		const reloaded = umansSharedConfig();
		(appContext.config as { modelBackends: unknown }).modelBackends = reloaded;
		const reloadedRouterConfig = toRouterConfig(reloaded as never);
		reloadedRouterConfig.backends[0].metadataFetch = metadataFetch;
		reloadedRouterConfig.backends[0].usageFetch = usageFetch;
		router.reload(reloadedRouterConfig);
		expect(router.isNotReady("umans")).toBe(true);

		wireBackendReadiness(appContext, router);
		await new Promise((r) => setTimeout(r, 50));

		// No duplicate per-model rows on the NEW shared array.
		const cfgIds = (reloaded.backends as Array<{ id: string }>).map((b) => b.id).sort();
		expect(cfgIds).toEqual(["umans-coder", "umans-flash"]);

		// calculateTurnCost on the CURRENT shared array is non-zero (no stale
		// closure into the orphaned old array).
		const cost = calculateTurnCost(
			"umans-flash",
			{ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null },
			reloaded.backends as never,
		);
		expect(cost).toBeCloseTo(0.5, 5);
	});
});

describe("no startup network dependency (AC.14)", () => {
	it("wireBackendReadiness returns synchronously even when the fetch never resolves", () => {
		const hangingFetch = () => new Promise(() => {}) as never;
		const { router, shared } = buildRouterWithUmans(hangingFetch, hangingFetch);
		const appContext = makeAppContext(shared);
		// Must not block.
		wireBackendReadiness(appContext, router);
		// umans stays not-ready / unselectable.
		expect(router.isNotReady("umans")).toBe(true);
		expect(router.listBackends().map((b) => b.id)).not.toContain("umans");
	});
});

// --- R-MC4 production-path readiness gate (slice 6) --------------------------
// The pure `resolveCatalog` computes ready/configGap per backend; these tests
// prove the production start path CONSUMES them: an unready backend (no
// max_context in any of config/provider/models.dev) is marked not-ready on the
// real router, so it is neither advertised in hosts.models nor routable, and
// its configGap is logged once. A later models.dev refresh that supplies the
// missing max_context flips it ready and re-advertises WITHOUT a restart. A
// local config context_window makes a backend ready with no models.dev.

/**
 * Build a real router over two static openai-compatible backends (constructs
 * without live network): `ready-one` (will resolve a max_context) and `gapped`
 * (will not). Both start selectable — no readiness wiring on a static driver.
 */
function buildRouterWithTwoStatic() {
	const shared = {
		backends: [
			{
				id: "ready-one",
				provider: "openai-compatible",
				api_key: "sk-test",
				base_url: "http://localhost:8000",
				model: "ready-model",
				context_window: 128000,
			},
			{
				id: "gapped",
				provider: "openai-compatible",
				api_key: "sk-test",
				base_url: "http://localhost:8000",
				model: "gapped-model",
			},
		],
		default: "ready-one",
	};
	const router = createModelRouter(toRouterConfig(shared as never));
	return { router, shared };
}

/** A resolved-catalog entry fixture with/without a resolved max_context. */
function resolvedEntry(ready: boolean, providerModelId: string): ResolvedBackend {
	return {
		metadata: {
			provider_model_id: providerModelId,
			logical_model: null,
			vendor: null,
			capabilities: ready ? { max_context: 128000 } : {},
			field_sources: ready ? { max_context: "config" } : {},
		},
		ready,
		configGap: ready
			? ""
			: `${providerModelId}: max_context is unresolved across local config, provider discovery, and models.dev — set context_window in model_backends to make this route ready`,
		logicalModel: null,
		groupingSource: "none",
	};
}

describe("R-MC4 readiness gate on the production path", () => {
	it("does not advertise or route an unready backend and logs its configGap once", () => {
		const { router, shared } = buildRouterWithTwoStatic();
		const appContext = makeAppContext(shared);
		const warnings: Array<{ msg: string; meta?: unknown }> = [];
		(appContext.logger as unknown as { warn: unknown }).warn = (msg: string, meta?: unknown) => {
			warnings.push({ msg, meta });
		};

		const catalog = new Map<string, ResolvedBackend>([
			["ready-one", resolvedEntry(true, "ready-model")],
			["gapped", resolvedEntry(false, "gapped-model")],
		]);

		// Before gating both are selectable (static drivers are born ready).
		expect(
			router
				.listBackends()
				.map((b) => b.id)
				.sort(),
		).toEqual(["gapped", "ready-one"]);

		gateUnreadyBackends(router, catalog, appContext.logger);

		// The gapped backend is now excluded from selection + eligibility.
		expect(router.isNotReady("gapped")).toBe(true);
		expect(router.listBackends().map((b) => b.id)).toEqual(["ready-one"]);
		expect(router.listEligible().map((b) => b.id)).not.toContain("gapped");

		// configGap logged exactly once, naming the field to set.
		const gapLogs = warnings.filter(
			(w) => w.msg.includes("gapped-model") || JSON.stringify(w.meta).includes("gapped"),
		);
		expect(gapLogs.length).toBe(1);
		expect(JSON.stringify(gapLogs[0])).toContain("context_window");

		// Advertisement (hosts.models) excludes the gapped backend.
		advertiseLocalModels(appContext, router, shared as never, catalog);
		const row = db.query("SELECT models FROM hosts WHERE site_id = ?").get(siteId) as {
			models: string;
		};
		const advertised = JSON.parse(row.models) as Array<{ id: string }>;
		expect(advertised.map((m) => m.id)).toEqual(["ready-one"]);
	});

	it("flips a newly-ready backend to ready and re-advertises after a models.dev refresh (first-boot trap)", () => {
		const { router, shared } = buildRouterWithTwoStatic();
		const appContext = makeAppContext(shared);

		// First boot: no models.dev cache, gapped lacks max_context — unready.
		const beforeRefresh = new Map<string, ResolvedBackend>([
			["ready-one", resolvedEntry(true, "ready-model")],
			["gapped", resolvedEntry(false, "gapped-model")],
		]);
		gateUnreadyBackends(router, beforeRefresh, appContext.logger);
		advertiseLocalModels(appContext, router, shared as never, beforeRefresh);
		expect(router.isNotReady("gapped")).toBe(true);
		expect(router.listBackends().map((b) => b.id)).toEqual(["ready-one"]);

		// A refresh lands a models.dev snapshot supplying gapped's max_context.
		// Re-resolution now reports gapped as ready; the gate must flip it back.
		const afterRefresh = new Map<string, ResolvedBackend>([
			["ready-one", resolvedEntry(true, "ready-model")],
			["gapped", resolvedEntry(true, "gapped-model")],
		]);
		gateUnreadyBackends(router, afterRefresh, appContext.logger);
		advertiseLocalModels(appContext, router, shared as never, afterRefresh);

		expect(router.isNotReady("gapped")).toBe(false);
		expect(
			router
				.listBackends()
				.map((b) => b.id)
				.sort(),
		).toEqual(["gapped", "ready-one"]);
		const row = db.query("SELECT models FROM hosts WHERE site_id = ?").get(siteId) as {
			models: string;
		};
		const advertised = JSON.parse(row.models) as Array<{ id: string }>;
		expect(advertised.map((m) => m.id).sort()).toEqual(["gapped", "ready-one"]);
	});

	it("a local config context_window makes a backend ready with no models.dev", async () => {
		// Drive the REAL resolveLocalCatalog over a router whose only backend
		// carries context_window in config and has no models.dev snapshot. The
		// resolved entry must be ready purely from the config layer.
		const shared = {
			backends: [
				{
					id: "cfg-only",
					provider: "openai-compatible",
					api_key: "sk-test",
					base_url: "http://localhost:8000",
					model: "cfg-model",
					context_window: 65536,
				},
			],
			default: "cfg-only",
		};
		const router = createModelRouter(toRouterConfig(shared as never));
		// cache = null (no models.dev), empty aliases.
		const catalog = await resolveLocalCatalog(router, shared as never, null, new Map());
		const resolved = catalog.get("cfg-only");
		expect(resolved?.ready).toBe(true);
		expect(resolved?.metadata.capabilities.max_context).toBe(65536);
		expect(resolved?.metadata.field_sources.max_context).toBe("config");

		// And the gate keeps it selectable.
		const appContext = makeAppContext(shared);
		gateUnreadyBackends(router, catalog, appContext.logger);
		expect(router.isNotReady("cfg-only")).toBe(false);
		expect(router.listBackends().map((b) => b.id)).toContain("cfg-only");
	});
});

// --- Expanded-backend router config (invariant #17, #281) --------------------
// BedrockNamespaceDriver is not on the @bound/llm public surface; it is imported
// by path so the recorded control-plane fixtures go through its `fetch` seam.
// The registrar must hand each expanded backend a FULL router BackendConfig —
// the same one toRouterConfig would produce for its shared row — so namespace /
// model_overrides / top-level defaults request controls and the logical-model
// pin reach inference, and the hint fallback normalizes the raw provider model
// id under the real provider rather than the namespace-prefixed backend id.

const BEDROCK_FOUNDATION_MODELS = {
	modelSummaries: [
		{
			modelId: "anthropic.claude-haiku-5-5",
			modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5",
			providerName: "Anthropic",
			inputModalities: ["TEXT", "IMAGE"],
			outputModalities: ["TEXT"],
			modelLifecycle: { status: "ACTIVE" },
			inferenceTypesSupported: ["INFERENCE_PROFILE"],
			inferenceAPIsSupported: { converse: { streaming: true, sync: true }, openAiResponses: false },
			explicitPromptCaching: { isSupported: true },
		},
		{
			modelId: "openai.gpt-5.6-sol",
			modelArn: "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-5.6-sol",
			providerName: "OpenAI",
			inputModalities: ["TEXT", "IMAGE"],
			outputModalities: ["TEXT"],
			modelLifecycle: { status: "ACTIVE" },
			inferenceTypesSupported: ["INFERENCE_PROFILE"],
			inferenceAPIsSupported: { converse: { streaming: true, sync: true }, openAiResponses: true },
			explicitPromptCaching: { isSupported: true },
		},
	],
};

const BEDROCK_INFERENCE_PROFILES = {
	inferenceProfileSummaries: [
		{
			inferenceProfileId: "global.anthropic.claude-haiku-5-5",
			type: "SYSTEM_DEFINED",
			status: "ACTIVE",
			models: [{ modelArn: "arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-5-5" }],
		},
		{
			inferenceProfileId: "global.openai.gpt-5.6-sol",
			type: "SYSTEM_DEFINED",
			status: "ACTIVE",
			models: [{ modelArn: "arn:aws:bedrock:::foundation-model/openai.gpt-5.6-sol" }],
		},
	],
};

function bedrockFixtureFetch(): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(new Request(input, init).url).pathname;
		if (path.endsWith("/foundation-models")) {
			return new Response(JSON.stringify(BEDROCK_FOUNDATION_MODELS), { status: 200 });
		}
		if (path.endsWith("/inference-profiles")) {
			return new Response(JSON.stringify(BEDROCK_INFERENCE_PROFILES), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

/** A static single-model entry that must come through expansion untouched. */
function explicitEntry() {
	return {
		id: "explicit",
		provider: "openai-compatible",
		api_key: "sk-test",
		base_url: "http://localhost:8000",
		model: "gpt-6-luna",
		context_window: 128000,
		effort: "medium",
		cache_ttl: "5m",
		system_prompt_suffix: "explicit-suffix",
	};
}

const NAMESPACE_CAPS = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: true,
};

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !predicate(); i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("expanded backends get a full router config", () => {
	it("bedrock: namespace, model_overrides and defaults reach the router getters; hint fallback finds the expanded id", async () => {
		const shared = {
			backends: [
				explicitEntry(),
				{
					id: "bedrock-main",
					provider: "bedrock",
					region: "us-east-1",
					// Namespace-level controls every expanded model inherits.
					thinking: { type: "adaptive" as const },
					effort: "high",
					model_overrides: {
						// One model's controls pinned without listing the others.
						"anthropic.claude-haiku-5-5": {
							thinking: { type: "enabled" as const, budget_tokens: 2048 },
							effort: "low",
							cache_ttl: "1h",
							system_prompt_suffix: "haiku-suffix",
						},
					},
				},
			],
			default: "explicit",
			// Top-level defaults fill fields neither the namespace nor an override sets.
			defaults: { effort: "minimal", cache_ttl: "1h" },
		};
		const routerConfig = toRouterConfig(shared as never);
		const router = createModelRouter({
			backends: [routerConfig.backends[0]],
			default: "explicit",
		});
		const explicitBefore = {
			effort: router.getEffort("explicit"),
			thinking: router.getThinkingConfig("explicit"),
			cacheTtl: router.getCacheTtl("explicit"),
			suffix: router.getSystemPromptSuffix("explicit"),
			maxOutput: router.getMaxOutputTokens("explicit"),
		};
		// Seed the namespace driver with the recorded control-plane fixtures (the
		// config factory would sign live AWS requests).
		router.addDynamicBackend(
			"bedrock-main",
			new BedrockNamespaceDriver({
				namespaceId: "bedrock-main",
				region: "us-east-1",
				fetch: bedrockFixtureFetch(),
				modelOverrides: routerConfig.backends[1].modelOverrides,
			}),
			NAMESPACE_CAPS,
		);
		router.markNotReady("bedrock-main");
		const appContext = makeAppContext(shared);

		// Expanded Bedrock models carry no window of their own; models.dev supplies
		// it, so the post-registration catalog pass keeps them ready (R-MC4).
		wireBackendReadiness(appContext, router, { modelsDevCache: await loadedModelsDevCache() });
		await waitFor(() => router.tryGetBackend("bedrock-main") === null);
		await settleExpandedBackendPasses(router);

		const gpt = "bedrock-main-openai.gpt-5.6-sol";
		const haiku = "bedrock-main-anthropic.claude-haiku-5-5";
		expect(router.tryGetBackend(gpt)).not.toBeNull();
		expect(router.tryGetBackend(haiku)).not.toBeNull();

		// Namespace-level values.
		expect(router.getThinkingConfig(gpt)).toEqual({ type: "adaptive", display: "summarized" });
		expect(router.getEffort(gpt)).toBe("high");
		// Neither namespace nor override sets cache_ttl for gpt: the defaults block
		// fills it (not the capability fallback "5m").
		expect(router.getCacheTtl(gpt)).toBe("1h");
		expect(router.getSystemPromptSuffix(gpt)).toBeUndefined();

		// Per-model override wins over the namespace entry.
		expect(router.getThinkingConfig(haiku)).toEqual({ type: "enabled", budget_tokens: 2048 });
		expect(router.getEffort(haiku)).toBe("low");
		expect(router.getCacheTtl(haiku)).toBe("1h");
		expect(router.getSystemPromptSuffix(haiku)).toBe("haiku-suffix");

		// An old hand-written hint resolves through the logical model to the
		// expanded backend (raw model id normalized under the bedrock provider).
		expect(router.resolveLocalBackendIdForHint("gpt-5.6-sol")).toBe(gpt);
		expect(router.resolveLocalBackendIdForHint("claude-haiku-5.5")).toBe(haiku);

		// The explicit single-model entry is unchanged by the expansion.
		expect({
			effort: router.getEffort("explicit"),
			thinking: router.getThinkingConfig("explicit"),
			cacheTtl: router.getCacheTtl("explicit"),
			suffix: router.getSystemPromptSuffix("explicit"),
			maxOutput: router.getMaxOutputTokens("explicit"),
		}).toEqual(explicitBefore);
		expect(explicitBefore).toEqual({
			effort: "medium",
			thinking: undefined,
			cacheTtl: "5m",
			suffix: "explicit-suffix",
			maxOutput: undefined,
		});
		expect(router.resolveLocalBackendIdForHint("gpt-6-luna")).toBe("explicit");
	});

	it("github-copilot: defaults, namespace thinking, an override and its logical_model pin reach the router", async () => {
		const account: CopilotAccountInfo = {
			chatEnabled: true,
			copilotPlan: "enterprise",
			apiEndpoint: "https://api.enterprise.githubcopilot.com",
		};
		const tokenManager = {
			getAccessToken: async () => "ghu_abc",
		} as unknown as CopilotTokenManager;
		const catalogFetch = (async (input: RequestInfo | URL) => {
			const url = new URL(new Request(input).url);
			if (url.pathname.endsWith("/models")) {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-opus-5.5",
								supported_endpoints: ["/v1/messages"],
								capabilities: {
									limits: { max_context_window_tokens: 200000, max_output_tokens: 32000 },
								},
							},
							{
								id: "gpt-6.2-sol",
								supported_endpoints: ["/responses"],
								capabilities: { limits: { max_context_window_tokens: 400000 } },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const shared = {
			backends: [
				{
					id: "copilot",
					provider: "github-copilot",
					thinking: { type: "adaptive" as const },
					model_overrides: {
						"claude-opus-5.5": {
							effort: "high",
							max_output_tokens: 16000,
							logical_model: "opus-5-5",
						},
					},
				},
			],
			default: "copilot",
			defaults: { effort: "medium", cache_ttl: "1h" },
		};
		const routerConfig = toRouterConfig(shared as never);
		const router = createModelRouter({ backends: [], default: "copilot" });
		router.addDynamicBackend(
			"copilot",
			new GitHubCopilotDriver({
				tokenManager,
				namespaceId: "copilot",
				contextWindow: 0,
				account,
				fetch: catalogFetch,
				modelOverrides: routerConfig.backends[0].modelOverrides,
			}),
			NAMESPACE_CAPS,
		);
		router.markNotReady("copilot");
		const appContext = makeAppContext(shared);

		wireBackendReadiness(appContext, router);
		await waitFor(() => router.tryGetBackend("copilot") === null);

		const opus = "copilot-claude-opus-5.5";
		const sol = "copilot-gpt-6.2-sol";
		expect(router.tryGetBackend(opus)).not.toBeNull();

		// Defaults fill effort + cache_ttl where nothing more specific is set.
		expect(router.getEffort(sol)).toBe("medium");
		expect(router.getCacheTtl(sol)).toBe("1h");
		// Namespace thinking inherited by every expanded model.
		expect(router.getThinkingConfig(sol)).toEqual({ type: "adaptive", display: "summarized" });
		expect(router.getThinkingConfig(opus)).toEqual({ type: "adaptive", display: "summarized" });
		// Override wins over defaults, including the operator output cap.
		expect(router.getEffort(opus)).toBe("high");
		expect(router.getCacheTtl(opus)).toBe("1h");
		expect(router.getMaxOutputTokens(opus)).toBe(16000);

		// The logical_model pin governs local hint resolution: the old
		// hand-written `copilot-opus-5.5` (normalizes to `opus-5-5`) finds the
		// expanded claude backend.
		expect(router.resolveLocalBackendIdForHint("copilot-opus-5.5")).toBe(opus);
		expect(router.resolveLocalBackendIdForHint("gpt-6.2-sol")).toBe(sol);
	});

	it("re-applies the full config after a SIGHUP-style reload + re-expansion", async () => {
		const metadataFetch = async () => ({ ok: true as const, value: lineup() });
		const usageFetch = async () => ({
			ok: true as const,
			value: { concurrencyLimit: 2 } satisfies UmansUsage,
		});
		const build = (effort: string, cacheTtl: string) => ({
			backends: [{ id: "umans", provider: "umans", api_key: "sk-test", effort }],
			default: "umans",
			defaults: { cache_ttl: cacheTtl },
		});
		const shared = build("low", "1h");
		const routerConfig = toRouterConfig(shared as never);
		routerConfig.backends[0].metadataFetch = metadataFetch;
		routerConfig.backends[0].usageFetch = usageFetch;
		const router = createModelRouter(routerConfig);
		const appContext = makeAppContext(shared);

		wireBackendReadiness(appContext, router);
		await waitFor(() => router.tryGetBackend("umans") === null);
		expect(router.getEffort("umans-coder")).toBe("low");
		expect(router.getCacheTtl("umans-coder")).toBe("1h");
		expect(router.getMaxOutputTokens("umans-coder")).toBe(8192);

		const reloaded = build("high", "5m");
		(appContext.config as { modelBackends: unknown }).modelBackends = reloaded;
		const reloadedConfig = toRouterConfig(reloaded as never);
		reloadedConfig.backends[0].metadataFetch = metadataFetch;
		reloadedConfig.backends[0].usageFetch = usageFetch;
		router.reload(reloadedConfig);
		wireBackendReadiness(appContext, router);
		await waitFor(() => router.tryGetBackend("umans") === null);

		expect(router.getEffort("umans-coder")).toBe("high");
		expect(router.getCacheTtl("umans-coder")).toBe("5m");
		expect(router.getMaxOutputTokens("umans-coder")).toBe(8192);
	});
});

// --- Expanded backends advertise catalog-resolved metadata (#281) -------------
// A namespace registering its expanded backends must run the same resolve →
// gate → apply → advertise pass the rest of startup uses, so hosts.models carries
// the catalog logical model (not the backend id placeholder), the resolved
// max_context, and a model_overrides logical_model pin.

const MODELS_DEV_BEDROCK = {
	"amazon-bedrock": {
		models: {
			"openai.gpt-5.6-sol": { limit: { context: 400000, output: 64000 } },
			"anthropic.claude-haiku-5-5": { limit: { context: 200000, output: 32000 } },
		},
	},
};

async function loadedModelsDevCache(): Promise<ModelsDevCache> {
	const cache = new ModelsDevCache({
		cachePath: null,
		fetchImpl: (async () =>
			new Response(JSON.stringify(MODELS_DEV_BEDROCK), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	});
	expect(await cache.refresh()).toBe("updated");
	return cache;
}

function bedrockMainShared() {
	return {
		backends: [
			{
				id: "bedrock-main",
				provider: "bedrock",
				region: "us-east-1",
				model_overrides: {
					"anthropic.claude-haiku-5-5": { logical_model: "haiku-pinned" },
				},
			},
		],
		default: "bedrock-main",
	};
}

function seedBedrockMain(
	router: ReturnType<typeof createModelRouter>,
	shared: ReturnType<typeof bedrockMainShared>,
) {
	const routerConfig = toRouterConfig(shared as never);
	router.addDynamicBackend(
		"bedrock-main",
		new BedrockNamespaceDriver({
			namespaceId: "bedrock-main",
			region: "us-east-1",
			fetch: bedrockFixtureFetch(),
			modelOverrides: routerConfig.backends[0].modelOverrides,
		}),
		NAMESPACE_CAPS,
	);
	router.markNotReady("bedrock-main");
}

function advertisedModels(): Array<{
	id: string;
	logical_model?: string;
	capabilities?: { max_context?: number };
}> {
	const row = db.query("SELECT models FROM hosts WHERE site_id = ?").get(siteId) as {
		models: string;
	};
	return JSON.parse(row.models);
}

describe("expanded backends advertise catalog-resolved metadata", () => {
	const gpt = "bedrock-main-openai.gpt-5.6-sol";
	const haiku = "bedrock-main-anthropic.claude-haiku-5-5";

	it("advertises the catalog logical model, resolved max_context and a logical_model pin after registration", async () => {
		const cache = await loadedModelsDevCache();
		const shared = bedrockMainShared();
		const router = createModelRouter({ backends: [], default: "bedrock-main" });
		seedBedrockMain(router, shared);
		const appContext = makeAppContext(shared);

		wireBackendReadiness(appContext, router, { modelsDevCache: cache });
		await waitFor(() => router.tryGetBackend("bedrock-main") === null);
		await settleExpandedBackendPasses(router);

		const advertised = advertisedModels();
		const ids = advertised.map((m) => m.id).sort();
		expect(ids).toEqual([haiku, gpt].sort());
		expect(ids).not.toContain("bedrock-main");
		const gptEntry = advertised.find((m) => m.id === gpt);
		expect(gptEntry?.logical_model).toBe("gpt-5-6-sol");
		expect(gptEntry?.capabilities?.max_context).toBe(400000);
		expect(advertised.find((m) => m.id === haiku)?.logical_model).toBe("haiku-pinned");
		// The router got the resolved metadata too (applyResolvedCatalog).
		expect(router.getEffectiveCapabilities(gpt)?.max_context).toBe(400000);
		expect(router.isNotReady(gpt)).toBe(false);
	});

	it("re-registration after a SIGHUP-style reload re-resolves without duplicating rows", async () => {
		const cache = await loadedModelsDevCache();
		const shared = bedrockMainShared();
		const router = createModelRouter({ backends: [], default: "bedrock-main" });
		seedBedrockMain(router, shared);
		const appContext = makeAppContext(shared);
		wireBackendReadiness(appContext, router, { modelsDevCache: cache });
		await waitFor(() => router.tryGetBackend("bedrock-main") === null);
		await settleExpandedBackendPasses(router);

		const reloaded = bedrockMainShared();
		(appContext.config as { modelBackends: unknown }).modelBackends = reloaded;
		router.reload({ backends: [], default: "bedrock-main" });
		seedBedrockMain(router, reloaded);
		wireBackendReadiness(appContext, router);
		await waitFor(() => router.tryGetBackend("bedrock-main") === null);
		await settleExpandedBackendPasses(router);

		const cfgIds = (reloaded.backends as Array<{ id: string }>).map((b) => b.id).sort();
		expect(cfgIds).toEqual([haiku, gpt].sort());
		const advertised = advertisedModels();
		expect(advertised.map((m) => m.id).sort()).toEqual([haiku, gpt].sort());
		// The cache handed to the first wiring is kept for later re-registrations.
		expect(advertised.find((m) => m.id === gpt)?.logical_model).toBe("gpt-5-6-sol");
		expect(advertised.find((m) => m.id === gpt)?.capabilities?.max_context).toBe(400000);
	});

	it("gates an expanded backend whose max_context resolves nowhere, like a static backend", async () => {
		const shared = bedrockMainShared();
		const router = createModelRouter({ backends: [], default: "bedrock-main" });
		seedBedrockMain(router, shared);
		const appContext = makeAppContext(shared);
		wireBackendReadiness(appContext, router, { modelsDevCache: null });
		await waitFor(() => router.tryGetBackend("bedrock-main") === null);
		await settleExpandedBackendPasses(router);

		expect(router.isNotReady(gpt)).toBe(true);
		expect(advertisedModels().map((m) => m.id)).not.toContain(gpt);
	});
});

describe("expanded-backend catalog pass failure", () => {
	it("logs a failing pass instead of rejecting, keeping the immediate advertisement", async () => {
		const shared = bedrockMainShared();
		const router = createModelRouter({ backends: [], default: "bedrock-main" });
		seedBedrockMain(router, shared);
		const appContext = makeAppContext(shared);
		const warnings: string[] = [];
		(appContext.logger as unknown as { warn: unknown }).warn = (msg: string) => {
			warnings.push(msg);
		};
		(router as unknown as { applyResolvedCatalog: unknown }).applyResolvedCatalog = () => {
			throw new Error("apply failed");
		};
		wireBackendReadiness(appContext, router, { modelsDevCache: await loadedModelsDevCache() });
		await waitFor(() => router.tryGetBackend("bedrock-main") === null);
		await settleExpandedBackendPasses(router);

		expect(warnings).toContain("[llm] Expanded-backend catalog pass failed");
		expect(advertisedModels().map((m) => m.id)).toContain("bedrock-main-openai.gpt-5.6-sol");
	});
});

describe("createCoalescedPass", () => {
	it("runs one pass for schedules in the same tick", async () => {
		let runs = 0;
		const pass = createCoalescedPass(
			async () => {
				runs++;
			},
			() => {},
		);
		pass.schedule();
		pass.schedule();
		pass.schedule();
		await pass.settled();
		expect(runs).toBe(1);
	});

	it("a schedule during a running pass triggers exactly one trailing pass", async () => {
		let runs = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const pass = createCoalescedPass(
			async () => {
				runs++;
				if (runs === 1) await gate;
			},
			() => {},
		);
		pass.schedule();
		await new Promise((r) => setTimeout(r, 0));
		expect(runs).toBe(1);
		pass.schedule();
		pass.schedule();
		release();
		await pass.settled();
		expect(runs).toBe(2);
	});

	it("reports a failing pass and keeps draining", async () => {
		const errors: unknown[] = [];
		let runs = 0;
		const pass = createCoalescedPass(
			async () => {
				runs++;
				if (runs === 1) throw new Error("boom");
			},
			(e) => errors.push(e),
		);
		pass.schedule();
		await pass.settled();
		pass.schedule();
		await pass.settled();
		expect(runs).toBe(2);
		expect((errors[0] as Error).message).toBe("boom");
	});

	it("settled() resolves immediately when idle", async () => {
		const pass = createCoalescedPass(
			async () => {},
			() => {},
		);
		await pass.settled();
	});
});
