import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { Task } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { EVICTION_SELECTOR_SQL } from "../scheduler";

describe("eviction host-liveness gate (R-LR2, R-LR7)", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;

	const EVICTION_TIMEOUT = 600_000; // 10 minutes
	const HOST_HEARTBEAT_INTERVAL = 120_000;
	const HOST_OFFLINE_TIMEOUT = Math.max(EVICTION_TIMEOUT, 2 * HOST_HEARTBEAT_INTERVAL);
	const ORPHAN_HEARTBEAT_TIMEOUT = 2 * EVICTION_TIMEOUT; // 20 minutes

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "eviction-host-liveness-test-"));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	beforeEach(() => {
		// Clear tables before each test to ensure isolation
		db.exec("DELETE FROM tasks");
		db.exec("DELETE FROM hosts");
	});

	function runEvictionSelector(
		evictionTimeMs: number,
		hostOfflineTimeoutMs: number,
		orphanTimeoutMs: number = ORPHAN_HEARTBEAT_TIMEOUT,
		now = new Date(),
	): Task[] {
		const evictionTime = new Date(now.getTime() - evictionTimeMs).toISOString();
		const hostOfflineThreshold = new Date(now.getTime() - hostOfflineTimeoutMs).toISOString();
		const orphanThreshold = new Date(now.getTime() - orphanTimeoutMs).toISOString();

		// Exercise the exact production statement, not a hand-copied duplicate, so any
		// drift in the production SQL surfaces here (mirrors the STALE_TASK_RESET_SQL pattern).
		const tasksToEvict = db
			.query<Task, [string, string, string]>(EVICTION_SELECTOR_SQL)
			.all(evictionTime, hostOfflineThreshold, orphanThreshold) as Task[];

		return tasksToEvict;
	}

	function insertTask(
		taskId: string,
		claimedBySiteId: string,
		heartbeatAtMs: number,
		now = new Date(),
	): void {
		const heartbeatAt = new Date(now.getTime() - heartbeatAtMs).toISOString();
		const nowStr = now.toISOString();

		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				taskId,
				"cron",
				"running",
				"0 * * * *",
				null,
				null,
				claimedBySiteId,
				nowStr,
				"lease-1",
				null,
				null,
				0,
				null,
				null,
				null,
				0,
				"status",
				null,
				0,
				5,
				0,
				0,
				0,
				heartbeatAt,
				null,
				null,
				nowStr,
				"system",
				nowStr,
				0,
			],
		);
	}

	function insertHost(
		siteId: string,
		modifiedAtMs: number | null,
		onlineAtMs: number | null,
		now = new Date(),
	): void {
		// modified_at is NOT NULL in schema — always provide a value
		// If modifiedAtMs is null, use the current time (fresh)
		const modifiedAt =
			modifiedAtMs !== null
				? new Date(now.getTime() - modifiedAtMs).toISOString()
				: now.toISOString();
		const onlineAt =
			onlineAtMs !== null ? new Date(now.getTime() - onlineAtMs).toISOString() : null;

		db.run(
			`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[siteId, "test-host", "1.0", null, null, null, null, onlineAt, modifiedAt, 0],
		);
	}

	it("evicts when both task heartbeat_at and host modified_at are stale", () => {
		const taskId = randomUUID();
		const siteId = "stale-host";
		const now = new Date("2026-01-01T00:00:00.000Z");

		insertTask(taskId, siteId, EVICTION_TIMEOUT + 60_000, now);
		insertHost(siteId, HOST_OFFLINE_TIMEOUT + 60_000, null, now);

		const evicted = runEvictionSelector(
			EVICTION_TIMEOUT,
			HOST_OFFLINE_TIMEOUT,
			ORPHAN_HEARTBEAT_TIMEOUT,
			now,
		);
		expect(evicted.map((task) => task.id)).toEqual([taskId]);
	});

	it("does not evict at the strict eviction, host, or orphan boundaries", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const cases = [
			{ taskAge: EVICTION_TIMEOUT, hostAge: HOST_OFFLINE_TIMEOUT + 60_000 },
			{ taskAge: EVICTION_TIMEOUT + 60_000, hostAge: HOST_OFFLINE_TIMEOUT },
			{ taskAge: ORPHAN_HEARTBEAT_TIMEOUT, hostAge: 0 },
		];

		for (const [index, { taskAge, hostAge }] of cases.entries()) {
			const taskId = `strict-boundary-${index}`;
			const siteId = `strict-boundary-host-${index}`;
			insertTask(taskId, siteId, taskAge, now);
			insertHost(siteId, hostAge, null, now);
		}

		const evicted = runEvictionSelector(
			EVICTION_TIMEOUT,
			HOST_OFFLINE_TIMEOUT,
			ORPHAN_HEARTBEAT_TIMEOUT,
			now,
		);
		expect(evicted).toEqual([]);
	});

	it("does not evict a stale but non-orphaned task while its host is fresh", () => {
		const taskId = randomUUID();
		const siteId = "fresh-host";
		const now = new Date("2026-01-01T00:00:00.000Z");

		insertTask(taskId, siteId, EVICTION_TIMEOUT + 60_000, now);
		insertHost(siteId, 0, null, now);

		const evicted = runEvictionSelector(
			EVICTION_TIMEOUT,
			HOST_OFFLINE_TIMEOUT,
			ORPHAN_HEARTBEAT_TIMEOUT,
			now,
		);
		expect(evicted).toEqual([]);
	});

	it("LEFT JOIN: missing host row permits eviction (decommissioned host)", () => {
		const taskId = randomUUID();
		const decommissionedSite = "decommissioned-site";

		// Insert running task with stale heartbeat_at
		insertTask(taskId, decommissionedSite, 30 * 60 * 1000);

		// Do NOT insert a hosts row for this site_id
		// The LEFT JOIN will produce NULL for h.site_id, h.modified_at, h.online_at
		// The OR branch (h.site_id IS NULL) will fire, permitting eviction

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(1);
		expect(evicted[0].id).toBe(taskId);
	});

	it("ORPHAN: evicts a running task whose heartbeat is stale beyond the orphan threshold even when the host process is fresh (issue: d2ecf42d)", () => {
		const taskId = randomUUID();
		const siteF = "site-F";

		// Task heartbeat 25 minutes stale — past ORPHAN_HEARTBEAT_TIMEOUT (20min).
		insertTask(taskId, siteF, 25 * 60 * 1000);

		// Host process is alive and fresh (modified_at 30s ago). Under the pure
		// host-liveness gate this protected the task forever, wedging it. Host-process
		// liveness is NOT task-lease liveness: a live host can leave a task orphaned
		// (e.g. its agent loop was interrupted mid-flight by a restart that re-registered
		// the host row before the in-flight task could resume). The orphan arm makes a
		// heartbeat this stale sufficient on its own, regardless of host liveness.
		insertHost(siteF, 30 * 1000, null);

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(1);
		expect(evicted[0].id).toBe(taskId);
	});

	it("ORPHAN boundary: host-liveness still protects a task stale past eviction but not yet orphaned", () => {
		const taskId = randomUUID();
		const siteG = "site-G";

		// Heartbeat 12 minutes stale: past EVICTION_TIMEOUT (10min) so it clears the
		// AND gate, but below ORPHAN_HEARTBEAT_TIMEOUT (20min). With a fresh host the
		// task is NOT yet orphaned, so host liveness still protects it.
		insertTask(taskId, siteG, 12 * 60 * 1000);
		insertHost(siteG, 30 * 1000, null);

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(0);
	});

	it("Edge case: claimed_by IS NULL (corruption state) permits eviction", () => {
		const taskId = randomUUID();

		// Insert running task with stale heartbeat_at and NULL claimed_by (corruption state)
		// This is an unlikely scenario but possible if the database is corrupted
		const now = new Date();
		const heartbeatAt = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
		const nowStr = now.toISOString();

		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				taskId,
				"cron",
				"running",
				"0 * * * *",
				null,
				null,
				null, // claimed_by IS NULL (corruption)
				null,
				null,
				null,
				null,
				0,
				null,
				null,
				null,
				0,
				"status",
				null,
				0,
				5,
				0,
				0,
				0,
				heartbeatAt,
				null,
				null,
				nowStr,
				"system",
				nowStr,
				0,
			],
		);

		// Do NOT insert a hosts row; claimed_by is NULL anyway
		// The LEFT JOIN ON clause (h.site_id = t.claimed_by) won't match on NULL
		// so h.site_id will be NULL, and the OR branch (h.site_id IS NULL) fires

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(1);
		expect(evicted[0].id).toBe(taskId);
	});
});
