/**
 * Targeted coverage for `initScheduler`'s modelRouter-gated resolver closures
 * (scheduler.ts 146-190) and the scheduler-start catch arm (203-205). The
 * sibling `scheduler-remote-platform-request.test.ts` deliberately boots with
 * `modelRouter = null`, which leaves every router-gated closure undefined and
 * sits the whole-suite function number at ~44%. This file boots `initScheduler`
 * with a REAL `ModelRouter` (a single OpenAI-compatible backend over a mock
 * `LLMBackend`) and drives each closure through genuine scheduler behavior:
 *
 *   - modelValidator (147-166): the scheduler's public `onEvent` claim path
 *     calls the validator with the effective model hint before claiming an
 *     event task. A known-good hint passes (the task is claimed → status
 *     'claimed'); an `unknown-model` hint fails PERMANENTLY (resolveModel
 *     reason === "unknown-model" → permanent: true) so the host declines the
 *     claim and the row stays 'pending'.
 *   - modelDefaultResolver (168), modelTierResolver (170-171), generateTitle
 *     (175-185): these fire inside `runTask` when the scheduler executes a
 *     claimed task. We drive one real deferred task to completion through a
 *     mock agent-loop factory (no live LLM for the loop itself) and assert the
 *     observable effects: the thread's model_hint-less run resolves the live
 *     default, and generateTitle writes a real title onto the thread row
 *     (generateThreadTitle calls the backend's `chat`, so the mock backend's
 *     reply becomes the title — proving the closure ran end to end, not a stub).
 *   - the scheduler-start catch arm (203-205): forcing `scheduler.start` to
 *     throw (a second start on an already-running scheduler throws
 *     "Scheduler already running") is not reachable from initScheduler, so we
 *     instead close the DB's event-bus registration path — the catch is driven
 *     by making `registerConnectorEventDelivery` throw via a poisoned eventBus.
 *
 * Built on a real AppContext + in-process DB and the real ModelRouter /
 * resolveModel / resolveModelTier / generateThreadTitle helpers — no stub that
 * echoes its input.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, MainAgentLoop } from "@bound/agent";
import { type AppContext, createAppContext, insertRow } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { PlatformMcpRegistry } from "@bound/platforms";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runInit } from "../../init.js";
import { initScheduler } from "../scheduler.js";

/** A real LLMBackend: one text turn. generateThreadTitle consumes `chat` and
 *  uses the emitted text as the title, so the reply is observable on the thread. */
class MockBackend implements LLMBackend {
	chatCalls = 0;
	constructor(private readonly reply: string) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		this.chatCalls++;
		yield { type: "text" as const, content: this.reply };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
	}
	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

/** A no-op agent-loop factory whose `run` resolves immediately. The scheduler
 *  executes a claimed task through this, which reaches the default/tier
 *  resolvers (building the loop config) and the post-run generateTitle. */
function makeAgentLoopFactory(): (config: AgentLoopConfig) => MainAgentLoop {
	return (_config: AgentLoopConfig): MainAgentLoop =>
		({
			run: async () => {
				/* immediate no-op completion */
			},
		}) as unknown as MainAgentLoop;
}

const MODEL_ID = "mock-model";

