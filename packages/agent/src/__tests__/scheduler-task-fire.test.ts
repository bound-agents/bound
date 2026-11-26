/**
 * task_fire consumer lane.
 *
 * The scheduler's tick drives a durable-work pass that claims pending
 * `task_fire` rows targeted at this host, verifies the referenced tasks
 * binding is still due for the payload's scheduled instant, performs the
 * pending→claimed CAS into runTask, and consumes the firing after runTask
 * returns. Every enqueue in this block is synthetic.
 *
 * Decision matrix under test:
 *  - valid due firing            → CAS bridge → runTask → consume (exactly once)
 *  - task claimed by another host → pending→claimed CAS no-ops → stale consume
 *  - next_run_at moved            → payload mismatch → stale consume
 *  - task deleted / missing       → binding gone → stale consume
 *  - event task (next_run_at NULL)→ never executes → stale consume + log
 *  - malformed payload            → token-fenced dead-letter (redrivable)
 *  - attempt budget exhausted     → token-fenced dead-letter
 *  - crash before runTask         → row stays processing → boot reset → re-run
 *  - workspool redrive round-trip → dead-letter → redrive → pending → executes
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult } from "@bound/agent";
import {
	applyMetricsSchema,
	applySchema,
	createDatabase,
	deadLetterDurableWork,
	getDurableWork,
	insertDurableWork,
	redriveDeadLetterDurableWork,
	resetProcessingDurableWork,
} from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Scheduler, type TaskFirePayload, taskFireIdempotencyKey } from "../scheduler";
import { waitFor } from "./helpers";

describe("Scheduler task_fire consumer lane", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `sched-taskfire-${randomBytes(4).toString("hex")}-`));
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
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
		return {
			db,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			eventBus,
			hostName: "test-host",
			siteId,
			config: {
				allowlist: {
					default_web_user: "test",
					users: { test: { display_name: "Test" } },
				},
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
			...overrides,
		} as unknown as AppContext;
	}

	function makeAgentLoopFactory(
		onRun?: () => void,
	): (config: AgentLoopConfig) => { run: () => Promise<AgentLoopResult> } {
		return () => ({
			run: async () => {
				onRun?.();
				return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
			},
		});
	}

	/** Insert a scheduled (non-event) pending task due at `nextRunAt`. */
	function insertScheduledTask(taskId: string, nextRunAt: string): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'deferred', 'pending', 'manual', NULL, NULL,
				NULL, NULL, NULL, ?, NULL,
				0, NULL, NULL, NULL, 1,
				'status', NULL, 0, 5,
				0, 0, 1,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, nextRunAt, now, now],
		);
	}

	/** Insert an event task (next_run_at NULL). */
	function insertEventTask(taskId: string): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'event', 'pending', 'webhook:x', NULL, ?,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 1,
				'status', NULL, 0, 5,
				0, 0, 1,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, randomUUID(), now, now],
		);
	}

	function enqueueTaskFire(payload: TaskFirePayload, id = randomUUID()): boolean {
		return insertDurableWork(db, {
			id,
			target_site_id: siteId,
			kind: "task_fire",
			payload: JSON.stringify(payload),
			idempotency_key: taskFireIdempotencyKey(payload),
		});
	}

	// --- (a) valid firing: CAS bridge → runTask → consume, exactly once -----
	it("executes a due firing through runTask and consumes the row exactly once", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		expect(enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId)).toBe(true);

		await scheduler.processPendingTaskFire();
		await waitFor(() => {
			const t = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
			} | null;
			return t?.status === "completed";
		});

		expect(runs).toBe(1);
		const work = getDurableWork(db, workId);
		expect(work?.claim_state).toBe("consumed");

		// A second identical enqueue is fenced (INSERT OR IGNORE on kind+key),
		// and a second consumer pass finds nothing → still exactly one run.
		expect(enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt })).toBe(false);
		await scheduler.processPendingTaskFire();
		expect(runs).toBe(1);
	});

	// --- (b) stale firings: no-op consume, task state untouched -------------
	it("consumes as a no-op when the task was already claimed by another host", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);
		// Simulate a peer claim: status is no longer 'pending'.
		db.run("UPDATE tasks SET status = 'claimed', claimed_by = 'peer' WHERE id = ?", [taskId]);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);

		await scheduler.processPendingTaskFire();

		expect(runs).toBe(0);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
		const t = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string;
		};
		expect(t.status).toBe("claimed");
		expect(t.claimed_by).toBe("peer");
	});

	it("consumes as a no-op when next_run_at moved past the payload's scheduled instant", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		const movedTo = new Date(Date.now() + 3_600_000).toISOString();
		insertScheduledTask(taskId, movedTo); // row's live next_run_at != payload scheduled_at

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);

		await scheduler.processPendingTaskFire();

		expect(runs).toBe(0);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
		expect(
			(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status,
		).toBe("pending");
	});

	it("consumes as a no-op when the task binding is gone (deleted / missing)", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		// No task row inserted at all.

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);

		await scheduler.processPendingTaskFire();

		expect(runs).toBe(0);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
	});

	// --- (g) event-task guard -----------------------------------------------
	it("never executes a firing that points at an event task (next_run_at NULL)", async () => {
		const taskId = randomUUID();
		insertEventTask(taskId);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		// A synthetic firing claiming an event task's row. Producers never mint
		// these; the guard defends anyway.
		enqueueTaskFire(
			{ task_id: taskId, scheduled_at: new Date(Date.now() - 60_000).toISOString() },
			workId,
		);

		await scheduler.processPendingTaskFire();

		expect(runs).toBe(0);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
		expect(
			(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status,
		).toBe("pending");
	});

	// --- (c) malformed payload → dead-letter --------------------------------
	it("dead-letters a task_fire row with a malformed payload", async () => {
		const scheduler = new Scheduler(makeCtx() as never, makeAgentLoopFactory() as never);
		const workId = randomUUID();
		// Valid JSON (insert requires it) but missing task_id — structurally invalid.
		insertDurableWork(db, {
			id: workId,
			target_site_id: siteId,
			kind: "task_fire",
			payload: JSON.stringify({ scheduled_at: "2026-01-01T00:00:00.000Z" }),
			idempotency_key: `task-fire:malformed:${workId}`,
		});

		await scheduler.processPendingTaskFire();

		const work = getDurableWork(db, workId);
		expect(work?.claim_state).toBe("dead_letter");
		expect(work?.last_error).toBeTruthy();
	});

	// --- (c1) scheduled_at timestamp validation and canonicalization --------
	it("dead-letters an unparseable scheduled_at instead of silently consuming it as stale", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const scheduler = new Scheduler(makeCtx() as never, makeAgentLoopFactory() as never);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: "not-a-date" }, workId);

		await scheduler.processPendingTaskFire();

		const work = getDurableWork(db, workId);
		expect(work?.claim_state).toBe("dead_letter");
		expect(work?.last_error).toContain("scheduled_at");
	});

	it("executes a firing when scheduled_at differs from next_run_at only by ISO formatting", async () => {
		const taskId = randomUUID();
		const canonicalScheduledAt = new Date(Date.now() - 60_000).toISOString();
		const differentlyFormattedScheduledAt = canonicalScheduledAt.replace(".000Z", "Z");
		insertScheduledTask(taskId, canonicalScheduledAt);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: differentlyFormattedScheduledAt }, workId);

		await scheduler.processPendingTaskFire();
		await waitFor(() => runs === 1);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
	});

	// --- (e) attempt budget → dead-letter -----------------------------------
	// The spec's "infrastructure failure before runTask" is a failure in the
	// BRIDGE (payload read / CAS / runTask invocation), NOT inside the agent
	// loop. runTask launches the loop asynchronously (setImmediate); a loop
	// throw is a TASK outcome (soft/hard write-back) and the firing was still
	// executed → consumed. To exercise the firing-lane infrastructure-failure
	// path we make the synchronous bridge itself throw, via a Scheduler whose
	// runTask raises before returning.
	class BridgeFailingScheduler extends Scheduler {
		override runTask(): void {
			throw new Error("bridge failure before runTask completes");
		}
	}

	it("dead-letters a firing after the attempt budget is exhausted", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const scheduler = new BridgeFailingScheduler(
			makeCtx() as never,
			makeAgentLoopFactory() as never,
		);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);

		// Drive repeated claim+reset cycles until the attempt budget is spent.
		for (let i = 0; i < 5; i++) {
			await scheduler.processPendingTaskFire();
			const work = getDurableWork(db, workId);
			if (work?.claim_state === "dead_letter") break;
			// The bridge failed before runTask completed → the row must stay
			// claim-owned (processing), never consumed, until the budget is spent.
			expect(work?.claim_state).toBe("processing");
			// Simulate boot recovery returning the abandoned row to pending, and
			// the binding CAS-back (as eviction would) so the next attempt re-bridges.
			resetProcessingDurableWork(db, siteId);
			db.run(
				"UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_id = NULL WHERE id = ?",
				[taskId],
			);
		}

		const work = getDurableWork(db, workId);
		expect(work?.claim_state).toBe("dead_letter");
		expect(work?.last_error).toBeTruthy();
	});

	// --- (d) crash recovery --------------------------------------------------
	it("leaves the row processing on failure before runTask, then re-runs after boot reset", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);

		// First pass: the bridge throws before runTask completes (crash).
		const crashingScheduler = new BridgeFailingScheduler(
			makeCtx() as never,
			makeAgentLoopFactory() as never,
		);
		await crashingScheduler.processPendingTaskFire();

		// The row must remain claim-owned (processing), never consumed.
		expect(getDurableWork(db, workId)?.claim_state).toBe("processing");

		// Boot recovery returns it to pending; re-arm binding as eviction would.
		// (The crash CAS-claimed the binding before throwing, so reset it too.)
		resetProcessingDurableWork(db, siteId);
		db.run(
			"UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_id = NULL WHERE id = ?",
			[taskId],
		);
		expect(getDurableWork(db, workId)?.claim_state).toBe("pending");

		// Healthy pass re-claims and executes.
		let runs = 0;
		const healthyScheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		await healthyScheduler.processPendingTaskFire();
		// runs++ fires inside runTask's async agent loop (setImmediate), so wait on
		// that observable side-effect rather than the synchronous firing ack.
		await waitFor(() => runs === 1);
		await waitFor(() => getDurableWork(db, workId)?.claim_state === "consumed");
	});

	// --- (e1) fire-and-forget tick containment -------------------------------
	it("contains a pre-bridge live-task read failure from tick and reclaims it on the next pass", async () => {
		const taskId = randomUUID();
		// Keep phase1 from claiming this binding before tick reaches the durable lane.
		const scheduledAt = new Date(Date.now() + 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);
		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);

		const errors: Array<{ message: string; details: unknown }> = [];
		const originalQuery = db.query.bind(db);
		let failLiveTaskRead = true;
		const originalDbQuery = db.query;
		(db as unknown as { query: typeof db.query }).query = ((sql: string) => {
			const statement = originalQuery(sql);
			if (failLiveTaskRead && sql.includes("SELECT * FROM tasks WHERE id = ?")) {
				return new Proxy(statement, {
					get(target, property, receiver) {
						if (property === "get")
							return () => {
								throw new Error("injected live task read failure");
							};
						return Reflect.get(target, property, receiver);
					},
				});
			}
			return statement;
		}) as typeof db.query;

		try {
			const scheduler = new Scheduler(
				makeCtx({
					logger: {
						debug: () => {},
						info: () => {},
						warn: () => {},
						error: (message, details) => errors.push({ message, details }),
					},
				}) as never,
				makeAgentLoopFactory() as never,
			);
			(scheduler as unknown as { running: boolean }).running = true;
			(scheduler as unknown as { tick: () => void }).tick();
			await waitFor(() =>
				errors.some(
					({ message }) => message === "[scheduler] task_fire processing failed before completion",
				),
			);
			expect(getDurableWork(db, workId)?.claim_state).toBe("processing");
			// The internal catch contains the rejection, so tick's seam catch is not needed
			// here; Bun would fail the test on an unhandled rejection.
			expect(
				errors.some(({ message }) => message === "[scheduler] task_fire consumer pass escaped"),
			).toBe(false);
		} finally {
			(db as unknown as { query: typeof db.query }).query = originalDbQuery;
		}

		failLiveTaskRead = false;
		let runs = 0;
		const healthyScheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		resetProcessingDurableWork(db, siteId);
		await healthyScheduler.processPendingTaskFire();
		await waitFor(() => runs === 1);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
	});

	// --- (f) workspool redrive round-trip -----------------------------------
	it("redrives a dead-lettered firing back to pending and the consumer executes it", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const workId = randomUUID();
		enqueueTaskFire({ task_id: taskId, scheduled_at: scheduledAt }, workId);
		// Force it into a dead letter (generic over kinds — no task_fire-specific op).
		deadLetterDurableWork(db, workId, "manual dead-letter for redrive test");
		expect(getDurableWork(db, workId)?.claim_state).toBe("dead_letter");

		// Redrive → pending.
		expect(redriveDeadLetterDurableWork(db, workId, null)).toBe(true);
		expect(getDurableWork(db, workId)?.claim_state).toBe("pending");

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		await scheduler.processPendingTaskFire();
		await waitFor(() => runs === 1);
		await waitFor(() => getDurableWork(db, workId)?.claim_state === "consumed");
	});
});

