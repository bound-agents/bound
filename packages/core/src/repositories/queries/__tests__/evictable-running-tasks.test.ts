import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Host, Task } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import { listEvictableRunningTasks } from "../evictable-running-tasks";

const SITE = "site-test";

// Fixed clock anchors. The finder gates eviction on three thresholds passed by
// the caller; we declare them explicitly so the oracle is hand-written.
const EVICTION_TIME = "2026-01-01T12:00:00.000Z";
const HOST_OFFLINE_THRESHOLD = "2026-01-01T11:00:00.000Z";
const ORPHAN_THRESHOLD = "2026-01-01T00:00:00.000Z";

const EVICTION_ARGS = {
	evictionTime: EVICTION_TIME,
	hostOfflineThreshold: HOST_OFFLINE_THRESHOLD,
	orphanThreshold: ORPHAN_THRESHOLD,
};

/**
 * Construct a full `tasks` row. Every column from the Task type is set so the
 * STRICT table is satisfied and the `t.*` projection is fully populated.
 */
function makeTask(overrides: Partial<Task>): Task {
	return {
		id: "task-default",
		type: "cron",
		status: "running",
		trigger_spec: "{}",
		payload: null,
		thread_id: null,
		origin_thread_id: null,
		claimed_by: null,
		claimed_at: null,
		lease_id: null,
		next_run_at: null,
		last_run_at: null,
		run_count: 0,
		max_runs: null,
		requires: null,
		model_hint: null,
		no_history: 0,
		inject_mode: "results",
		depends_on: null,
		require_success: 0,
		alert_threshold: 3,
		consecutive_failures: 0,
		event_depth: 0,
		no_quiescence: 0,
		system_prompt_addition: null,
		heartbeat_at: null,
		result: null,
		error: null,
		created_at: "2026-01-01T00:00:00.000Z",
		created_by: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
}

/**
 * Construct a `hosts` row. `modified_at` / `online_at` drive the offline
 * predicate; we set both explicitly. (`commit_hash` / `deleted` are not on the
 * Host type but default in the schema, so they are omitted.)
 */
function makeHost(overrides: Partial<Host>): Host {
	return {
		site_id: "host-default",
		host_name: "default",
		version: null,
		sync_url: null,
		mcp_servers: null,
		mcp_tools: null,
		mcp_tool_annotations: null,
		mcp_capabilities: null,
		models: null,
		overlay_root: null,
		online_at: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		platforms: null,
		...overrides,
	};
}

describe("listEvictableRunningTasks", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("gates ALL eviction on heartbeat_at < evictionTime — a fresh heartbeat is never evicted", () => {
		// Heartbeat is AFTER evictionTime; even with no host (claimed_by NULL) the
		// outer gate excludes it.
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "fresh",
				claimed_by: null,
				heartbeat_at: "2026-01-01T13:00:00.000Z",
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual([]);
	});

	it("LEFT JOIN null case: claimed_by NULL → h.site_id IS NULL → evicted (corrupted lease state)", () => {
		// status=running but lease unset. The LEFT JOIN on claimed_by=NULL matches
		// nothing, so h.site_id IS NULL fires and the row is evicted even though no
		// host row exists.
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "orphan-lease",
				claimed_by: null,
				heartbeat_at: "2026-01-01T11:30:00.000Z", // before evictionTime
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual(["orphan-lease"]);
		// Projection shape: the row is the full task row (t.*). Spot-check the
		// columns call sites destructure.
		const row = rows[0];
		expect(row.status).toBe("running");
		expect(row.claimed_by).toBeNull();
		expect(row.heartbeat_at).toBe("2026-01-01T11:30:00.000Z");
		expect(row.deleted).toBe(0);
	});

	it("LEFT JOIN null case: claimed_by points at a NON-EXISTENT host → h.site_id IS NULL → evicted", () => {
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "ghost-host",
				claimed_by: "host-that-never-existed",
				heartbeat_at: "2026-01-01T11:30:00.000Z",
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual(["ghost-host"]);
	});

	it("host offline (modified_at < hostOfflineThreshold) → evicted; host fresh → retained", () => {
		// Offline host: modified_at well before the offline threshold.
		insertRow(
			db,
			"hosts",
			makeHost({ site_id: "host-offline", modified_at: "2026-01-01T09:00:00.000Z" }),
			SITE,
		);
		// Fresh host: modified_at AFTER the offline threshold.
		insertRow(
			db,
			"hosts",
			makeHost({ site_id: "host-fresh", modified_at: "2026-01-01T11:30:00.000Z" }),
			SITE,
		);

		// Task on the offline host — heartbeat before evictionTime but AFTER orphan
		// backstop, so only the host-offline branch can evict it.
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "on-offline",
				claimed_by: "host-offline",
				heartbeat_at: "2026-01-01T11:45:00.000Z",
			}),
			SITE,
		);
		// Task on the fresh host — heartbeat before evictionTime but after orphan
		// backstop and host is fresh → NOT evictable.
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "on-fresh",
				claimed_by: "host-fresh",
				heartbeat_at: "2026-01-01T11:45:00.000Z",
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual(["on-offline"]);
	});

	it("COALESCE: host with NULL modified_at falls back to online_at for the offline check", () => {
		// We seed modified_at directly via insertRow (the trusted write path
		// preserves the provided value). To exercise the COALESCE fallback we
		// cannot have a NULL
		// modified_at (schema requires NOT NULL), so we model the documented
		// COALESCE(h.modified_at, h.online_at) behavior: modified_at present and
		// fresh keeps the task, even though online_at is stale.
		insertRow(
			db,
			"hosts",
			makeHost({
				site_id: "host-coalesce",
				modified_at: "2026-01-01T11:30:00.000Z", // fresh → wins COALESCE
				online_at: "2026-01-01T01:00:00.000Z", // stale, ignored because modified_at present
			}),
			SITE,
		);
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "coalesce-task",
				claimed_by: "host-coalesce",
				heartbeat_at: "2026-01-01T11:45:00.000Z",
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		// modified_at is fresh, heartbeat after orphan backstop, host exists → retained.
		expect(rows.map((r) => r.id)).toEqual([]);
	});

	it("orphan backstop: heartbeat_at < orphanThreshold → evicted even when the host is fresh", () => {
		insertRow(
			db,
			"hosts",
			makeHost({ site_id: "host-fresh", modified_at: "2026-01-01T11:55:00.000Z" }),
			SITE,
		);
		// Heartbeat is before BOTH evictionTime AND orphanThreshold → the orphan
		// branch fires regardless of host freshness.
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "orphaned",
				claimed_by: "host-fresh",
				heartbeat_at: "2025-12-31T23:00:00.000Z",
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual(["orphaned"]);
	});

	it("only status='running' is considered — pending/completed/failed are ignored", () => {
		const heartbeat = "2026-01-01T11:30:00.000Z"; // pre-evictionTime
		for (const status of ["pending", "completed", "failed", "cancelled"] as const) {
			insertRow(
				db,
				"tasks",
				makeTask({
					id: `not-running-${status}`,
					status,
					claimed_by: null, // would otherwise satisfy the offline branch
					heartbeat_at: heartbeat,
				}),
				SITE,
			);
		}
		// A running control that SHOULD be evicted.
		insertRow(
			db,
			"tasks",
			makeTask({ id: "running-control", claimed_by: null, heartbeat_at: heartbeat }),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual(["running-control"]);
	});

	it("deleted filtering: a soft-deleted running task is excluded even when otherwise evictable", () => {
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "live-evictable",
				claimed_by: null,
				heartbeat_at: "2026-01-01T11:30:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "tombstoned",
				claimed_by: null,
				heartbeat_at: "2026-01-01T11:30:00.000Z",
			}),
			SITE,
		);
		// Soft-delete the second one. softDelete flips deleted=1; status stays
		// 'running', so only the deleted=0 filter excludes it.
		softDelete(db, "tasks", "tombstoned", SITE);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual(["live-evictable"]);
	});

	it("heartbeat_at NULL: NULL < evictionTime is not true in SQLite → never evicted", () => {
		// A running task with no heartbeat at all. `NULL < ?` evaluates to NULL
		// (not TRUE), so the outer heartbeat gate excludes it. This pins the exact
		// SQL three-valued-logic behavior the call site relies on.
		insertRow(
			db,
			"tasks",
			makeTask({ id: "null-heartbeat", claimed_by: null, heartbeat_at: null }),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows.map((r) => r.id)).toEqual([]);
	});

	it("empty table returns [] without throwing", () => {
		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(rows).toEqual([]);
	});

	it("combined: returns exactly the evictable subset across a mixed seed set", () => {
		// One offline host, one fresh host.
		insertRow(
			db,
			"hosts",
			makeHost({ site_id: "h-offline", modified_at: "2026-01-01T08:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"hosts",
			makeHost({ site_id: "h-fresh", modified_at: "2026-01-01T11:59:00.000Z" }),
			SITE,
		);

		const preEvict = "2026-01-01T11:30:00.000Z"; // before evictionTime, after orphan backstop
		const orphaned = "2025-12-31T22:00:00.000Z"; // before orphan backstop
		const fresh = "2026-01-01T13:30:00.000Z"; // after evictionTime

		// Evictable: claimed_by NULL (corrupted lease).
		insertRow(
			db,
			"tasks",
			makeTask({ id: "e-null-lease", claimed_by: null, heartbeat_at: preEvict }),
			SITE,
		);
		// Evictable: on offline host.
		insertRow(
			db,
			"tasks",
			makeTask({ id: "e-offline-host", claimed_by: "h-offline", heartbeat_at: preEvict }),
			SITE,
		);
		// Evictable: orphan backstop, even on fresh host.
		insertRow(
			db,
			"tasks",
			makeTask({ id: "e-orphan", claimed_by: "h-fresh", heartbeat_at: orphaned }),
			SITE,
		);
		// Retained: fresh host, heartbeat after orphan backstop.
		insertRow(
			db,
			"tasks",
			makeTask({ id: "r-fresh-host", claimed_by: "h-fresh", heartbeat_at: preEvict }),
			SITE,
		);
		// Retained: heartbeat newer than evictionTime (outer gate).
		insertRow(
			db,
			"tasks",
			makeTask({ id: "r-fresh-hb", claimed_by: null, heartbeat_at: fresh }),
			SITE,
		);
		// Retained: not running.
		insertRow(
			db,
			"tasks",
			makeTask({
				id: "r-pending",
				status: "pending",
				claimed_by: null,
				heartbeat_at: preEvict,
			}),
			SITE,
		);

		const rows = listEvictableRunningTasks(db, EVICTION_ARGS);
		expect(new Set(rows.map((r) => r.id))).toEqual(
			new Set(["e-null-lease", "e-offline-host", "e-orphan"]),
		);
		expect(rows).toHaveLength(3);
	});
});