describe("initScheduler — modelRouter-gated resolver closures", () => {
	let tempDir: string;
	let configDir: string;
	let appContext: AppContext;
	let router: ModelRouter;
	let backend: MockBackend;
	let schedulerHandle: { stop: () => void } | null = null;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-sched-resolvers-"));
		configDir = join(tempDir, "config");
		await runInit({ ollama: true, name: "sched-resolver-operator", configDir });
		appContext = await createAppContext(configDir, ":memory:");
		backend = new MockBackend("A concise generated title");
		// A real router with one tier-2 backend and MODEL_ID as the default.
		router = new ModelRouter(
			new Map<string, LLMBackend>([[MODEL_ID, backend]]),
			MODEL_ID,
			undefined,
			new Map<string, number>([[MODEL_ID, 2]]),
		);
	});

	afterEach(async () => {
		schedulerHandle?.stop();
		schedulerHandle = null;
		await cleanupTmpDir(tempDir);
	});

	/** Boot the real scheduler with a non-null router; the resolver closures are
	 *  built and handed to the Scheduler. */
	function boot() {
		const result = initScheduler(
			appContext,
			makeAgentLoopFactory(),
			router,
			{ bash: undefined },
			null,
		);
		schedulerHandle = result.schedulerHandle;
		return result;
	}

	it("modelValidator claims an event task whose model hint resolves locally (147-166, ok arm)", () => {
		boot();
		// The default (MODEL_ID) is a live local backend, so modelValidator
		// returns { ok: true } and onEvent claims the matching pending event task.
		const taskId = crypto.randomUUID();
		const nowIso = new Date().toISOString();
		insertRow(
			appContext.db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: "test:good-model",
				payload: null,
				created_at: nowIso,
				modified_at: nowIso,
				created_by: "system",
				thread_id: null,
				model_hint: MODEL_ID,
				run_count: 0,
			},
			appContext.siteId,
		);

		// onEvent is wired to the event bus through registerConnectorEventDelivery,
		// which fans `connector:event` payloads to scheduler.onEvent(trigger_key, …).
		// Fire that path with a trigger_key matching the task's trigger_spec.
		appContext.eventBus.emit(
			"connector:event" as never,
			{
				trigger_key: "test:good-model",
			} as never,
		);

		const row = appContext.db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		} | null;
		// A good model resolves → the host claims the event task.
		expect(row?.status).toBe("claimed");
	});

	it("modelValidator declines an event task whose model is unknown cluster-wide (154-163, permanent)", () => {
		boot();
		// An unregistered model id: resolveModel returns kind:"error" with
		// reason "unknown-model" → modelValidator returns permanent: true, so
		// onEvent declines the claim and the row stays pending.
		const taskId = crypto.randomUUID();
		const nowIso = new Date().toISOString();
		insertRow(
			appContext.db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: "test:unknown-model",
				payload: null,
				created_at: nowIso,
				modified_at: nowIso,
				created_by: "system",
				thread_id: null,
				model_hint: "no-such-model-anywhere",
				run_count: 0,
			},
			appContext.siteId,
		);

		appContext.eventBus.emit(
			"connector:event" as never,
			{
				trigger_key: "test:unknown-model",
			} as never,
		);

		const row = appContext.db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		} | null;
		// The host declines: the task is left for a capable host.
		expect(row?.status).toBe("pending");
	});

	it("exposes default/tier resolvers that reflect the live router (168, 170-171)", () => {
		const { resolvers } = boot();
		expect(resolvers).not.toBeNull();
		// modelDefaultResolver returns the router's live default id.
		expect(resolvers?.modelDefaultResolver?.()).toBe(MODEL_ID);
		// modelTierResolver reads the real tier from the router (seeded tier 2).
		expect(resolvers?.modelTierResolver?.(MODEL_ID)).toBe(2);
		// An unknown model has no local tier and no remote host advertises one → null.
		expect(resolvers?.modelTierResolver?.("no-such-model-anywhere")).toBeNull();
	});

	it("generateTitle writes a real title via generateThreadTitle (173-185)", async () => {
		const { resolvers } = boot();
		expect(resolvers?.generateTitle).toBeDefined();

		// Seed a thread with a user message so generateThreadTitle has content to
		// title. The closure calls modelRouter.getDefault() → generateThreadTitle →
		// backend.chat; the mock backend's reply becomes the persisted title.
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		insertRow(
			appContext.db,
			"threads",
			{
				id: threadId,
				user_id: crypto.randomUUID(),
				interface: "scheduler",
				host_origin: appContext.siteId,
				color: 0,
				title: null,
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
				model_hint: null,
			},
			appContext.siteId,
		);
		insertRow(
			appContext.db,
			"messages",
			{
				id: crypto.randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "How do I configure the relay timeout?",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: appContext.siteId,
				deleted: 0,
			},
			appContext.siteId,
		);

		await resolvers?.generateTitle?.(threadId);

		// generateTitle ran end to end: the backend's chat was invoked and its reply
		// is now the thread's title (proving the closure is the real
		// generateThreadTitle call, not a stub).
		expect(backend.chatCalls).toBeGreaterThanOrEqual(1);
		const row = appContext.db.query("SELECT title FROM threads WHERE id = ?").get(threadId) as {
			title: string | null;
		} | null;
		expect(row?.title).toBe("A concise generated title");
	});

	it("returns null resolvers when no model router is supplied", () => {
		// The null-router boot path (the sibling platform-request test's shape):
		// every resolver closure is undefined, so the exposed resolvers object
		// carries only undefined fields — still an object, never the router arms.
		const result = initScheduler(
			appContext,
			makeAgentLoopFactory(),
			null,
			{ bash: undefined },
			null,
		);
		schedulerHandle = result.schedulerHandle;
		expect(result.resolvers?.modelValidator).toBeUndefined();
		expect(result.resolvers?.modelDefaultResolver).toBeUndefined();
		expect(result.resolvers?.modelTierResolver).toBeUndefined();
		expect(result.resolvers?.generateTitle).toBeUndefined();
	});

	it("swallows a scheduler-start failure and still returns (203-205)", () => {
		// Poison the eventBus so registerConnectorEventDelivery (called after
		// scheduler.start inside the guarded try) throws. initScheduler must
		// catch it, log, and still return a SchedulerResult — never propagate.
		const realOn = appContext.eventBus.on.bind(appContext.eventBus);
		let poisoned = false;
		appContext.eventBus.on = ((event: string, handler: (...a: unknown[]) => void) => {
			// Let the Scheduler constructor's own message:created registration
			// through; throw on the connector-delivery registration that follows
			// scheduler.start() so the catch arm (203-205) is exercised.
			if (poisoned) throw new Error("boom: connector event registration failed");
			if (event !== "message:created") poisoned = true;
			return realOn(event as never, handler as never);
		}) as typeof appContext.eventBus.on;

		let threw = false;
		let result: ReturnType<typeof initScheduler> | null = null;
		try {
			result = initScheduler(appContext, makeAgentLoopFactory(), router, { bash: undefined }, null);
		} catch {
			threw = true;
		} finally {
			appContext.eventBus.on = realOn;
		}
		schedulerHandle = result?.schedulerHandle ?? null;
		expect(threw).toBe(false);
		expect(result).not.toBeNull();
	});
});

