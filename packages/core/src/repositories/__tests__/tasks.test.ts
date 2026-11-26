import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Task } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	countRunningTasks,
	findActiveTaskById,
	findActiveTaskPayloadById,
	findLatestTaskSettingsForThread,
	findRunningTaskIdForThread,
	findTaskById,
	findTaskClaimById,
	findTaskClaimedAtById,
	findTaskExistenceById,
	findTaskIdAndStatusById,
	findTaskIdById,
	findTaskRunTimestampsById,
	listActiveTasks,
	listActiveTasksWithPayload,
} from "../tasks";

const SITE_ID = "site-test";

/** Build a fully-populated Task row with sensible defaults; override per test. */
function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		id: overrides.id,
		type: "cron",
		status: "pending",
		trigger_spec: "0 * * * *",
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

function seed(db: Database, overrides: Partial<Task> & { id: string }): Task {
	const task = makeTask(overrides);
	insertRow(db, "tasks", task, SITE_ID);
	return task;
}

describe("repositories/tasks", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	// --- Simple by-id finders (representative happy + miss paths) ---

	describe("findTaskById", () => {
		it("returns the full row when present", () => {
			seed(db, { id: "t1", status: "running", trigger_spec: "spec-1" });
			const row = findTaskById(db, "t1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("t1");
			expect(row?.status).toBe("running");
			expect(row?.trigger_spec).toBe("spec-1");
		});

		it("returns null on a miss", () => {
			expect(findTaskById(db, "absent")).toBeNull();
		});

		it("returns soft-deleted rows too (no deleted filter)", () => {
			seed(db, { id: "tombstone" });
			softDelete(db, "tasks", "tombstone", SITE_ID);
			const row = findTaskById(db, "tombstone");
			expect(row).not.toBeNull();
			expect(row?.deleted).toBe(1);
		});
	});

	describe("findActiveTaskById", () => {
		it("returns a live row", () => {
			seed(db, { id: "live" });
			expect(findActiveTaskById(db, "live")?.id).toBe("live");
		});

		it("returns null for a soft-deleted row (deleted=0 filter)", () => {
			seed(db, { id: "gone" });
			softDelete(db, "tasks", "gone", SITE_ID);
			expect(findActiveTaskById(db, "gone")).toBeNull();
		});

		it("returns null on a miss", () => {
			expect(findActiveTaskById(db, "absent")).toBeNull();
		});
	});

	describe("findTaskClaimedAtById", () => {
		it("returns claimed_at", () => {
			seed(db, { id: "c1", claimed_at: "2026-02-02T00:00:00.000Z" });
			expect(findTaskClaimedAtById(db, "c1")).toEqual({
				claimed_at: "2026-02-02T00:00:00.000Z",
			});
		});

		it("returns null on a miss", () => {
			expect(findTaskClaimedAtById(db, "absent")).toBeNull();
		});
	});

	describe("findTaskRunTimestampsById", () => {
		it("returns last_run_at and created_at", () => {
			seed(db, {
				id: "r1",
				created_at: "2026-01-05T00:00:00.000Z",
				last_run_at: "2026-01-06T00:00:00.000Z",
			});
			expect(findTaskRunTimestampsById(db, "r1")).toEqual({
				last_run_at: "2026-01-06T00:00:00.000Z",
				created_at: "2026-01-05T00:00:00.000Z",
			});
		});

		it("returns null on a miss", () => {
			expect(findTaskRunTimestampsById(db, "absent")).toBeNull();
		});
	});

	describe("findTaskClaimById", () => {
		it("returns claim/lease/status/deleted columns", () => {
			seed(db, {
				id: "cl1",
				claimed_by: "host-a",
				lease_id: "lz1",
				status: "claimed",
			});
			expect(findTaskClaimById(db, "cl1")).toEqual({
				claimed_by: "host-a",
				lease_id: "lz1",
				status: "claimed",
				deleted: 0,
			});
		});

		it("returns null on a miss", () => {
			expect(findTaskClaimById(db, "absent")).toBeNull();
		});
	});

	describe("findTaskIdAndStatusById / findTaskIdById", () => {
		it("findTaskIdAndStatusById returns id and status", () => {
			seed(db, { id: "is1", status: "running" });
			expect(findTaskIdAndStatusById(db, "is1")).toEqual({ id: "is1", status: "running" });
		});

		it("findTaskIdById returns id only", () => {
			seed(db, { id: "id1" });
			expect(findTaskIdById(db, "id1")).toEqual({ id: "id1" });
		});

		it("both return null on a miss", () => {
			expect(findTaskIdAndStatusById(db, "absent")).toBeNull();
			expect(findTaskIdById(db, "absent")).toBeNull();
		});
	});

	// --- deleted-filter behavior: existence/status finders OMIT the deleted=0 filter ---

	describe("findTaskExistenceById (deleted-omission, exposes tombstone)", () => {
		it("returns null on a true miss", () => {
			expect(findTaskExistenceById(db, "absent")).toBeNull();
		});
	});

	// --- Active (deleted=0) detail finders ---

	describe("active detail finders respect deleted=0", () => {
		beforeEach(() => {
			seed(db, {
				id: "act",
				type: "event",
				thread_id: "thr-1",
				payload: JSON.stringify({ a: 1 }),
			});
		});

		it("findActiveTaskPayloadById returns payload for live, null for deleted", () => {
			expect(findActiveTaskPayloadById(db, "act")).toEqual({
				payload: JSON.stringify({ a: 1 }),
			});
			softDelete(db, "tasks", "act", SITE_ID);
			expect(findActiveTaskPayloadById(db, "act")).toBeNull();
		});
	});

	describe("countRunningTasks", () => {
		it("counts running, live tasks", () => {
			seed(db, { id: "rA", status: "running" });
			seed(db, { id: "rB", status: "running" });
			seed(db, { id: "rDel", status: "running" });
			softDelete(db, "tasks", "rDel", SITE_ID);
			seed(db, { id: "pend", status: "pending" });
			expect(countRunningTasks(db)).toEqual({ count: 2 });
		});

		it("returns count 0 over an empty set", () => {
			expect(countRunningTasks(db)).toEqual({ count: 0 });
		});
	});

	// --- listActiveTasks (optional status, ORDER BY created_at DESC) ---

	describe("listActiveTasks", () => {
		it("returns all live tasks newest-first when no status given", () => {
			seed(db, { id: "old", created_at: "2026-01-01T00:00:00.000Z" });
			seed(db, { id: "mid", created_at: "2026-02-01T00:00:00.000Z" });
			seed(db, { id: "new", created_at: "2026-03-01T00:00:00.000Z" });
			seed(db, { id: "del", created_at: "2026-04-01T00:00:00.000Z" });
			softDelete(db, "tasks", "del", SITE_ID);
			expect(listActiveTasks(db).map((t) => t.id)).toEqual(["new", "mid", "old"]);
		});

		it("filters by status when provided", () => {
			seed(db, { id: "p1", status: "pending", created_at: "2026-01-01T00:00:00.000Z" });
			seed(db, { id: "r1", status: "running", created_at: "2026-02-01T00:00:00.000Z" });
			expect(listActiveTasks(db, "running").map((t) => t.id)).toEqual(["r1"]);
		});

		it("returns [] over an empty set", () => {
			expect(listActiveTasks(db)).toEqual([]);
		});
	});

	// --- per-thread finders (ORDER BY created_at DESC LIMIT 1) ---

	describe("findRunningTaskIdForThread", () => {
		it("returns the running live task for the thread", () => {
			seed(db, { id: "tr", status: "running", thread_id: "T" });
			expect(findRunningTaskIdForThread(db, "T")).toEqual({ id: "tr" });
		});

		it("ignores non-running and deleted; returns null", () => {
			seed(db, { id: "tp", status: "pending", thread_id: "T2" });
			seed(db, { id: "td", status: "running", thread_id: "T2" });
			softDelete(db, "tasks", "td", SITE_ID);
			expect(findRunningTaskIdForThread(db, "T2")).toBeNull();
		});
	});

	describe("findLatestTaskSettingsForThread", () => {
		it("returns the newest live task's settings projection", () => {
			seed(db, {
				id: "s-old",
				thread_id: "ST",
				type: "cron",
				no_history: 0,
				system_prompt_addition: null,
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seed(db, {
				id: "s-new",
				thread_id: "ST",
				type: "event",
				no_history: 1,
				system_prompt_addition: "extra prompt",
				created_at: "2026-02-01T00:00:00.000Z",
			});
			expect(findLatestTaskSettingsForThread(db, "ST")).toEqual({
				id: "s-new",
				type: "event",
				no_history: 1,
				system_prompt_addition: "extra prompt",
			});
		});

		it("returns null for an unknown thread", () => {
			expect(findLatestTaskSettingsForThread(db, "absent")).toBeNull();
		});
	});

	describe("listActiveTasksWithPayload (deleted=0 AND payload IS NOT NULL)", () => {
		it("returns id/payload/thread_id for live tasks that have a payload", () => {
			seed(db, { id: "w1", payload: "p1", thread_id: "th1" });
			seed(db, { id: "w2", payload: "p2", thread_id: null });
			seed(db, { id: "nopay", payload: null, thread_id: "th3" });
			seed(db, { id: "del", payload: "p4", thread_id: "th4" });
			softDelete(db, "tasks", "del", SITE_ID);

			const rows = listActiveTasksWithPayload(db).sort((a, b) => a.id.localeCompare(b.id));
			expect(rows).toEqual([
				{ id: "w1", payload: "p1", thread_id: "th1" },
				{ id: "w2", payload: "p2", thread_id: null },
			]);
		});

		it("returns [] when no task carries a payload", () => {
			seed(db, { id: "nopay", payload: null });
			expect(listActiveTasksWithPayload(db)).toEqual([]);
		});
	});
});
