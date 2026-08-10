import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemoryEdge, SemanticMemory, Task, Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import {
	listMemorySourceInfoByKeys,
	listPinnedMemoryWithSource,
	listRecencyMemoryWithSource,
	listSummaryChildrenWithSource,
	listSummaryMemoryWithSource,
} from "../memory-with-source";

const SITE = "site-test";

// ── Row factories ───────────────────────────────────────────────────────────
// Every column from the @bound/shared row type is supplied; nullable columns
// default to null. Timestamps are fixed ISO-8601 strings for determinism.

function makeMemory(
	overrides: Partial<SemanticMemory> & Pick<SemanticMemory, "id" | "key">,
): SemanticMemory {
	return {
		value: `value-of-${overrides.key}`,
		source: null,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		last_accessed_at: null,
		tier: "default",
		deleted: 0,
		...overrides,
	} as SemanticMemory;
}

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
	return {
		type: "cron",
		status: "pending",
		trigger_spec: `trigger-${overrides.id}`,
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
	} as Task;
}

function makeThread(overrides: Partial<Thread> & Pick<Thread, "id">): Thread {
	return {
		user_id: "user-1",
		interface: "web",
		host_origin: SITE,
		color: 0,
		title: `title-${overrides.id}`,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: "2026-01-01T00:00:00.000Z",
		last_message_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		model_hint: null,
		...overrides,
	} as Thread;
}

function makeEdge(
	overrides: Partial<MemoryEdge> & Pick<MemoryEdge, "id" | "source_key" | "target_key">,
): MemoryEdge {
	return {
		relation: "summarizes",
		weight: 1.0,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	} as MemoryEdge;
}

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

// ── listPinnedMemoryWithSource (L0) ──────────────────────────────────────────

describe("listPinnedMemoryWithSource", () => {
	it("returns only pinned, live entries ordered by key ASC", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m-z", key: "z-pinned", tier: "pinned" }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m-a", key: "a-pinned", tier: "pinned" }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m-d", key: "default-tier", tier: "default" }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m-del", key: "del-pinned", tier: "pinned" }),
			SITE,
		);
		softDelete(db, "semantic_memory", "m-del", SITE);

		const rows = listPinnedMemoryWithSource(db);
		expect(rows.map((r) => r.key)).toEqual(["a-pinned", "z-pinned"]);
		expect(rows.every((r) => r.tier === "pinned")).toBe(true);
	});

	it("resolves a task source: task_name populated, thread fields null", () => {
		insertRow(db, "tasks", makeTask({ id: "task-1", trigger_spec: "0 9 * * *" }), SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m1", key: "k", tier: "pinned", source: "task-1", value: "V" }),
			SITE,
		);

		const rows = listPinnedMemoryWithSource(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			key: "k",
			value: "V",
			source: "task-1",
			tier: "pinned",
			task_name: "0 9 * * *",
			thread_id: null,
			thread_title: null,
		});
		// exact projection shape — every declared column present
		expect(Object.keys(rows[0]).sort()).toEqual(
			[
				"key",
				"modified_at",
				"source",
				"task_name",
				"thread_id",
				"thread_title",
				"tier",
				"value",
			].sort(),
		);
	});

	it("resolves a thread source: thread_id/thread_title populated, task_name null", () => {
		insertRow(db, "threads", makeThread({ id: "thread-1", title: "My Thread" }), SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m1", key: "k", tier: "pinned", source: "thread-1" }),
			SITE,
		);

		const rows = listPinnedMemoryWithSource(db);
		expect(rows[0]).toMatchObject({
			source: "thread-1",
			task_name: null,
			thread_id: "thread-1",
			thread_title: "My Thread",
		});
	});

	it("LEFT-JOIN null case: source points at a non-existent id => all source labels null", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m1", key: "k", tier: "pinned", source: "ghost-id" }),
			SITE,
		);

		const rows = listPinnedMemoryWithSource(db);
		expect(rows[0].source).toBe("ghost-id");
		expect(rows[0].task_name).toBeNull();
		expect(rows[0].thread_id).toBeNull();
		expect(rows[0].thread_title).toBeNull();
	});

	it("LEFT-JOIN deleted filter: a soft-deleted task source resolves to null labels", () => {
		insertRow(db, "tasks", makeTask({ id: "task-1", trigger_spec: "live-spec" }), SITE);
		softDelete(db, "tasks", "task-1", SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m1", key: "k", tier: "pinned", source: "task-1" }),
			SITE,
		);

		const rows = listPinnedMemoryWithSource(db);
		// memory still present (it's live), but the deleted task is filtered out of the join
		expect(rows[0].source).toBe("task-1");
		expect(rows[0].task_name).toBeNull();
	});

	it("LEFT-JOIN deleted filter: a soft-deleted thread source resolves to null labels", () => {
		insertRow(db, "threads", makeThread({ id: "thread-1", title: "Gone" }), SITE);
		softDelete(db, "threads", "thread-1", SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m1", key: "k", tier: "pinned", source: "thread-1" }),
			SITE,
		);

		const rows = listPinnedMemoryWithSource(db);
		expect(rows[0].thread_id).toBeNull();
		expect(rows[0].thread_title).toBeNull();
	});

	it("empty DB returns []", () => {
		expect(listPinnedMemoryWithSource(db)).toEqual([]);
	});
});

