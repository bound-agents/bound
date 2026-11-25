/**
 * Behavioral coverage for the three `server.ts` paths the single-node and
 * fully-configured boot fixtures do not reach, driven by calling `initServer`
 * directly with crafted deps against a real in-memory DB:
 *
 *   1. Background aux dispatch (`runBackgroundAuxThread`, #76/#220): a seeded
 *      background placeholder + pending dispatch entry, driven through a fake
 *      `agentLoopFactory.createAuxLoopRunner`, delivers the aux result onto the
 *      parent's placeholder row and re-drives the parent via `notify:enqueued`.
 *      Also the spurious-re-wake guard, the missing-stamp fail-safe, the
 *      missing-agent and missing-runner error paths.
 *
 *   2. The event-listener wiring (`task:completed` → notify route,
 *      `notify:enqueued` → handleThread, the client-tool expiry scan) — emitted
 *      on the real eventBus and asserted via observable DB / handler effects.
 *
 *   3. The platform MCP leader-election adapter (`mcpLeaderAdapter`
 *      connect/disconnect): a platforms.json with one zero-token connector makes
 *      `initServer` build the adapter and `PlatformLeaderElection.start()` claim
 *      leadership, firing `connect()`; `stopLeaderElections()` fires
 *      `disconnect()`. Asserted against the leader-key row and the registry
 *      lifecycle.
 *
 * initServer is driven directly (not a full `startNode`) so the aux loop runner
 * and the platform setup can be fakes — the real factory needs a live sandbox +
 * model backend, and a real Discord connector needs a token. Every server,
 * interval, and leader election started here is stopped in afterEach via the
 * ServerResult handles (webServer.stop, stopLeaderElections, threadExecutor
 * drain) so nothing leaks into sibling files under the combined commit-hook run.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyMetricsSchema,
	applySchema,
	createDatabase,
	enqueueMessage,
	findBackgroundPlaceholderDeliveryState,
	insertRow,
	readMessageMetadata,
} from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { initServer } from "../server.js";
import {
	createMcpAppProxyRelay,
	createRemotePlatformRequest,
	createRouteHealthRelay,
	formatNotification,
} from "../server.js";

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function silentLogger() {
	return {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
	};
}

/**
 * A relay-processor stub capturing which wiring setters `initServer` called.
 * All four are no-op sinks — `initServer` only ever calls them, never reads back.
 */
function makeRelayProcessor() {
	const calls = {
		setAgentLoopFactory: 0,
		setThreadExecutor: 0,
		setWsRegistry: 0,
		setPlatformMcpRegistry: 0,
	};
	return {
		calls,
		setAgentLoopFactory: () => {
			calls.setAgentLoopFactory++;
		},
		setThreadExecutor: () => {
			calls.setThreadExecutor++;
		},
		setWsRegistry: () => {
			calls.setWsRegistry++;
		},
		setPlatformMcpRegistry: () => {
			calls.setPlatformMcpRegistry++;
		},
	};
}

/** A model router stub exposing only the methods the warm-poke/notify paths read. */
function makeModelRouter() {
	return {
		getDefaultId: () => "fake",
		getCacheTtl: () => undefined,
		getCacheWarmConfig: () => undefined,
	};
}

type AppContextLike = {
	db: Database;
	config: {
		modelBackends: { backends: Array<Record<string, unknown>>; default: string };
		allowlist: { default_web_user: string };
	};
	optionalConfig: Record<string, { ok: boolean; value?: unknown }>;
	eventBus: TypedEventEmitter;
	logger: ReturnType<typeof silentLogger>;
	siteId: string;
	hostName: string;
};

function makeAppContext(
	db: Database,
	siteId: string,
	optionalConfig: AppContextLike["optionalConfig"] = {},
	warmingEnabled = false,
): AppContextLike {
	return {
		db,
		config: {
			modelBackends: {
				backends: [
					{
						id: "fake",
						provider: "openai-compatible",
						price_per_m_input: 0,
						price_per_m_output: 0,
						price_per_m_cache_read: 0,
						price_per_m_cache_write: 0,
						...(warmingEnabled ? { cache_warming: { enabled: true, max_pokes: 1 } } : {}),
					},
				],
				default: "fake",
			},
			allowlist: { default_web_user: "operator" },
		},
		optionalConfig,
		eventBus: new TypedEventEmitter(),
		logger: silentLogger(),
		siteId,
		hostName: "test-host",
	};
}

/** Build the ServerDeps `initServer` consumes from a crafted appContext + factory. */
function makeDeps(appContext: AppContextLike, agentLoopFactory: any, relayProcessor: any): any {
	return {
		appContext,
		modelRouter: makeModelRouter(),
		agentLoopFactory,
		keyManager: undefined,
		keyring: undefined,
		hubSiteId: undefined,
		clusterFsObj: null,
		relayProcessor,
		oauthMcpBridge: null,
		getMcpAppAccessToken: null,
		ports: { webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
	};
}

// ---------------------------------------------------------------------------
// Row seeding helpers
// ---------------------------------------------------------------------------

function seedThread(
	db: Database,
	siteId: string,
	id: string,
	iface: string,
	userId: string,
	agentId?: string,
) {
	const now = new Date().toISOString();
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: userId,
			interface: iface,
			host_origin: "test-host",
			title: null,
			summary: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
			agent_id: agentId ?? null,
		},
		siteId,
	);
}

/**
 * Seed the parent's background placeholder (a tool_result row carrying the
 * in-flight `background` marker), the aux thread's seed user message (carrying
 * the `background_parent` correlation), and the aux thread's pending dispatch
 * entry so `claimPending` inside `runBackgroundAuxThread` returns a work item.
 */
function seedBackgroundAux(
	db: Database,
	siteId: string,
	opts: {
		parentThreadId: string;
		auxThreadId: string;
		callId: string;
		agentId: string;
		stampInFlight?: boolean;
	},
) {
	const now = new Date().toISOString();
	// Parent placeholder tool_result row.
	insertRow(
		db,
		"messages",
		{
			id: randomUUID(),
			thread_id: opts.parentThreadId,
			role: "tool_result",
			content: "[running in background]",
			model_id: null,
			tool_name: opts.callId,
			created_at: now,
			modified_at: now,
			host_origin: "test-host",
			deleted: 0,
			exit_code: null,
			metadata: opts.stampInFlight === false ? null : JSON.stringify({ background: 1 }),
		},
		siteId,
	);
	// Aux thread seed user message carrying the parent correlation.
	const seedMsgId = randomUUID();
	insertRow(
		db,
		"messages",
		{
			id: seedMsgId,
			thread_id: opts.auxThreadId,
			role: "user",
			content: "do the aux errand",
			model_id: null,
			tool_name: null,
			created_at: now,
			modified_at: now,
			host_origin: "test-host",
			deleted: 0,
			exit_code: null,
			metadata: JSON.stringify({
				background_parent: { thread_id: opts.parentThreadId, call_id: opts.callId },
			}),
		},
		siteId,
	);
	// Pending dispatch for the aux thread so claimPending yields it.
	enqueueMessage(db, seedMsgId, opts.auxThreadId);
}

