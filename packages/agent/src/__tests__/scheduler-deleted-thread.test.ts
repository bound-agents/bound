/**
 * Regression: a live task bound to a soft-deleted thread.
 *
 * The scheduler's thread-existence probe ignored `threads.deleted`, so a task
 * whose thread the user had deleted kept writing wakeup messages into the
 * tombstone and running loops against it. Model resolution, meanwhile,
 * started from the live thread row, so the task's own model_hint was dropped
 * and the loop fell through to the symbolic default.
 *
 * Contract under test (all through the real runTask path via scheduler.start):
 *  - deleted thread: the task is parked (`failed`, next_run_at + claim cleared)
 *    with an actionable error; no messages are written, no loop runs, the
 *    thread stays deleted, and unconsumed durable intake stays `pending`.
 *  - a parked task is not re-claimed by later ticks or events (no spin).
 *  - missing thread: still created, and the task hint drives the loop model.
 *  - live thread: task hint beats thread hint; thread hint beats the symbolic default.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult } from "@bound/agent";
import { applyMetricsSchema, applySchema, createDatabase, insertDurableWork } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Scheduler } from "../scheduler";
import { sleep, waitFor } from "./helpers";

describe("Scheduler: task bound to a soft-deleted thread", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `sched-deleted-thread-${randomBytes(4).toString("hex")}-`));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();
		db.run("DELETE FROM host_meta");
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);
	});

	afterEach(() => {
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM turns");
		db.run("DELETE FROM durable_work");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM threads");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus,
			hostName: "test-host",
			siteId,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: {
					backends: [
						{
							id: "mock",
							provider: "openai-compatible",
							model: "mock",
							base_url: "http://localhost:11434",
							context_window: 8000,
							price_per_m_input: 0,
							price_per_m_output: 0,
						},
					],
					default: "mock",
				},
			},
			optionalConfig: {},
		} as unknown as AppContext;
	}

	function recordingFactory(configs: AgentLoopConfig[]) {
		return (config: AgentLoopConfig) => ({
			run: async (): Promise<AgentLoopResult> => {
				configs.push(config);
				return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
			},
		});
	}

	function insertTask(opts: {
		id: string;
		type: "event" | "deferred";
		threadId: string;
		modelHint?: string | null;
		triggerSpec?: string;
	}): void {
		const now = new Date().toISOString();
		const due = new Date(Date.now() - 60_000).toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, ?, 'pending', ?, 'do the thing', ?,
				NULL, NULL, NULL, ?, NULL,
				0, NULL, NULL, ?, 0,
				'results', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[
				opts.id,
				opts.type,
				opts.triggerSpec ?? (opts.type === "event" ? "test:event" : '{"type":"deferred"}'),
				opts.threadId,
				due,
				opts.modelHint ?? null,
				now,
				now,
			],
		);
	}

	function insertThread(id: string, opts: { deleted?: 0 | 1; modelHint?: string | null } = {}) {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, model_hint)
			 VALUES (?, 'u', 'web', ?, ?, ?, ?, ?, ?)`,
			[id, siteId, now, now, now, opts.deleted ?? 0, opts.modelHint ?? null],
		);
	}

	function insertIntake(threadId: string): string {
		const id = randomUUID();
		insertDurableWork(db, {
			id,
			target_site_id: siteId,
			kind: "webhook_intake",
			ref_id: threadId,
			idempotency_key: `webhook:${randomUUID()}`,
			payload: JSON.stringify({ body: '{"action":"opened"}' }),
			expires_at: new Date(Date.now() + 3600_000).toISOString(),
			source_site: siteId,
			received_at: new Date().toISOString(),
		});
		return id;
	}

	function taskRow(id: string) {
		return db
			.query(
				"SELECT status, error, next_run_at, claimed_by, lease_id, run_count, thread_id FROM tasks WHERE id = ?",
			)
			.get(id) as {
			status: string;
			error: string | null;
			next_run_at: string | null;
			claimed_by: string | null;
			lease_id: string | null;
			run_count: number;
			thread_id: string;
		};
	}

	function messageCount(threadId: string): number {
		return (
			db.query("SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?").get(threadId) as {
				c: number;
			}
		).c;
	}

	it("parks an event task whose thread was deleted without touching the thread or its intake", async () => {
		const taskId = randomUUID();
		const threadId = randomUUID();
		insertThread(threadId, { deleted: 1, modelHint: "thread-model" });
		insertTask({ id: taskId, type: "event", threadId, modelHint: "task-model" });
		const intakeId = insertIntake(threadId);

		const configs: AgentLoopConfig[] = [];
		const scheduler = new Scheduler(makeCtx(), recordingFactory(configs));
		const { stop } = scheduler.start(10);
		try {
			await waitFor(() => taskRow(taskId).status === "failed", {
				timeoutMs: 5000,
				message: "task bound to a deleted thread was not parked",
			});
			// Further ticks and a matching event must not re-claim the parked task.
			scheduler.onEvent("test:event", null);
			await sleep(150);
		} finally {
			stop();
		}

		const task = taskRow(taskId);
		expect(task.status).toBe("failed");
		expect(task.next_run_at).toBeNull();
		expect(task.claimed_by).toBeNull();
		expect(task.lease_id).toBeNull();
		expect(task.thread_id).toBe(threadId);
		expect(task.error).toContain(threadId);
		expect(task.error).toContain("deleted");
		expect(task.error).toContain("cancel this task and schedule a replacement on a live thread");
		expect(task.error).not.toMatch(/restore the thread to resume/i);

		expect(configs).toHaveLength(0);
		expect(messageCount(threadId)).toBe(0);
		expect(
			(db.query("SELECT deleted FROM threads WHERE id = ?").get(threadId) as { deleted: number })
				.deleted,
		).toBe(1);
		expect(
			(
				db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(intakeId) as {
					claim_state: string;
				}
			).claim_state,
		).toBe("pending");
		// No phantom thread was created in its place.
		expect((db.query("SELECT COUNT(*) AS c FROM threads").get() as { c: number }).c).toBe(1);
	});

	it("parks a deferred task whose thread was deleted", async () => {
		const taskId = randomUUID();
		const threadId = randomUUID();
		insertThread(threadId, { deleted: 1 });
		insertTask({ id: taskId, type: "deferred", threadId, modelHint: "task-model" });

		const configs: AgentLoopConfig[] = [];
		const scheduler = new Scheduler(makeCtx(), recordingFactory(configs));
		const { stop } = scheduler.start(10);
		try {
			await waitFor(() => taskRow(taskId).status === "failed", {
				timeoutMs: 5000,
				message: "deferred task bound to a deleted thread was not parked",
			});
			await sleep(100);
		} finally {
			stop();
		}

		expect(configs).toHaveLength(0);
		expect(messageCount(threadId)).toBe(0);
		expect(taskRow(taskId).error).toContain("deleted");
	});

	it("still creates a missing thread and runs on the task model hint", async () => {
		const taskId = randomUUID();
		const threadId = randomUUID();
		insertTask({ id: taskId, type: "deferred", threadId, modelHint: "task-model" });

		const configs: AgentLoopConfig[] = [];
		const scheduler = new Scheduler(makeCtx(), recordingFactory(configs));
		const { stop } = scheduler.start(10);
		try {
			await waitFor(() => configs.length === 1, {
				timeoutMs: 5000,
				message: "task with a missing thread did not run",
			});
		} finally {
			stop();
		}

		expect(configs[0]?.threadId).toBe(threadId);
		expect(configs[0]?.modelId).toBe("task-model");
		expect(
			db.query("SELECT deleted FROM threads WHERE id = ?").get(threadId) as { deleted: number },
		).toEqual({ deleted: 0 });
		expect(messageCount(threadId)).toBeGreaterThan(0);
	});

	async function runOne(taskId: string): Promise<AgentLoopConfig> {
		const configs: AgentLoopConfig[] = [];
		const scheduler = new Scheduler(makeCtx(), recordingFactory(configs));
		const { stop } = scheduler.start(10);
		try {
			await waitFor(() => configs.length === 1, {
				timeoutMs: 5000,
				message: `task ${taskId} did not run`,
			});
		} finally {
			stop();
		}
		return configs[0] as AgentLoopConfig;
	}

	it("prefers the task hint over the live thread hint", async () => {
		const taskId = randomUUID();
		const threadId = randomUUID();
		insertThread(threadId, { modelHint: "thread-model" });
		insertTask({ id: taskId, type: "deferred", threadId, modelHint: "task-model" });
		expect((await runOne(taskId)).modelId).toBe("task-model");
	});

	it("falls back to the live thread hint, then the symbolic default", async () => {
		const taskA = randomUUID();
		const threadA = randomUUID();
		insertThread(threadA, { modelHint: "thread-model" });
		insertTask({ id: taskA, type: "deferred", threadId: threadA, modelHint: null });
		expect((await runOne(taskA)).modelId).toBe("thread-model");

		const taskB = randomUUID();
		const threadB = randomUUID();
		insertThread(threadB, { modelHint: null });
		insertTask({ id: taskB, type: "deferred", threadId: threadB, modelHint: null });
		// The symbolic default; resolveModel maps it to the cluster default role.
		expect((await runOne(taskB)).modelId).toBe("default");
	});
});
