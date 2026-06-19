import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createTaskTool } from "../task";

function getExecute(tool: ReturnType<typeof createTaskTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Task Tool", () => {
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

	describe("action=schedule", () => {
		it("should accept cron expression with comma and spaces preserving full string", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
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
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test cron task",
				cron: "0 * *",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/);
			expect(result).toMatch(/5 fields/i);
		});

		it("should return descriptive error when no trigger params provided", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test cron task",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/);
			expect(result).toMatch(/must specify/i);
		});

		it("should accept delay format and compute next_run_at", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
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
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
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
			const tool = createTaskTool(contextWithThreadId);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test task",
				cron: "0 * * * *",
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.origin_thread_id).toBe("test-thread-123");
		});

		it("should use explicit thread_id param when provided", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test task",
				cron: "0 * * * *",
				thread_id: "explicit-thread-456",
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.origin_thread_id).toBe("explicit-thread-456");
		});

		it("should accept optional payload parameter", async () => {
			const tool = createTaskTool(toolContext);
			const payloadJson = JSON.stringify({ key: "value" });
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test task",
				cron: "0 * * * *",
				payload: payloadJson,
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.payload).toBe(payloadJson);
		});

		it("should accept model_hint parameter", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test task",
				cron: "0 * * * *",
				model_hint: "opus",
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.model_hint).toBe("opus");
		});

		it("should set no_history flag when provided", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test task",
				cron: "0 * * * *",
				no_history: true,
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.no_history).toBe(1);
		});

		it("should accept alert_threshold parameter", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test task",
				cron: "0 * * * *",
				alert_threshold: 5,
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.alert_threshold).toBe(5);
		});

		it("should fold task_description into payload when payload is omitted (#64)", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Draft the RFC for state-aware backfill",
				delay: "5m",
			});

			expect(typeof result).toBe("string");
			expect(result).not.toMatch(/Error/);

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task).not.toBeNull();
			expect(task.payload).toBe("Draft the RFC for state-aware backfill");
		});

		it("should prefer an explicit payload over task_description (#64)", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "human-readable summary",
				payload: '{"instructions":"actual instructions"}',
				delay: "5m",
			});

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.payload).toBe('{"instructions":"actual instructions"}');
		});

		it("should fold task_description into payload when payload is an empty string (#64)", async () => {
			// Regression: models passing payload:"" (e.g. as a workaround for a
			// null-rejecting optional param) defeated the `??` fold, since "" is not
			// nullish. The task then woke with an empty payload and exited.
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Answer the passenger's bread question in full",
				payload: "",
				delay: "5m",
			});

			expect(result).not.toMatch(/Error/);
			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.payload).toBe("Answer the passenger's bread question in full");
		});

		it("should treat a whitespace-only payload as absent and store null when no task_description (#64)", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				payload: "   ",
				delay: "5m",
			});

			expect(result).not.toMatch(/Error/);
			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.payload).toBeNull();
		});

		it("should accept a sub-minute delay in seconds and compute next_run_at", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test seconds delay",
				delay: "5s",
			});

			expect(typeof result).toBe("string");
			expect(result).not.toMatch(/Error/);

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task).not.toBeNull();

			const triggerSpec = JSON.parse(task.trigger_spec);
			expect(triggerSpec.type).toBe("deferred");

			const nextRun = new Date(triggerSpec.at);
			const expectedTime = new Date(new Date().getTime() + 5 * 1000);
			const diff = Math.abs(nextRun.getTime() - expectedTime.getTime());
			expect(diff).toBeLessThan(2000); // within 2 seconds
		});

		it("should dispatch immediately when delay is 'now' (#181)", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test immediate dispatch",
				delay: "now",
			});

			expect(typeof result).toBe("string");
			expect(result).not.toMatch(/Error/);

			const taskId = result.trim();
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task).not.toBeNull();

			const triggerSpec = JSON.parse(task.trigger_spec);
			expect(triggerSpec.type).toBe("deferred");

			// next_run_at is at-or-before now, so the next scheduler poll picks it up.
			expect(task.next_run_at).not.toBeNull();
			const nextRun = new Date(task.next_run_at).getTime();
			expect(nextRun).toBeLessThanOrEqual(Date.now() + 1000);
			expect(nextRun).toBeGreaterThan(Date.now() - 5000);
		});

		it("should also accept '0' and 'immediate' as immediate dispatch (#181)", async () => {
			const tool = createTaskTool(toolContext);
			for (const delay of ["0", "immediate"]) {
				const result = await getExecute(tool)({
					action: "schedule",
					task_description: `Test immediate via ${delay}`,
					delay,
				});
				expect(result).not.toMatch(/Error/);
				const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.trim()) as any;
				expect(JSON.parse(task.trigger_spec).type).toBe("deferred");
				expect(new Date(task.next_run_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
			}
		});

		it("should list valid units when the delay format is unparseable", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Test bad delay",
				delay: "soon",
			});

			expect(result).toMatch(/Error/);
			expect(result).toMatch(/s, m, h, or d/);
		});
	});

	describe("action=update", () => {
		// Helper: schedule a task and return its id.
		async function scheduleTask(
			tool: ReturnType<typeof createTaskTool>,
			extra: Record<string, unknown> = {},
		): Promise<string> {
			const result = await getExecute(tool)({
				action: "schedule",
				task_description: "Seed task",
				cron: "0 * * * *",
				...extra,
			});
			expect(result).not.toMatch(/Error/);
			return result.trim();
		}

		it("should toggle no_history on an existing task (#100)", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool, { no_history: false });

			let task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.no_history).toBe(0);

			const result = await getExecute(tool)({
				action: "update",
				task_id: taskId,
				no_history: true,
			});
			expect(result).toMatch(/Updated task/);
			expect(result).toMatch(/no_history/);

			task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.no_history).toBe(1);
		});

		it("should re-enable history (no_history=false) on update", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool, { no_history: true });

			await getExecute(tool)({ action: "update", task_id: taskId, no_history: false });

			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.no_history).toBe(0);
		});

		it("should update model_hint and clear it with an empty string", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool, { model_hint: "opus" });

			await getExecute(tool)({ action: "update", task_id: taskId, model_hint: "haiku" });
			let task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.model_hint).toBe("haiku");

			await getExecute(tool)({ action: "update", task_id: taskId, model_hint: "" });
			task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.model_hint).toBeNull();
		});

		it("should update alert_threshold", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool);

			await getExecute(tool)({ action: "update", task_id: taskId, alert_threshold: 7 });
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.alert_threshold).toBe(7);
		});

		it("should reject alert_threshold <= 0", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool);

			const result = await getExecute(tool)({
				action: "update",
				task_id: taskId,
				alert_threshold: 0,
			});
			expect(result).toMatch(/Error/);
			expect(result).toMatch(/greater than 0/i);
		});

		it("should leave omitted fields unchanged", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool, { model_hint: "opus", alert_threshold: 4 });

			await getExecute(tool)({ action: "update", task_id: taskId, no_history: true });

			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.no_history).toBe(1);
			expect(task.model_hint).toBe("opus"); // untouched
			expect(task.alert_threshold).toBe(4); // untouched
		});

		it("should error when task_id is missing", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({ action: "update", no_history: true });
			expect(result).toMatch(/Error/);
			expect(result).toMatch(/task_id/);
		});

		it("should error when the task does not exist", async () => {
			const tool = createTaskTool(toolContext);
			const result = await getExecute(tool)({
				action: "update",
				task_id: "nonexistent-id",
				no_history: true,
			});
			expect(result).toMatch(/Error/);
			expect(result).toMatch(/not found/i);
		});

		it("should error when no mutable fields are provided", async () => {
			const tool = createTaskTool(toolContext);
			const taskId = await scheduleTask(tool);

			const result = await getExecute(tool)({ action: "update", task_id: taskId });
			expect(result).toMatch(/Error/);
			expect(result).toMatch(/at least one/i);
		});

		it("should refuse a task modifying itself (ctx.taskId === task_id)", async () => {
			// A task's own agent loop must not be able to rewrite its own config.
			// This closes the class of incident where a webhook/event task cleared
			// its own model_hint mid-run (silently upgrading cost). See
			// bound_issue:task-self-clears-own-model_hint-via-task-update-20260601.
			const taskId = await scheduleTask(createTaskTool(toolContext), { model_hint: "opus" });

			// Build a context whose running task IS the task being updated.
			const selfContext: ToolContext = { ...toolContext, taskId };
			const selfTool = createTaskTool(selfContext);

			const result = await getExecute(selfTool)({
				action: "update",
				task_id: taskId,
				model_hint: "",
			});

			expect(result).toMatch(/Error/);
			expect(result).toMatch(/itself|own/i);

			// The hint must be untouched.
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
			expect(task.model_hint).toBe("opus");
		});

		it("should still allow updating a different task when running inside a task loop", async () => {
			const runningTaskId = await scheduleTask(createTaskTool(toolContext));
			const otherTaskId = await scheduleTask(createTaskTool(toolContext), { model_hint: "opus" });

			const selfContext: ToolContext = { ...toolContext, taskId: runningTaskId };
			const selfTool = createTaskTool(selfContext);

			const result = await getExecute(selfTool)({
				action: "update",
				task_id: otherTaskId,
				model_hint: "haiku",
			});

			expect(result).toMatch(/Updated task/);
			const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(otherTaskId) as any;
			expect(task.model_hint).toBe("haiku");
		});
	});

	it("tool should have valid RegisteredTool shape", () => {
		const tool = createTaskTool(toolContext);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition).toBeDefined();
		expect(tool.toolDefinition.function.name).toBe("task");
		expect(tool.toolDefinition.function.description).toBeDefined();
		expect(tool.toolDefinition.function.parameters).toBeDefined();
		expect(tool.execute).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("tool definition should have required parameters", () => {
		const tool = createTaskTool(toolContext);
		const params = tool.toolDefinition.function.parameters as any;
		expect(params.required).toContain("action");
		expect(params.properties.action).toBeDefined();
		expect(params.properties.task_description).toBeDefined();
		expect(params.properties.cron).toBeDefined();
		expect(params.properties.delay).toBeDefined();
		expect(params.properties.on_event).toBeDefined();
		expect(params.properties.task_id).toBeDefined();
	});
});