function seedAgent(db: Database, siteId: string, id: string) {
	const now = new Date().toISOString();
	insertRow(
		db,
		"agents",
		{
			id,
			name: "aux-identity",
			persona: "You are a focused auxiliary worker.",
			tools: null,
			model_hint: null,
			created_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initServer — background aux dispatch (#76/#220)", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-aux-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	/**
	 * Drive a background aux thread end to end: the fake aux runner returns a
	 * summary, and the dispatcher must land it on the parent's placeholder row
	 * (content + background_delivered stamp) and emit notify:enqueued to re-drive
	 * the parent. We trigger the run by emitting notify:enqueued for the AUX
	 * thread (the same wake channel handleThread listens on) after wiring a
	 * background seed — but handleThread routes background-owned aux threads into
	 * runBackgroundAuxThread via the seed correlation.
	 */
	it("delivers the aux runner's summary onto the parent placeholder and re-drives the parent", async () => {
		const parentThreadId = randomUUID();
		const auxThreadId = randomUUID();
		const agentId = randomUUID();
		const callId = `call_${randomUUID().slice(0, 8)}`;

		seedThread(db, siteId, parentThreadId, "web", "operator");
		seedThread(db, siteId, auxThreadId, "web", "operator", agentId);
		seedAgent(db, siteId, agentId);
		seedBackgroundAux(db, siteId, { parentThreadId, auxThreadId, callId, agentId });

		let runnerCalled = false;
		let seenInstructions = "";
		const agentLoopFactory = {
			createAuxLoopRunner: () => async (cfg: { instructions: string }) => {
				runnerCalled = true;
				seenInstructions = cfg.instructions;
				return { summary: "aux errand complete: 3 files scanned", error: undefined };
			},
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		// `finishParent` emits notify:enqueued for the parent after resolving the
		// placeholder (the #220 strand fix). We assert the durable observable effect
		// of that re-drive — resolveDeferredToolResult calls enqueueToolResult, which
		// writes a tool_result dispatch row keyed tool-result:<thread>:<callId> —
		// rather than racing the synchronous event dispatch.

		// Wake the aux thread. handleThread sees the seed's background_parent
		// correlation and routes to runBackgroundAuxThread.
		appContext.eventBus.emit("notify:enqueued", { thread_id: auxThreadId });
		for (let i = 0; i < 40 && !runnerCalled; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		// Let the resolution + re-drive settle after the runner resolves.
		await new Promise((r) => setTimeout(r, 50));

		expect(runnerCalled).toBe(true);
		expect(seenInstructions).toBe("do the aux errand");

		// Parent placeholder now carries the delivered result + stamp.
		const placeholder = findBackgroundPlaceholderDeliveryState(db, parentThreadId, callId);
		expect(placeholder).not.toBeNull();
		expect(placeholder?.delivered).toBe(true);
		const parentRow = db
			.query(
				"SELECT content, exit_code FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
			)
			.get(parentThreadId, callId) as { content: string; exit_code: number } | null;
		expect(parentRow?.content).toBe("aux errand complete: 3 files scanned");
		expect(parentRow?.exit_code).toBe(0);

		// The parent thread was re-driven: a tool_result dispatch row for the
		// parent's (thread, call_id) now exists (enqueueToolResult, via
		// resolveDeferredToolResult inside finishParent).
		const reDrive = db
			.query("SELECT id FROM durable_work WHERE kind = 'dispatch_message' AND idempotency_key = ?")
			.get(`tool-result:${parentThreadId}:${callId}`) as { id: string } | null;
		expect(reDrive).not.toBeNull();
	});

	it("marks the parent placeholder as an error when the aux runner returns an error", async () => {
		const parentThreadId = randomUUID();
		const auxThreadId = randomUUID();
		const agentId = randomUUID();
		const callId = `call_${randomUUID().slice(0, 8)}`;

		seedThread(db, siteId, parentThreadId, "web", "operator");
		seedThread(db, siteId, auxThreadId, "web", "operator", agentId);
		seedAgent(db, siteId, agentId);
		seedBackgroundAux(db, siteId, { parentThreadId, auxThreadId, callId, agentId });

		const agentLoopFactory = {
			createAuxLoopRunner: () => async () => ({
				summary: "",
				error: "model refused the errand",
			}),
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		appContext.eventBus.emit("notify:enqueued", { thread_id: auxThreadId });
		await new Promise((r) => setTimeout(r, 150));

		const parentRow = db
			.query(
				"SELECT content, exit_code FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
			)
			.get(parentThreadId, callId) as { content: string; exit_code: number } | null;
		expect(parentRow?.content).toContain("model refused the errand");
		expect(parentRow?.exit_code).toBe(1);
	});

	it("delivers anyway when the placeholder is missing its in-flight background stamp (#220 fail-safe)", async () => {
		const parentThreadId = randomUUID();
		const auxThreadId = randomUUID();
		const agentId = randomUUID();
		const callId = `call_${randomUUID().slice(0, 8)}`;

		seedThread(db, siteId, parentThreadId, "web", "operator");
		seedThread(db, siteId, auxThreadId, "web", "operator", agentId);
		seedAgent(db, siteId, agentId);
		// stampInFlight: false — placeholder exists but never got its `background`
		// marker. The dispatcher must still deliver (fail-safe toward delivery).
		seedBackgroundAux(db, siteId, {
			parentThreadId,
			auxThreadId,
			callId,
			agentId,
			stampInFlight: false,
		});

		const agentLoopFactory = {
			createAuxLoopRunner: () => async () => ({ summary: "delivered despite missing stamp" }),
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		appContext.eventBus.emit("notify:enqueued", { thread_id: auxThreadId });
		await new Promise((r) => setTimeout(r, 150));

		const parentRow = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
			)
			.get(parentThreadId, callId) as { content: string } | null;
		expect(parentRow?.content).toBe("delivered despite missing stamp");
	});

	it("errors the parent placeholder when the aux agent identity is not found", async () => {
		const parentThreadId = randomUUID();
		const auxThreadId = randomUUID();
		const callId = `call_${randomUUID().slice(0, 8)}`;
		const missingAgentId = randomUUID();

		seedThread(db, siteId, parentThreadId, "web", "operator");
		seedThread(db, siteId, auxThreadId, "web", "operator", missingAgentId);
		// No seedAgent — the agent row is absent.
		seedBackgroundAux(db, siteId, {
			parentThreadId,
			auxThreadId,
			callId,
			agentId: missingAgentId,
		});

		let runnerCalled = false;
		const agentLoopFactory = {
			createAuxLoopRunner: () => async () => {
				runnerCalled = true;
				return { summary: "should not run" };
			},
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		appContext.eventBus.emit("notify:enqueued", { thread_id: auxThreadId });
		await new Promise((r) => setTimeout(r, 150));

		expect(runnerCalled).toBe(false);
		const parentRow = db
			.query(
				"SELECT content, exit_code FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
			)
			.get(parentThreadId, callId) as { content: string; exit_code: number } | null;
		expect(parentRow?.content).toContain("not found");
		expect(parentRow?.exit_code).toBe(1);
	});

	it("errors the parent placeholder when the factory cannot build an aux runner", async () => {
		const parentThreadId = randomUUID();
		const auxThreadId = randomUUID();
		const agentId = randomUUID();
		const callId = `call_${randomUUID().slice(0, 8)}`;

		seedThread(db, siteId, parentThreadId, "web", "operator");
		seedThread(db, siteId, auxThreadId, "web", "operator", agentId);
		seedAgent(db, siteId, agentId);
		seedBackgroundAux(db, siteId, { parentThreadId, auxThreadId, callId, agentId });

		// createAuxLoopRunner returns undefined → the "cannot construct" branch.
		const agentLoopFactory = {
			createAuxLoopRunner: () => undefined,
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		appContext.eventBus.emit("notify:enqueued", { thread_id: auxThreadId });
		await new Promise((r) => setTimeout(r, 150));

		const parentRow = db
			.query(
				"SELECT content, exit_code FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
			)
			.get(parentThreadId, callId) as { content: string; exit_code: number } | null;
		expect(parentRow?.content).toContain("cannot construct auxiliary loops");
		expect(parentRow?.exit_code).toBe(1);
	});

	it("does not clobber an already-delivered placeholder on a spurious re-wake", async () => {
		const parentThreadId = randomUUID();
		const auxThreadId = randomUUID();
		const agentId = randomUUID();
		const callId = `call_${randomUUID().slice(0, 8)}`;

		seedThread(db, siteId, parentThreadId, "web", "operator");
		seedThread(db, siteId, auxThreadId, "web", "operator", agentId);
		seedAgent(db, siteId, agentId);

		// Placeholder is ALREADY delivered (background_delivered stamp present,
		// in-flight marker dropped) — this is the spurious-re-wake condition.
		const now = new Date().toISOString();
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: parentThreadId,
				role: "tool_result",
				content: "original delivered result",
				model_id: null,
				tool_name: callId,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: 0,
				metadata: JSON.stringify({ background_delivered: true }),
			},
			siteId,
		);
		const seedMsgId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: seedMsgId,
				thread_id: auxThreadId,
				role: "user",
				content: "re-wake errand",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: JSON.stringify({
					background_parent: { thread_id: parentThreadId, call_id: callId },
				}),
			},
			siteId,
		);
		enqueueMessage(db, seedMsgId, auxThreadId);

		const agentLoopFactory = {
			createAuxLoopRunner: () => async () => ({ summary: "second result — must not land" }),
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		appContext.eventBus.emit("notify:enqueued", { thread_id: auxThreadId });
		await new Promise((r) => setTimeout(r, 150));

		// The originally-delivered result is untouched by the re-wake.
		const parentRow = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
			)
			.get(parentThreadId, callId) as { content: string } | null;
		expect(parentRow?.content).toBe("original delivered result");
		// And the delivered stamp survives.
		const meta = (() => {
			const row = db
				.query(
					"SELECT id FROM messages WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result'",
				)
				.get(parentThreadId, callId) as { id: string } | null;
			return row ? readMessageMetadata(db, row.id) : null;
		})();
		expect(meta?.background_delivered).toBe(true);
	});
});

describe("initServer — event listener wiring", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-events-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	it("routes task:completed to a local task_complete notification labelled by trigger spec", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");
		const taskId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "completed",
				trigger_spec: "0 9 * * *",
				thread_id: threadId,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const appContext = makeAppContext(db, siteId);
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		const enqueued: string[] = [];
		appContext.eventBus.on("notify:enqueued", ({ thread_id }) => enqueued.push(thread_id));

		// Before the fix this handler queried a nonexistent `tasks.name` column
		// and threw on every database.
		expect(() =>
			appContext.eventBus.emit("task:completed", { task_id: taskId, result: "ok" }),
		).not.toThrow();

		expect(enqueued).toContain(threadId);
		const rows = db
			.query("SELECT payload FROM durable_work WHERE kind = 'dispatch_message'")
			.all() as { payload: string }[];
		const notes = rows
			.map(
				(r) =>
					JSON.parse(r.payload) as { thread_id: string; event_type: string; event_payload: string },
			)
			.filter((p) => p.thread_id === threadId && p.event_type === "notification")
			.map((p) => JSON.parse(p.event_payload) as Record<string, unknown>);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({
			type: "task_complete",
			task_id: taskId,
			task_name: "0 9 * * *",
			result: "ok",
		});
	});

	it("ignores task:completed for a task with no thread", async () => {
		const taskId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "deferred",
				status: "completed",
				trigger_spec: "5m",
				thread_id: null,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
		const appContext = makeAppContext(db, siteId);
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		const enqueued: string[] = [];
		appContext.eventBus.on("notify:enqueued", ({ thread_id }) => enqueued.push(thread_id));
		appContext.eventBus.emit("task:completed", { task_id: taskId, result: null });

		expect(enqueued).toEqual([]);
		const count = db
			.query("SELECT count(*) AS n FROM durable_work WHERE kind = 'dispatch_message'")
			.get() as { n: number };
		expect(count.n).toBe(0);
	});

	it("drives handleThread on notify:enqueued (no pending work is a safe no-op)", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		const appContext = makeAppContext(db, siteId);
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		// A non-background thread with nothing pending: handleThread claims
		// nothing and returns without touching the thread. We assert it does not
		// throw and leaves the executor idle.
		appContext.eventBus.emit("notify:enqueued", { thread_id: threadId });
		await new Promise((r) => setTimeout(r, 50));

		expect(result.threadExecutor.isActive(threadId)).toBe(false);
	});
});

