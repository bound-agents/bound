import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { randomUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createCancelTool } from "../cancel";

function getExecute(tool: ReturnType<typeof createCancelTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Cancel Tool", () => {
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

	it("should cancel a task by task_id", async () => {
		const taskId = randomUUID();
		const now = new Date().toISOString();

		// Create a pending task
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "deferred",
				status: "pending",
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
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const tool = createCancelTool(toolContext);
		const result = await getExecute(tool)({
			task_id: taskId,
		});

		// Result should contain "cancelled" or the task ID
		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		// Verify task status changed to cancelled
		const updatedTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		};
		expect(updatedTask).not.toBeNull();
		expect(updatedTask.status).toBe("cancelled");
	});

	it("should cancel multiple tasks matching payload_match", async () => {
		const now = new Date().toISOString();
		const payload1 = JSON.stringify({ action: "cleanup", target: "old_files" });
		const payload2 = JSON.stringify({ action: "cleanup", target: "temp_cache" });
		const payload3 = JSON.stringify({ action: "backup", target: "database" });

		// Create three tasks
		const taskId1 = randomUUID();
		const taskId2 = randomUUID();
		const taskId3 = randomUUID();

		for (const [taskId, payload] of [
			[taskId1, payload1],
			[taskId2, payload2],
			[taskId3, payload3],
		]) {
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "deferred",
					status: "pending",
					trigger_spec: JSON.stringify({ type: "deferred", at: now }),
					payload,
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
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}

		const tool = createCancelTool(toolContext);
		const result = await getExecute(tool)({
			payload_match: "cleanup",
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);
		expect(result).toMatch(/2/); // should say 2 tasks cancelled

		// Verify the cleanup tasks are cancelled
		const cancelledCleanupTasks = db
			.prepare("SELECT COUNT(*) as count FROM tasks WHERE payload LIKE ? AND status = 'cancelled'")
			.get("%cleanup%") as { count: number };
		expect(cancelledCleanupTasks.count).toBe(2);

		// Verify the backup task is NOT cancelled
		const backupTask = db
			.prepare("SELECT status FROM tasks WHERE id = ? AND deleted = 0")
			.get(taskId3) as { status: string };
		expect(backupTask.status).toBe("pending");
	});

	it("should return error when task_id not found", async () => {
		const tool = createCancelTool(toolContext);
		const result = await getExecute(tool)({
			task_id: "nonexistent-task-id",
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
		expect(result).toMatch(/not found/i);
	});

	it("should return error when neither task_id nor payload_match provided", async () => {
		const tool = createCancelTool(toolContext);
		const result = await getExecute(tool)({});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
		expect(result).toMatch(/specify/i);
	});

	it("should return message when no tasks match payload_match", async () => {
		const tool = createCancelTool(toolContext);
		const result = await getExecute(tool)({
			payload_match: "nonexistent",
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);
		expect(result).toMatch(/not found|0|no tasks/i);
	});

	it("tool should have valid RegisteredTool shape", () => {
		const tool = createCancelTool(toolContext);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition).toBeDefined();
		expect(tool.toolDefinition.function.name).toBe("cancel");
		expect(tool.toolDefinition.function.description).toBeDefined();
		expect(tool.toolDefinition.function.parameters).toBeDefined();
		expect(tool.execute).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("tool definition should have task_id and payload_match in properties", () => {
		const tool = createCancelTool(toolContext);
		const params = tool.toolDefinition.function.parameters as any;
		expect(params.properties.task_id).toBeDefined();
		expect(params.properties.payload_match).toBeDefined();
	});
});