/**
 * task_fire producer.
 *
 * The rendezvous winner in phase-1 enqueues a `task_fire` durable_work row
 * (kind `task_fire`, target self, fenced on `task-fire:<task_id>:<scheduled_at>`)
 * instead of claiming the binding; the same-tick consumer lane
 * (`processPendingTaskFire`, after phase-3) claims it and performs the
 * pending→claimed CAS into runTask, so the synced `tasks` row lifecycle is
 * unchanged (R-DW17).
 *
 * Behaviour matrix under test:
 *  - (a) end-to-end: due task → row enqueued (verbatim key, TTL) → consumer
 *    claims → bridge CAS → runTask executes → task completes.
 *  - (b) fence dedupe: two phase-1 passes over one due binding → one row.
 *  - (c) re-arm cycle: completed cron task re-arms → new firing key enqueued
 *    → executes.
 *  - (d) no-double-run: phase-3 + the bridge cannot both run one firing.
 *  - (e) partition double-winner: a firing whose binding a peer already
 *    claimed on the synced row → no-op consume.
 */
describe("Scheduler task_fire producer", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `sched-taskfire-5c-${randomBytes(4).toString("hex")}-`));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();
		db.run("DELETE FROM host_meta");
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);
		// Register this host as live so shouldDispatchHere's rendezvous has a
		// candidate set; a lone live candidate makes this host the winner.
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted)
			 VALUES (?, 'test-host', ?, ?, 0)
			 ON CONFLICT(site_id) DO UPDATE SET online_at = excluded.online_at, modified_at = excluded.modified_at, deleted = 0`,
			[siteId, now, now],
		);
	});

	afterEach(() => {
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM turns");
		db.run("DELETE FROM durable_work");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM hosts");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCapturingLogger(sink: Array<{ message: string; details: unknown }>) {
		return {
			debug: () => {},
			info: (message: string, details: unknown) => sink.push({ message, details }),
			warn: (message: string, details: unknown) => sink.push({ message, details }),
			error: (message: string, details: unknown) => sink.push({ message, details }),
		};
	}

	function makeCtx(
		overrides: Partial<AppContext> = {},
		logger?: ReturnType<typeof makeCapturingLogger>,
	): AppContext {
		return {
			db,
			logger: logger ?? {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			eventBus,
			hostName: "test-host",
			siteId,
			config: {
				allowlist: {
					default_web_user: "test",
					users: { test: { display_name: "Test" } },
				},
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
			...overrides,
		} as unknown as AppContext;
	}

	function makeAgentLoopFactory(
		onRun?: () => void,
	): (config: AgentLoopConfig) => { run: () => Promise<AgentLoopResult> } {
		return () => ({
			run: async () => {
				onRun?.();
				return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
			},
		});
	}

	/** Insert a scheduled (non-event) pending task due at `nextRunAt`. */
	function insertScheduledTask(taskId: string, nextRunAt: string, triggerSpec = "manual"): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'deferred', 'pending', ?, NULL, NULL,
				NULL, NULL, NULL, ?, NULL,
				0, NULL, NULL, NULL, 1,
				'status', NULL, 0, 5,
				0, 0, 1,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, triggerSpec, nextRunAt, now, now],
		);
	}

	/** Insert a cron task due at `nextRunAt` (re-arms after each run). */
	function insertCronTask(taskId: string, nextRunAt: string, expression = "* * * * *"): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'cron', 'pending', ?, NULL, NULL,
				NULL, NULL, NULL, ?, NULL,
				0, NULL, NULL, NULL, 1,
				'status', NULL, 0, 5,
				0, 0, 1,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, JSON.stringify({ type: "cron", expression }), nextRunAt, now, now],
		);
	}

	function taskFireRows(): Array<{
		id: string;
		idempotency_key: string;
		payload: string;
		expires_at: string | null;
		claim_state: string;
	}> {
		return db
			.query(
				"SELECT id, idempotency_key, payload, expires_at, claim_state FROM durable_work WHERE kind = 'task_fire' ORDER BY created_at ASC",
			)
			.all() as Array<{
			id: string;
			idempotency_key: string;
			payload: string;
			expires_at: string | null;
			claim_state: string;
		}>;
	}

	function countTaskFireRows(): number {
		return (
			db.query("SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'task_fire'").get() as {
				n: number;
			}
		).n;
	}

	it("enqueues a task_fire row that the consumer executes, and records enqueue_inserted", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		let runs = 0;
		const logs: Array<{ message: string; details: unknown }> = [];
		const scheduler = new Scheduler(
			makeCtx({}, makeCapturingLogger(logs)) as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);

		// Phase-1 leaves the binding pending and enqueues a task_fire row.
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();

		const afterPhase1 = db
			.query("SELECT status, claimed_by FROM tasks WHERE id = ?")
			.get(taskId) as { status: string; claimed_by: string | null };
		expect(afterPhase1.status).toBe("pending");
		expect(afterPhase1.claimed_by).toBeNull();

		const rows = taskFireRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].idempotency_key).toBe(`task-fire:${taskId}:${scheduledAt}`);
		expect(JSON.parse(rows[0].payload)).toEqual({ task_id: taskId, scheduled_at: scheduledAt });
		// TTL present and in the future (RPC-appropriate window).
		expect(rows[0].expires_at).not.toBeNull();
		expect(new Date(rows[0].expires_at as string).getTime()).toBeGreaterThan(Date.now());

		// The consumer claims the enqueued row and executes through the bridge.
		const workId = rows[0].id;
		await scheduler.processPendingTaskFire();
		await waitFor(() => {
			const t = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
			} | null;
			return t?.status === "completed";
		});
		expect(runs).toBe(1);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
	});

	// --- (b) fence dedupe: two phase-1 passes → one row ----------------------
	it("dedupes re-enqueues across ticks while the binding's next_run_at is unchanged", () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const scheduler = new Scheduler(makeCtx() as never, makeAgentLoopFactory() as never);
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();

		expect(countTaskFireRows()).toBe(1);
	});

	// --- (c) re-arm cycle: NEW firing key enqueued and executed --------------
	it("mints a fresh firing when a completed cron task re-arms to a new next_run_at", async () => {
		const taskId = randomUUID();
		const firstInstant = new Date(Date.now() - 60_000).toISOString();
		insertCronTask(taskId, firstInstant);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);

		// First firing: enqueue → consume → execute → cron re-arm on completion.
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
		const firstRows = taskFireRows();
		expect(firstRows).toHaveLength(1);
		expect(firstRows[0].idempotency_key).toBe(`task-fire:${taskId}:${firstInstant}`);

		await scheduler.processPendingTaskFire();
		// Wait for the re-arm: the completed run advances next_run_at to a fresh
		// future instant and returns the binding to pending.
		await waitFor(() => {
			const t = db.query("SELECT status, next_run_at FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
				next_run_at: string | null;
			} | null;
			return t?.status === "pending" && t.next_run_at !== null && t.next_run_at !== firstInstant;
		});
		expect(runs).toBe(1);

		// The re-arm minted a NEW next_run_at. Capture it, force it due, and run
		// phase-1 again: a fresh firing keyed on the new instant is enqueued
		// (the key includes scheduled_at, so it does NOT collide with the first).
		const reArmedInstant = (
			db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as { next_run_at: string }
		).next_run_at;
		expect(reArmedInstant).not.toBe(firstInstant);
		// The cron re-arm computes a future instant; force it due so phase-1 sees it,
		// keeping the (task_id, scheduled_at) identity intact.
		db.run("UPDATE tasks SET next_run_at = ? WHERE id = ?", [reArmedInstant, taskId]);
		// If the re-armed instant is already in the past, it's due as-is; otherwise
		// pull it back so the phase-1 due scan (next_run_at <= now) picks it up while
		// preserving a scheduled_at distinct from firstInstant.
		if (new Date(reArmedInstant).getTime() > Date.now()) {
			const pastButDistinct = new Date(Date.now() - 30_000).toISOString();
			db.run("UPDATE tasks SET next_run_at = ? WHERE id = ?", [pastButDistinct, taskId]);
		}
		const secondInstant = (
			db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as { next_run_at: string }
		).next_run_at;
		expect(secondInstant).not.toBe(firstInstant);

		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();

		const secondRows = db
			.query(
				"SELECT idempotency_key FROM durable_work WHERE kind = 'task_fire' AND idempotency_key = ?",
			)
			.all(`task-fire:${taskId}:${secondInstant}`) as Array<{ idempotency_key: string }>;
		expect(secondRows).toHaveLength(1);
		expect(secondRows[0].idempotency_key).toBe(`task-fire:${taskId}:${secondInstant}`);

		await scheduler.processPendingTaskFire();
		await waitFor(() => runs === 2);
	});

	// --- (d) no-double-run: phase-3 + bridge cannot both run one firing ------
	it("runs a firing exactly once even when phase-3 and the durable bridge both see the tick", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);

		// Phase-1 enqueues (no claim). The bridge claims + runs the firing.
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
		await scheduler.processPendingTaskFire();
		await waitFor(() => runs === 1);

		// Now the binding is running/completed. A subsequent phase-3 pass scans
		// claimed rows for this host; the runTask claimed→running lease CAS is the
		// guard against a second execution of the same instant. Drive several
		// phase-3 passes and assert the run count never advances.
		for (let i = 0; i < 3; i++) {
			(scheduler as unknown as { phase3Run: () => void }).phase3Run();
		}
		// Also re-run the whole tick sequence once (phase-1 dedupes on the fence,
		// phase-3 sees no re-claimable row, the consumer finds the row consumed).
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
		(scheduler as unknown as { phase3Run: () => void }).phase3Run();
		await scheduler.processPendingTaskFire();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(runs).toBe(1);
	});

	// --- (d1) budget deferral RELEASES the firing (not consume): the fence never
	//          blocks re-enqueue, and the task runs once budget clears -----------
	it("releases (does not consume) a firing deferred by daily budget, so it runs once budget clears without any durable-work pruning", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		let runs = 0;
		// Over-budget config: a tiny daily budget plus a turn row that exceeds it.
		// shouldSkipDueToBudget only defers autonomous (created_by='system') tasks,
		// which insertScheduledTask produces.
		const overBudgetCtx = makeCtx({
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
					daily_budget_usd: 0.01,
				},
			},
		} as unknown as Partial<AppContext>);
		// Today's spend already exceeds the budget.
		const nowIso = new Date().toISOString();
		db.run(
			"INSERT INTO turns (id, model_id, tokens_in, tokens_out, cost_usd, created_at, deleted) VALUES (?, 'mock', 100, 100, 1.0, ?, 0)",
			[randomUUID(), nowIso],
		);

		const overBudgetScheduler = new Scheduler(
			overBudgetCtx as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		insertDurableWork(db, {
			id: workId,
			target_site_id: siteId,
			kind: "task_fire",
			payload: JSON.stringify({ task_id: taskId, scheduled_at: scheduledAt }),
			idempotency_key: taskFireIdempotencyKey({ task_id: taskId, scheduled_at: scheduledAt }),
		});
		const attemptsBefore = getDurableWork(db, workId)?.attempt_count ?? -1;
		expect(attemptsBefore).toBe(0);

		// Over-budget pass: the bridge claims, checks budget, and RELEASES.
		await overBudgetScheduler.processPendingTaskFire();
		expect(runs).toBe(0);

		// The firing is back to pending (NOT consumed) with a fully restored binding.
		const deferred = getDurableWork(db, workId);
		expect(deferred?.claim_state).toBe("pending");
		expect(deferred?.claim_token).toBeNull();
		// Release is attempt-neutral: the claim's +1 is undone, back to 0.
		expect(deferred?.attempt_count).toBe(0);
		const binding = db
			.query("SELECT status, claimed_by, claimed_at FROM tasks WHERE id = ?")
			.get(taskId) as {
			status: string;
			claimed_by: string | null;
			claimed_at: string | null;
		};
		expect(binding.status).toBe("pending");
		expect(binding.claimed_by).toBeNull();
		expect(binding.claimed_at).toBeNull();

		// Budget clears (drop the expensive turn). No durable-work pruning happens —
		// the SAME row is still present and pending; its fence never blocked anything.
		db.run("UPDATE turns SET cost_usd = 0 WHERE model_id = 'mock'");
		expect(countTaskFireRows()).toBe(1);

		// Next tick under a healthy scheduler re-claims the SAME row and executes.
		const healthyScheduler = new Scheduler(
			makeCtx({
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
						daily_budget_usd: 0.01,
					},
				},
			} as unknown as Partial<AppContext>) as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		await healthyScheduler.processPendingTaskFire();
		await waitFor(() => runs === 1);
		await waitFor(() => getDurableWork(db, workId)?.claim_state === "consumed");
		// The firing that finally executed is the ORIGINAL row — never pruned/re-minted.
		expect(countTaskFireRows()).toBe(1);
	});

	// --- (d2) crash window: self-claimed binding RELEASES the firing, which runs
	//          on a later tick once phase-0 eviction resets the binding ----------
	it("releases (does not consume) a firing whose binding is self-claimed (crash window), then runs it after phase-0 eviction resets the binding", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		// Simulate the crash window: the bridge's pending→claimed CAS committed for
		// THIS host, then the host crashed before runTask; boot recovery reset the
		// FIRING to pending (we enqueue it fresh) but the BINDING is stuck claimed by
		// this host, with a stale claimed_at older than LEASE_DURATION (5m) so phase-0
		// arm (a) will evict it.
		const staleClaimedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		db.run("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?", [
			siteId,
			staleClaimedAt,
			taskId,
		]);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		const workId = randomUUID();
		insertDurableWork(db, {
			id: workId,
			target_site_id: siteId,
			kind: "task_fire",
			payload: JSON.stringify({ task_id: taskId, scheduled_at: scheduledAt }),
			idempotency_key: taskFireIdempotencyKey({ task_id: taskId, scheduled_at: scheduledAt }),
		});

		// Pass 1: the binding is self-claimed → classifier says binding_not_pending,
		// but the self-vs-peer split RELEASES the firing rather than consuming it.
		await scheduler.processPendingTaskFire();
		expect(runs).toBe(0);
		const released = getDurableWork(db, workId);
		expect(released?.claim_state).toBe("pending");
		expect(released?.attempt_count).toBe(0); // attempt-neutral

		// Phase-0 eviction resets the stale self-claimed binding back to pending.
		(scheduler as unknown as { phase0Eviction: () => void }).phase0Eviction();
		const evicted = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string | null;
		};
		expect(evicted.status).toBe("pending");
		expect(evicted.claimed_by).toBeNull();

		// Pass 2: now the binding is pending, the bridge CAS succeeds, the firing runs.
		await scheduler.processPendingTaskFire();
		await waitFor(() => runs === 1);
		await waitFor(() => getDurableWork(db, workId)?.claim_state === "consumed");
	});

	// --- (d3) contention no-double-run: phase-3 and a second bridge invocation
	//          race the SAME claimed binding; exactly one execution, loser clean --
	it("runs a firing exactly once when phase-3 and a second bridge pass contend for the same claimed binding, with the loser returning cleanly", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		let runs = 0;
		const logs: Array<{ message: string; details: unknown }> = [];
		const scheduler = new Scheduler(
			makeCtx({}, makeCapturingLogger(logs)) as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);

		// Put the binding in the exact mid-flight state the bridge leaves it in:
		// status='claimed', claimed_by=self (post-CAS, pre-runTask). runTask's
		// claimed→running lease CAS is the exclusion point both contenders hit.
		db.run("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?", [
			siteId,
			new Date().toISOString(),
			taskId,
		]);

		// Drive BOTH contenders at the same claimed row without completing the first:
		// phase-3 scans claimed-by-self rows and calls runTask; a direct runTask call
		// models the second bridge invocation. Exactly one wins the claimed→running
		// CAS; the loser returns cleanly.
		const claimedTask = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as never;
		(scheduler as unknown as { runTask: (t: unknown) => void }).runTask(claimedTask);
		(scheduler as unknown as { phase3Run: () => void }).phase3Run();

		await waitFor(() => runs === 1);
		// Give any losing CAS path time to (not) fire a second run.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(runs).toBe(1);

		// The loser produced no meaningful error write-back and no dead-letter: the
		// binding reached running (won once). A successful completion write-back sets
		// error to "" (the no-error signal, scheduler.ts completion path), so assert a
		// FALSY error rather than strict null — a real failure would be a non-empty
		// message. What matters is that the losing runTask CAS returned cleanly.
		const finalTask = db.query("SELECT status, error FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			error: string | null;
		};
		expect(finalTask.error == null || finalTask.error === "").toBe(true);
		expect(["running", "completed"]).toContain(finalTask.status);
	});

	// --- (e) partition double-winner: peer already claimed → no-op consume ----
	it("no-op consumes a durable-mode firing whose binding a peer already claimed", async () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		let runs = 0;
		const scheduler = new Scheduler(
			makeCtx() as never,
			makeAgentLoopFactory(() => {
				runs++;
			}) as never,
		);
		// Producer enqueues the firing this host won.
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
		const rows = taskFireRows();
		expect(rows).toHaveLength(1);
		const workId = rows[0].id;

		// A partition peer wins the synced-row race first: the binding is no longer
		// pending by the time our consumer bridges.
		db.run("UPDATE tasks SET status = 'claimed', claimed_by = 'peer' WHERE id = ?", [taskId]);

		await scheduler.processPendingTaskFire();

		expect(runs).toBe(0);
		expect(getDurableWork(db, workId)?.claim_state).toBe("consumed");
		const t = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string;
		};
		expect(t.status).toBe("claimed");
		expect(t.claimed_by).toBe("peer");
	});
});
