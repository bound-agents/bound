import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { setChangelogEventBus } from "@bound/core";
import type { ChangeLogEntry, Task } from "@bound/shared";
import { applyLWWReducer } from "@bound/sync";
import { EVICTION_SELECTOR_SQL, ORPHAN_HEARTBEAT_TIMEOUT } from "../scheduler";

describe("eviction host-liveness gate integration (R-LR2)", () => {
	let dbA: Database;
	let dbB: Database;
	let siteIdA: string;

	const EVICTION_TIMEOUT = 600_000; // 10 minutes
	const HOST_OFFLINE_TIMEOUT = 600_000;
	const ORPHAN_TIMEOUT = ORPHAN_HEARTBEAT_TIMEOUT; // 20 minutes

	function evictFrom(db: Database, now: Date): Task[] {
		const evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString();
		const hostOfflineThreshold = new Date(now.getTime() - HOST_OFFLINE_TIMEOUT).toISOString();
		const orphanThreshold = new Date(now.getTime() - ORPHAN_TIMEOUT).toISOString();
		return db
			.query<Task, [string, string, string]>(EVICTION_SELECTOR_SQL)
			.all(evictionTime, hostOfflineThreshold, orphanThreshold) as Task[];
	}

	beforeEach(() => {
		// Create two in-memory databases with full schema (simulating two hosts)
		dbA = createDatabase(":memory:");
		dbB = createDatabase(":memory:");

		applySchema(dbA);
		applySchema(dbB);

		// Disable event bus for tests to avoid side effects
		setChangelogEventBus(null);

		// Create a unique site ID for host A
		siteIdA = randomUUID();
	});

	afterEach(() => {
		dbA.close();
		dbB.close();
		// Restore event bus in case other tests need it
		setChangelogEventBus(null);
	});

	it("AC2.2: peer does not evict while lease-holder host-heartbeat is fresh", async () => {
		const taskId = randomUUID();
		const leaseId = randomUUID();
		const now = new Date();
		const pastTime30Min = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
		// 12 min: past EVICTION_TIMEOUT but below ORPHAN_HEARTBEAT_TIMEOUT, so a fresh host
		// still protects this not-yet-orphaned task. (Past the orphan threshold the orphan
		// arm overrides host liveness — see the ORPHAN integration test below.)
		const staleHeartbeat = new Date(now.getTime() - 12 * 60 * 1000).toISOString();
		const freshTime = new Date(now.getTime() - 30 * 1000).toISOString();
		const nowStr = now.toISOString();

		// Insert a running task on host A with stale (but not yet orphaned) heartbeat_at
		insertRow(
			dbA,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "running",
				trigger_spec: "0 * * * *",
				payload: null,
				thread_id: null,
				claimed_by: siteIdA,
				claimed_at: pastTime30Min,
				lease_id: leaseId,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: staleHeartbeat, // stale past eviction, below orphan threshold
				result: null,
				error: null,
				created_at: nowStr,
				created_by: "system",
				modified_at: nowStr,
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Insert host A with fresh modified_at to signal it's still alive
		insertRow(
			dbA,
			"hosts",
			{
				site_id: siteIdA,
				host_name: "test-host-a",
				version: "1.0",
				sync_url: null,
				mcp_servers: null,
				mcp_tools: null,
				models: null,
				overlay_root: null,
				online_at: nowStr,
				modified_at: freshTime,
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Get all changelog entries from dbA and replay them to dbB
		const allEntries = dbA
			.prepare("SELECT * FROM change_log ORDER BY hlc ASC")
			.all() as ChangeLogEntry[];

		for (const entry of allEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Run host B's eviction selector
		const tasksToEvict = evictFrom(dbB, now);

		// AC2.2: Should NOT evict because host A's modified_at is fresh and the task
		// is not yet orphaned.
		expect(tasksToEvict).toHaveLength(0);
	});

	it("ORPHAN: peer evicts a task stale past the orphan threshold even while the host-heartbeat is fresh (issue: d2ecf42d)", async () => {
		const taskId = randomUUID();
		const leaseId = randomUUID();
		const now = new Date();
		const orphanedHeartbeat = new Date(now.getTime() - 25 * 60 * 1000).toISOString();
		const freshTime = new Date(now.getTime() - 30 * 1000).toISOString();
		const nowStr = now.toISOString();

		// Running task whose heartbeat is 25 min stale — past ORPHAN_HEARTBEAT_TIMEOUT (20min).
		insertRow(
			dbA,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "running",
				trigger_spec: "0 * * * *",
				payload: null,
				thread_id: null,
				claimed_by: siteIdA,
				claimed_at: orphanedHeartbeat,
				lease_id: leaseId,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: orphanedHeartbeat, // orphaned: stale past the orphan threshold
				result: null,
				error: null,
				created_at: nowStr,
				created_by: "system",
				modified_at: nowStr,
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Host A's process is alive and fresh — under the pure host-liveness gate this
		// protected the task forever, wedging it (the d2ecf42d failure mode).
		insertRow(
			dbA,
			"hosts",
			{
				site_id: siteIdA,
				host_name: "test-host-a",
				version: "1.0",
				sync_url: null,
				mcp_servers: null,
				mcp_tools: null,
				models: null,
				overlay_root: null,
				online_at: nowStr,
				modified_at: freshTime,
				deleted: 0,
			} as any,
			siteIdA,
		);

		const allEntries = dbA
			.prepare("SELECT * FROM change_log ORDER BY hlc ASC")
			.all() as ChangeLogEntry[];
		for (const entry of allEntries) {
			applyLWWReducer(dbB, entry);
		}

		const tasksToEvict = evictFrom(dbB, now);

		// The orphan arm fires regardless of host liveness.
		expect(tasksToEvict).toHaveLength(1);
		expect(tasksToEvict[0].id).toBe(taskId);
	});

	it("AC2.1: peer evicts after lease-holder host-heartbeat goes stale", async () => {
		const taskId = randomUUID();
		const leaseId = randomUUID();
		const now = new Date();
		const pastTime30Min = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
		const nowStr = now.toISOString();

		// Insert a running task on host A with stale heartbeat_at
		insertRow(
			dbA,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "running",
				trigger_spec: "0 * * * *",
				payload: null,
				thread_id: null,
				claimed_by: siteIdA,
				claimed_at: pastTime30Min,
				lease_id: leaseId,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: pastTime30Min, // stale
				result: null,
				error: null,
				created_at: nowStr,
				created_by: "system",
				modified_at: nowStr,
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Insert host A with stale modified_at to signal it's offline
		insertRow(
			dbA,
			"hosts",
			{
				site_id: siteIdA,
				host_name: "test-host-a",
				version: "1.0",
				sync_url: null,
				mcp_servers: null,
				mcp_tools: null,
				models: null,
				overlay_root: null,
				online_at: nowStr,
				modified_at: pastTime30Min, // stale
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Get all changelog entries from dbA and replay them to dbB
		const allEntries = dbA
			.prepare("SELECT * FROM change_log ORDER BY hlc ASC")
			.all() as ChangeLogEntry[];

		for (const entry of allEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Run host B's eviction selector
		const evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString();
		const hostOfflineThreshold = new Date(now.getTime() - HOST_OFFLINE_TIMEOUT).toISOString();
		const tasksToEvict = dbB
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

		// AC2.1: Should evict because both task heartbeat and host modified_at are stale
		expect(tasksToEvict).toHaveLength(1);
		expect(tasksToEvict[0].id).toBe(taskId);
	});
});