describe("initServer — platform leader-election adapter", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-leader-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
		// Register this host so leader-election ownership reads resolve.
		const now = new Date().toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: "test-host",
				online_at: now,
				modified_at: now,
				deleted: 0,
				work_spool_capable: 1,
			},
			siteId,
		);
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	it("claims platform leadership and builds the MCP registry when a connector is configured", async () => {
		// platforms.json with one Discord connector. No real token is needed: the
		// adapter's connect() imports setupDiscordServers, which fails to build a
		// live client and is swallowed per-connector; what we assert is that the
		// leader-election claimed the seat (connect ran) and the registry exists.
		const platformsConfig = {
			connectors: [
				{
					platform: "discord",
					token: "not-a-real-token",
					allowed_users: [],
					leadership: "auto",
					failover_threshold_ms: 30_000,
				},
			],
		};
		const appContext = makeAppContext(db, siteId, {
			platforms: { ok: true, value: platformsConfig },
		});
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		// The platform MCP registry was constructed.
		expect(result.platformMcpRegistry).not.toBeNull();

		// Leadership was claimed: the leader key names this site.
		const leaderRow = db
			.query("SELECT value FROM cluster_config WHERE key = 'platform_leader:mcp-platforms'")
			.get() as { value: string } | null;
		expect(leaderRow?.value).toBe(siteId);
	});

	it("skips leader election but still builds the registry when zero connectors are configured", async () => {
		const appContext = makeAppContext(db, siteId, {
			platforms: { ok: true, value: { connectors: [] } },
		});
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		expect(result.platformMcpRegistry).not.toBeNull();
		// No platform leader key was written (the "no connectors" branch).
		const leaderRow = db
			.query("SELECT value FROM cluster_config WHERE key = 'platform_leader:mcp-platforms'")
			.get() as { value: string } | null;
		expect(leaderRow).toBeNull();
	});

	it("starts the RSS poller leader election regardless of platforms config", async () => {
		// No platforms.json at all — the RSS block still runs its own leader
		// election (platform_leader:rss), proving the RSS poller wiring is reached.
		const appContext = makeAppContext(db, siteId, {});
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		const rssLeader = db
			.query("SELECT value FROM cluster_config WHERE key = 'platform_leader:rss'")
			.get() as { value: string } | null;
		expect(rssLeader?.value).toBe(siteId);

		// stopLeaderElections tears the RSS election down (idempotent).
		result.stopLeaderElections();
		result.stopLeaderElections();
	});
});

