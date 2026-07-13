import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientSession, Host, Message, Task, Thread, Turn } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import { countThreadsDirectory, listThreadsDirectory } from "../threads-directory-listing";

const SITE_ID = "site-test";
const USER = "user-1";

/**
 * Seed a `threads` row. `model_hint` is a real column in the test DB — added by
 * an `ALTER TABLE` migration that `applySchema` runs after the `CREATE TABLE` —
 * so the typed `Thread` seed inserts cleanly. Nullable columns default to null.
 */
function seedThread(db: Database, overrides: Partial<Thread> & { id: string }): void {
	const base: Thread = {
		id: overrides.id,
		user_id: USER,
		interface: "web",
		host_origin: SITE_ID,
		color: 0,
		title: null,
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
	};
	insertRow(db, "threads", base, SITE_ID);
}

/**
 * Seed a `messages` row. `exit_code` and `metadata` are real columns in the
 * test DB — `applySchema` adds them via `ALTER TABLE` after the `CREATE TABLE` —
 * so the typed `Message` seed inserts cleanly. Nullable columns default to null.
 */
function seedMessage(
	db: Database,
	overrides: Partial<Message> & { id: string; thread_id: string },
): void {
	const base: Message = {
		id: overrides.id,
		thread_id: overrides.thread_id,
		role: "user",
		content: "hi",
		model_id: null,
		tool_name: null,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: null,
		host_origin: SITE_ID,
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
	insertRow(db, "messages", base, SITE_ID);
}

/**
 * Seed a `turns` row (append-only, lives in the metrics schema). Every NOT NULL
 * column is filled; nullable columns default to null.
 */
function seedTurn(
	db: Database,
	overrides: Partial<Turn> & { id: string; thread_id: string; model_id: string },
): void {
	const base: Turn = {
		id: overrides.id,
		thread_id: overrides.thread_id,
		task_id: null,
		dag_root_id: null,
		model_id: overrides.model_id,
		tokens_in: 0,
		tokens_out: 0,
		tokens_cache_write: null,
		tokens_cache_read: null,
		cost_usd: null,
		created_at: "2026-01-01T00:00:00.000Z",
		status: null,
		relay_target: null,
		relay_latency_ms: null,
		context_debug: null,
		host_origin: null,
		modified_at: null,
		...overrides,
	};
	insertRow(db, "turns", base, SITE_ID);
}

/**
 * Seed a `tasks` row. `origin_thread_id` and `system_prompt_addition` are real
 * columns in the test DB — `applySchema` adds them via `ALTER TABLE` after the
 * `CREATE TABLE` — so the typed `Task` seed inserts cleanly. Nullable columns
 * default to null.
 */
function seedTask(
	db: Database,
	overrides: Partial<Task> & { id: string; thread_id: string; status: Task["status"] },
): void {
	const base: Task = {
		id: overrides.id,
		type: "deferred",
		status: overrides.status,
		trigger_spec: "{}",
		payload: null,
		created_at: "2026-01-01T00:00:00.000Z",
		created_by: null,
		thread_id: overrides.thread_id,
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
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
	insertRow(db, "tasks", base, SITE_ID);
}

/**
 * Seed a `hosts` row. PK is `site_id`. The test DB carries a `commit_hash`
 * column (added by an `ALTER TABLE` migration) that the `Host` type omits; it
 * is nullable, so the typed seed simply leaves it unset and the DB defaults it
 * to null.
 */
function seedHost(
	db: Database,
	overrides: Partial<Host> & { site_id: string; host_name: string },
): void {
	const base: Host = {
		site_id: overrides.site_id,
		host_name: overrides.host_name,
		version: null,
		sync_url: null,
		mcp_servers: null,
		mcp_tools: null,
		mcp_tool_annotations: null,
		mcp_capabilities: null,
		models: null,
		online_at: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		platforms: null,
		...overrides,
	};
	insertRow(db, "hosts", base, SITE_ID);
}

/**
 * Seed a `client_sessions` row. PK `id` is `${connection_id}::${thread_id}`.
 */
function seedClientSession(
	db: Database,
	overrides: Partial<ClientSession> & {
		connection_id: string;
		thread_id: string;
		site_id: string;
	},
): void {
	const id = overrides.id ?? `${overrides.connection_id}::${overrides.thread_id}`;
	const base: ClientSession = {
		id,
		connection_id: overrides.connection_id,
		thread_id: overrides.thread_id,
		site_id: overrides.site_id,
		created_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		modified_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
	insertRow(db, "client_sessions", base, SITE_ID);
}

/**
 * The exact thread (`t.*`) column set the projection carries before the four
 * derived aggregates. Mirrors the live `threads` table — including the
 * `model_hint` column added by a post-CREATE ALTER. Used to assert the precise
 * projection key set.
 */
const THREAD_COLUMNS = [
	"id",
	"user_id",
	"interface",
	"host_origin",
	"color",
	"title",
	"summary",
	"summary_through",
	"summary_model_id",
	"extracted_through",
	"created_at",
	"last_message_at",
	"modified_at",
	"deleted",
	"model_hint",
];
const DERIVED_COLUMNS = ["messageCount", "lastModel", "attachedSessionHostsJson", "hasRunningTask"];

describe("threads-directory-listing finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("listThreadsDirectory — projection shape", () => {
		it("projects the exact declared column set (t.* plus four derived aggregates)", () => {
			seedThread(db, {
				id: "t-1",
				title: "Deploy chat",
				color: 3,
				last_message_at: "2026-02-02T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows).toHaveLength(1);
			// Exact key set — guards against projection drift. Call sites destructure these.
			expect(Object.keys(rows[0]).sort()).toEqual([...THREAD_COLUMNS, ...DERIVED_COLUMNS].sort());
			// Hand-written oracle for the base thread columns + aggregates.
			expect(rows[0].id).toBe("t-1");
			expect(rows[0].title).toBe("Deploy chat");
			expect(rows[0].color).toBe(3);
			expect(rows[0].user_id).toBe(USER);
			expect(rows[0].messageCount).toBe(1);
			expect(rows[0].lastModel).toBeNull();
			// No client sessions seeded → empty JSON array literal, not null.
			expect(rows[0].attachedSessionHostsJson).toBe("[]");
			expect(rows[0].hasRunningTask).toBe(0);
		});

		it("returns [] when the user has no threads", () => {
			expect(
				listThreadsDirectory(db, {
					userId: "nobody",
					includeEmpty: true,
					beforeTs: null,
					beforeId: null,
					limit: null,
				}),
			).toEqual([]);
		});
	});

	describe("messageCount — correlated COUNT over live messages", () => {
		it("counts only live (deleted=0) messages on the thread", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedMessage(db, { id: "m-2", thread_id: "t-1", role: "assistant" });
			seedMessage(db, { id: "m-3", thread_id: "t-1", role: "assistant" });
			softDelete(db, "messages", "m-3", SITE_ID);
			// A message on a DIFFERENT thread must not leak into this count.
			seedThread(db, { id: "t-other", last_message_at: "2026-01-01T00:00:00.000Z" });
			seedMessage(db, { id: "m-other", thread_id: "t-other", role: "user" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			const t1 = rows.find((r) => r.id === "t-1");
			expect(t1?.messageCount).toBe(2);
		});
	});

	describe("lastModel — most-recent turn's model_id (correlated subquery)", () => {
		it("returns the model_id of the latest turn by created_at", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedTurn(db, {
				id: "tu-old",
				thread_id: "t-1",
				model_id: "haiku",
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seedTurn(db, {
				id: "tu-new",
				thread_id: "t-1",
				model_id: "opus",
				created_at: "2026-03-03T00:00:00.000Z",
			});

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].lastModel).toBe("opus");
		});

		it("is null when the thread has no turns (LEFT-JOIN-equivalent null case)", () => {
			seedThread(db, { id: "t-noturn", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-noturn", role: "user" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].lastModel).toBeNull();
		});
	});

	describe("attachedSessionHostsJson — host label aggregation with LEFT JOIN to hosts", () => {
		it("uses host_name when a matching live host row exists", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedHost(db, { site_id: "site-laptop", host_name: "laptop" });
			seedClientSession(db, {
				connection_id: "conn-1",
				thread_id: "t-1",
				site_id: "site-laptop",
			});

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].attachedSessionHostsJson).toBe(JSON.stringify(["laptop"]));
		});

		it("falls back to site_id when the host row is ABSENT (LEFT JOIN null case)", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			// No hosts row for site-ghost → COALESCE(h.host_name, cs.site_id) = site_id.
			seedClientSession(db, {
				connection_id: "conn-1",
				thread_id: "t-1",
				site_id: "site-ghost",
			});

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].attachedSessionHostsJson).toBe(JSON.stringify(["site-ghost"]));
		});

		it("falls back to site_id when the host row is SOFT-DELETED (join filters h.deleted=0)", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedHost(db, { site_id: "site-dead", host_name: "deadhost" });
			softDelete(db, "hosts", "site-dead", SITE_ID);
			seedClientSession(db, {
				connection_id: "conn-1",
				thread_id: "t-1",
				site_id: "site-dead",
			});

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			// The host join is filtered to deleted=0, so the tombstoned host is invisible
			// and the label falls back to the raw site_id.
			expect(rows[0].attachedSessionHostsJson).toBe(JSON.stringify(["site-dead"]));
		});

		it("excludes soft-deleted client_sessions and sorts distinct labels ascending", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedHost(db, { site_id: "site-z", host_name: "zeta" });
			seedHost(db, { site_id: "site-a", host_name: "alpha" });
			seedHost(db, { site_id: "site-gone", host_name: "gone" });
			// Two live sessions on distinct hosts → both labels, sorted ASC.
			seedClientSession(db, { connection_id: "c-z", thread_id: "t-1", site_id: "site-z" });
			seedClientSession(db, { connection_id: "c-a", thread_id: "t-1", site_id: "site-a" });
			// A soft-deleted session must be excluded entirely.
			seedClientSession(db, {
				connection_id: "c-gone",
				thread_id: "t-1",
				site_id: "site-gone",
			});
			softDelete(db, "client_sessions", "c-gone::t-1", SITE_ID);

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			// GROUP BY cs.site_id, label + ORDER BY label ASC → ["alpha","zeta"], no "gone".
			expect(rows[0].attachedSessionHostsJson).toBe(JSON.stringify(["alpha", "zeta"]));
		});

		it("collapses multiple connections from the SAME site into one label via GROUP BY", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedHost(db, { site_id: "site-laptop", host_name: "laptop" });
			seedClientSession(db, {
				connection_id: "conn-1",
				thread_id: "t-1",
				site_id: "site-laptop",
			});
			seedClientSession(db, {
				connection_id: "conn-2",
				thread_id: "t-1",
				site_id: "site-laptop",
			});

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].attachedSessionHostsJson).toBe(JSON.stringify(["laptop"]));
		});
	});

	describe("hasRunningTask — EXISTS over live running tasks", () => {
		it("is 1 when a live task on the thread is running", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedTask(db, { id: "task-run", thread_id: "t-1", status: "running" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].hasRunningTask).toBe(1);
		});

		it("is 0 when the only running task is soft-deleted (deleted=0 filter)", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedTask(db, { id: "task-dead", thread_id: "t-1", status: "running" });
			softDelete(db, "tasks", "task-dead", SITE_ID);

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].hasRunningTask).toBe(0);
		});

		it("is 0 when the live task on the thread is not running", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "user" });
			seedTask(db, { id: "task-pending", thread_id: "t-1", status: "pending" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows[0].hasRunningTask).toBe(0);
		});
	});

	describe("includeEmpty gate — EXISTS(role='user' message)", () => {
		it("includeEmpty=false excludes a thread with no live user message", () => {
			seedThread(db, { id: "t-empty", last_message_at: "2026-02-02T00:00:00.000Z" });
			// Only an assistant message — not a user message.
			seedMessage(db, { id: "m-asst", thread_id: "t-empty", role: "assistant" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: false,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows).toEqual([]);
		});

		it("includeEmpty=false includes a thread with a live user message", () => {
			seedThread(db, { id: "t-user", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-user", thread_id: "t-user", role: "user" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: false,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-user"]);
		});

		it("includeEmpty=false excludes a thread whose only user message is soft-deleted", () => {
			seedThread(db, { id: "t-soft", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedMessage(db, { id: "m-soft", thread_id: "t-soft", role: "user" });
			softDelete(db, "messages", "m-soft", SITE_ID);

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: false,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows).toEqual([]);
		});

		it("includeEmpty=true includes a thread with zero user messages", () => {
			seedThread(db, { id: "t-empty", last_message_at: "2026-02-02T00:00:00.000Z" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-empty"]);
		});
	});

	describe("thread-level filters (left side)", () => {
		it("excludes a soft-deleted thread", () => {
			seedThread(db, { id: "t-live", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedThread(db, { id: "t-dead", last_message_at: "2026-03-03T00:00:00.000Z" });
			softDelete(db, "threads", "t-dead", SITE_ID);

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-live"]);
		});

		it("scopes to the requested user only", () => {
			seedThread(db, {
				id: "t-mine",
				user_id: USER,
				last_message_at: "2026-02-02T00:00:00.000Z",
			});
			seedThread(db, {
				id: "t-theirs",
				user_id: "other-user",
				last_message_at: "2026-03-03T00:00:00.000Z",
			});

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-mine"]);
		});
	});

	describe("ordering, keyset cursor, and limit", () => {
		it("orders by last_message_at DESC, then id DESC", () => {
			seedThread(db, { id: "t-old", last_message_at: "2026-01-01T00:00:00.000Z" });
			seedThread(db, { id: "t-new", last_message_at: "2026-06-06T00:00:00.000Z" });
			seedThread(db, { id: "t-mid", last_message_at: "2026-03-03T00:00:00.000Z" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-new", "t-mid", "t-old"]);
		});

		it("breaks ties on identical last_message_at by id DESC", () => {
			seedThread(db, { id: "t-aaa", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedThread(db, { id: "t-ccc", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedThread(db, { id: "t-bbb", last_message_at: "2026-02-02T00:00:00.000Z" });

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: null,
			});
			// id DESC over identical timestamps.
			expect(rows.map((r) => r.id)).toEqual(["t-ccc", "t-bbb", "t-aaa"]);
		});

		it("applies the keyset cursor: strictly older rows, plus id tiebreak at the boundary ts", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-01-01T00:00:00.000Z" });
			seedThread(db, { id: "t-2", last_message_at: "2026-02-02T00:00:00.000Z" });
			// Two rows share the boundary timestamp; cursor id sits between them.
			seedThread(db, { id: "t-3a", last_message_at: "2026-03-03T00:00:00.000Z" });
			seedThread(db, { id: "t-3z", last_message_at: "2026-03-03T00:00:00.000Z" });
			seedThread(db, { id: "t-4", last_message_at: "2026-04-04T00:00:00.000Z" });

			// Cursor at (2026-03-03, "t-3z"): want rows with last_message_at < ts,
			// OR (== ts AND id < "t-3z"). So t-3a (== ts, id < t-3z), t-2, t-1.
			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: "2026-03-03T00:00:00.000Z",
				beforeId: "t-3z",
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-3a", "t-2", "t-1"]);
		});

		it("ignores the cursor when only one of beforeTs/beforeId is provided", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-01-01T00:00:00.000Z" });
			seedThread(db, { id: "t-2", last_message_at: "2026-02-02T00:00:00.000Z" });

			// beforeId null disables the cursor entirely — all rows returned.
			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: "2026-01-01T00:00:00.000Z",
				beforeId: null,
				limit: null,
			});
			expect(rows.map((r) => r.id)).toEqual(["t-2", "t-1"]);
		});

		it("applies LIMIT and keeps the most-recent rows under the cap", () => {
			const stamps: Array<[string, string]> = [
				["t-1", "2026-01-01T00:00:00.000Z"],
				["t-2", "2026-02-02T00:00:00.000Z"],
				["t-3", "2026-03-03T00:00:00.000Z"],
				["t-4", "2026-04-04T00:00:00.000Z"],
				["t-5", "2026-05-05T00:00:00.000Z"],
			];
			for (const [id, last] of stamps) {
				seedThread(db, { id, last_message_at: last });
			}

			const rows = listThreadsDirectory(db, {
				userId: USER,
				includeEmpty: true,
				beforeTs: null,
				beforeId: null,
				limit: 2,
			});
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.id)).toEqual(["t-5", "t-4"]);
		});
	});

	describe("countThreadsDirectory — total independent of cursor/limit", () => {
		it("counts all matching live threads for the user", () => {
			seedThread(db, { id: "t-1", last_message_at: "2026-01-01T00:00:00.000Z" });
			seedThread(db, { id: "t-2", last_message_at: "2026-02-02T00:00:00.000Z" });
			seedThread(db, { id: "t-3", last_message_at: "2026-03-03T00:00:00.000Z" });

			const res = countThreadsDirectory(db, { userId: USER, includeEmpty: true });
			expect(res).toEqual({ total: 3 });
		});

		it("returns zero (a row, not null) when no threads match", () => {
			const res = countThreadsDirectory(db, { userId: "nobody", includeEmpty: true });
			// COUNT(*) always yields one row, so the finder returns { total: 0 }, never null.
			expect(res).toEqual({ total: 0 });
		});

		it("excludes soft-deleted threads and threads owned by others", () => {
			seedThread(db, { id: "t-live", user_id: USER });
			seedThread(db, { id: "t-dead", user_id: USER });
			softDelete(db, "threads", "t-dead", SITE_ID);
			seedThread(db, { id: "t-theirs", user_id: "other-user" });

			const res = countThreadsDirectory(db, { userId: USER, includeEmpty: true });
			expect(res).toEqual({ total: 1 });
		});

		it("honors includeEmpty=false: counts only threads with a live user message", () => {
			seedThread(db, { id: "t-user" });
			seedMessage(db, { id: "m-user", thread_id: "t-user", role: "user" });
			seedThread(db, { id: "t-empty" });
			seedMessage(db, { id: "m-asst", thread_id: "t-empty", role: "assistant" });

			const res = countThreadsDirectory(db, { userId: USER, includeEmpty: false });
			expect(res).toEqual({ total: 1 });
		});
	});
});