// ── listSummaryMemoryWithSource (L1) ─────────────────────────────────────────

describe("listSummaryMemoryWithSource", () => {
	it("returns summary-tier live rows ordered by modified_at DESC then key ASC", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "m-old",
				key: "older",
				tier: "summary",
				modified_at: "2026-01-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "m-new",
				key: "newer",
				tier: "summary",
				modified_at: "2026-03-01T00:00:00.000Z",
			}),
			SITE,
		);
		// rowid/key tiebreak: identical modified_at, keys b < c
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "m-c",
				key: "c-tie",
				tier: "summary",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "m-b",
				key: "b-tie",
				tier: "summary",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);
		// non-summary tier excluded
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "m-p", key: "pinned-x", tier: "pinned" }),
			SITE,
		);

		const rows = listSummaryMemoryWithSource(db);
		expect(rows.map((r) => r.key)).toEqual(["newer", "b-tie", "c-tie", "older"]);
	});

	it("excludes soft-deleted summary rows", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "live", key: "live-sum", tier: "summary" }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "dead", key: "dead-sum", tier: "summary" }),
			SITE,
		);
		softDelete(db, "semantic_memory", "dead", SITE);

		const rows = listSummaryMemoryWithSource(db);
		expect(rows.map((r) => r.key)).toEqual(["live-sum"]);
	});

	it("empty DB returns []", () => {
		expect(listSummaryMemoryWithSource(db)).toEqual([]);
	});
});

// ── listSummaryChildrenWithSource (L1 children) ──────────────────────────────

describe("listSummaryChildrenWithSource", () => {
	it("returns live children reachable via outgoing summarizes edges, key ASC", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "s", key: "summary-parent", tier: "summary" }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "c1", key: "child-z", tier: "detail" }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "c2", key: "child-a", tier: "detail" }),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "summary-parent", target_key: "child-z" }),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e2", source_key: "summary-parent", target_key: "child-a" }),
			SITE,
		);

		const rows = listSummaryChildrenWithSource(db, "summary-parent");
		expect(rows.map((r) => r.key)).toEqual(["child-a", "child-z"]);
	});

	it("excludes children with a soft-deleted edge", () => {
		insertRow(db, "semantic_memory", makeMemory({ id: "s", key: "parent", tier: "summary" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "c1", key: "keep", tier: "detail" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "c2", key: "drop", tier: "detail" }), SITE);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "parent", target_key: "keep" }),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e2", source_key: "parent", target_key: "drop" }),
			SITE,
		);
		softDelete(db, "memory_edges", "e2", SITE);

		const rows = listSummaryChildrenWithSource(db, "parent");
		expect(rows.map((r) => r.key)).toEqual(["keep"]);
	});

	it("excludes children whose target memory is soft-deleted", () => {
		insertRow(db, "semantic_memory", makeMemory({ id: "s", key: "parent", tier: "summary" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "c1", key: "alive", tier: "detail" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "c2", key: "gone", tier: "detail" }), SITE);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "parent", target_key: "alive" }),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e2", source_key: "parent", target_key: "gone" }),
			SITE,
		);
		softDelete(db, "semantic_memory", "c2", SITE);

		const rows = listSummaryChildrenWithSource(db, "parent");
		expect(rows.map((r) => r.key)).toEqual(["alive"]);
	});

	it("ignores non-summarizes relations", () => {
		insertRow(db, "semantic_memory", makeMemory({ id: "s", key: "parent", tier: "summary" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "c1", key: "child", tier: "detail" }), SITE);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "parent", target_key: "child", relation: "related_to" }),
			SITE,
		);

		expect(listSummaryChildrenWithSource(db, "parent")).toEqual([]);
	});

	it("resolves source labels on a child", () => {
		insertRow(db, "threads", makeThread({ id: "thr", title: "Child Source" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "s", key: "parent", tier: "summary" }), SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "c1", key: "child", tier: "detail", source: "thr" }),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "parent", target_key: "child" }),
			SITE,
		);

		const rows = listSummaryChildrenWithSource(db, "parent");
		expect(rows[0]).toMatchObject({
			key: "child",
			thread_id: "thr",
			thread_title: "Child Source",
			task_name: null,
		});
	});

	it("returns [] for a parent key with no edges", () => {
		expect(listSummaryChildrenWithSource(db, "no-such-parent")).toEqual([]);
	});
});

