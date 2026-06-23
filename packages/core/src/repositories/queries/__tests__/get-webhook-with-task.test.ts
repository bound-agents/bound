import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Task, Webhook } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import {
	getWebhookWithTaskById,
	getWebhookWithTaskByName,
	listWebhooksForCli,
	listWebhooksWithTask,
} from "../get-webhook-with-task";

const SITE_ID = "site-test";

/**
 * Seed a `tasks` row. Only the columns the schema actually declares are written
 * (the `Task` type carries an `origin_thread_id` field that the schema does not,
 * so it must be omitted or the INSERT fails). Nullable columns default to null.
 */
function seedTask(db: Database, overrides: Partial<Task> & { id: string }): void {
	const base = {
		id: overrides.id,
		type: "event",
		status: "pending",
		trigger_spec: "webhook",
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
		created_at: "2026-01-01T00:00:00.000Z",
		created_by: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
	// Cast through unknown: the literal omits `origin_thread_id` from the Task
	// type on purpose (no such column in the schema).
	insertRow(db, "tasks", base as unknown as Task, SITE_ID);
}

function seedWebhook(
	db: Database,
	overrides: Partial<Webhook> & { id: string; name: string },
): void {
	const base: Webhook = {
		id: overrides.id,
		name: overrides.name,
		secret: "shhh",
		signature_format: "github",
		description: null,
		task_id: "task-default",
		thread_id: "thread-default",
		created_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		modified_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
	insertRow(db, "webhooks", base, SITE_ID);
}

describe("get-webhook-with-task finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("getWebhookWithTaskById — happy path + projection shape", () => {
		it("projects the exact column set with task fields surfaced", () => {
			seedTask(db, {
				id: "task-1",
				model_hint: "opus",
				no_history: 1,
				system_prompt_addition: "be terse",
			});
			seedWebhook(db, {
				id: "wh-1",
				name: "deploy",
				signature_format: "stripe",
				description: "deploy hook",
				task_id: "task-1",
				thread_id: "thread-1",
				created_at: "2026-02-02T00:00:00.000Z",
				modified_at: "2026-02-02T00:00:00.000Z",
			});

			const row = getWebhookWithTaskById(db, "wh-1");
			expect(row).not.toBeNull();
			// Hand-written oracle: assert the EXACT projection the call sites destructure.
			expect(row).toEqual({
				id: "wh-1",
				name: "deploy",
				signature_format: "stripe",
				description: "deploy hook",
				task_id: "task-1",
				thread_id: "thread-1",
				created_at: "2026-02-02T00:00:00.000Z",
				modified_at: "2026-02-02T00:00:00.000Z",
				prompt: "be terse",
				model_hint: "opus",
				no_history: 1,
			});
			// Exact key set — guards against accidental projection drift.
			expect(Object.keys(row as object).sort()).toEqual(
				[
					"created_at",
					"description",
					"id",
					"model_hint",
					"modified_at",
					"name",
					"no_history",
					"prompt",
					"signature_format",
					"task_id",
					"thread_id",
				].sort(),
			);
		});

		it("returns null for an absent id", () => {
			seedTask(db, { id: "task-1" });
			seedWebhook(db, { id: "wh-1", name: "deploy", task_id: "task-1" });
			expect(getWebhookWithTaskById(db, "nope")).toBeNull();
		});

		it("returns null when the matching webhook is soft-deleted (deleted=0 filter)", () => {
			seedTask(db, { id: "task-1" });
			seedWebhook(db, { id: "wh-1", name: "deploy", task_id: "task-1" });
			softDelete(db, "webhooks", "wh-1", SITE_ID);
			expect(getWebhookWithTaskById(db, "wh-1")).toBeNull();
		});
	});

	describe("LEFT JOIN null case — webhook with no matching live task", () => {
		it("returns the webhook with null prompt/model_hint and no_history coerced to 0 when task is absent", () => {
			// task_id points at a task that was never inserted.
			seedWebhook(db, {
				id: "wh-orphan",
				name: "orphan",
				task_id: "ghost-task",
				thread_id: "thread-x",
				created_at: "2026-03-03T00:00:00.000Z",
				modified_at: "2026-03-03T00:00:00.000Z",
			});

			const row = getWebhookWithTaskById(db, "wh-orphan");
			expect(row).not.toBeNull();
			expect(row?.prompt).toBeNull();
			expect(row?.model_hint).toBeNull();
			// CASE WHEN ... ELSE 0 — a missing task yields 0, never null.
			expect(row?.no_history).toBe(0);
			// Webhook's own columns still populated.
			expect(row?.id).toBe("wh-orphan");
			expect(row?.task_id).toBe("ghost-task");
			expect(row?.thread_id).toBe("thread-x");
		});

		it("excludes a soft-deleted task from the join (join filters t.deleted=0)", () => {
			seedTask(db, {
				id: "task-dead",
				model_hint: "sonnet",
				no_history: 1,
				system_prompt_addition: "ignore me",
			});
			softDelete(db, "tasks", "task-dead", SITE_ID);
			seedWebhook(db, { id: "wh-2", name: "stale", task_id: "task-dead" });

			const row = getWebhookWithTaskById(db, "wh-2");
			expect(row).not.toBeNull();
			// The webhook survives, but the soft-deleted task contributes nothing.
			expect(row?.prompt).toBeNull();
			expect(row?.model_hint).toBeNull();
			expect(row?.no_history).toBe(0);
		});

		it("no_history coerces to 0 when the linked task has no_history=0", () => {
			seedTask(db, { id: "task-z", no_history: 0 });
			seedWebhook(db, { id: "wh-z", name: "zero", task_id: "task-z" });
			const row = getWebhookWithTaskById(db, "wh-z");
			expect(row?.no_history).toBe(0);
		});
	});

	describe("getWebhookWithTaskByName", () => {
		it("finds a live webhook by name with task fields", () => {
			seedTask(db, { id: "task-n", model_hint: "haiku", no_history: 1 });
			seedWebhook(db, { id: "wh-n", name: "named-hook", task_id: "task-n" });
			const row = getWebhookWithTaskByName(db, "named-hook");
			expect(row?.id).toBe("wh-n");
			expect(row?.model_hint).toBe("haiku");
			expect(row?.no_history).toBe(1);
		});

		it("returns null for an absent name", () => {
			expect(getWebhookWithTaskByName(db, "ghost")).toBeNull();
		});

		it("returns null for a soft-deleted webhook by name", () => {
			seedTask(db, { id: "task-n", model_hint: "haiku" });
			seedWebhook(db, { id: "wh-n", name: "named-hook", task_id: "task-n" });
			softDelete(db, "webhooks", "wh-n", SITE_ID);
			expect(getWebhookWithTaskByName(db, "named-hook")).toBeNull();
		});
	});

	describe("listWebhooksWithTask — ordering + filtering", () => {
		it("returns [] when there are no webhooks", () => {
			expect(listWebhooksWithTask(db)).toEqual([]);
		});

		it("orders by created_at DESC and excludes soft-deleted webhooks", () => {
			seedTask(db, { id: "task-a", model_hint: "opus" });
			seedWebhook(db, {
				id: "wh-old",
				name: "old",
				task_id: "task-a",
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
			});
			seedWebhook(db, {
				id: "wh-new",
				name: "new",
				task_id: "task-a",
				created_at: "2026-05-05T00:00:00.000Z",
				modified_at: "2026-05-05T00:00:00.000Z",
			});
			seedWebhook(db, {
				id: "wh-mid",
				name: "mid",
				task_id: "task-a",
				created_at: "2026-03-03T00:00:00.000Z",
				modified_at: "2026-03-03T00:00:00.000Z",
			});
			seedWebhook(db, {
				id: "wh-gone",
				name: "gone",
				task_id: "task-a",
				created_at: "2026-04-04T00:00:00.000Z",
				modified_at: "2026-04-04T00:00:00.000Z",
			});
			softDelete(db, "webhooks", "wh-gone", SITE_ID);

			const rows = listWebhooksWithTask(db);
			expect(rows.map((r) => r.id)).toEqual(["wh-new", "wh-mid", "wh-old"]);
			// task fields surfaced on each live row
			expect(rows.every((r) => r.model_hint === "opus")).toBe(true);
		});

		it("surfaces nulls for webhooks whose task is missing while keeping rows that have a task", () => {
			seedTask(db, { id: "task-live", model_hint: "sonnet", no_history: 1 });
			seedWebhook(db, {
				id: "wh-has-task",
				name: "has-task",
				task_id: "task-live",
				created_at: "2026-02-02T00:00:00.000Z",
				modified_at: "2026-02-02T00:00:00.000Z",
			});
			seedWebhook(db, {
				id: "wh-no-task",
				name: "no-task",
				task_id: "missing",
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
			});

			const rows = listWebhooksWithTask(db);
			expect(rows.map((r) => r.id)).toEqual(["wh-has-task", "wh-no-task"]);

			const hasTask = rows[0];
			expect(hasTask.model_hint).toBe("sonnet");
			expect(hasTask.no_history).toBe(1);

			const noTask = rows[1];
			expect(noTask.prompt).toBeNull();
			expect(noTask.model_hint).toBeNull();
			expect(noTask.no_history).toBe(0);
		});
	});

	describe("listWebhooksForCli — distinct compact projection", () => {
		it("returns the exact CLI column set and raw no_history (nullable when no task)", () => {
			seedTask(db, {
				id: "task-cli",
				model_hint: "opus",
				no_history: 1,
				system_prompt_addition: "should NOT appear in CLI projection",
			});
			seedWebhook(db, {
				id: "wh-cli",
				name: "cli-hook",
				signature_format: "slack",
				description: "cli desc",
				task_id: "task-cli",
				created_at: "2026-02-02T00:00:00.000Z",
				modified_at: "2026-02-02T00:00:00.000Z",
			});

			const rows = listWebhooksForCli(db);
			expect(rows).toEqual([
				{
					name: "cli-hook",
					signature_format: "slack",
					description: "cli desc",
					created_at: "2026-02-02T00:00:00.000Z",
					model_hint: "opus",
					// Raw task INTEGER, NOT the CASE-coerced value of the other projection.
					no_history: 1,
				},
			]);
			// The CLI projection must NOT carry id/task_id/thread_id/prompt.
			expect(Object.keys(rows[0]).sort()).toEqual(
				[
					"created_at",
					"description",
					"model_hint",
					"name",
					"no_history",
					"signature_format",
				].sort(),
			);
		});

		it("surfaces raw no_history=null (not 0) for the CLI projection when the task is absent", () => {
			seedWebhook(db, {
				id: "wh-cli-orphan",
				name: "cli-orphan",
				task_id: "ghost",
				created_at: "2026-03-03T00:00:00.000Z",
				modified_at: "2026-03-03T00:00:00.000Z",
			});
			const rows = listWebhooksForCli(db);
			expect(rows).toHaveLength(1);
			expect(rows[0].model_hint).toBeNull();
			// Distinct from WebhookWithTaskRow: this projection has NO CASE coercion,
			// so a missing task yields a raw NULL, not 0.
			expect(rows[0].no_history).toBeNull();
		});

		it("orders by created_at DESC and excludes soft-deleted webhooks", () => {
			seedTask(db, { id: "task-cli", model_hint: "opus" });
			seedWebhook(db, {
				id: "wh-1",
				name: "first",
				task_id: "task-cli",
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
			});
			seedWebhook(db, {
				id: "wh-2",
				name: "second",
				task_id: "task-cli",
				created_at: "2026-06-06T00:00:00.000Z",
				modified_at: "2026-06-06T00:00:00.000Z",
			});
			seedWebhook(db, {
				id: "wh-3",
				name: "third",
				task_id: "task-cli",
				created_at: "2026-04-04T00:00:00.000Z",
				modified_at: "2026-04-04T00:00:00.000Z",
			});
			softDelete(db, "webhooks", "wh-3", SITE_ID);

			const rows = listWebhooksForCli(db);
			expect(rows.map((r) => r.name)).toEqual(["second", "first"]);
		});

		it("returns [] when there are no webhooks", () => {
			expect(listWebhooksForCli(db)).toEqual([]);
		});
	});
});
