import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createScheduleTool } from "../schedule";

function getExecute(tool: ReturnType<typeof createScheduleTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Schedule Tool", () => {
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

	it("should accept cron expression with comma and spaces preserving full string", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test cron task",
			cron: "0,30 * * * *",
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/Error/);

		// Verify task was created with correct cron expression
		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task).not.toBeNull();
		expect(task.id).toBe(taskId);

		const triggerSpec = JSON.parse(task.trigger_spec);
		expect(triggerSpec.type).toBe("cron");
		expect(triggerSpec.expression).toBe("0,30 * * * *");
	});

	it("should reject cron expression with only 3 fields", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test cron task",
			cron: "0 * *",
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/Error/);
		expect(result).toMatch(/5 fields/i);
	});

	it("should return descriptive error when no trigger params provided", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test cron task",
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/Error/);
		expect(result).toMatch(/must specify/i);
	});

	it("should accept delay format and compute next_run_at", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test delay task",
			delay: "5m",
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/Error/);

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task).not.toBeNull();

		const triggerSpec = JSON.parse(task.trigger_spec);
		expect(triggerSpec.type).toBe("deferred");
		expect(triggerSpec.at).toBeDefined();

		// Verify next_run_at is about 5 minutes from now
		const nextRun = new Date(triggerSpec.at);
		const expectedTime = new Date(new Date().getTime() + 5 * 60 * 1000);
		const diff = Math.abs(nextRun.getTime() - expectedTime.getTime());
		expect(diff).toBeLessThan(2000); // within 2 seconds
	});

	it("should accept on_event trigger", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test event task",
			on_event: "file:changed",
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/Error/);

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task).not.toBeNull();

		const triggerSpec = JSON.parse(task.trigger_spec);
		expect(triggerSpec.type).toBe("event");
		expect(triggerSpec.event).toBe("file:changed");
	});

	it("should use threadId from context when thread_id param not provided", async () => {
		const contextWithThreadId = {
			...toolContext,
			threadId: "test-thread-123",
		};
		const tool = createScheduleTool(contextWithThreadId);
		const result = await getExecute(tool)({
			task_description: "Test task",
			cron: "0 * * * *",
		});

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.origin_thread_id).toBe("test-thread-123");
	});

	it("should use explicit thread_id param when provided", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test task",
			cron: "0 * * * *",
			thread_id: "explicit-thread-456",
		});

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.origin_thread_id).toBe("explicit-thread-456");
	});

	it("should accept optional payload parameter", async () => {
		const tool = createScheduleTool(toolContext);
		const payloadJson = JSON.stringify({ key: "value" });
		const result = await getExecute(tool)({
			task_description: "Test task",
			cron: "0 * * * *",
			payload: payloadJson,
		});

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.payload).toBe(payloadJson);
	});

	it("should accept model_hint parameter", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test task",
			cron: "0 * * * *",
			model_hint: "opus",
		});

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.model_hint).toBe("opus");
	});

	it("should set no_history flag when provided", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test task",
			cron: "0 * * * *",
			no_history: true,
		});

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.no_history).toBe(1);
	});

	it("should accept alert_threshold parameter", async () => {
		const tool = createScheduleTool(toolContext);
		const result = await getExecute(tool)({
			task_description: "Test task",
			cron: "0 * * * *",
			alert_threshold: 5,
		});

		const taskId = result.trim();
		const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.alert_threshold).toBe(5);
	});

	it("tool should have valid RegisteredTool shape", () => {
		const tool = createScheduleTool(toolContext);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition).toBeDefined();
		expect(tool.toolDefinition.function.name).toBe("schedule");
		expect(tool.toolDefinition.function.description).toBeDefined();
		expect(tool.toolDefinition.function.parameters).toBeDefined();
		expect(tool.execute).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("tool definition should have required parameters", () => {
		const tool = createScheduleTool(toolContext);
		const params = tool.toolDefinition.function.parameters as any;
		expect(params.required).toContain("task_description");
		expect(params.properties.task_description).toBeDefined();
		expect(params.properties.cron).toBeDefined();
		expect(params.properties.delay).toBeDefined();
		expect(params.properties.on_event).toBeDefined();
	});
});
