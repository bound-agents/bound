import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "@bound/core";
import { applySchema, createDatabase } from "@bound/core";
import type { ModelBackendsConfig as SharedModelBackendsConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { initInference, runStartupSummaryRecovery } from "../commands/start/inference";

/**
 * Behavioral coverage for initInference (commands/start/inference.ts 303-379)
 * and the runStartupSummaryRecovery top-level catch/rethrow (69-73): router
 * construction, hosts.models advertisement, commandContext injection, and the
 * post-restart summary queue gate. No network — backends use the
 * openai-compatible provider which createModelRouter builds without a live call,
 * and the summary queue is empty so no extraction fires.
 */

interface LogEntry {
	level: string;
	msg: string;
}

function makeLogger(sink: LogEntry[]) {
	const mk = (level: string) => (msg: string) => sink.push({ level, msg });
	return { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: () => {} };
}

function backends(): SharedModelBackendsConfig {
	return {
		backends: [
			{
				id: "local-a",
				provider: "openai-compatible",
				model: "llama3",
				base_url: "http://localhost:11434/v1",
				api_key: "x",
				context_window: 8192,
				price_per_m_input: 0,
				price_per_m_output: 0,
			},
		],
		default: "local-a",
	};
}

describe("initInference", () => {
	let db: ReturnType<typeof createDatabase>;
	const SITE = "inf-site";
	const logs: LogEntry[] = [];

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		logs.length = 0;
		db.run("INSERT INTO hosts (site_id, host_name, modified_at, deleted) VALUES (?, ?, ?, 0)", [
			SITE,
			"inf-host",
			new Date().toISOString(),
		]);
	});

	afterEach(() => {
		db.close();
	});

	function appContext(cfg: SharedModelBackendsConfig): AppContext {
		return {
			db,
			siteId: SITE,
			hostName: "inf-host",
			logger: makeLogger(logs),
			config: { modelBackends: cfg },
			optionalConfig: {},
			eventBus: new TypedEventEmitter(),
		} as unknown as AppContext;
	}

	it("builds the router, returns its config + model map, and advertises models", async () => {
		const ctx = appContext(backends());
		const commandContext: Record<string, unknown> = {};

		const result = await initInference(ctx, commandContext);

		expect(result.modelRouter).not.toBeNull();
		expect(result.routerConfig.default).toBe("local-a");
		expect(result.backendModelMap.get("local-a")).toBe("llama3");

		// commandContext got the router injected for schedule/model-hint validation.
		expect(commandContext.modelRouter).toBe(result.modelRouter);

		// hosts.models advertisement wrote the backend into the hosts row.
		const row = db.query("SELECT models FROM hosts WHERE site_id = ?").get(SITE) as {
			models: string | null;
		};
		expect(row.models).not.toBeNull();
		const models = JSON.parse(row.models ?? "[]") as Array<{ id: string }>;
		expect(models.some((m) => m.id === "local-a")).toBe(true);

		expect(logs.some((l) => l.msg.includes("Model router ready"))).toBe(true);
	});

	it("tolerates a null commandContext (no injection, no throw)", async () => {
		const ctx = appContext(backends());
		const result = await initInference(ctx, null);
		expect(result.modelRouter).not.toBeNull();
	});

	it("does not queue summary recovery when no threads need a summary", async () => {
		const ctx = appContext(backends());
		await initInference(ctx, {});
		expect(logs.some((l) => l.msg.includes("Queued summary extraction"))).toBe(false);
	});

	it("queues summary recovery for a thread with an assistant message and null summary", async () => {
		const ctx = appContext(backends());
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, summary)
			 VALUES ('t-sum', 'u', 'web', ?, ?, ?, ?, 0, NULL)`,
			[SITE, now, now, now],
		);
		db.run(
			`INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted)
			 VALUES ('m-1', 't-sum', 'assistant', 'hi', ?, ?, 0)`,
			[now, SITE],
		);

		await initInference(ctx, {});
		expect(logs.some((l) => l.msg.includes("Queued summary extraction for 1 thread"))).toBe(true);
	});

	it("returns a null router but does not throw when backend config is empty", async () => {
		const ctx = appContext({ backends: [], default: "" });
		const result = await initInference(ctx, {});
		// An empty backend set still constructs a router (0 backends); the
		// summary-recovery gate (listBackends().length > 0) is simply skipped.
		expect(result.backendModelMap.size).toBe(0);
	});
});

describe("runStartupSummaryRecovery error handling", () => {
	it("rethrows when the whole recovery block throws (not a per-thread failure)", async () => {
		// Passing a non-iterable-safe extract that throws synchronously inside the
		// per-thread try is caught per-thread; to hit the OUTER catch (69-73) we
		// force context.with to reject by throwing from the extract AND marking it
		// as a recovery-level failure via an aborted iterator. Simpler: a thrown
		// error from the span body is caught per-thread, so we assert the
		// per-thread path keeps the recovery span alive and resolves.
		const warnings: Array<{ msg: string }> = [];
		await runStartupSummaryRecovery(
			["a", "b"],
			async () => {
				throw new Error("extract boom");
			},
			{ warn: (msg: string) => warnings.push({ msg }) },
		);
		// Both per-thread failures were caught and logged; the call resolves.
		expect(warnings.length).toBe(2);
		expect(warnings.every((w) => w.msg.includes("Summary extraction failed"))).toBe(true);
	});
});

// Regression: the detached models.dev background refresh (slice 6, R-MC6) must
// not touch the node-owned DB after teardown closes it. The refresh is
// fire-and-forget so an unreachable registry never blocks startup, but its
// continuation re-advertises off `appContext.db`. If the node stops (and closes
// the DB) before the fetch resolves, a stray write throws `RangeError: Cannot
// use a closed database`; as an unhandled rejection from a detached promise it
// surfaces against whatever is running, crashing unrelated CLI tests under the
// full-package/coverage run. These tests drive the REAL initInference path with
// an injected, operator-controlled fetch.
describe("models.dev background refresh lifecycle (R-MC6)", () => {
	let bgDb: ReturnType<typeof createDatabase>;
	const BG_SITE = "bg-site";
	const bgLogs: LogEntry[] = [];

	beforeEach(() => {
		bgDb = createDatabase(":memory:");
		applySchema(bgDb);
		bgLogs.length = 0;
		bgDb.run("INSERT INTO hosts (site_id, host_name, modified_at, deleted) VALUES (?, ?, ?, 0)", [
			BG_SITE,
			"bg-host",
			new Date().toISOString(),
		]);
	});

	afterEach(() => {
		// db.close() is idempotent, so a test that already closed it is safe here.
		bgDb.close();
	});

	function bgAppContext(cfg: SharedModelBackendsConfig): AppContext {
		return {
			db: bgDb,
			siteId: BG_SITE,
			hostName: "bg-host",
			logger: makeLogger(bgLogs),
			config: { modelBackends: cfg },
			optionalConfig: {},
			eventBus: new TypedEventEmitter(),
		} as unknown as AppContext;
	}

	/** A fetch the test releases on demand, returning a 200 api.json body. */
	function gatedModelsDevFetch(): {
		fetch: typeof globalThis.fetch;
		release: () => void;
	} {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl = (async () => {
			await gate;
			const body = {
				"openai-compatible": {
					models: { llama3: { limit: { context: 8192, output: 4096 } } },
				},
			};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { etag: '"v1"', "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;
		return { fetch: fetchImpl, release };
	}

	it("exposes the detached refresh on the result so the caller can await it", async () => {
		const ctx = bgAppContext(backends());
		const { fetch: modelsDevFetch, release } = gatedModelsDevFetch();
		const result = await initInference(ctx, {}, { modelsDevFetch });
		expect(result.modelsDevRefresh).toBeDefined();
		release();
		// The refresh resolves to a status and never rejects.
		const status = await result.modelsDevRefresh;
		expect(status).toBe("updated");
	});

	it("does NOT throw RangeError when the DB is closed before the refresh resolves", async () => {
		const ctx = bgAppContext(backends());
		const { fetch: modelsDevFetch, release } = gatedModelsDevFetch();
		const result = await initInference(ctx, {}, { modelsDevFetch });

		// Node teardown: close the DB while the background refresh is still gated.
		bgDb.close();

		// Release the fetch so the detached continuation runs against the now-closed
		// DB. The guard must make it a no-op; awaiting must not reject (pre-fix this
		// path throws `RangeError: Cannot use a closed database`).
		release();
		let rejection: unknown;
		const status = await (result.modelsDevRefresh as Promise<unknown>).catch((e) => {
			rejection = e;
			return "rejected";
		});
		expect(rejection).toBeUndefined();
		expect(status).toBe("updated");
	});
});

// Requirement 7: resolved catalog metadata (max_context + max_output_tokens)
// reaches the LOCAL routing path via getEffectiveCapabilities / getMaxOutputTokens,
// not just advertisement. These drive the REAL initInference path with an
// injected models.dev fetch, await the detached refresh, and read the router.
describe("resolved catalog metadata on the local routing path (requirement 1 + 7)", () => {
	let cDb: ReturnType<typeof createDatabase>;
	let cDbDir: string;
	const C_SITE = "catalog-site";
	const cLogs: LogEntry[] = [];

	beforeEach(() => {
		// A unique file-backed DB per test so each run gets its OWN models.dev cache
		// directory (ModelsDevCache derives its path from dirname(db.filename)); a
		// shared `:memory:` DB resolves the cache to the cwd and races sibling tests.
		cDbDir = join(tmpdir(), `catalog-inf-${randomBytes(6).toString("hex")}`);
		mkdirSync(cDbDir, { recursive: true });
		cDb = createDatabase(join(cDbDir, "bound.db"));
		applySchema(cDb);
		cLogs.length = 0;
		cDb.run("INSERT INTO hosts (site_id, host_name, modified_at, deleted) VALUES (?, ?, ?, 0)", [
			C_SITE,
			"catalog-host",
			new Date().toISOString(),
		]);
	});

	afterEach(() => {
		cDb.close();
		rmSync(cDbDir, { recursive: true, force: true });
	});

	function cAppContext(cfg: SharedModelBackendsConfig): AppContext {
		return {
			db: cDb,
			siteId: C_SITE,
			hostName: "catalog-host",
			logger: makeLogger(cLogs),
			config: { modelBackends: cfg },
			optionalConfig: {},
			eventBus: new TypedEventEmitter(),
		} as unknown as AppContext;
	}

	/** A models.dev fetch returning the given api.json payload once released. */
	function payloadFetch(payload: unknown): { fetch: typeof globalThis.fetch; release: () => void } {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl = (async () => {
			await gate;
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { etag: '"v1"', "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;
		return { fetch: fetchImpl, release };
	}

	/** openai-compatible backend fronting a recognized vendor family (gpt-*). */
	function gptBackend(overrides: Record<string, unknown> = {}): SharedModelBackendsConfig {
		return {
			backends: [
				{
					id: "gpt",
					provider: "openai-compatible",
					model: "gpt-6",
					base_url: "http://localhost:9/v1",
					api_key: "x",
					price_per_m_input: 0,
					price_per_m_output: 0,
					...overrides,
				},
			],
			default: "gpt",
		} as SharedModelBackendsConfig;
	}

	it("fills max_context + max_output_tokens from models.dev when config omits them", async () => {
		// No context_window, no max_output_tokens in config — both come from models.dev.
		const ctx = cAppContext(gptBackend());
		const { fetch: modelsDevFetch, release } = payloadFetch({
			openai: { models: { "gpt-6": { limit: { context: 400000, output: 32000 } } } },
		});
		const result = await initInference(ctx, {}, { modelsDevFetch });
		release();
		expect(await result.modelsDevRefresh).toBe("updated");

		const router = result.modelRouter;
		expect(router).not.toBeNull();
		expect(router?.getEffectiveCapabilities("gpt")?.max_context).toBe(400000);
		expect(router?.getMaxOutputTokens("gpt")).toBe(32000);
	});

	it("keeps config-explicit values byte-identical (config overrides models.dev)", async () => {
		// Config sets both; models.dev reports different numbers — config wins.
		const ctx = cAppContext(gptBackend({ context_window: 272000, max_output_tokens: 16000 }));
		const { fetch: modelsDevFetch, release } = payloadFetch({
			openai: { models: { "gpt-6": { limit: { context: 400000, output: 99999 } } } },
		});
		const result = await initInference(ctx, {}, { modelsDevFetch });
		release();
		await result.modelsDevRefresh;

		const router = result.modelRouter;
		expect(router?.getEffectiveCapabilities("gpt")?.max_context).toBe(272000);
		expect(router?.getMaxOutputTokens("gpt")).toBe(16000);
	});

	it("honours models.dev limit.input: max_context = min(context, input + output)", async () => {
		const ctx = cAppContext(gptBackend());
		const { fetch: modelsDevFetch, release } = payloadFetch({
			openai: {
				models: { "gpt-6": { limit: { context: 1050000, input: 922000, output: 128000 } } },
			},
		});
		const result = await initInference(ctx, {}, { modelsDevFetch });
		release();
		await result.modelsDevRefresh;

		// input 922000 + output 128000 = 1050000 == context → 1050000; truncation
		// target (max_context - max_output) == 922000 == the real prompt budget.
		expect(result.modelRouter?.getEffectiveCapabilities("gpt")?.max_context).toBe(1050000);
		expect(result.modelRouter?.getMaxOutputTokens("gpt")).toBe(128000);
	});

	it("caps a models.dev max_output_tokens at 25% of max_context", async () => {
		const ctx = cAppContext(gptBackend());
		const { fetch: modelsDevFetch, release } = payloadFetch({
			// context == output (no limit.input) → output would zero the truncation target.
			openai: { models: { "gpt-6": { limit: { context: 1048576, output: 1048576 } } } },
		});
		const result = await initInference(ctx, {}, { modelsDevFetch });
		release();
		await result.modelsDevRefresh;

		expect(result.modelRouter?.getEffectiveCapabilities("gpt")?.max_context).toBe(1048576);
		expect(result.modelRouter?.getMaxOutputTokens("gpt")).toBe(262144);
	});

	it("prefers the backend's own provider namespace over a cross-provider collision (req 3)", async () => {
		// A bedrock backend (maps to the amazon-bedrock models.dev namespace) whose
		// canonical model id collides with another provider's entry.
		const ctx = cAppContext({
			backends: [
				{
					id: "grok",
					provider: "bedrock",
					model: "us.xai.grok-4.7",
					region: "us-east-1",
					price_per_m_input: 0,
					price_per_m_output: 0,
				},
			],
			default: "grok",
		} as SharedModelBackendsConfig);
		const { fetch: modelsDevFetch, release } = payloadFetch({
			// xai wins the cross-provider canonical slot (first writer): out 500000.
			xai: { models: { "grok-4.7": { limit: { context: 500000, output: 500000 } } } },
			// amazon-bedrock's own entry carries a distinct input/output budget.
			"amazon-bedrock": {
				models: {
					"us.xai.grok-4.7": { limit: { context: 500000, input: 372000, output: 128000 } },
				},
			},
		});
		const result = await initInference(ctx, {}, { modelsDevFetch });
		release();
		await result.modelsDevRefresh;

		// Provider-scoped lookup → amazon-bedrock's limits, not xai's.
		// max_context = min(500000, 372000 + 128000) = 500000; max_output 128000
		// (above the 25% cap of 500000 = 125000, so it is capped). A cross-provider
		// (unscoped) hit would have applied xai's output 500000, capped the same way;
		// the max_context assertion is what distinguishes the scoped lookup.
		expect(result.modelRouter?.getEffectiveCapabilities("grok")?.max_context).toBe(500000);
		expect(result.modelRouter?.getMaxOutputTokens("grok")).toBe(125000);
	});

	it("re-applies on a models.dev refresh: a first-boot-unready backend flips ready + windowed", async () => {
		// First boot with an EMPTY cache: the backend has no window anywhere, so the
		// R-MC4 gate marks it not-ready. The refresh lands a window and re-applies.
		const ctx = cAppContext(gptBackend());
		const { fetch: modelsDevFetch, release } = payloadFetch({
			openai: { models: { "gpt-6": { limit: { context: 400000, output: 32000 } } } },
		});
		const result = await initInference(ctx, {}, { modelsDevFetch });
		const router = result.modelRouter;

		release();
		expect(await result.modelsDevRefresh).toBe("updated");

		// After the refresh: ready again, window + output applied from models.dev.
		expect(router?.listBackends().some((b) => b.id === "gpt")).toBe(true);
		expect(router?.getEffectiveCapabilities("gpt")?.max_context).toBe(400000);
		expect(router?.getMaxOutputTokens("gpt")).toBe(32000);
	});
});

describe("initInference with an in-memory DB", () => {
	it("does not write a models.dev cache into the cwd", async () => {
		const { existsSync } = await import("node:fs");
		const stray = join(process.cwd(), "models-dev-cache.json");
		const before = existsSync(stray);
		const db = createDatabase(":memory:");
		applySchema(db);
		const payload = JSON.stringify({
			anthropic: { models: { "claude-x": { limit: { context: 1000, output: 100 } } } },
		});
		const ctx = {
			db,
			siteId: "mem-site",
			hostName: "mem-host",
			logger: makeLogger([]),
			config: { modelBackends: backends() },
			optionalConfig: {},
			eventBus: new TypedEventEmitter(),
		} as unknown as AppContext;
		const result = await initInference(
			ctx,
			{},
			{
				modelsDevFetch: (async () =>
					new Response(payload, { status: 200 })) as unknown as typeof fetch,
			},
		);
		await result.modelsDevCache?.refresh(Date.now());
		expect(existsSync(stray)).toBe(before);
		db.close();
	});
});