// ── listMemorySourceInfoByKeys (L2, dynamic IN-list) ─────────────────────────

describe("listMemorySourceInfoByKeys", () => {
	it("empty keys array returns [] without touching the DB", () => {
		expect(listMemorySourceInfoByKeys(db, [])).toEqual([]);
	});

	it("single-element key resolves its source", () => {
		insertRow(db, "tasks", makeTask({ id: "task-1", trigger_spec: "spec-one" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "k1", source: "task-1" }), SITE);

		const rows = listMemorySourceInfoByKeys(db, ["k1"]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "k1",
			task_name: "spec-one",
			thread_id: null,
			thread_title: null,
		});
	});

	it("multiple keys resolve and the projection is exactly the 4 declared columns", () => {
		insertRow(db, "threads", makeThread({ id: "thr", title: "T" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "k1", source: "thr" }), SITE);
		insertRow(db, "semantic_memory", makeMemory({ id: "m2", key: "k2" }), SITE);

		const rows = listMemorySourceInfoByKeys(db, ["k1", "k2", "absent-key"]);
		const byKey = new Map(rows.map((r) => [r.key, r]));
		expect(byKey.size).toBe(2);
		const k1Row = rows.find((r) => r.key === "k1");
		expect(k1Row).toBeDefined();
		expect(Object.keys(k1Row ?? {}).sort()).toEqual(
			["key", "task_name", "thread_id", "thread_title"].sort(),
		);
		expect(byKey.get("k1")).toEqual({
			key: "k1",
			task_name: null,
			thread_id: "thr",
			thread_title: "T",
		});
		expect(byKey.get("k2")).toEqual({
			key: "k2",
			task_name: null,
			thread_id: null,
			thread_title: null,
		});
	});

	it("INCLUDES soft-deleted memory rows (no m.deleted filter)", () => {
		insertRow(db, "semantic_memory", makeMemory({ id: "m1", key: "tombstone" }), SITE);
		softDelete(db, "semantic_memory", "m1", SITE);

		const rows = listMemorySourceInfoByKeys(db, ["tombstone"]);
		expect(rows.map((r) => r.key)).toEqual(["tombstone"]);
	});

	it("absent key returns []", () => {
		expect(listMemorySourceInfoByKeys(db, ["nope"])).toEqual([]);
	});
});

// ── listRecencyMemoryWithSource (L3) ─────────────────────────────────────────