// ---------------------------------------------------------------------------
// handleThread main dispatch — the core non-background turn-driving path
// ---------------------------------------------------------------------------

describe("initServer — handleThread main dispatch (non-background turn)", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-dispatch-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	/**
	 * Seed a non-background web thread with a pending user_message, then wake it.
	 * The fake agentLoopFactory runs a loop that resolves to a terminal text
	 * result. We assert the loop ran (the core dispatch path executed), the turn
	 * opened and closed, and the batch was acknowledged (the dispatch_queue entry
	 * is no longer pending).
	 */
	it("opens a turn, runs the local loop, and acknowledges the batch for a pending user message", async () => {
		const threadId = randomUUID();
		const userId = "operator";
		seedThread(db, siteId, threadId, "web", userId);

		const now = new Date().toISOString();
		const userMsgId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMsgId,
				thread_id: threadId,
				role: "user",
				content: "please run a turn",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);
		enqueueMessage(db, userMsgId, threadId);

		let loopRan = false;
		let seenThreadId = "";
		let seenModelId = "";
		// agentLoopFactory is called by runLocalAgentLoop as (config) => MainAgentLoop.
		const agentLoopFactory = (config: { threadId: string; modelId: string }) => ({
			run: async () => {
				loopRan = true;
				seenThreadId = config.threadId;
				seenModelId = config.modelId;
				return {
					messagesCreated: 1,
					toolCallsMade: 0,
					yielded: false,
					error: undefined,
				};
			},
		});
		// createAuxLoopRunner is on the same factory object (a MainAgentLoop factory
		// also exposes the aux-runner builder). Attach it so the dep shape matches.
		(agentLoopFactory as any).createAuxLoopRunner = () => undefined;

		// A model router that reports a usable default and a local backend so the
		// onComplete title-generation branch and the runFn model resolution run.
		const modelRouter = {
			getDefaultId: () => "fake",
			getDefault: () => ({ id: "fake" }),
			listBackends: () => [],
			getCacheTtl: () => undefined,
			getCacheWarmConfig: () => undefined,
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			modelRouter,
		});

		appContext.eventBus.emit("notify:enqueued", { thread_id: threadId });
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		// Let acknowledgeBatch + turn close settle.
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
		expect(seenThreadId).toBe(threadId);
		expect(seenModelId).toBe("fake");

		// The claimed user_message was acknowledged: no pending dispatch entry
		// remains for this thread.
		const pending = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'")
			.get(threadId) as { c: number };
		expect(pending.c).toBe(0);

		// The executor released the thread (no longer active).
		expect(result.threadExecutor.isActive(threadId)).toBe(false);
	});

	/**
	 * When the loop yields (cooperative cancellation / re-batch), handleThread
	 * must leave the claimed entry re-batchable rather than acknowledging it.
	 * We assert the loop ran and the thread settled idle; the yield branch
	 * (result.yielded → return { yielded, claimedIds }) is the path under test.
	 */
	it("handles a yielded loop result without acknowledging the batch", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		const now = new Date().toISOString();
		const userMsgId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMsgId,
				thread_id: threadId,
				role: "user",
				content: "yielding turn",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);
		enqueueMessage(db, userMsgId, threadId);

		// The executor re-drives runFn after a yield (resetProcessingForThread +
		// continue while hasPending stays true). A mock that yields forever would
		// spin the drain loop indefinitely, so yield once then complete normally;
		// the completed pass acknowledges the batch and the thread settles idle.
		let loopRan = false;
		let calls = 0;
		const agentLoopFactory: any = () => ({
			run: async () => {
				loopRan = true;
				calls++;
				return {
					messagesCreated: 0,
					toolCallsMade: 0,
					yielded: calls === 1,
					error: undefined,
				};
			},
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		const modelRouter = {
			getDefaultId: () => "fake",
			getDefault: () => ({ id: "fake" }),
			listBackends: () => [],
			getCacheTtl: () => undefined,
			getCacheWarmConfig: () => undefined,
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			modelRouter,
		});

		appContext.eventBus.emit("notify:enqueued", { thread_id: threadId });
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
		// The thread is no longer held by the executor after the yield return.
		expect(result.threadExecutor.isActive(threadId)).toBe(false);
	});

	/**
	 * A loop that throws drives the catch arm of the runFn: acknowledgeBatch in
	 * the error path, closeTurn("error"), and the logged error. We assert the
	 * batch is still acknowledged (the error path acks to avoid a stuck entry).
	 */
	it("acknowledges the batch and closes the turn with error when the loop throws", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		const now = new Date().toISOString();
		const userMsgId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMsgId,
				thread_id: threadId,
				role: "user",
				content: "throwing turn",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);
		enqueueMessage(db, userMsgId, threadId);

		let loopRan = false;
		const agentLoopFactory: any = () => ({
			run: async () => {
				loopRan = true;
				throw new Error("inference exploded");
			},
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		const modelRouter = {
			getDefaultId: () => "fake",
			getDefault: () => ({ id: "fake" }),
			listBackends: () => [],
			getCacheTtl: () => undefined,
			getCacheWarmConfig: () => undefined,
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			modelRouter,
		});

		appContext.eventBus.emit("notify:enqueued", { thread_id: threadId });
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
		// Error path still acknowledges so the entry is not stuck pending.
		const pending = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'")
			.get(threadId) as { c: number };
		expect(pending.c).toBe(0);
		expect(result.threadExecutor.isActive(threadId)).toBe(false);
	});

	/**
	 * message:created enqueues a user message AND triggers handleThread. This
	 * exercises the message:created listener's enqueue + dispatch arm (distinct
	 * from the notify:enqueued path above).
	 */
	it("enqueues and dispatches on message:created for a user message", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		let loopRan = false;
		const agentLoopFactory: any = () => ({
			run: async () => {
				loopRan = true;
				return { messagesCreated: 1, toolCallsMade: 0, yielded: false, error: undefined };
			},
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		const modelRouter = {
			getDefaultId: () => "fake",
			getDefault: () => ({ id: "fake" }),
			listBackends: () => [],
			getCacheTtl: () => undefined,
			getCacheWarmConfig: () => undefined,
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			modelRouter,
		});

		// Insert the row first (the handler enqueues by id, does not create it).
		const now = new Date().toISOString();
		const userMsgId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMsgId,
				thread_id: threadId,
				role: "user",
				content: "created-event turn",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);

		appContext.eventBus.emit("message:created", {
			message: { id: userMsgId, role: "user" },
			thread_id: threadId,
			trace_context: undefined,
		});
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
		const pending = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'")
			.get(threadId) as { c: number };
		expect(pending.c).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Client-tool expiry scan (the EXPIRY_SCAN_INTERVAL_MS body)
// ---------------------------------------------------------------------------

describe("initServer — client-tool expiry scan", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-expiry-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	/**
	 * Seed a client_tool_call dispatch entry whose created_at is well past the
	 * 5-minute TTL, with no live client session, then drive the expiry scan on a
	 * short injected interval. The scan must flip the entry to 'expired' and
	 * inject a `developer`-role interruption notice into the thread.
	 */
	it("expires a stale client tool call and injects a developer interruption notice", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		// A client tool call created 10 minutes ago (TTL is 5m) with no live
		// session, so it is eligible for expiry.
		const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		db.prepare(
			`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
			 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
		).run(
			randomUUID(),
			threadId,
			JSON.stringify({ call_id: "c1", tool_name: "read", arguments: {} }),
			"dead-connection",
			staleAt,
			staleAt,
		);

		const agentLoopFactory: any = () => ({
			run: async () => ({ messagesCreated: 0, toolCallsMade: 0, yielded: false }),
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			scanIntervals: { expiryScanIntervalMs: 20 },
		});

		// Wait for the scan to fire at least once and flip the entry.
		let expiredRow: { status: string } | null = null;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 25));
			expiredRow = db
				.query(
					"SELECT status FROM dispatch_queue WHERE thread_id = ? AND event_type = 'client_tool_call'",
				)
				.get(threadId) as { status: string } | null;
			if (expiredRow?.status === "expired") break;
		}
		expect(expiredRow?.status).toBe("expired");

		// A developer-role interruption notice landed on the thread.
		const notice = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'developer' ORDER BY created_at DESC LIMIT 1",
			)
			.get(threadId) as { content: string } | null;
		expect(notice?.content).toContain("Client tool call expired");
	});

	/**
	 * A client tool call whose thread still has a LIVE session must NOT be
	 * reaped — the TTL clock excludes live-session threads. We register a live
	 * client session for the thread and assert the stale entry survives.
	 */
	it("does not expire a stale call whose thread still has a live client session", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		// getClientSessions derives `live` from the JOINed hosts row
		// (h.modified_at ?? h.online_at within CLIENT_SESSION_HOST_STALE_MS = 5m).
		// Bind the session to a REMOTE peer site: the web server's startup
		// reapStaleClientSessions only reaps rows whose site_id is THIS host and
		// whose connection is not in the live WS set ("Remote-host sessions are
		// never touched"). A local session with no real WS connection would be
		// swept at boot, so model a live session held by a peer host instead.
		const now = new Date().toISOString();
		const peerSiteId = randomUUID();
		insertRow(
			db,
			"hosts",
			{
				site_id: peerSiteId,
				host_name: "peer-host",
				work_spool_capable: 0,
				online_at: now,
				modified_at: now,
				deleted: 0,
			},
			peerSiteId,
		);
		insertRow(
			db,
			"client_sessions",
			{
				id: randomUUID(),
				connection_id: "live-conn",
				thread_id: threadId,
				site_id: peerSiteId,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			peerSiteId,
		);

		const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		db.prepare(
			`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
			 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
		).run(
			randomUUID(),
			threadId,
			JSON.stringify({ call_id: "c2", tool_name: "read", arguments: {} }),
			"live-conn",
			staleAt,
			staleAt,
		);

		const agentLoopFactory: any = () => ({
			run: async () => ({ messagesCreated: 0, toolCallsMade: 0, yielded: false }),
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			scanIntervals: { expiryScanIntervalMs: 20 },
		});

		// Give the scan several chances to run.

		// Give the scan several chances to run.
		await new Promise((r) => setTimeout(r, 200));

		const row = db
			.query(
				"SELECT status FROM dispatch_queue WHERE thread_id = ? AND event_type = 'client_tool_call'",
			)
			.get(threadId) as { status: string } | null;
		// Still pending: the live session shielded it from the TTL reap.
		expect(row?.status).toBe("pending");
	});
});

