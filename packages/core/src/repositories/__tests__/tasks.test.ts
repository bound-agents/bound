import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Task } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	countPendingNoQuiescenceTasks,
	countRunningTasks,
	findActiveTaskById,
	findActiveTaskIdAndType,
	findActiveTaskIdById,
	findActiveTaskPayloadById,
	findActiveTaskSummaryById,
	findActiveTaskThreadId,
	findLatestEventTaskIdForThread,
	findLatestTaskSettingsForThread,
	findRunningTaskIdForThread,
	findTaskById,
	findTaskClaimById,
	findTaskClaimedAtById,
	findTaskExistenceById,
	findTaskIdAndStatusById,
	findTaskIdById,
	findTaskLeaseById,
	findTaskRunTimestampsById,
	findTaskStatusById,
	listActiveTasks,
	listActiveTasksWithPayload,
	listCancellableTaskIdsByPayload,
	listClaimedTasksForHost,
	listNoHistoryCronThreadAnchors,
	listPendingEventTasksByTrigger,
	listPendingTaskStatsByHost,
	listRecentTaskCompletions,
	listRunningTaskIdAndStatus,
	listRunningTaskIdsForHost,
	listRunningTasksForHost,
	listSchedulablePendingTasks,
	listStaleClaimedTasks,
	listStuckRecoverableTasks,
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
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
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

	describe("findTaskLeaseById", () => {
		it("returns the lease_id field", () => {
			seed(db, { id: "leased", lease_id: "lease-42" });
			expect(findTaskLeaseById(db, "leased")).toEqual({ lease_id: "lease-42" });
		});

		it("returns null lease_id when unset", () => {
			seed(db, { id: "nolease" });
			expect(findTaskLeaseById(db, "nolease")).toEqual({ lease_id: null });
		});

		it("returns null on a miss", () => {
			expect(findTaskLeaseById(db, "absent")).toBeNull();
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

	describe("findTaskStatusById", () => {
		it("returns status/deleted/consecutive_failures", () => {
			seed(db, { id: "s1", status: "failed", consecutive_failures: 4 });
			expect(findTaskStatusById(db, "s1")).toEqual({
				status: "failed",
				deleted: 0,
				consecutive_failures: 4,
			});
		});

		it("returns null on a miss", () => {
			expect(findTaskStatusById(db, "absent")).toBeNull();
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
		it("returns the tombstoned row with deleted=1 while the active-filtered sibling does not", () => {
			seed(db, { id: "live" });
			seed(db, { id: "dead" });
			softDelete(db, "tasks", "dead", SITE_ID);

			// Omission finder surfaces the tombstone.
			expect(findTaskExistenceById(db, "dead")).toEqual({ id: "dead", deleted: 1 });
			expect(findTaskExistenceById(db, "live")).toEqual({ id: "live", deleted: 0 });

			// deleted=0 sibling hides it.
			expect(findActiveTaskIdById(db, "dead")).toBeNull();
			expect(findActiveTaskIdById(db, "live")).toEqual({ id: "live" });
		});

		it("returns null on a true miss", () => {
			expect(findTaskExistenceById(db, "absent")).toBeNull();
		});
	});

	describe("findTaskStatusById (deleted-omission, exposes tombstone)", () => {
		it("returns status of a soft-deleted row (no deleted=0 filter)", () => {
			seed(db, { id: "dead", status: "completed" });
			softDelete(db, "tasks", "dead", SITE_ID);
			expect(findTaskStatusById(db, "dead")).toEqual({
				status: "completed",
				deleted: 1,
				consecutive_failures: 0,
			});
			// active sibling hides it
			expect(findActiveTaskById(db, "dead")).toBeNull();
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

		it("findActiveTaskThreadId returns thread_id for live, null for deleted", () => {
			expect(findActiveTaskThreadId(db, "act")).toEqual({ thread_id: "thr-1" });
			softDelete(db, "tasks", "act", SITE_ID);
			expect(findActiveTaskThreadId(db, "act")).toBeNull();
		});

		it("findActiveTaskIdAndType returns id+type for live", () => {
			expect(findActiveTaskIdAndType(db, "act")).toEqual({ id: "act", type: "event" });
		});

		it("findActiveTaskPayloadById returns payload for live, null for deleted", () => {
			expect(findActiveTaskPayloadById(db, "act")).toEqual({
				payload: JSON.stringify({ a: 1 }),
			});
			softDelete(db, "tasks", "act", SITE_ID);
			expect(findActiveTaskPayloadById(db, "act")).toBeNull();
		});
	});

	// --- listRunningTasksForHost / listRunningTaskIdsForHost (no deleted filter on the former) ---

	describe("listRunningTasksForHost", () => {
		it("returns only running tasks claimed by the host (includes soft-deleted — no deleted filter)", () => {
			seed(db, { id: "run-a", status: "running", claimed_by: "host-x" });
			seed(db, { id: "run-b", status: "running", claimed_by: "host-x" });
			seed(db, { id: "run-other", status: "running", claimed_by: "host-y" });
			seed(db, { id: "pend", status: "pending", claimed_by: "host-x" });
			seed(db, { id: "run-del", status: "running", claimed_by: "host-x" });
			softDelete(db, "tasks", "run-del", SITE_ID);

			const ids = listRunningTasksForHost(db, "host-x")
				.map((t) => t.id)
				.sort();
			// run-del survives because this finder has no deleted=0 filter.
			expect(ids).toEqual(["run-a", "run-b", "run-del"]);
		});

		it("returns [] when no host matches", () => {
			expect(listRunningTasksForHost(db, "nobody")).toEqual([]);
		});
	});

	describe("listRunningTaskIdsForHost / listRunningTaskIdAndStatus", () => {
		it("listRunningTaskIdsForHost returns running ids for host (no deleted filter)", () => {
			seed(db, { id: "r-a", status: "running", claimed_by: "h1" });
			seed(db, { id: "r-del", status: "running", claimed_by: "h1" });
			softDelete(db, "tasks", "r-del", SITE_ID);
			seed(db, { id: "r-b", status: "pending", claimed_by: "h1" });
			const ids = listRunningTaskIdsForHost(db, "h1")
				.map((r) => r.id)
				.sort();
			expect(ids).toEqual(["r-a", "r-del"]);
		});

		it("listRunningTaskIdAndStatus returns all running across hosts (no deleted filter)", () => {
			seed(db, { id: "ra", status: "running", claimed_by: "h1" });
			seed(db, { id: "rb", status: "running", claimed_by: "h2" });
			seed(db, { id: "rc", status: "pending" });
			const rows = listRunningTaskIdAndStatus(db).sort((a, b) => a.id.localeCompare(b.id));
			expect(rows).toEqual([
				{ id: "ra", status: "running" },
				{ id: "rb", status: "running" },
			]);
		});
	});

	// --- listStuckRecoverableTasks (composite type/status matrix) ---

	describe("listStuckRecoverableTasks", () => {
		const threshold = "2026-03-01T00:00:00.000Z";
		const claimedEarly = "2026-02-01T00:00:00.000Z"; // < threshold
		const claimedLate = "2026-04-01T00:00:00.000Z"; // > threshold

		it("matches the precise type/status/claimed-time/failure matrix", () => {
			// heartbeat with failed/cancelled/completed -> recoverable
			seed(db, {
				id: "hb-failed",
				type: "heartbeat",
				status: "failed",
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			seed(db, {
				id: "hb-completed",
				type: "heartbeat",
				status: "completed",
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			// heartbeat running -> NOT recoverable
			seed(db, {
				id: "hb-running",
				type: "heartbeat",
				status: "running",
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			// cron failed -> recoverable
			seed(db, {
				id: "cron-failed",
				type: "cron",
				status: "failed",
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			// cron completed -> NOT recoverable (only 'failed' for cron/event)
			seed(db, {
				id: "cron-completed",
				type: "cron",
				status: "completed",
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			// deferred failed with consecutive_failures < max(3) -> recoverable
			seed(db, {
				id: "def-ok",
				type: "deferred",
				status: "failed",
				consecutive_failures: 2,
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			// deferred failed with consecutive_failures >= max(3) -> NOT recoverable
			seed(db, {
				id: "def-exhausted",
				type: "deferred",
				status: "failed",
				consecutive_failures: 3,
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			// recoverable shape but claimed_at NOT before threshold -> excluded
			seed(db, {
				id: "cron-late",
				type: "cron",
				status: "failed",
				claimed_by: "h",
				claimed_at: claimedLate,
			});
			// recoverable shape but claimed_by NULL -> excluded
			seed(db, {
				id: "cron-unclaimed",
				type: "cron",
				status: "failed",
				claimed_by: null,
				claimed_at: claimedEarly,
			});
			// soft-deleted recoverable -> excluded (deleted=0 filter)
			seed(db, {
				id: "cron-deleted",
				type: "cron",
				status: "failed",
				claimed_by: "h",
				claimed_at: claimedEarly,
			});
			softDelete(db, "tasks", "cron-deleted", SITE_ID);

			const ids = listStuckRecoverableTasks(db, threshold, 3)
				.map((t) => t.id)
				.sort();
			expect(ids).toEqual(["cron-failed", "def-ok", "hb-completed", "hb-failed"]);
		});

		it("returns [] with no matches", () => {
			expect(listStuckRecoverableTasks(db, threshold, 3)).toEqual([]);
		});
	});

	// --- listSchedulablePendingTasks (ORDER BY next_run_at ASC, LIMIT 100) ---

	describe("listSchedulablePendingTasks", () => {
		const now = "2026-05-01T00:00:00.000Z";

		it("returns pending+live tasks due now, ordered by next_run_at ASC", () => {
			seed(db, { id: "due-3", status: "pending", next_run_at: "2026-04-03T00:00:00.000Z" });
			seed(db, { id: "due-1", status: "pending", next_run_at: "2026-04-01T00:00:00.000Z" });
			seed(db, { id: "due-2", status: "pending", next_run_at: "2026-04-02T00:00:00.000Z" });
			seed(db, { id: "future", status: "pending", next_run_at: "2026-06-01T00:00:00.000Z" });
			seed(db, { id: "no-next", status: "pending", next_run_at: null });
			seed(db, { id: "running", status: "running", next_run_at: "2026-04-01T00:00:00.000Z" });
			seed(db, { id: "del", status: "pending", next_run_at: "2026-04-01T00:00:00.000Z" });
			softDelete(db, "tasks", "del", SITE_ID);

			const ids = listSchedulablePendingTasks(db, now).map((t) => t.id);
			expect(ids).toEqual(["due-1", "due-2", "due-3"]);
		});

		it("includes tasks whose next_run_at exactly equals now (<=)", () => {
			seed(db, { id: "exact", status: "pending", next_run_at: now });
			expect(listSchedulablePendingTasks(db, now).map((t) => t.id)).toEqual(["exact"]);
		});

		it("caps the result at 100", () => {
			for (let i = 0; i < 105; i++) {
				const stamp = `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
				seed(db, { id: `p-${String(i).padStart(3, "0")}`, status: "pending", next_run_at: stamp });
			}
			expect(listSchedulablePendingTasks(db, now).length).toBe(100);
		});
	});

	// --- listClaimedTasksForHost (ORDER BY created_at ASC, LIMIT 10) ---

	describe("listClaimedTasksForHost", () => {
		it("returns claimed tasks for host ordered by created_at ASC, capped at 10", () => {
			for (let i = 0; i < 12; i++) {
				const created = `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
				seed(db, {
					id: `c-${String(i).padStart(2, "0")}`,
					status: "claimed",
					claimed_by: "hX",
					created_at: created,
				});
			}
			seed(db, { id: "other-host", status: "claimed", claimed_by: "hY" });
			const ids = listClaimedTasksForHost(db, "hX").map((t) => t.id);
			expect(ids.length).toBe(10);
			// oldest 10 by created_at: c-00 .. c-09
			expect(ids).toEqual([
				"c-00",
				"c-01",
				"c-02",
				"c-03",
				"c-04",
				"c-05",
				"c-06",
				"c-07",
				"c-08",
				"c-09",
			]);
		});

		it("uses rowid as a stable tiebreak when created_at is identical (insertion order)", () => {
			const same = "2026-01-01T00:00:00.000Z";
			seed(db, { id: "first", status: "claimed", claimed_by: "hT", created_at: same });
			seed(db, { id: "second", status: "claimed", claimed_by: "hT", created_at: same });
			seed(db, { id: "third", status: "claimed", claimed_by: "hT", created_at: same });
			const ids = listClaimedTasksForHost(db, "hT").map((t) => t.id);
			expect(ids).toEqual(["first", "second", "third"]);
		});
	});

	// --- listStaleClaimedTasks (deleted=0, claimed_at < expiry) ---

	describe("listStaleClaimedTasks", () => {
		it("returns live claimed tasks claimed before the expiry", () => {
			seed(db, { id: "stale", status: "claimed", claimed_at: "2026-01-01T00:00:00.000Z" });
			seed(db, { id: "fresh", status: "claimed", claimed_at: "2026-03-01T00:00:00.000Z" });
			seed(db, { id: "del", status: "claimed", claimed_at: "2026-01-01T00:00:00.000Z" });
			softDelete(db, "tasks", "del", SITE_ID);
			const ids = listStaleClaimedTasks(db, "2026-02-01T00:00:00.000Z").map((t) => t.id);
			expect(ids).toEqual(["stale"]);
		});
	});

	// --- listPendingEventTasksByTrigger ---

	describe("listPendingEventTasksByTrigger", () => {
		it("matches type=event, status=pending, deleted=0, trigger_spec", () => {
			seed(db, { id: "ev-a", type: "event", status: "pending", trigger_spec: "evt:x" });
			seed(db, { id: "ev-b", type: "event", status: "pending", trigger_spec: "evt:x" });
			seed(db, { id: "ev-other", type: "event", status: "pending", trigger_spec: "evt:y" });
			seed(db, { id: "ev-running", type: "event", status: "running", trigger_spec: "evt:x" });
			seed(db, { id: "cron-x", type: "cron", status: "pending", trigger_spec: "evt:x" });
			const ids = listPendingEventTasksByTrigger(db, "evt:x")
				.map((t) => t.id)
				.sort();
			expect(ids).toEqual(["ev-a", "ev-b"]);
		});

		it("returns [] when nothing matches", () => {
			expect(listPendingEventTasksByTrigger(db, "evt:none")).toEqual([]);
		});
	});

	// --- Aggregates ---

	describe("countPendingNoQuiescenceTasks", () => {
		it("counts pending tasks with no_quiescence=1 (ignores deleted? — no deleted filter)", () => {
			seed(db, { id: "nq1", status: "pending", no_quiescence: 1 });
			seed(db, { id: "nq2", status: "pending", no_quiescence: 1 });
			seed(db, { id: "nq-running", status: "running", no_quiescence: 1 });
			seed(db, { id: "nq-zero", status: "pending", no_quiescence: 0 });
			expect(countPendingNoQuiescenceTasks(db)).toEqual({ count: 2 });
		});

		it("returns count 0 when none match (never null)", () => {
			expect(countPendingNoQuiescenceTasks(db)).toEqual({ count: 0 });
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

	describe("listPendingTaskStatsByHost (GROUP BY + COUNT + SUM)", () => {
		it("groups pending live tasks by host with total and failing counts", () => {
			seed(db, { id: "a1", status: "pending", claimed_by: "h1", consecutive_failures: 0 });
			seed(db, { id: "a2", status: "pending", claimed_by: "h1", consecutive_failures: 2 });
			seed(db, { id: "a3", status: "pending", claimed_by: "h1", consecutive_failures: 5 });
			seed(db, { id: "b1", status: "pending", claimed_by: "h2", consecutive_failures: 0 });
			seed(db, { id: "running", status: "running", claimed_by: "h1", consecutive_failures: 9 });
			seed(db, { id: "del", status: "pending", claimed_by: "h1", consecutive_failures: 1 });
			softDelete(db, "tasks", "del", SITE_ID);

			const rows = listPendingTaskStatsByHost(db).sort((a, b) =>
				String(a.claimed_by).localeCompare(String(b.claimed_by)),
			);
			expect(rows).toEqual([
				{ claimed_by: "h1", total: 3, failing: 2 },
				{ claimed_by: "h2", total: 1, failing: 0 },
			]);
		});

		it("returns [] over an empty set", () => {
			expect(listPendingTaskStatsByHost(db)).toEqual([]);
		});
	});

	describe("listNoHistoryCronThreadAnchors (GROUP BY thread_id, MAX)", () => {
		it("returns MAX(last_run_at) per thread for live no_history tasks past the cutoff", () => {
			const cutoff = "2026-02-01T00:00:00.000Z";
			// thread-1: two runs, both after cutoff -> anchor = max
			seed(db, {
				id: "n1",
				no_history: 1,
				thread_id: "thread-1",
				last_run_at: "2026-03-01T00:00:00.000Z",
			});
			seed(db, {
				id: "n2",
				no_history: 1,
				thread_id: "thread-1",
				last_run_at: "2026-04-01T00:00:00.000Z",
			});
			// thread-2: one run after cutoff
			seed(db, {
				id: "n3",
				no_history: 1,
				thread_id: "thread-2",
				last_run_at: "2026-03-15T00:00:00.000Z",
			});
			// before cutoff -> excluded
			seed(db, {
				id: "old",
				no_history: 1,
				thread_id: "thread-3",
				last_run_at: "2026-01-01T00:00:00.000Z",
			});
			// no_history=0 -> excluded
			seed(db, {
				id: "hist",
				no_history: 0,
				thread_id: "thread-4",
				last_run_at: "2026-03-01T00:00:00.000Z",
			});
			// null thread_id -> excluded
			seed(db, {
				id: "nothr",
				no_history: 1,
				thread_id: null,
				last_run_at: "2026-03-01T00:00:00.000Z",
			});

			const rows = listNoHistoryCronThreadAnchors(db, cutoff).sort((a, b) =>
				a.thread_id.localeCompare(b.thread_id),
			);
			expect(rows).toEqual([
				{ thread_id: "thread-1", anchor: "2026-04-01T00:00:00.000Z" },
				{ thread_id: "thread-2", anchor: "2026-03-15T00:00:00.000Z" },
			]);
		});

		it("returns [] when no task qualifies", () => {
			expect(listNoHistoryCronThreadAnchors(db, "2026-02-01T00:00:00.000Z")).toEqual([]);
		});
	});

	// --- listRecentTaskCompletions (ORDER BY last_run_at DESC, LIMIT 5) ---

	describe("listRecentTaskCompletions", () => {
		it("returns completed/failed live tasks after cutoff, newest first, capped at 5", () => {
			const cutoff = "2026-01-01T00:00:00.000Z";
			// 6 qualifying rows; expect newest 5
			for (let i = 1; i <= 6; i++) {
				seed(db, {
					id: `done-${i}`,
					status: i % 2 === 0 ? "completed" : "failed",
					trigger_spec: `spec-${i}`,
					error: i % 2 === 0 ? null : `err-${i}`,
					last_run_at: `2026-02-0${i}T00:00:00.000Z`,
				});
			}
			// before cutoff -> excluded
			seed(db, {
				id: "before",
				status: "completed",
				last_run_at: "2025-12-01T00:00:00.000Z",
			});
			// pending -> excluded
			seed(db, { id: "pend", status: "pending", last_run_at: "2026-03-01T00:00:00.000Z" });
			// deleted -> excluded
			seed(db, { id: "del", status: "completed", last_run_at: "2026-03-01T00:00:00.000Z" });
			softDelete(db, "tasks", "del", SITE_ID);

			const rows = listRecentTaskCompletions(db, cutoff);
			expect(rows.length).toBe(5);
			expect(rows.map((r) => r.last_run_at)).toEqual([
				"2026-02-06T00:00:00.000Z",
				"2026-02-05T00:00:00.000Z",
				"2026-02-04T00:00:00.000Z",
				"2026-02-03T00:00:00.000Z",
				"2026-02-02T00:00:00.000Z",
			]);
			// confirm the projected shape and error nullness on the newest
			expect(rows[0]).toEqual({
				trigger_spec: "spec-6",
				status: "completed",
				error: null,
				last_run_at: "2026-02-06T00:00:00.000Z",
			});
		});

		it("returns [] over the zero-row case", () => {
			expect(listRecentTaskCompletions(db, "2026-01-01T00:00:00.000Z")).toEqual([]);
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

		it("uses rowid as tiebreak for identical created_at (newest insertion first under DESC)", () => {
			const same = "2026-01-01T00:00:00.000Z";
			seed(db, { id: "first", created_at: same });
			seed(db, { id: "second", created_at: same });
			seed(db, { id: "third", created_at: same });
			// ORDER BY created_at DESC with rowid tiebreak: SQLite emits higher rowid last
			// within an equal key, so insertion order is preserved (ASC by rowid).
			expect(listActiveTasks(db).map((t) => t.id)).toEqual(["first", "second", "third"]);
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

	describe("findLatestEventTaskIdForThread", () => {
		it("returns the newest event task for the thread (created_at DESC)", () => {
			seed(db, {
				id: "e-old",
				type: "event",
				thread_id: "TT",
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seed(db, {
				id: "e-new",
				type: "event",
				thread_id: "TT",
				created_at: "2026-02-01T00:00:00.000Z",
			});
			seed(db, { id: "c", type: "cron", thread_id: "TT", created_at: "2026-03-01T00:00:00.000Z" });
			expect(findLatestEventTaskIdForThread(db, "TT")).toEqual({ id: "e-new" });
		});

		it("returns null when the thread has no event task", () => {
			seed(db, { id: "c", type: "cron", thread_id: "NO" });
			expect(findLatestEventTaskIdForThread(db, "NO")).toBeNull();
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

	// --- payload-based finders ---

	describe("listCancellableTaskIdsByPayload (LIKE + status IN + type != heartbeat)", () => {
		it("matches non-heartbeat pending/claimed live tasks whose payload LIKEs the pattern", () => {
			seed(db, {
				id: "m1",
				type: "cron",
				status: "pending",
				payload: '{"target":"abc"}',
			});
			seed(db, {
				id: "m2",
				type: "event",
				status: "claimed",
				payload: '{"target":"abc"}',
			});
			// heartbeat excluded
			seed(db, {
				id: "hb",
				type: "heartbeat",
				status: "pending",
				payload: '{"target":"abc"}',
			});
			// running excluded
			seed(db, {
				id: "run",
				type: "cron",
				status: "running",
				payload: '{"target":"abc"}',
			});
			// non-matching payload excluded
			seed(db, {
				id: "other",
				type: "cron",
				status: "pending",
				payload: '{"target":"xyz"}',
			});
			// deleted excluded
			seed(db, {
				id: "del",
				type: "cron",
				status: "pending",
				payload: '{"target":"abc"}',
			});
			softDelete(db, "tasks", "del", SITE_ID);

			const ids = listCancellableTaskIdsByPayload(db, '%"target":"abc"%')
				.map((r) => r.id)
				.sort();
			expect(ids).toEqual(["m1", "m2"]);
		});

		it("returns [] when no payload matches", () => {
			seed(db, { id: "x", type: "cron", status: "pending", payload: "{}" });
			expect(listCancellableTaskIdsByPayload(db, "%nomatch%")).toEqual([]);
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

	// --- findActiveTaskSummaryById: tasks has no `name` column, so this finder errors ---

	describe("findActiveTaskSummaryById (suspected bug: no `name` column in tasks)", () => {
		it("throws because the tasks table has no `name` column", () => {
			seed(db, { id: "sum", thread_id: "th" });
			expect(() => findActiveTaskSummaryById(db, "sum")).toThrow();
		});
	});
});