describe("listRecencyMemoryWithSource", () => {
	const BASELINE = "2026-01-01T00:00:00.000Z";

	it("excludes pinned and summary tiers; includes default + orphan detail", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "d",
				key: "default-row",
				tier: "default",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "p",
				key: "pinned-row",
				tier: "pinned",
				modified_at: "2026-02-02T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "s",
				key: "summary-row",
				tier: "summary",
				modified_at: "2026-02-03T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "det",
				key: "orphan-detail",
				tier: "detail",
				modified_at: "2026-02-04T00:00:00.000Z",
			}),
			SITE,
		);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		expect(rows.map((r) => r.key).sort()).toEqual(["default-row", "orphan-detail"]);
	});

	it("excludes a detail entry that HAS an incoming summarizes edge (non-orphan)", () => {
		insertRow(db, "semantic_memory", makeMemory({ id: "sum", key: "sum", tier: "summary" }), SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "det",
				key: "covered-detail",
				tier: "detail",
				modified_at: "2026-02-04T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "sum", target_key: "covered-detail" }),
			SITE,
		);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		expect(rows.map((r) => r.key)).not.toContain("covered-detail");
	});

	it("a detail entry whose only summarizes edge is soft-deleted counts as orphan (included)", () => {
		insertRow(db, "semantic_memory", makeMemory({ id: "sum", key: "sum", tier: "summary" }), SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "det",
				key: "reorphaned",
				tier: "detail",
				modified_at: "2026-02-04T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"memory_edges",
			makeEdge({ id: "e1", source_key: "sum", target_key: "reorphaned" }),
			SITE,
		);
		softDelete(db, "memory_edges", "e1", SITE);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		expect(rows.map((r) => r.key)).toContain("reorphaned");
	});

	it("excludes _internal.% keys", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "i",
				key: "_internal.foo",
				tier: "default",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "k",
				key: "keep.me",
				tier: "default",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		expect(rows.map((r) => r.key)).toEqual(["keep.me"]);
	});

	it("filters strictly on modified_at > baseline (boundary equal is excluded)", () => {
		insertRow(
			db,
			"semantic_memory",
			makeMemory({ id: "eq", key: "at-baseline", tier: "default", modified_at: BASELINE }),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "after",
				key: "after-baseline",
				tier: "default",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		expect(rows.map((r) => r.key)).toEqual(["after-baseline"]);
	});

	it("INCLUDES soft-deleted rows and carries the deleted flag", () => {
		// modified_at < baseline-window check: a live default row well after baseline.
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "live",
				key: "live-row",
				tier: "default",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "dead",
				key: "dead-row",
				tier: "default",
				modified_at: "2026-02-02T00:00:00.000Z",
			}),
			SITE,
		);
		// softDelete bumps modified_at to wall-clock now (> baseline), so it stays in-window.
		softDelete(db, "semantic_memory", "dead", SITE);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		const byKey = new Map(rows.map((r) => [r.key, r]));
		expect(byKey.has("live-row")).toBe(true);
		expect(byKey.has("dead-row")).toBe(true);
		expect(byKey.get("live-row")?.deleted).toBe(0);
		expect(byKey.get("dead-row")?.deleted).toBe(1);
	});

	it("orders by modified_at DESC and applies LIMIT cap", () => {
		for (const [id, key, mod] of [
			["a", "row-a", "2026-02-01T00:00:00.000Z"],
			["b", "row-b", "2026-02-02T00:00:00.000Z"],
			["c", "row-c", "2026-02-03T00:00:00.000Z"],
			["d", "row-d", "2026-02-04T00:00:00.000Z"],
		] as const) {
			insertRow(
				db,
				"semantic_memory",
				makeMemory({ id, key, tier: "default", modified_at: mod }),
				SITE,
			);
		}

		const rows = listRecencyMemoryWithSource(db, BASELINE, 2);
		// newest two, DESC
		expect(rows.map((r) => r.key)).toEqual(["row-d", "row-c"]);
	});

	it("resolves source labels and the LEFT-JOIN null case", () => {
		insertRow(db, "tasks", makeTask({ id: "task-1", trigger_spec: "cron-spec" }), SITE);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "m1",
				key: "with-task",
				tier: "default",
				source: "task-1",
				modified_at: "2026-02-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"semantic_memory",
			makeMemory({
				id: "m2",
				key: "ghost-src",
				tier: "default",
				source: "missing",
				modified_at: "2026-02-02T00:00:00.000Z",
			}),
			SITE,
		);

		const rows = listRecencyMemoryWithSource(db, BASELINE, 100);
		const byKey = new Map(rows.map((r) => [r.key, r]));
		expect(byKey.get("with-task")).toMatchObject({
			task_name: "cron-spec",
			thread_id: null,
			thread_title: null,
		});
		expect(byKey.get("ghost-src")).toMatchObject({
			task_name: null,
			thread_id: null,
			thread_title: null,
		});
	});

	it("zero matching rows returns []", () => {
		expect(listRecencyMemoryWithSource(db, BASELINE, 100)).toEqual([]);
	});
});