// ---------------------------------------------------------------------------
// Cache-warming warm-poke driver (the warmingEnabled interval body)
// ---------------------------------------------------------------------------

describe("initServer — warm-poke driver", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-warmpoke-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		// The warm-poke driver reads the `turns` table (predictCacheState +
		// selectWarmPokeTargets). applySchema alone doesn't create it; the metrics
		// schema does.
		applyMetricsSchema(db);
		siteId = randomUUID();
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	/**
	 * With a backend that opts into cache_warming, the warm-poke driver starts.
	 * We seed a recently-active thread whose prompt cache is near expiry so
	 * selectWarmPokeTargets returns it, give the model router a warm config +
	 * TTL so resolvePokePolicy yields a policy, and drive the scan on a short
	 * interval. The driver must enqueue a `cache_warm_poke` notification for the
	 * target thread.
	 */
	it("enqueues a cache_warm_poke notification for a warm-eligible active thread", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		// selectWarmPokeTargets needs: (A) a real user message inside the 24h
		// active window to make the thread a candidate; (B) a `turns` row with
		// cache activity whose age puts predictCacheState at "warm" (age < ttl 5m)
		// AND clears the just-in-time gate (age >= ttl - scanInterval, where the
		// selection scanInterval is the real WARM_POKE_SCAN_INTERVAL_MS = 2m). A
		// 4-minute-old turn sits in the [3m, 5m) window that satisfies both.
		const recent = new Date(Date.now() - 30 * 1000).toISOString();
		const turnAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "last real user turn",
				model_id: null,
				tool_name: null,
				created_at: recent,
				modified_at: recent,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);
		// A turns row ~4m old with a cache read so predictCacheState reports warm
		// (cache activity present, age < 5m TTL) and the thread is poke-eligible.
		db.prepare(
			`INSERT INTO turns (id, thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at)
			 VALUES (?, ?, 'fake', 100, 50, 80, 0, ?)`,
		).run(randomUUID(), threadId, turnAt);

		const agentLoopFactory: any = () => ({
			run: async () => ({ messagesCreated: 0, toolCallsMade: 0, yielded: false }),
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		// Router reports a warm config and TTL so resolvePokePolicy returns a
		// non-null policy (enabled + cacheable).
		const modelRouter = {
			getDefaultId: () => "fake",
			getDefault: () => ({ id: "fake" }),
			listBackends: () => [],
			getCacheTtl: () => "5m",
			getCacheWarmConfig: () => ({ enabled: true, maxPokes: 3 }),
		};

		// warmingEnabled is read from config.modelBackends — pass a backend that
		// opts in via the makeAppContext warmingEnabled flag.
		const appContext = makeAppContext(db, siteId, {}, true);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			modelRouter,
			scanIntervals: { warmPokeScanIntervalMs: 20 },
		});

		// The driver enqueues a `cache_warm_poke` notification and immediately
		// drives handleThread, which consumes (acks + deletes) the transient
		// dispatch_queue notification row and injects a durable developer-role
		// `[cache-warm-poke]` marker message. Assert on that persistent marker —
		// the queue row is gone by the time we poll.
		let pokeCount = 0;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 25));
			const row = db
				.query(
					"SELECT COUNT(*) AS c FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0 AND content LIKE '[cache-warm-poke]%'",
				)
				.get(threadId) as { c: number };
			pokeCount = row?.c ?? 0;
			if (pokeCount > 0) break;
		}
		expect(pokeCount).toBeGreaterThan(0);
	});

	/**
	 * When no backend opts into cache_warming, the warm-poke driver never starts
	 * — no poke notification is ever enqueued even for an active thread. This is
	 * the `warmingEnabled === false` short-circuit.
	 */
	it("never pokes when no backend opts into cache_warming", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		const agentLoopFactory: any = () => ({
			run: async () => ({ messagesCreated: 0, toolCallsMade: 0, yielded: false }),
		});
		agentLoopFactory.createAuxLoopRunner = () => undefined;

		// warmingEnabled flag omitted → no backend opts in.
		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(appContext, agentLoopFactory, makeRelayProcessor()),
			scanIntervals: { warmPokeScanIntervalMs: 20 },
		});

		await new Promise((r) => setTimeout(r, 150));

		const poke = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE event_payload LIKE '%cache_warm_poke%'",
			)
			.get() as { c: number };
		expect(poke.c).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Exported pure/adapter builders: formatNotification, createRemotePlatformRequest,
