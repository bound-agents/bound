/**
 * Slice 5A: task_fire consumer lane.
 *
 * The scheduler's tick drives a durable-work pass that claims pending
 * `task_fire` rows targeted at this host, verifies the referenced tasks
 * binding is still due for the payload's scheduled instant, bridges the
 * legacy pending→claimed CAS into the UNTOUCHED runTask body, and consumes
 * (→ consumed) the firing after runTask returns. NO production code enqueues
 * task_fire rows in 5A — the lane carries only test traffic (the producer
 * flip is 5B/5C), so every enqueue here is synthetic.
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
import {
	Scheduler,
	type TaskFirePayload,
	setTaskFireModeForTesting,
	taskFireIdempotencyKey,
} from "../scheduler";
import { selectFiringHost } from "../task-resolution";
import { waitFor } from "./helpers";

describe("Scheduler task_fire consumer lane (5A)", () => {
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
							tier: 1,
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
 * Slice 5B: task_fire PRODUCER in comparison mode.
 *
 * The legacy phase-1 CAS + execution keep running unchanged. In addition, for
 * each due scheduled firing the scheduler computes the would-be durable enqueue
 * decision (reusing shouldDispatchHere's rendezvous winner) and emits a
 * `task_fire_comparison` telemetry record. In "compare" mode (the default) NO
 * durable_work row is inserted — the dual-execution proof the migration plan
 * requires ("never run both execution paths for one artifact without the shared
 * idempotency fence") is a comparison, not an execution.
 *
 * Behaviour matrix under test:
 *  - compare (default): legacy fires exactly as before; comparison log emitted
 *    with decision_match=true; ZERO task_fire rows in durable_work.
 *  - legacy: no comparison log; byte-identical to HEAD behaviour.
 *  - durable: warns once per process, then behaves as compare.
 *  - firing not won by this host: legacy skips; comparison records
 *    legacy_dispatched=false / would_enqueue=false / decision_match=true.
 *  - event task (next_run_at NULL): no comparison record (R-DW18).
 */
