import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChangeLogEntry,
	type Task,
	type Thread,
	TypedEventEmitter,
	type Webhook,
} from "@bound/shared";
import {
	applyMetricsSchema,
	applySchema,
	createWebhookBinding,
	insertRow,
	setChangelogEventBus,
	softDelete,
	updateRow,
} from "../../index";
import {
	findWebhookByName,
	findWebhookDeletedFlagById,
	findWebhookIdAndTaskIdByName,
	findWebhookIdById,
	findWebhookIdByName,
	findWebhookIdsById,
	findWebhookIdsByName,
	findWebhookNameById,
	findWebhookTaskIdById,
} from "../webhooks";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
	return {
		id: "wh-1",
		name: "deploy",
		secret: "shhh",
		signature_format: "github",
		description: null,
		task_id: "task-1",
		thread_id: "thread-1",
		created_at: TS,
		deleted: 0,
		modified_at: TS,
		...overrides,
	};
}

describe("webhooks repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	function insertWebhook(overrides: Partial<Webhook> = {}) {
		insertRow(db, "webhooks", makeWebhook(overrides), SITE_ID);
	}

	describe("findWebhookByName", () => {
		it("returns the full live row by name", () => {
			insertWebhook({
				id: "wh-a",
				name: "ci-hook",
				secret: "topsecret",
				signature_format: "stripe",
				description: "CI trigger",
				task_id: "task-ci",
				thread_id: "thread-ci",
			});

			const row = findWebhookByName(db, "ci-hook");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("wh-a");
			expect(row?.name).toBe("ci-hook");
			expect(row?.secret).toBe("topsecret");
			expect(row?.signature_format).toBe("stripe");
			expect(row?.description).toBe("CI trigger");
			expect(row?.task_id).toBe("task-ci");
			expect(row?.thread_id).toBe("thread-ci");
			expect(row?.created_at).toBe(TS);
			expect(row?.deleted).toBe(0);
		});

		it("returns null for an absent name", () => {
			expect(findWebhookByName(db, "nope")).toBeNull();
		});

		it("does NOT return a soft-deleted row (deleted=0 filter)", () => {
			insertWebhook({ id: "wh-del", name: "gone" });
			softDelete(db, "webhooks", "wh-del", SITE_ID);
			expect(findWebhookByName(db, "gone")).toBeNull();
		});
	});

	describe("findWebhookIdByName", () => {
		it("returns the id for a live row", () => {
			insertWebhook({ id: "wh-b", name: "by-name-id" });
			expect(findWebhookIdByName(db, "by-name-id")).toEqual({ id: "wh-b" });
		});

		it("returns null for an absent name", () => {
			expect(findWebhookIdByName(db, "missing")).toBeNull();
		});
	});

	describe("findWebhookIdAndTaskIdByName", () => {
		it("returns id and task_id for a live row", () => {
			insertWebhook({ id: "wh-c", name: "id-task", task_id: "task-xyz" });
			expect(findWebhookIdAndTaskIdByName(db, "id-task")).toEqual({
				id: "wh-c",
				task_id: "task-xyz",
			});
		});

		it("returns null for an absent name", () => {
			expect(findWebhookIdAndTaskIdByName(db, "missing")).toBeNull();
		});
	});

	describe("findWebhookIdsByName", () => {
		it("returns id, task_id, thread_id for a live row", () => {
			insertWebhook({
				id: "wh-d",
				name: "all-ids",
				task_id: "task-d",
				thread_id: "thread-d",
			});
			expect(findWebhookIdsByName(db, "all-ids")).toEqual({
				id: "wh-d",
				task_id: "task-d",
				thread_id: "thread-d",
			});
		});

		it("returns null for an absent name", () => {
			expect(findWebhookIdsByName(db, "missing")).toBeNull();
		});
	});

	describe("findWebhookIdsById", () => {
		it("returns id, task_id, thread_id for a live row", () => {
			insertWebhook({
				id: "wh-e",
				name: "ids-by-id",
				task_id: "task-e",
				thread_id: "thread-e",
			});
			expect(findWebhookIdsById(db, "wh-e")).toEqual({
				id: "wh-e",
				task_id: "task-e",
				thread_id: "thread-e",
			});
		});

		it("returns null for an absent id", () => {
			expect(findWebhookIdsById(db, "no-such-id")).toBeNull();
		});
	});

	describe("findWebhookIdById", () => {
		it("returns the id for a live row", () => {
			insertWebhook({ id: "wh-f", name: "id-by-id" });
			expect(findWebhookIdById(db, "wh-f")).toEqual({ id: "wh-f" });
		});

		it("returns null for an absent id", () => {
			expect(findWebhookIdById(db, "ghost")).toBeNull();
		});
	});

	describe("findWebhookNameById", () => {
		it("returns the name for a live row", () => {
			insertWebhook({ id: "wh-g", name: "named" });
			expect(findWebhookNameById(db, "wh-g")).toEqual({ name: "named" });
		});

		it("returns null for an absent id", () => {
			expect(findWebhookNameById(db, "ghost")).toBeNull();
		});
	});

	describe("findWebhookTaskIdById", () => {
		it("returns the task_id for a live row", () => {
			insertWebhook({ id: "wh-h", name: "task-by-id", task_id: "task-h" });
			expect(findWebhookTaskIdById(db, "wh-h")).toEqual({ task_id: "task-h" });
		});

		it("returns null for an absent id", () => {
			expect(findWebhookTaskIdById(db, "ghost")).toBeNull();
		});
	});

	describe("findWebhookDeletedFlagById (deleted-filter OMISSION)", () => {
		it("returns the tombstoned row's deleted flag while deleted=0 siblings do not", () => {
			insertWebhook({ id: "wh-tomb", name: "tomb" });
			softDelete(db, "webhooks", "wh-tomb", SITE_ID);

			// The omission finder sees the soft-deleted row.
			expect(findWebhookDeletedFlagById(db, "wh-tomb")).toEqual({ deleted: 1 });

			// Its deleted=0 siblings do NOT.
			expect(findWebhookIdById(db, "wh-tomb")).toBeNull();
			expect(findWebhookNameById(db, "wh-tomb")).toBeNull();
			expect(findWebhookByName(db, "tomb")).toBeNull();
		});

		it("returns deleted=0 for a live row", () => {
			insertWebhook({ id: "wh-live", name: "live" });
			expect(findWebhookDeletedFlagById(db, "wh-live")).toEqual({ deleted: 0 });
		});

		it("returns null for an absent id (row never existed)", () => {
			expect(findWebhookDeletedFlagById(db, "never")).toBeNull();
		});

		it("reflects an updated deleted flag after restore via updateRow", () => {
			insertWebhook({ id: "wh-restore", name: "restore" });
			softDelete(db, "webhooks", "wh-restore", SITE_ID);
			expect(findWebhookDeletedFlagById(db, "wh-restore")).toEqual({ deleted: 1 });

			updateRow(db, "webhooks", "wh-restore", { deleted: 0 }, SITE_ID);
			expect(findWebhookDeletedFlagById(db, "wh-restore")).toEqual({ deleted: 0 });
			// And now the deleted=0 siblings see it again.
			expect(findWebhookByName(db, "restore")?.id).toBe("wh-restore");
		});
	});
});