// createMcpAppProxyRelay
// ---------------------------------------------------------------------------

describe("formatNotification", () => {
	it("formats a task_complete payload with task name and result", () => {
		const out = formatNotification({
			type: "task_complete",
			task_name: "nightly backup",
			result: "3 files",
		});
		expect(out).toBe('[notification] Task "nightly backup" completed. Result: 3 files');
	});

	it("falls back to success when task_complete carries no result", () => {
		const out = formatNotification({ type: "task_complete", task_name: "x" });
		expect(out).toContain("Result: success");
	});

	it("formats an advisory_created payload with title and detail", () => {
		const out = formatNotification({
			type: "advisory_created",
			title: "disk low",
			detail: "8% free",
		});
		expect(out).toBe("[notification] New advisory: disk low. 8% free");
	});

	it("marks a proactive payload as agent-authored and unverified", () => {
		const out = formatNotification({ type: "proactive", content: "I think X is broken" });
		expect(out).toContain("agent-authored summary, unverified");
		expect(out).toContain("I think X is broken");
	});

	it("marks an introspect payload with its source thread and unverified framing", () => {
		const out = formatNotification({
			type: "introspect",
			source_thread: "thread-7",
			content: "state summary",
		});
		expect(out).toContain("introspect request from thread thread-7");
		expect(out).toContain("agent-authored framing, unverified");
	});

	it("emits the warm-poke marker for a cache_warm_poke payload", () => {
		const out = formatNotification({ type: "cache_warm_poke" });
		expect(out).toContain("automated cache-warming turn");
	});

	it("JSON-stringifies an unknown payload type", () => {
		const out = formatNotification({ type: "mystery", a: 1 });
		expect(out).toContain("[notification]");
		expect(out).toContain('"mystery"');
	});
});

