/**
 * A resume whose model is known in the cluster but has no eligible route right
 * now (every route in backoff, half-open with its trial slot taken, or drained)
 * waits abortably for a route, resumes on recovery, and on an exhausted wait
 * posts one non-fatal notice and yields so the dispatcher re-drives the thread.
 * A decommissioned model keeps its pick-another-model alert.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { ThreadExecutor, applyMetricsSchema, applySchema } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { MainAgentLoop } from "../agent-loop";

const SITE = "site-local";
const BACKEND_ID = "copilot-gemini-4-carbon";
const LOGICAL = "gemini-4-carbon";
const ROUTE_ID = `${SITE}:copilot:${BACKEND_ID}` as const;

class CountingBackend implements LLMBackend {
	calls = 0;
	async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
		if (!String(params.system ?? "").includes("running summary of a conversation")) this.calls++;
		yield { type: "text", content: "Done." };
		yield {
			type: "done",
			usage: {
				input_tokens: 10,
				output_tokens: 5,
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

describe("MainAgentLoop — known model with no eligible route", () => {
	let db: Database;
	let threadId: string;
	let backend: CountingBackend;
	let router: ModelRouter;
	let nowMs: number;

	beforeEach(() => {
		nowMs = Date.now();
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, model_hint)
			 VALUES (?, 'u', 'web', ?, ?, ?, ?, 0, ?)`,
			[threadId, SITE, now, now, now, LOGICAL],
		);
		db.run(
			`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
			 VALUES (?, ?, 'user', 'hello', ?, ?, ?, 0)`,
			[randomUUID(), threadId, now, now, SITE],
		);
		backend = new CountingBackend();
		router = new ModelRouter(
			new Map<string, LLMBackend>([[BACKEND_ID, backend]]),
			BACKEND_ID,
			undefined,
			new Map([
				[
					BACKEND_ID,
					{ id: BACKEND_ID, provider: "copilot", model: BACKEND_ID, logicalModel: LOGICAL },
				],
			]),
			undefined,
			() => nowMs,
			new Map([[BACKEND_ID, { routeId: ROUTE_ID, reasoningOrigin: `${SITE}:copilot` }]]),
		);
	});

	afterEach(() => db.close());

	function ctx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: SITE,
		} as unknown as AppContext;
	}

	function makeLoop(opts: {
		waitBudgetMs: number;
		modelId?: string;
		abortSignal?: AbortSignal;
		taskId?: string;
		taskType?: string;
		noTools?: boolean;
	}) {
		const loop = new MainAgentLoop(
			ctx(),
			{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			router,
			{
				threadId,
				userId: "u",
				modelId: opts.modelId ?? LOGICAL,
				abortSignal: opts.abortSignal,
				taskId: opts.taskId,
				taskType: opts.taskType,
				noTools: opts.noTools,
			},
		);
		// The wait budget is min(inference timeout, MAX_MODEL_RECONNECT_WAIT_MS);
		// pin the inference timeout so the test controls the budget.
		(loop as unknown as { _inferenceTimeoutMs: number })._inferenceTimeoutMs = opts.waitBudgetMs;
		return loop;
	}

	function alerts(): string[] {
		return (
			db
				.query(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'alert' ORDER BY created_at ASC",
				)
				.all(threadId) as Array<{ content: string }>
		).map((r) => r.content);
	}

	it("resumes on the route once its backoff clears during the wait", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const release = setTimeout(() => router.recordRouteSuccess(BACKEND_ID), 50);
		try {
			const result = await makeLoop({ waitBudgetMs: 10_000 }).run();
			expect(result.error).toBeUndefined();
			expect(result.outcome).toBe("completed");
			expect(backend.calls).toBe(1);
			expect(alerts()).toEqual([]);
		} finally {
			clearTimeout(release);
		}
	});

	it("resumes once the backoff expires and the route promotes to half-open", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		// Move the route-health clock past next_trial_at mid-wait: the next poll
		// sees half_open and this cold thread claims the trial slot.
		const expire = setTimeout(() => {
			nowMs += 10 * 60_000;
		}, 50);
		try {
			const result = await makeLoop({ waitBudgetMs: 10_000 }).run();
			expect(result.outcome).toBe("completed");
			expect(backend.calls).toBe(1);
			expect(alerts()).toEqual([]);
		} finally {
			clearTimeout(expire);
		}
	});

	it("the thread executor re-drives a yielded round until the route recovers", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const executor = new ThreadExecutor(db, ctx().logger);
		const outcomes: Array<string | undefined> = [];
		await executor.execute(threadId, async () => {
			const result = await makeLoop({ waitBudgetMs: 30 }).run();
			outcomes.push(result.outcome);
			// The outage ends between rounds: backoff expires.
			if (result.yielded) nowMs += 10 * 60_000;
			return result as unknown as { yielded?: boolean; error?: string };
		});
		expect(outcomes).toEqual(["model-unavailable", "completed"]);
		expect(backend.calls).toBe(1);
		expect(alerts()).toHaveLength(1);
	});

	it("an exhausted wait posts one non-fatal notice and yields for a re-drive", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });

		const first = await makeLoop({ waitBudgetMs: 30 }).run();
		expect(first.outcome).toBe("model-unavailable");
		expect(first.yielded).toBe(true);
		expect(backend.calls).toBe(0);

		const posted = alerts();
		expect(posted).toHaveLength(1);
		expect(posted[0]).not.toContain("Unknown model");
		expect(posted[0]).not.toContain("Loop error");
		expect(posted[0]).toContain(`Model "${LOGICAL}" is known in the cluster`);
		expect(posted[0]).toContain(`${ROUTE_ID}: backoff until`);
		expect(posted[0]).toContain("retries automatically");

		// The re-driven round finds the same outage: no second copy of the notice.
		const second = await makeLoop({ waitBudgetMs: 30 }).run();
		expect(second.outcome).toBe("model-unavailable");
		expect(alerts()).toHaveLength(1);
	});

	it("a re-driven round after an intervening wakeup message still posts no second notice", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		await makeLoop({ waitBudgetMs: 30 }).run();
		const later = new Date(Date.now() + 1000).toISOString();
		db.run(
			`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
			 VALUES (?, ?, 'developer', 'wakeup', ?, ?, ?, 0)`,
			[randomUUID(), threadId, later, later, SITE],
		);
		await makeLoop({ waitBudgetMs: 30 }).run();
		expect(alerts()).toHaveLength(1);
	});

	it("a scheduled task run says the run failed and how the scheduler retries it", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const result = await makeLoop({ waitBudgetMs: 30, taskId: "task-1", taskType: "cron" }).run();
		expect(result.outcome).toBe("model-unavailable");
		// The scheduler, not the thread executor, owns a task run's retry.
		expect(result.yielded).toBeFalsy();
		expect(result.error).toBeDefined();
		const [notice] = alerts();
		expect(notice).toContain(`Model "${LOGICAL}" is known in the cluster`);
		expect(notice).not.toContain("retries automatically");
		expect(notice).toContain("This cron task run ends as failed");
		expect(notice).toContain("next scheduled time");
	});

	it("a deferred task run names the scheduler's bounded backoff retry", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		await makeLoop({ waitBudgetMs: 30, taskId: "task-1", taskType: "deferred" }).run();
		const [notice] = alerts();
		expect(notice).toContain("This deferred task run ends as failed");
		expect(notice).toContain("retries it with backoff");
	});

	it("a cache-warm poke ends quietly: no notice, no re-drive", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const result = await makeLoop({ waitBudgetMs: 30, noTools: true }).run();
		expect(result.outcome).toBe("model-unavailable");
		expect(result.yielded).toBeFalsy();
		expect(alerts()).toEqual([]);
	});

	it("a zero wait budget posts the non-fatal notice and does not re-drive", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const result = await makeLoop({ waitBudgetMs: 0 }).run();
		expect(result.outcome).toBe("model-unavailable");
		expect(result.yielded).toBeFalsy();
		const [notice] = alerts();
		expect(notice).not.toContain("Loop error");
		expect(notice).not.toContain("Failed to resolve");
		expect(notice).toContain(`Model "${LOGICAL}" is known in the cluster`);
		expect(notice).toContain("Send a new message");
	});

	it("an abort interrupts the wait without posting an alert", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 30);

		const result = await makeLoop({
			waitBudgetMs: 60_000,
			abortSignal: controller.signal,
		}).run();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.outcome).toBe("aborted");
		expect(result.yielded).toBeUndefined();
		expect(backend.calls).toBe(0);
		expect(alerts()).toEqual([]);
	});

	it("cancel() interrupts the wait without posting an alert", async () => {
		router.recordRouteFailure(BACKEND_ID, { errorKind: "transport" });
		const loop = makeLoop({ waitBudgetMs: 60_000 });
		const started = Date.now();
		setTimeout(() => loop.cancel(), 30);

		const result = await loop.run();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.outcome).toBe("aborted");
		expect(alerts()).toEqual([]);
	});

	it("a decommissioned model keeps the pick-another-model alert", async () => {
		const result = await makeLoop({ waitBudgetMs: 30, modelId: "retired-model" }).run();
		expect(result.outcome).toBe("model-resolution-failed");
		const posted = alerts();
		expect(posted).toHaveLength(1);
		expect(posted[0]).toContain("decommissioned");
		expect(posted[0].toLowerCase()).toContain("pick another model");
	});
});