describe("createWebhookBinding", () => {
	const input = {
		name: "binding",
		signatureFormat: "github" as const,
		description: "desc",
		prompt: "prompt",
		modelHint: "model",
		noHistory: 1 as const,
	};
	let db: Database;
	let observerDb: Database | null;
	let tempDir: string | null;

	function changeLogRows(database: Database): ChangeLogEntry[] {
		return database
			.query(
				"SELECT hlc, table_name, row_id, site_id, timestamp, row_data FROM change_log ORDER BY hlc",
			)
			.all() as ChangeLogEntry[];
	}

	function expectTableCounts(database: Database, counts: Record<string, number>) {
		for (const [table, count] of Object.entries(counts)) {
			expect(database.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count });
		}
	}

	function expectChangeTables(database: Database, tableNames: string[]) {
		expect(changeLogRows(database).map((change) => change.table_name)).toEqual(tableNames);
	}

	function expectCompletePersistedBinding(database: Database, name: string) {
		const webhook = database.query("SELECT * FROM webhooks WHERE name = ?").get(name) as Webhook;
		const task = database.query("SELECT * FROM tasks WHERE id = ?").get(webhook.task_id) as Task;
		const thread = database
			.query("SELECT * FROM threads WHERE id = ?")
			.get(webhook.thread_id) as Thread;
		const changes = changeLogRows(database);
		const {
			agent_id: _agentId,
			parent_thread_id: _parentThreadId,
			...threadInsertSnapshot
		} = thread;

		expect(webhook.task_id).toBe(task.id);
		expect(webhook.thread_id).toBe(task.thread_id);
		expect(task.thread_id).toBe(thread.id);
		expect(changes.map((change) => change.table_name)).toEqual(["threads", "tasks", "webhooks"]);
		expect(changes.map((change) => change.row_id)).toEqual([thread.id, task.id, webhook.id]);
		expect(changes.map((change) => change.site_id)).toEqual([SITE_ID, SITE_ID, SITE_ID]);
		expect(changes.map((change) => change.hlc)).toEqual(
			[...changes.map((change) => change.hlc)].sort(),
		);
		expect(changes.map((change) => JSON.parse(change.row_data))).toEqual([
			threadInsertSnapshot,
			task,
			webhook,
		]);
		return { changes, task, thread, webhook };
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		observerDb = null;
		tempDir = null;
	});

	afterEach(() => {
		setChangelogEventBus(null);
		observerDb?.close();
		db.close();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("persists complete linked rows and replicated snapshots in thread-task-webhook order", () => {
		const binding = createWebhookBinding(db, SITE_ID, input);
		const { task, thread, webhook } = expectCompletePersistedBinding(db, input.name);

		expect(binding.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(thread).toEqual({
			id: binding.threadId,
			user_id: "system",
			interface: "webhook",
			host_origin: SITE_ID,
			color: 0,
			title: "Webhook: binding",
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			model_hint: "model",
			created_at: thread.created_at,
			last_message_at: thread.created_at,
			modified_at: thread.created_at,
			deleted: 0,
			parent_thread_id: null,
			agent_id: null,
		});
		expect(task).toEqual({
			id: binding.taskId,
			type: "event",
			status: "pending",
			trigger_spec: "webhook:binding",
			payload: null,
			created_at: thread.created_at,
			created_by: SITE_ID,
			thread_id: binding.threadId,
			origin_thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: null,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: "model",
			no_history: 1,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 3,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			system_prompt_addition: "prompt",
			modified_at: thread.created_at,
			deleted: 0,
		});
		expect(webhook).toEqual({
			id: binding.webhookId,
			name: "binding",
			secret: binding.secret,
			signature_format: "github",
			description: "desc",
			task_id: binding.taskId,
			thread_id: binding.threadId,
			created_at: thread.created_at,
			deleted: 0,
			modified_at: thread.created_at,
		});
	});

	it("keeps the committed thread and its change-log entry when task persistence aborts", () => {
		db.exec(`CREATE TRIGGER abort_webhook_task_insert BEFORE INSERT ON tasks
			WHEN NEW.trigger_spec = 'webhook:binding'
			BEGIN SELECT RAISE(ABORT, 'forced task persistence failure'); END`);
		expect(() => createWebhookBinding(db, SITE_ID, input)).toThrow(
			"forced task persistence failure",
		);
		expectTableCounts(db, { threads: 1, tasks: 0, webhooks: 0 });
		expectChangeTables(db, ["threads"]);
	});

	it("keeps committed thread and task rows when webhook persistence aborts", () => {
		db.exec(`CREATE TRIGGER abort_webhook_insert BEFORE INSERT ON webhooks
			WHEN NEW.name = 'binding'
			BEGIN SELECT RAISE(ABORT, 'forced webhook persistence failure'); END`);
		expect(() => createWebhookBinding(db, SITE_ID, input)).toThrow(
			"forced webhook persistence failure",
		);
		expectTableCounts(db, { threads: 1, tasks: 1, webhooks: 0 });
		expectChangeTables(db, ["threads", "tasks"]);
	});

	it("propagates a post-commit event failure only after an independent connection sees the complete linked binding and snapshots", () => {
		db.close();
		tempDir = mkdtempSync(join(tmpdir(), "bound-webhook-binding-"));
		db = new Database(join(tempDir, "binding.db"));
		applySchema(db);
		applyMetricsSchema(db);
		observerDb = new Database(join(tempDir, "binding.db"));
		const events: string[] = [];
		const eventBus = new TypedEventEmitter();
		eventBus.on("changelog:written", (data) => {
			events.push(`changelog:written:${data.tableName}`);
			if (data.tableName !== "webhooks") return;

			const { changes } = expectCompletePersistedBinding(observerDb as Database, input.name);
			expect(changes.at(-1)?.hlc).toBe(data.hlc);
			throw new Error("forced post-commit event failure");
		});
		setChangelogEventBus(eventBus);

		expect(() => createWebhookBinding(db, SITE_ID, input)).toThrow(
			"forced post-commit event failure",
		);
		expect(events).toEqual([
			"changelog:written:threads",
			"changelog:written:tasks",
			"changelog:written:webhooks",
		]);
		const webhook = db.query("SELECT * FROM webhooks WHERE name = ?").get(input.name) as Webhook;
		const task = db.query("SELECT * FROM tasks WHERE id = ?").get(webhook.task_id) as Task;
		expectTableCounts(db, { threads: 1, tasks: 1, webhooks: 1 });
		expect(webhook.thread_id).toBe(task.thread_id);
		expectChangeTables(db, ["threads", "tasks", "webhooks"]);
	});

	it("restores a tombstone with fresh linkage and an ordered full-row update snapshot", () => {
		const first = createWebhookBinding(db, SITE_ID, input);
		softDelete(db, "webhooks", first.webhookId, SITE_ID);
		const second = createWebhookBinding(db, SITE_ID, {
			...input,
			description: "restored desc",
			signatureFormat: "slack",
		});
		const restored = db
			.query("SELECT * FROM webhooks WHERE id = ?")
			.get(second.webhookId) as Webhook;
		const restoredTask = db.query("SELECT id FROM tasks WHERE id = ?").get(second.taskId);
		const restoredThread = db.query("SELECT id FROM threads WHERE id = ?").get(second.threadId);
		const changes = changeLogRows(db);
		const restoration = changes.at(-1);

		expect(second.webhookId).toBe(first.webhookId);
		expect(second.taskId).not.toBe(first.taskId);
		expect(second.threadId).not.toBe(first.threadId);
		expect(restored).toMatchObject({
			id: first.webhookId,
			name: "binding",
			secret: second.secret,
			signature_format: "slack",
			description: "restored desc",
			task_id: second.taskId,
			thread_id: second.threadId,
			deleted: 0,
		});
		expect(restored.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(restoredTask).toEqual({ id: second.taskId });
		expect(restoredThread).toEqual({ id: second.threadId });
		expect(changes.slice(-3).map((change) => change.table_name)).toEqual([
			"threads",
			"tasks",
			"webhooks",
		]);
		expect(restoration).toMatchObject({
			table_name: "webhooks",
			row_id: first.webhookId,
			site_id: SITE_ID,
		});
		expect(JSON.parse(restoration?.row_data ?? "{}")).toEqual(restored);
	});

	it("leaves the tombstone intact while retaining new thread and task commits when restoration update aborts", () => {
		const first = createWebhookBinding(db, SITE_ID, input);
		softDelete(db, "webhooks", first.webhookId, SITE_ID);
		db.exec(`CREATE TRIGGER abort_webhook_restore BEFORE UPDATE ON webhooks
			WHEN NEW.id = '${first.webhookId}' AND NEW.deleted = 0
			BEGIN SELECT RAISE(ABORT, 'forced tombstone restoration failure'); END`);
		expect(() => createWebhookBinding(db, SITE_ID, input)).toThrow(
			"forced tombstone restoration failure",
		);
		expect(
			db
				.query("SELECT deleted, task_id, thread_id FROM webhooks WHERE id = ?")
				.get(first.webhookId),
		).toEqual({ deleted: 1, task_id: first.taskId, thread_id: first.threadId });
		expect(db.query("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 2 });
		expect(db.query("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 2 });
		expect(
			changeLogRows(db)
				.slice(-3)
				.map((change) => change.table_name),
		).toEqual(["webhooks", "threads", "tasks"]);
	});
});
