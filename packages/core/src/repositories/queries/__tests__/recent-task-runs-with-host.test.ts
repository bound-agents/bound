import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Host, Task } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import { listRecentTaskRunsWithHost } from "../recent-task-runs-with-host";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

/**
 * Seed a `tasks` row. Only the columns the schema declares are written (the
 * `Task` type carries `origin_thread_id` which the schema lacks, so it is
 * omitted via a cast through unknown). Nullable columns default to null.
 */
function seedTask(db: Database, overrides: Partial<Task> & { id: string }): void {
	const base = {
		id: overrides.id,
		type: "cron",
		status: "pending",
		trigger_spec: "0 * * * *",
		payload: null,
		thread_id: null,
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
		created_at: TS,
		created_by: null,
		modified_at: TS,
		deleted: 0,
		...overrides,
	};
	insertRow(db, "tasks", base as unknown as Task, SITE_ID);
}

/**
 * Seed a `hosts` row. The `hosts` table carries a `deleted` column in the schema
 * even though the `Host` type omits it; the query filters `h.deleted = 0`, so we
 * thread a `deleted` value in via a cast.
 */
function seedHost(db: Database, siteId: string, hostName: string, deleted = 0): void {
	const row = {
		site_id: siteId,
		host_name: hostName,
		version: null,
		sync_url: null,
		mcp_servers: null,
		mcp_tools: null,
		mcp_tool_annotations: null,
		mcp_capabilities: null,
		models: null,
		overlay_root: null,
		online_at: null,
		modified_at: TS,
		platforms: null,
		deleted,
	} as Host & { deleted: number };
	insertRow(db, "hosts", row, SITE_ID);
}