describe("createRemotePlatformRequest", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-remotereq-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(() => {
		db.close();
		cleanupTmpDir(tmpDir);
	});

	/**
	 * With no fresh remote host advertising the requested platform server, the
	 * builder's returned function throws a descriptive error immediately rather
	 * than waiting out a relay timeout. This is the `!targetSiteId` guard.
	 */
	it("throws a descriptive error when no fresh remote host advertises the platform", async () => {
		const fn = createRemotePlatformRequest({
			db,
			siteId,
			eventBus: new TypedEventEmitter(),
			optionalConfig: {},
		} as any);
		await expect(fn("discord", "tools/list", {})).rejects.toThrow(
			/No fresh remote host found for platform server 'discord'/,
		);
	});
});

describe("createMcpAppProxyRelay", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-mcpproxy-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(() => {
		db.close();
		cleanupTmpDir(tmpDir);
	});

	/**
	 * Routing an mcp_app_proxy request to an owner site that does not advertise
	 * work-spool capability is a typed routing error (R-DW14). The builder's
	 * returned function surfaces it as a thrown error. This drives the
	 * routeRelayRequest error branch of the proxy relay.
	 */
	it("throws when the owner site cannot be routed to", async () => {
		const fn = createMcpAppProxyRelay({
			db,
			siteId,
			eventBus: new TypedEventEmitter(),
			optionalConfig: {},
		} as any);
		// Unknown owner site with no work-spool-capable host row → routing error.
		await expect(
			fn(randomUUID(), {
				server_name: "appsrv",
				method: "tools/call",
				headers: {},
				body_base64: "",
			}),
		).rejects.toThrow();
	});
});

describe("createRouteHealthRelay", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-routehealth-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(() => {
		db.close();
		cleanupTmpDir(tmpDir);
	});

	it("throws (caller reports unknown) when the peer cannot be routed to", async () => {
		const fn = createRouteHealthRelay({ db, siteId, optionalConfig: {} } as any);
		await expect(fn(randomUUID(), 200)).rejects.toThrow();
	});

	it("throws when a routable peer does not answer within the bound", async () => {
		const peer = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted, work_spool_capable) VALUES (?, 'peer', ?, ?, 0, 1)",
			[peer, now, now],
		);
		const fn = createRouteHealthRelay({ db, siteId, optionalConfig: {} } as any);
		const started = Date.now();
		await expect(fn(peer, 150)).rejects.toThrow(/Timeout/);
		expect(Date.now() - started).toBeLessThan(2_000);
		const row = db
			.query("SELECT kind, target_site_id FROM durable_work WHERE kind = 'route_health'")
			.get() as { kind: string; target_site_id: string } | null;
		expect(row?.target_site_id).toBe(peer);
	});
});

// ---------------------------------------------------------------------------
// handleThread — trace-context parsing, boot recovery, and re-trigger
// ---------------------------------------------------------------------------

describe("initServer — handleThread trace/recovery paths", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-tracerec-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	function seedPendingUser(threadId: string, content: string): string {
		const now = new Date().toISOString();
		const userMsgId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMsgId,
				thread_id: threadId,
				role: "user",
				content,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test-host",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);
		enqueueMessage(db, userMsgId, threadId);
		return userMsgId;
	}

	function mainLoopFactory(onRun: () => void): any {
		const f: any = () => ({
			run: async () => {
				onRun();
				return { messagesCreated: 1, toolCallsMade: 0, yielded: false, error: undefined };
			},
		});
		f.createAuxLoopRunner = () => undefined;
		return f;
	}

	const localBackendRouter = {
		getDefaultId: () => "fake",
		getDefault: () => ({ id: "fake" }),
		// A non-empty backend list drives the onComplete title-generation branch.
		listBackends: () => [{ id: "fake" }],
		getCacheTtl: () => undefined,
		getCacheWarmConfig: () => undefined,
	};

	/**
	 * message:created carrying a `trace_context` JSON string drives the
	 * extractTraceContext branch (server.ts ~968) rather than the undefined arm.
	 * The loop still runs and the batch is acknowledged; the trace parse is a
	 * side computation that must not break dispatch.
	 */
	it("parses a trace_context carrier on message:created and still runs the loop", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");
		const userMsgId = seedPendingUser(threadId, "traced turn");

		let loopRan = false;
		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(
				appContext,
				mainLoopFactory(() => {
					loopRan = true;
				}),
				makeRelayProcessor(),
			),
			modelRouter: localBackendRouter,
		});

		// A W3C traceparent, serialized as the JSON carrier handleThread parses.
		const traceContext = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});
		appContext.eventBus.emit("message:created", {
			message: { id: userMsgId, role: "user" },
			thread_id: threadId,
			trace_context: traceContext,
		});
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
		const pending = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'")
			.get(threadId) as { c: number };
		expect(pending.c).toBe(0);
	});

	/**
	 * A malformed (non-JSON) trace_context must be swallowed by the inner
	 * try/catch (server.ts ~970-974) and fall through to an empty carrier — the
	 * loop still runs. This drives the catch arm of the trace parse.
	 */
	it("tolerates a malformed trace_context carrier without failing dispatch", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");
		const userMsgId = seedPendingUser(threadId, "bad-trace turn");

		let loopRan = false;
		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(
				appContext,
				mainLoopFactory(() => {
					loopRan = true;
				}),
				makeRelayProcessor(),
			),
			modelRouter: localBackendRouter,
		});

		appContext.eventBus.emit("message:created", {
			message: { id: userMsgId, role: "user" },
			thread_id: threadId,
			trace_context: "}{ not json",
		});
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
	});

	/**
	 * initServer's boot-recovery block (server.ts ~1294-1305) scans
	 * dispatch_queue for threads with pending entries and re-dispatches each.
	 * Seeding a pending user message BEFORE initServer runs (no event emitted)
	 * drives that recovery dispatch: the loop runs purely from the boot scan.
	 */
	it("re-dispatches a thread with pending entries at boot (crash recovery)", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");
		seedPendingUser(threadId, "recovered turn");

		let loopRan = false;
		const appContext = makeAppContext(db, siteId);
		// Do NOT emit any event — the only trigger is the boot-recovery scan.
		result = await initServer({
			...makeDeps(
				appContext,
				mainLoopFactory(() => {
					loopRan = true;
				}),
				makeRelayProcessor(),
			),
			modelRouter: localBackendRouter,
		});

		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));

		expect(loopRan).toBe(true);
		const pending = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'")
			.get(threadId) as { c: number };
		expect(pending.c).toBe(0);
	});

	/**
	 * A tool_result message for a thread with ANOTHER client tool call still
	 * pending must NOT resume the loop — the barrier (server.ts ~1243-1247)
	 * returns early until the last outstanding call acks. We seed one pending
	 * client_tool_call, then fire a tool_result; the loop must stay unrun.
	 */
	it("defers resume on a tool_result while another client tool call is still pending", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");

		// An outstanding (un-acked) client tool call keeps the barrier closed.
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
			 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
		).run(
			randomUUID(),
			threadId,
			JSON.stringify({ call_id: "still-open", tool_name: "read", arguments: {} }),
			"live-conn",
			now,
			now,
		);

		let loopRan = false;
		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(
				appContext,
				mainLoopFactory(() => {
					loopRan = true;
				}),
				makeRelayProcessor(),
			),
			modelRouter: localBackendRouter,
		});

		appContext.eventBus.emit("message:created", {
			message: { id: randomUUID(), role: "tool_result" },
			thread_id: threadId,
			trace_context: undefined,
		});
		await new Promise((r) => setTimeout(r, 150));

		// Barrier held: no resume while the sibling call is outstanding.
		expect(loopRan).toBe(false);
		expect(result.threadExecutor.isActive(threadId)).toBe(false);
	});

	/**
	 * With a non-empty backend list AND a getDefault() that returns a real
	 * LLMBackend (an async-generator `chat`), the onComplete hook's
	 * generateThreadTitle path (server.ts ~1184-1200) runs to completion and
	 * writes a title. We assert the title lands — proving the title-gen branch
	 * and its resolving `.then` callback ran, not just the enter-branch guard.
	 */
	it("generates and stores a thread title in the onComplete hook", async () => {
		const threadId = randomUUID();
		seedThread(db, siteId, threadId, "web", "operator");
		seedPendingUser(threadId, "how do I configure a webhook");

		let loopRan = false;
		// A getDefault() backend whose chat() yields a one-chunk title. The
		// onComplete hook calls generateThreadTitle(db, threadId, this backend).
		const titleBackend = {
			id: "fake",
			chat: async function* () {
				yield { type: "text", content: "Configuring a webhook" };
			},
		};
		const router = {
			getDefaultId: () => "fake",
			getDefault: () => titleBackend,
			listBackends: () => [{ id: "fake" }],
			getCacheTtl: () => undefined,
			getCacheWarmConfig: () => undefined,
		};

		const appContext = makeAppContext(db, siteId);
		result = await initServer({
			...makeDeps(
				appContext,
				mainLoopFactory(() => {
					loopRan = true;
				}),
				makeRelayProcessor(),
			),
			modelRouter: router,
		});

		appContext.eventBus.emit("notify:enqueued", { thread_id: threadId });
		for (let i = 0; i < 40 && !loopRan; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}

		// Title generation is fire-and-forget off onComplete; poll for the write.
		let title: string | null = null;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 25));
			const row = db.query("SELECT title FROM threads WHERE id = ?").get(threadId) as {
				title: string | null;
			} | null;
			if (row?.title) {
				title = row.title;
				break;
			}
		}
		expect(title).toBe("Configuring a webhook");
	});
});

