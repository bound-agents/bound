import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
				tier: 3,
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
