import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";

describe("Scheduler webhook system prompt addition", () => {
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		db = new Database(":memory:");
		siteId = randomUUID();

		applySchema(db);

		// Insert a default host
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?)`,
			[siteId, "test-host", "1.0.0", new Date().toISOString(), 0],
		);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC3.6: systemPromptAddition flows from scheduler event tasks
	// ──────────────────────────────────────────────────────────────────
	test("AC3.6: Scheduler can read system_prompt_addition from event tasks", () => {
		// Create a webhook trigger task with system_prompt_addition
		const taskId = randomUUID();
		const threadId = randomUUID();
		const systemPromptAddition = "Process incoming webhook data carefully.";

		// Insert event task with system_prompt_addition
		db.prepare(
			`INSERT INTO tasks (id, thread_id, type, status, trigger_spec, no_history, system_prompt_addition, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run([
			taskId,
			threadId,
			"event",
			"pending",
			"webhook:github-push",
			0,
			systemPromptAddition,
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		]);

		// Verify the SELECT query used in scheduler works
		// This simulates what scheduler.ts line 980ish does to fetch the task
		const taskRow = db
			.query(
				"SELECT id, type, status, trigger_spec, no_history, system_prompt_addition, created_at FROM tasks WHERE id = ? AND deleted = 0",
			)
			.get(taskId) as {
			id: string;
			type: string;
			status: string;
			trigger_spec: string;
			no_history: number;
			system_prompt_addition: string | null;
			created_at: string;
		} | null;

		expect(taskRow).toBeDefined();
		expect(taskRow?.id).toBe(taskId);
		expect(taskRow?.type).toBe("event");
		expect(taskRow?.system_prompt_addition).toBe(systemPromptAddition);
	});

	test("AC3.6: Scheduler handles tasks without system_prompt_addition", () => {
		// Create a webhook trigger task without system_prompt_addition
		const taskId = randomUUID();
		const threadId = randomUUID();

		// Insert event task without system_prompt_addition
		db.prepare(
			`INSERT INTO tasks (id, thread_id, type, status, trigger_spec, no_history, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run([
			taskId,
			threadId,
			"event",
			"pending",
			"webhook:stripe-payment",
			0,
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		]);

		// Verify the SELECT query handles null system_prompt_addition
		const taskRow = db
			.query(
				"SELECT id, type, status, trigger_spec, no_history, system_prompt_addition FROM tasks WHERE id = ? AND deleted = 0",
			)
			.get(taskId) as {
			id: string;
			type: string;
			status: string;
			trigger_spec: string;
			no_history: number;
			system_prompt_addition: string | null;
		} | null;

		expect(taskRow).toBeDefined();
		expect(taskRow?.id).toBe(taskId);
		expect(taskRow?.system_prompt_addition).toBeNull();
	});
});