describe("listRecentTaskRunsWithHost", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("happy path + projection shape", () => {
		it("projects the exact column set with the claiming host's host_name resolved", () => {
			seedHost(db, "host-a", "alpha");
			seedTask(db, {
				id: "task-1",
				type: "cron",
				trigger_spec: "0 9 * * *",
				last_run_at: "2026-02-02T00:00:00.000Z",
				run_count: 7,
				consecutive_failures: 2,
				claimed_by: "host-a",
			});

			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows).toHaveLength(1);
			// Hand-written oracle: the EXACT projection call sites destructure.
			expect(rows[0]).toEqual({
				id: "task-1",
				type: "cron",
				trigger_spec: "0 9 * * *",
				last_run_at: "2026-02-02T00:00:00.000Z",
				run_count: 7,
				consecutive_failures: 2,
				claimed_by: "host-a",
				host_name: "alpha",
			});
			// Exact key set — guards against projection drift.
			expect(Object.keys(rows[0]).sort()).toEqual(
				[
					"claimed_by",
					"consecutive_failures",
					"host_name",
					"id",
					"last_run_at",
					"run_count",
					"trigger_spec",
					"type",
				].sort(),
			);
		});

		it("returns [] when no task has run after the baseline", () => {
			seedTask(db, {
				id: "task-old",
				last_run_at: "2025-12-31T00:00:00.000Z",
				claimed_by: null,
			});
			// baseline TS = 2026-01-01 is strictly after the run; excluded.
			expect(listRecentTaskRunsWithHost(db, TS, 10)).toEqual([]);
		});

		it("returns [] over an empty tasks table", () => {
			expect(listRecentTaskRunsWithHost(db, TS, 10)).toEqual([]);
		});
	});

	describe("LEFT JOIN null case — claiming host absent or unclaimed", () => {
		it("returns host_name=null when the task is unclaimed (claimed_by is null)", () => {
			seedTask(db, {
				id: "task-unclaimed",
				last_run_at: "2026-03-03T00:00:00.000Z",
				run_count: 1,
				claimed_by: null,
			});

			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows).toHaveLength(1);
			expect(rows[0].id).toBe("task-unclaimed");
			expect(rows[0].claimed_by).toBeNull();
			// No right-side match -> nullable projected column comes back null.
			expect(rows[0].host_name).toBeNull();
		});

		it("returns host_name=null when claimed_by points at a host that does not exist", () => {
			seedTask(db, {
				id: "task-ghost-host",
				last_run_at: "2026-03-03T00:00:00.000Z",
				claimed_by: "host-ghost",
			});

			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows).toHaveLength(1);
			// The left row survives; the missing right side yields a null host_name.
			expect(rows[0].claimed_by).toBe("host-ghost");
			expect(rows[0].host_name).toBeNull();
		});

		it("excludes a soft-deleted host from the join (join filters h.deleted=0)", () => {
			seedHost(db, "host-dead", "zombie", 1);
			seedTask(db, {
				id: "task-dead-host",
				last_run_at: "2026-03-03T00:00:00.000Z",
				claimed_by: "host-dead",
			});

			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows).toHaveLength(1);
			// Task is retained, but the tombstoned host contributes no host_name.
			expect(rows[0].claimed_by).toBe("host-dead");
			expect(rows[0].host_name).toBeNull();
		});
	});

	describe("deleted + null filtering on the left (tasks) side", () => {
		it("excludes a soft-deleted task (WHERE t.deleted=0)", () => {
			seedHost(db, "host-a", "alpha");
			seedTask(db, {
				id: "task-gone",
				last_run_at: "2026-04-04T00:00:00.000Z",
				claimed_by: "host-a",
			});
			softDelete(db, "tasks", "task-gone", SITE_ID);

			expect(listRecentTaskRunsWithHost(db, TS, 10)).toEqual([]);
		});

		it("excludes a task with last_run_at IS NULL", () => {
			seedTask(db, { id: "task-never-run", last_run_at: null });
			expect(listRecentTaskRunsWithHost(db, TS, 10)).toEqual([]);
		});

		it("uses a strict > baseline comparison (a run exactly at baseline is excluded)", () => {
			seedTask(db, { id: "task-at-baseline", last_run_at: TS });
			// last_run_at > baseline is strict; equality must NOT match.
			expect(listRecentTaskRunsWithHost(db, TS, 10)).toEqual([]);

			seedTask(db, {
				id: "task-after-baseline",
				last_run_at: "2026-01-01T00:00:00.001Z",
			});
			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows.map((r) => r.id)).toEqual(["task-after-baseline"]);
		});
	});

	describe("ordering by last_run_at DESC", () => {
		it("orders most-recent-run first", () => {
			seedTask(db, { id: "task-old", last_run_at: "2026-02-01T00:00:00.000Z" });
			seedTask(db, { id: "task-new", last_run_at: "2026-05-01T00:00:00.000Z" });
			seedTask(db, { id: "task-mid", last_run_at: "2026-03-01T00:00:00.000Z" });

			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows.map((r) => r.id)).toEqual(["task-new", "task-mid", "task-old"]);
		});

		it("resolves each row's host_name independently across mixed claims", () => {
			seedHost(db, "host-a", "alpha");
			seedHost(db, "host-b", "bravo");
			seedTask(db, {
				id: "task-a",
				last_run_at: "2026-05-01T00:00:00.000Z",
				claimed_by: "host-a",
			});
			seedTask(db, {
				id: "task-b",
				last_run_at: "2026-04-01T00:00:00.000Z",
				claimed_by: "host-b",
			});
			seedTask(db, {
				id: "task-c",
				last_run_at: "2026-03-01T00:00:00.000Z",
				claimed_by: null,
			});

			const rows = listRecentTaskRunsWithHost(db, TS, 10);
			expect(rows.map((r) => ({ id: r.id, host_name: r.host_name }))).toEqual([
				{ id: "task-a", host_name: "alpha" },
				{ id: "task-b", host_name: "bravo" },
				{ id: "task-c", host_name: null },
			]);
		});
	});

	describe("LIMIT cap + overflow detection", () => {
		it("caps result count at limit and keeps the most-recent rows", () => {
			// Seed 5 distinct runs; cap at 3 -> keep the 3 newest.
			seedTask(db, { id: "t1", last_run_at: "2026-01-02T00:00:00.000Z" });
			seedTask(db, { id: "t2", last_run_at: "2026-01-03T00:00:00.000Z" });
			seedTask(db, { id: "t3", last_run_at: "2026-01-04T00:00:00.000Z" });
			seedTask(db, { id: "t4", last_run_at: "2026-01-05T00:00:00.000Z" });
			seedTask(db, { id: "t5", last_run_at: "2026-01-06T00:00:00.000Z" });

			const rows = listRecentTaskRunsWithHost(db, TS, 3);
			expect(rows).toHaveLength(3);
			// DESC order: the three newest survive.
			expect(rows.map((r) => r.id)).toEqual(["t5", "t4", "t3"]);
		});

		it("returns maxTasks+1 rows so callers can detect overflow (limit = N+1)", () => {
			for (let i = 1; i <= 4; i++) {
				seedTask(db, {
					id: `over-${i}`,
					last_run_at: `2026-01-0${i + 1}T00:00:00.000Z`,
				});
			}
			// maxTasks = 2 -> caller passes 3, sees 3 rows (> maxTasks) and knows there's overflow.
			const rows = listRecentTaskRunsWithHost(db, TS, 3);
			expect(rows).toHaveLength(3);
			expect(rows.map((r) => r.id)).toEqual(["over-4", "over-3", "over-2"]);
		});
	});
});