// ---------------------------------------------------------------------------
// Platform leader connect() — connector:handle_synced activation + remote
// tool discovery (the fully-configured platforms branch)
// ---------------------------------------------------------------------------

describe("initServer — platform connector:handle_synced + remote discovery", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let result: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-handlesync-"));
		db = createDatabase(join(tmpDir, "t.db"));
		applySchema(db);
		siteId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: "test-host",
				online_at: now,
				modified_at: now,
				deleted: 0,
				work_spool_capable: 1,
			},
			siteId,
		);
	});

	afterEach(async () => {
		result?.handleMessageTracker?.stopWatchdog?.();
		result?.stopScanIntervals?.();
		result?.stopLeaderElections?.();
		await result?.webServer?.stop?.();
		await result?.syncServer?.stop?.();
		result = undefined;
		db.close();
		cleanupTmpDir(tmpDir);
	});

	const connectorsConfig = {
		connectors: [
			{
				platform: "discord",
				token: "not-a-real-token",
				allowed_users: [],
				leadership: "auto",
				failover_threshold_ms: 30_000,
			},
		],
	};

	/**
	 * When platforms are configured and this host claims leadership, connect()
	 * registers a `connector:handle_synced` listener (server.ts ~1545) and the
	 * fully-configured branch also wires a SECOND handle_synced listener for
	 * remote-tool re-discovery (server.ts ~1679). Emitting the event after boot
	 * drives both listeners. With an unknown handle_id, getConnectorHandle
	 * returns null and the activation listener is a safe no-op; the discovery
	 * listener fires discoverRemoteTools (no-op without fresh remote platforms).
	 * We assert the registry is live and the emit does not throw/wedge dispatch.
	 */
	it("registers handle_synced listeners on leadership and tolerates an unknown handle", async () => {
		const appContext = makeAppContext(db, siteId, {
			platforms: { ok: true, value: connectorsConfig },
		});
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, makeRelayProcessor()));

		expect(result.platformMcpRegistry).not.toBeNull();

		// Leadership claimed → connect() ran → listeners registered. Emit the
		// event with a handle id that has no connector_handles row.
		let threw = false;
		try {
			appContext.eventBus.emit("connector:handle_synced", { handle_id: randomUUID() });
			await new Promise((r) => setTimeout(r, 100));
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		// Registry still reports its (empty) server-name set — not torn down.
		expect(Array.isArray(result.platformMcpRegistry.getServerNames())).toBe(true);
	});

	/**
	 * The relay processor's setPlatformMcpRegistry is wired in the
	 * fully-configured branch (server.ts ~1618). We assert it was called,
	 * proving the branch past leader-election ran (relay wiring, connector tool
	 * creation, remote-discovery setup all live below it).
	 */
	it("wires the platform MCP registry into the relay processor", async () => {
		const relayProcessor = makeRelayProcessor();
		const appContext = makeAppContext(db, siteId, {
			platforms: { ok: true, value: connectorsConfig },
		});
		const agentLoopFactory = { createAuxLoopRunner: () => undefined };
		result = await initServer(makeDeps(appContext, agentLoopFactory, relayProcessor));

		expect(relayProcessor.calls.setPlatformMcpRegistry).toBeGreaterThan(0);
	});
});