describe("Scheduler task_fire producer comparison mode (5B)", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `sched-taskfire-5b-${randomBytes(4).toString("hex")}-`));
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
		// Default all 5B specs to the default mode explicitly; each spec that flips
		// it restores here on the next beforeEach (toggle hygiene, item (f)).
		setTaskFireModeForTesting("compare");
	});

	afterEach(() => {
		setTaskFireModeForTesting("compare");
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM turns");
		db.run("DELETE FROM durable_work");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM hosts");
	});

	afterAll(async () => {
		setTaskFireModeForTesting(undefined);
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	interface ComparisonRecord {
		task_id: string;
		scheduled_at: string;
		firing_key: string;
		idempotency_key: string;
		legacy_dispatched: boolean;
		legacy_claim_won: boolean;
		would_enqueue: boolean;
		candidate_count: number;
		decision_match: boolean;
	}

	/** A logger that captures info-level lines so we can inspect comparison records. */
	function makeCapturingLogger(sink: Array<{ message: string; details: unknown }>) {
		return {
			debug: () => {},
			info: (message: string, details: unknown) => sink.push({ message, details }),
			warn: (message: string, details: unknown) => sink.push({ message, details }),
			error: (message: string, details: unknown) => sink.push({ message, details }),
		};
	}

	function makeCtx(
		logger: ReturnType<typeof makeCapturingLogger>,
		overrides: Partial<AppContext> = {},
	): AppContext {
		return {
			db,
			logger,
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
							tier: 1,
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

	function runPhase1(logger: ReturnType<typeof makeCapturingLogger>): void {
		const scheduler = new Scheduler(makeCtx(logger) as never, makeAgentLoopFactory() as never);
		(scheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
	}

	function comparisonRecords(
		sink: Array<{ message: string; details: unknown }>,
	): ComparisonRecord[] {
		return sink
			.filter(
				(l) =>
					typeof l.details === "object" &&
					l.details !== null &&
					(l.details as { event?: string }).event === "task_fire_comparison",
			)
			.map((l) => l.details as unknown as ComparisonRecord);
	}

	function countTaskFireRows(): number {
		return (
			db.query("SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'task_fire'").get() as {
				n: number;
			}
		).n;
	}

	// --- (a) compare mode (default): legacy fires, comparison emitted, no rows --
	it("in compare mode fires legacy, emits a matching comparison, and inserts zero task_fire rows", () => {
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const logs: Array<{ message: string; details: unknown }> = [];
		runPhase1(makeCapturingLogger(logs));

		// Legacy path claimed the binding, exactly as at HEAD.
		const task = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string;
		};
		expect(task.status).toBe("claimed");
		expect(task.claimed_by).toBe(siteId);

		const records = comparisonRecords(logs);
		expect(records).toHaveLength(1);
		const rec = records[0];
		expect(rec.task_id).toBe(taskId);
		expect(rec.scheduled_at).toBe(scheduledAt);
		expect(rec.firing_key).toBe(`firing:${taskId}:${scheduledAt}`);
		expect(rec.idempotency_key).toBe(`task-fire:${taskId}:${scheduledAt}`);
		expect(rec.legacy_dispatched).toBe(true);
		expect(rec.legacy_claim_won).toBe(true);
		expect(rec.would_enqueue).toBe(true);
		expect(rec.candidate_count).toBeGreaterThanOrEqual(1);
		expect(rec.decision_match).toBe(true);

		// The 5A consumer must find nothing to claim from production paths.
		expect(countTaskFireRows()).toBe(0);
	});

	// --- (b) legacy mode: no comparison, byte-identical legacy behaviour -------
	it("in legacy mode claims the binding but emits no comparison record", () => {
		setTaskFireModeForTesting("legacy");
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);

		const logs: Array<{ message: string; details: unknown }> = [];
		runPhase1(makeCapturingLogger(logs));

		const task = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string;
		};
		expect(task.status).toBe("claimed");
		expect(task.claimed_by).toBe(siteId);

		expect(comparisonRecords(logs)).toHaveLength(0);
		expect(countTaskFireRows()).toBe(0);
	});

	// --- (c) durable mode: warns once per process, then behaves as compare -----
	it("in durable mode warns once across repeated ticks and scheduler instances, then behaves as compare", () => {
		setTaskFireModeForTesting("durable");
		const logs: Array<{ message: string; details: unknown }> = [];
		const logger = makeCapturingLogger(logs);
		const firstScheduler = new Scheduler(makeCtx(logger) as never, makeAgentLoopFactory() as never);

		// Two phase-1 ticks on one scheduler each process a distinct due firing.
		for (let i = 0; i < 2; i++) {
			insertScheduledTask(randomUUID(), new Date(Date.now() - 60_000).toISOString());
			(firstScheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();
		}

		// A second instance must share the same process-wide warning latch.
		insertScheduledTask(randomUUID(), new Date(Date.now() - 60_000).toISOString());
		const secondScheduler = new Scheduler(
			makeCtx(logger) as never,
			makeAgentLoopFactory() as never,
		);
		(secondScheduler as unknown as { phase1Schedule: () => void }).phase1Schedule();

		const warns = logs.filter(
			(l) =>
				typeof l.details === "object" &&
				l.details !== null &&
				(l.details as { event?: string }).event === "task_fire_durable_mode_unavailable",
		);
		expect(warns).toHaveLength(1);

		const records = comparisonRecords(logs);
		expect(records).toHaveLength(3);
		expect(records.every((record) => record.decision_match)).toBe(true);
		// Comparison mode never inserts executable rows.
		expect(countTaskFireRows()).toBe(0);
	});

	// --- (d) firing not won by this host: legacy skips, comparison matches ----
	it("records a not-won firing with legacy_dispatched=false and a matching would_enqueue=false", () => {
		// Register a second, DETERMINISTICALLY-winning peer. selectFiringHost picks
		// the highest deterministicUUID(firingKey:siteId); we retry siteIds until
		// the peer outranks this host for this firing so the rendezvous says
		// "elsewhere" without stubbing.
		const taskId = randomUUID();
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		insertScheduledTask(taskId, scheduledAt);
		const firingKey = `firing:${taskId}:${scheduledAt}`;

		const now = new Date().toISOString();
		let peerSiteId = "";
		for (let i = 0; i < 10_000; i++) {
			const candidate = randomUUID();
			if (
				selectFiringHost(firingKey, [
					{ siteId, hostName: "test-host" },
					{ siteId: candidate, hostName: "peer-host" },
				]) === candidate
			) {
				peerSiteId = candidate;
				break;
			}
		}
		expect(peerSiteId).not.toBe("");
		db.run(
			`INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted)
			 VALUES (?, 'peer-host', ?, ?, 0)`,
			[peerSiteId, now, now],
		);

		const logs: Array<{ message: string; details: unknown }> = [];
		runPhase1(makeCapturingLogger(logs));

		// Legacy skipped: the binding stays pending, unclaimed.
		const task = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string | null;
		};
		expect(task.status).toBe("pending");
		expect(task.claimed_by).toBeNull();

		const records = comparisonRecords(logs);
		expect(records).toHaveLength(1);
		const rec = records[0];
		expect(rec.legacy_dispatched).toBe(false);
		expect(rec.would_enqueue).toBe(false);
		expect(rec.legacy_claim_won).toBe(false);
		expect(rec.candidate_count).toBe(2);
		expect(rec.decision_match).toBe(true);
		expect(countTaskFireRows()).toBe(0);
	});

	// --- (e) event task: no comparison record (R-DW18) ------------------------
	it("emits no comparison record for an event task (next_run_at NULL)", () => {
		const taskId = randomUUID();
		insertEventTask(taskId);

		const logs: Array<{ message: string; details: unknown }> = [];
		runPhase1(makeCapturingLogger(logs));

		// Event tasks are excluded from the phase-1 due scan (next_run_at IS NOT
		// NULL) entirely, so there is nothing to compare — and no firing.
		expect(comparisonRecords(logs)).toHaveLength(0);
		expect(countTaskFireRows()).toBe(0);
	});
});
