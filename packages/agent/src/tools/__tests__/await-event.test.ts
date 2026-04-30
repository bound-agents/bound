import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { randomUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createAwaitEventTool } from "../await-event";

function getExecute(tool: ReturnType<typeof createAwaitEventTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

function createTask(
	db: Database.Database,
	siteId: string,
	status: string,
	result?: string,
	error?: string,
) {
	const taskId = randomUUID();
	const now = new Date().toISOString();

	insertRow(
		db,
		"tasks",
		{
			id: taskId,
			type: "deferred",
			status,
			trigger_spec: JSON.stringify({ type: "deferred", at: now }),
			payload: null,
			created_at: now,
			created_by: siteId,
			thread_id: null,
			origin_thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: now,
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
			heartbeat_at: null,
			result: result ?? null,
			error: error ?? null,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);

	return taskId;
}

describe("Native Await Event Tool", () => {
	let db: Database.Database;
	const siteId = "test-site";
	let toolContext: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);

		toolContext = {
			db,
			siteId,
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		};
	});

	afterEach(() => {
		db.close();
	});

	it("should return immediately for completed task", async () => {
		const taskId = createTask(db, siteId, "completed", "success result");

		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({
			task_ids: taskId,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		const parsed = JSON.parse(result);
		expect(parsed[taskId]).toBeDefined();
		expect(parsed[taskId].status).toBe("completed");
		expect(parsed[taskId].result).toBe("success result");
	});

	it("should return multiple task statuses", async () => {
		const taskId1 = createTask(db, siteId, "completed", "result1");
		const taskId2 = createTask(db, siteId, "failed", null, "error2");

		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({
			task_ids: `${taskId1}, ${taskId2}`,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		const parsed = JSON.parse(result);
		expect(parsed[taskId1]).toBeDefined();
		expect(parsed[taskId1].status).toBe("completed");
		expect(parsed[taskId2]).toBeDefined();
		expect(parsed[taskId2].status).toBe("failed");
		expect(parsed[taskId2].error).toBe("error2");
	});

	it("should return not_found for non-existent task", async () => {
		const fakeTa = "nonexistent-task-id";

		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({
			task_ids: fakeTa,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		const parsed = JSON.parse(result);
		expect(parsed[fakeTa]).toBeDefined();
		expect(parsed[fakeTa].status).toBe("not_found");
	});

	it("should return error when task_ids is empty", async () => {
		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({
			task_ids: "",
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
	});

	it("should return error when task_ids is missing", async () => {
		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
	});

	it("should handle cancelled task status", async () => {
		const taskId = createTask(db, siteId, "cancelled");

		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({
			task_ids: taskId,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		const parsed = JSON.parse(result);
		expect(parsed[taskId].status).toBe("cancelled");
	});

	it("should recognize terminal states", async () => {
		const completedId = createTask(db, siteId, "completed");
		const failedId = createTask(db, siteId, "failed");
		const cancelledId = createTask(db, siteId, "cancelled");

		const tool = createAwaitEventTool(toolContext);
		const result = await getExecute(tool)({
			task_ids: `${completedId}, ${failedId}, ${cancelledId}`,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		const parsed = JSON.parse(result);
		expect(parsed[completedId].status).toBe("completed");
		expect(parsed[failedId].status).toBe("failed");
		expect(parsed[cancelledId].status).toBe("cancelled");
	});

	it("should truncate output at 50KB", async () => {
		const tool = createAwaitEventTool(toolContext);

		// Create task with very large result
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const largeResult = "x".repeat(100000); // 100KB result

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "deferred",
				status: "completed",
				trigger_spec: JSON.stringify({ type: "deferred", at: now }),
				payload: null,
				created_at: now,
				created_by: siteId,
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
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
				heartbeat_at: null,
				result: largeResult,
				error: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const result = await getExecute(tool)({
			task_ids: taskId,
		});

		expect(typeof result).toBe("string");
		// Should contain truncation notice
		expect(result).toMatch(/truncated|output truncated/);
	});

	it("tool should have valid RegisteredTool shape", () => {
		const tool = createAwaitEventTool(toolContext);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition).toBeDefined();
		expect(tool.toolDefinition.function.name).toBe("await_event");
		expect(tool.toolDefinition.function.description).toBeDefined();
		expect(tool.toolDefinition.function.parameters).toBeDefined();
		expect(tool.execute).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("tool definition should require task_ids parameter", () => {
		const tool = createAwaitEventTool(toolContext);
		const params = tool.toolDefinition.function.parameters as any;
		expect(params.properties.task_ids).toBeDefined();
		expect(params.properties.timeout).toBeDefined();
		expect(params.required).toContain("task_ids");
	});
});
