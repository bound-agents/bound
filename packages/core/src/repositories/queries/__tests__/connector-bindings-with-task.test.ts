import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorHandleRow, Task, Thread } from "@bound/shared";
import { createCoreTestDb } from "../../../__tests__/test-database";
import { insertRow, softDelete } from "../../../index";
import {
	type ConnectorBindingWithTaskRow,
	listConnectorBindingsWithTask,
} from "../connector-bindings-with-task";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function seedHandle(db: Database, overrides: Partial<ConnectorHandleRow> & { id: string }): void {
	const row: ConnectorHandleRow = {
		id: overrides.id,
		server_name: overrides.server_name ?? "discord",
		event_name: overrides.event_name ?? "message",
		event_args: overrides.event_args ?? "{}",
		delivery_mode: overrides.delivery_mode ?? "push",
		cursor: overrides.cursor ?? null,
		task_id: overrides.task_id ?? null,
		created_at: overrides.created_at ?? TS,
		deleted: overrides.deleted ?? 0,
		modified_at: overrides.modified_at ?? TS,
	};
	insertRow(db, "connector_handles", row, SITE_ID);
}

function seedTask(db: Database, overrides: Partial<Task> & { id: string }): void {
	const base: Task = {
		id: overrides.id,
		type: "event",
		status: "pending",
		trigger_spec: "connector",
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
		created_at: TS,
		created_by: null,
		modified_at: TS,
		deleted: 0,
		...overrides,
	};
	insertRow(db, "tasks", base, SITE_ID);
}

function seedThread(db: Database, overrides: Partial<Thread> & { id: string }): void {
	const base: Thread = {
		id: overrides.id,
		user_id: "u1",
		interface: "web",
		host_origin: SITE_ID,
		color: null,
		title: null,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: TS,
		last_message_at: TS,
		modified_at: TS,
		deleted: 0,
		model_hint: null,
		agent_id: null,
		parent_thread_id: null,
		...overrides,
	};
	insertRow(db, "threads", base, SITE_ID);
}

describe("listConnectorBindingsWithTask", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	it("returns [] when there are no handles", () => {
		expect(listConnectorBindingsWithTask(db)).toEqual([]);
	});

	it("projects the handle plus task + thread fields and preserves raw event_args", () => {
		seedThread(db, { id: "thr-1", title: "Deploy watcher" });
		seedTask(db, {
			id: "task-1",
			status: "pending",
			thread_id: "thr-1",
			trigger_spec: "connector:event:h1",
			model_hint: "opus",
		});
		seedHandle(db, {
			id: "h1",
			server_name: "discord",
			event_name: "message_create",
			event_args: '{"channel":"123"}',
			delivery_mode: "push",
			cursor: "cur-9",
			task_id: "task-1",
			created_at: "2026-02-02T00:00:00.000Z",
			modified_at: "2026-02-02T00:00:00.000Z",
		});

		const rows = listConnectorBindingsWithTask(db);
		expect(rows).toHaveLength(1);
		const row = rows[0] as ConnectorBindingWithTaskRow;
		expect(row).toEqual({
			id: "h1",
			server_name: "discord",
			event_name: "message_create",
			// event_args stays a raw JSON string — parsed at the API edge.
			event_args: '{"channel":"123"}',
			delivery_mode: "push",
			cursor: "cur-9",
			task_id: "task-1",
			created_at: "2026-02-02T00:00:00.000Z",
			modified_at: "2026-02-02T00:00:00.000Z",
			task_status: "pending",
			task_thread_id: "thr-1",
			task_trigger_spec: "connector:event:h1",
			model_hint: "opus",
			thread_title: "Deploy watcher",
		});
	});

	it("surfaces null task/thread columns when the handle's task is absent (LEFT JOIN)", () => {
		seedHandle(db, { id: "h-orphan", task_id: "ghost-task" });
		const rows = listConnectorBindingsWithTask(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].task_status).toBeNull();
		expect(rows[0].task_thread_id).toBeNull();
		expect(rows[0].task_trigger_spec).toBeNull();
		expect(rows[0].model_hint).toBeNull();
		expect(rows[0].thread_title).toBeNull();
		// handle's own columns still populated
		expect(rows[0].id).toBe("h-orphan");
		expect(rows[0].task_id).toBe("ghost-task");
	});

	it("drops the task join when the task is soft-deleted (t.deleted=0 filter)", () => {
		seedTask(db, { id: "task-dead", model_hint: "sonnet", status: "pending" });
		softDelete(db, "tasks", "task-dead", SITE_ID);
		seedHandle(db, { id: "h2", task_id: "task-dead" });
		const rows = listConnectorBindingsWithTask(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].task_status).toBeNull();
		expect(rows[0].model_hint).toBeNull();
	});

	it("drops the thread join when the thread is soft-deleted but keeps task fields", () => {
		seedThread(db, { id: "thr-dead", title: "gone" });
		softDelete(db, "threads", "thr-dead", SITE_ID);
		seedTask(db, { id: "task-2", thread_id: "thr-dead", status: "running" });
		seedHandle(db, { id: "h3", task_id: "task-2" });
		const rows = listConnectorBindingsWithTask(db);
		expect(rows[0].task_status).toBe("running");
		expect(rows[0].task_thread_id).toBe("thr-dead");
		// thread title drops because the thread row is soft-deleted
		expect(rows[0].thread_title).toBeNull();
	});

	it("excludes soft-deleted handles and orders by created_at DESC", () => {
		seedHandle(db, { id: "h-old", created_at: "2026-01-01T00:00:00.000Z" });
		seedHandle(db, { id: "h-new", created_at: "2026-05-05T00:00:00.000Z" });
		seedHandle(db, { id: "h-mid", created_at: "2026-03-03T00:00:00.000Z" });
		seedHandle(db, { id: "h-gone", created_at: "2026-04-04T00:00:00.000Z" });
		softDelete(db, "connector_handles", "h-gone", SITE_ID);

		const rows = listConnectorBindingsWithTask(db);
		expect(rows.map((r) => r.id)).toEqual(["h-new", "h-mid", "h-old"]);
	});
});
