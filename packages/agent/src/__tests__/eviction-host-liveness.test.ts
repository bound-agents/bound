import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { Task } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";

describe("eviction host-liveness gate (R-LR2, R-LR7)", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;

	const EVICTION_TIMEOUT = 600_000; // 10 minutes
	const HOST_HEARTBEAT_INTERVAL = 120_000;
	const HOST_OFFLINE_TIMEOUT = Math.max(EVICTION_TIMEOUT, 2 * HOST_HEARTBEAT_INTERVAL);

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

	function runEvictionSelector(evictionTimeMs: number, hostOfflineTimeoutMs: number): Task[] {
		const now = new Date();
		const evictionTime = new Date(now.getTime() - evictionTimeMs).toISOString();
		const hostOfflineThreshold = new Date(now.getTime() - hostOfflineTimeoutMs).toISOString();

		const tasksToEvict = db
			.query<Task, [string, string]>(
				`SELECT t.*
				 FROM tasks t
				 LEFT JOIN hosts h ON h.site_id = t.claimed_by
				 WHERE t.status = 'running'
				   AND t.deleted = 0
				   AND t.heartbeat_at < ?
				   AND (
					   h.site_id IS NULL
					   OR COALESCE(h.modified_at, h.online_at) < ?
				   )`,
			)
			.all(evictionTime, hostOfflineThreshold) as Task[];

		return tasksToEvict;
	}

	function insertTask(taskId: string, claimedBySiteId: string, heartbeatAtMs: number): void {
		const now = new Date();
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
	): void {
		const now = new Date();
		// modified_at is NOT NULL in schema — always provide a value
		// If modifiedAtMs is null, use the current time (fresh)
		const modifiedAt =
			modifiedAtMs !== null
				? new Date(now.getTime() - modifiedAtMs).toISOString()
				: now.toISOString();
		const onlineAt =
			onlineAtMs !== null ? new Date(now.getTime() - onlineAtMs).toISOString() : null;

		db.run(
			`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[siteId, "test-host", "1.0", null, null, null, null, null, onlineAt, modifiedAt, 0],
		);
	}

	it("AC2.1: evicts when both task heartbeat_at and host modified_at are stale", () => {
		const taskId = randomUUID();
		const siteA = "site-A";

		// Insert running task with stale heartbeat_at (30 minutes old)
		insertTask(taskId, siteA, 30 * 60 * 1000);

		// Insert host row with stale modified_at (30 minutes old)
		insertHost(siteA, 30 * 60 * 1000, null);

		// Run eviction selector with timeouts
		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(1);
		expect(evicted[0].id).toBe(taskId);
	});

	it("AC2.2: does not evict when task heartbeat_at is stale but host modified_at is fresh", () => {
		const taskId = randomUUID();
		const siteB = "site-B";

		// Insert running task with stale heartbeat_at (30 minutes old)
		insertTask(taskId, siteB, 30 * 60 * 1000);

		// Insert host row with fresh modified_at (30 seconds old)
		insertHost(siteB, 30 * 1000, null);

		// Run eviction selector with timeouts
		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(0);
	});

	it("AC7.1: COALESCE(modified_at, online_at) — stale modified_at, NULL online_at permits eviction", () => {
		const taskId = randomUUID();
		const siteC = "site-C";

		// Insert running task with stale heartbeat_at (30 minutes old)
		insertTask(taskId, siteC, 30 * 60 * 1000);

		// Insert host row: stale modified_at, NULL online_at
		// COALESCE(modified_at, online_at) = stale modified_at → permits eviction
		insertHost(siteC, 30 * 60 * 1000, null);

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(1);
		expect(evicted[0].id).toBe(taskId);
	});

	it("AC7.1: COALESCE(modified_at, online_at) — fresh modified_at, stale online_at does not permit eviction", () => {
		const taskId = randomUUID();
		const siteD = "site-D";

		// Insert running task with stale heartbeat_at (30 minutes old)
		insertTask(taskId, siteD, 30 * 60 * 1000);

		// Insert host row: fresh modified_at (30s), stale online_at (30min)
		// COALESCE(modified_at, online_at) = fresh modified_at → does NOT permit eviction
		insertHost(siteD, 30 * 1000, 30 * 60 * 1000);

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(0);
	});

	it("AC7.1: COALESCE(modified_at, online_at) — stale modified_at, stale online_at permits eviction (unreachable NULL modified_at path)", () => {
		const taskId = randomUUID();
		const siteE = "site-E";

		// Insert running task with stale heartbeat_at (30 minutes old)
		insertTask(taskId, siteE, 30 * 60 * 1000);

		// Insert host row: stale modified_at (30min), stale online_at (30min)
		// COALESCE(modified_at, online_at) = stale modified_at → permits eviction
		// Note: The COALESCE fallback to online_at is tested here but never reaches it
		// because schema enforces hosts.modified_at NOT NULL, so COALESCE always returns
		// the non-NULL modified_at value. This test documents the expected behavior should
		// the schema change to allow NULL modified_at in the future.
		insertHost(siteE, 30 * 60 * 1000, 30 * 60 * 1000);

		const evicted = runEvictionSelector(EVICTION_TIMEOUT, HOST_OFFLINE_TIMEOUT);

		expect(evicted).toHaveLength(1);
		expect(evicted[0].id).toBe(taskId);
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
