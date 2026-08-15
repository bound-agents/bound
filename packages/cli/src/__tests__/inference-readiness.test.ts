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
import { createModelRouter } from "@bound/llm";
import type { UmansModelMeta, UmansUsage } from "@bound/llm";
import { createLogger } from "@bound/shared";
import { toRouterConfig, wireBackendReadiness } from "../commands/start/inference";

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

		// Default redirected off the placeholder to a concrete id.
		expect(["umans-coder", "umans-flash"]).toContain(router.getDefaultId());
		expect(shared.default).not.toBe("umans");
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