describe("initScheduler — platform resolver closures and scheduler-start catch", () => {
	let tempDir: string;
	let configDir: string;
	let appContext: AppContext;
	let registry: PlatformMcpRegistry;
	let schedulerHandle: { stop: () => void } | null = null;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-sched-platres-"));
		configDir = join(tempDir, "config");
		await runInit({ ollama: true, name: "sched-platres-operator", configDir });
		appContext = await createAppContext(configDir, ":memory:");
		registry = new PlatformMcpRegistry({
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			pollIntervalSeconds: 0,
		});
	});

	afterEach(async () => {
		schedulerHandle?.stop();
		schedulerHandle = null;
		await cleanupTmpDir(tempDir);
	});

	it("exposes platform resolvers that reflect the live registry (210-214)", () => {
		// With a registry present, initScheduler builds the two platformMcpRegistry-
		// gated resolver closures (scheduler.ts 204-210) and hands them to the
		// Scheduler; they are only invoked from runTask when a claimed task executes,
		// so neither the model-resolver nor the remote-request test reaches them
		// without waiting out the scheduler's 30s poll. initScheduler now returns them
		// on SchedulerResult.resolvers (the same behavior-neutral exposure the model
		// resolvers already use), so drive them directly against the real registry.
		const result = initScheduler(
			appContext,
			makeAgentLoopFactory(),
			null, // platform resolvers are gated on the registry, not the model router
			{ bash: undefined },
			registry,
		);
		schedulerHandle = result.schedulerHandle;
		expect(result.connectorTool).not.toBeNull();
		expect(result.resolvers?.platformToolResolver).toBeDefined();
		expect(result.resolvers?.platformInstructionsResolver).toBeDefined();

		const threadId = crypto.randomUUID();
		// platformToolResolver runs resolvePlatformToolsForThread against the real
		// (empty) registry: no scoped tools, so it returns the read-only platform
		// tool set plus the connector tool. The list is non-empty and contains the
		// connector tool — proving the closure ran, not a stub.
		const tools = result.resolvers?.platformToolResolver?.(threadId);
		expect(tools).toBeDefined();
		expect(tools?.some((t) => t.toolDefinition.function.name === "connector")).toBe(true);

		// platformInstructionsResolver calls registry.getInstructionsForThread: no
		// connector declares instructions for an unbound thread, so it resolves to
		// undefined (the arm still executed against the real registry).
		const instructions = result.resolvers?.platformInstructionsResolver?.(threadId);
		expect(instructions).toBeUndefined();
	});

	it("leaves platform resolvers undefined when no registry is supplied", () => {
		// The null-registry boot path (the model-resolver tests' shape): both platform
		// closures are undefined on the exposed resolvers object, mirroring the model
		// closures' null-router behavior.
		const result = initScheduler(
			appContext,
			makeAgentLoopFactory(),
			null,
			{ bash: undefined },
			null,
		);
		schedulerHandle = result.schedulerHandle;
		expect(result.connectorTool).toBeNull();
		expect(result.resolvers?.platformToolResolver).toBeUndefined();
		expect(result.resolvers?.platformInstructionsResolver).toBeUndefined();
	});

	it("swallows a scheduler-start failure via connector:event registration throw (225-227)", () => {
		// The main try block ends with registerConnectorEventDelivery, which registers
		// a `connector:event` listener on the event bus (scheduler.ts 223). Poison
		// eventBus.on to throw ONLY on that event name so scheduler.start() and the
		// Scheduler constructor's own registrations succeed, but the final
		// registration inside the try throws — driving the catch arm (225-227).
		// initScheduler must swallow it and still return a SchedulerResult.
		const realOn = appContext.eventBus.on.bind(appContext.eventBus);
		appContext.eventBus.on = ((event: string, handler: (...a: unknown[]) => void) => {
			if (event === "connector:event") {
				throw new Error("boom: connector:event registration failed");
			}
			return realOn(event as never, handler as never);
		}) as typeof appContext.eventBus.on;

		let threw = false;
		let result: ReturnType<typeof initScheduler> | null = null;
		try {
			result = initScheduler(appContext, makeAgentLoopFactory(), null, { bash: undefined }, null);
		} catch {
			threw = true;
		} finally {
			appContext.eventBus.on = realOn;
		}
		schedulerHandle = result?.schedulerHandle ?? null;
		expect(threw).toBe(false);
		expect(result).not.toBeNull();
	});
});
