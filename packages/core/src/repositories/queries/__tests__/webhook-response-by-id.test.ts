import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Task, Webhook } from "@bound/shared";
import { createCoreTestDb } from "../../../__tests__/test-database";
import { insertRow, softDelete } from "../../../index";
import { findWebhookResponseById } from "../get-webhook-with-task";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function seedTask(db: Database, overrides: Partial<Task> & { id: string }): void {
	const base: Task = {
		id: overrides.id,
		type: "event",
		status: "pending",
		trigger_spec: "webhook",
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
		created_at: TS,
		deleted: 0,
		modified_at: TS,
		...overrides,
	};
	insertRow(db, "webhooks", base, SITE_ID);
}

describe("findWebhookResponseById", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	it("returns null for an absent id", () => {
		expect(findWebhookResponseById(db, "nope")).toBeNull();
	});

	it("projects webhook + task fields with the exact response column set", () => {
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

		const row = findWebhookResponseById(db, "wh-1");
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
		// secret must NOT be in the response projection.
		expect(Object.keys(row as object)).not.toContain("secret");
	});

	it("returns a soft-deleted webhook too — the finder has NO w.deleted filter", () => {
		seedTask(db, { id: "task-2" });
		seedWebhook(db, { id: "wh-2", name: "stale", task_id: "task-2" });
		softDelete(db, "webhooks", "wh-2", SITE_ID);
		// Distinct from get-webhook-with-task: this read is used by the response
		// path and intentionally returns even tombstoned rows.
		const row = findWebhookResponseById(db, "wh-2");
		expect(row).not.toBeNull();
		expect(row?.id).toBe("wh-2");
	});

	it("LEFT JOIN null case: missing task yields null prompt/model_hint and no_history=0", () => {
		seedWebhook(db, { id: "wh-orphan", name: "orphan", task_id: "ghost" });
		const row = findWebhookResponseById(db, "wh-orphan");
		expect(row?.prompt).toBeNull();
		expect(row?.model_hint).toBeNull();
		expect(row?.no_history).toBe(0);
	});

	it("excludes a soft-deleted task from the join (t.deleted=0)", () => {
		seedTask(db, { id: "task-dead", model_hint: "sonnet", no_history: 1 });
		softDelete(db, "tasks", "task-dead", SITE_ID);
		seedWebhook(db, { id: "wh-3", name: "joins-dead", task_id: "task-dead" });
		const row = findWebhookResponseById(db, "wh-3");
		expect(row?.prompt).toBeNull();
		expect(row?.model_hint).toBeNull();
		expect(row?.no_history).toBe(0);
	});
});
