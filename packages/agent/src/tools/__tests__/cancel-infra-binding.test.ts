import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow, softDelete } from "@bound/core";
import { randomUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createCancelTool } from "../cancel";

function getExecute(tool: ReturnType<typeof createCancelTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

function insertEventTask(db: Database.Database, siteId: string, triggerSpec: string): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"tasks",
		{
			id,
			type: "event",
			status: "pending",
			trigger_spec: triggerSpec,
			payload: JSON.stringify({ marker: "infra-bound" }),
			created_at: now,
			created_by: "system",
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
			alert_threshold: 5,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
	return id;
}

function status(db: Database.Database, taskId: string): string | undefined {
	const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
		| { status: string }
		| undefined;
	return row?.status;
}

describe("Cancel tool — infrastructure-binding guard", () => {
	let db: Database.Database;
	const siteId = "test-site";
	let toolContext: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		toolContext = {
			db,
			siteId,
			eventBus: { on: () => {}, off: () => {}, emit: () => {}, once: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};
	});

	afterEach(() => {
		db.close();
	});

	it("refuses to cancel a task a live webhook still points at", async () => {
		const taskId = insertEventTask(db, siteId, "webhook:bound-v2");
		const now = new Date().toISOString();
		insertRow(
			db,
			"webhooks",
			{
				id: randomUUID(),
				name: "bound-v2",
				secret: "shh",
				signature_format: "github",
				description: null,
				task_id: taskId,
				thread_id: randomUUID(),
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);

		const result = await getExecute(createCancelTool(toolContext))({ task_id: taskId });

		expect(result).toMatch(/^Error/);
		expect(result).toContain("bound-v2");
		expect(status(db, taskId)).toBe("pending");
	});

	it("refuses to cancel a task a live connector handle still points at", async () => {
		const taskId = insertEventTask(db, siteId, "connector:event:abc123");
		const now = new Date().toISOString();
		insertRow(
			db,
			"connector_handles",
			{
				id: "abc123",
				server_name: "discord",
				event_name: "message_create",
				event_args: "{}",
				delivery_mode: "push",
				cursor: null,
				task_id: taskId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);

		const result = await getExecute(createCancelTool(toolContext))({ task_id: taskId });

		expect(result).toMatch(/^Error/);
		expect(result).toContain("discord:message_create");
		expect(status(db, taskId)).toBe("pending");
	});

	it("allows cancelling once the webhook binding is soft-deleted (genuine orphan)", async () => {
		const taskId = insertEventTask(db, siteId, "webhook:retired");
		const now = new Date().toISOString();
		const webhookId = randomUUID();
		insertRow(
			db,
			"webhooks",
			{
				id: webhookId,
				name: "retired",
				secret: "shh",
				signature_format: "github",
				description: null,
				task_id: taskId,
				thread_id: randomUUID(),
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		softDelete(db, "webhooks", webhookId, siteId);

		const result = await getExecute(createCancelTool(toolContext))({ task_id: taskId });

		expect(result).not.toMatch(/^Error/);
		expect(status(db, taskId)).toBe("cancelled");
	});

	it("skips infra-bound tasks in a payload_match bulk cancel but cancels the rest", async () => {
		const boundTask = insertEventTask(db, siteId, "webhook:infra-bound");
		const now = new Date().toISOString();
		insertRow(
			db,
			"webhooks",
			{
				id: randomUUID(),
				name: "infra-bound",
				secret: "shh",
				signature_format: "raw",
				description: null,
				task_id: boundTask,
				thread_id: randomUUID(),
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		// An ordinary event task with the same payload marker — should still cancel.
		const freeTask = insertEventTask(db, siteId, "event:user-scheduled");

		const result = await getExecute(createCancelTool(toolContext))({
			payload_match: "infra-bound",
		});

		expect(status(db, boundTask)).toBe("pending");
		expect(status(db, freeTask)).toBe("cancelled");
		expect(result).toContain("1");
	});
});
