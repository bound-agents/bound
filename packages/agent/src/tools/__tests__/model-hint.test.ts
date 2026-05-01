import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types.js";
import { createModelHintTool } from "../model-hint.js";

describe("model_hint tool", () => {
	let db: Database;
	let testRunId: string;
	let siteId: string;

	beforeEach(() => {
		testRunId = randomBytes(4).toString("hex");
		siteId = `test-site-${testRunId}`;
		db = new Database(":memory:");
		applySchema(db);

		// Insert minimal host_meta
		db.exec(`INSERT INTO host_meta (key, value) VALUES ('site_id', '${siteId}')`);
	});

	it("sets model hint on a task when model parameter provided", async () => {
		// Create a task
		const taskId = `task-${testRunId}`;
		db.prepare(
			`INSERT INTO tasks (id, type, thread_id, payload, status, trigger_spec, created_at, modified_at, deleted)
			 VALUES (?, 'cron', ?, '{}', 'pending', '{}', datetime('now'), datetime('now'), 0)`,
		).run(taskId, `thread-${testRunId}`);

		// Create the tool
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			taskId,
		};

		const tool = createModelHintTool(toolCtx);

		// Execute with model parameter
		const result = await tool.execute({ model: "opus" });

		// Should succeed
		expect(typeof result).toBe("string");
		expect(result).not.toContain("Error");

		// Verify task was updated
		const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.model_hint).toBe("opus");
	});

	it("clears model hint when reset parameter is true", async () => {
		// Create a task with model_hint set
		const taskId = `task-${testRunId}`;
		db.prepare(
			`INSERT INTO tasks (id, type, thread_id, payload, status, trigger_spec, created_at, modified_at, deleted, model_hint)
			 VALUES (?, 'cron', ?, '{}', 'pending', '{}', datetime('now'), datetime('now'), 0, 'opus')`,
		).run(taskId, `thread-${testRunId}`);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			taskId,
		};

		const tool = createModelHintTool(toolCtx);

		// Execute with reset
		const result = await tool.execute({ reset: true });

		expect(typeof result).toBe("string");
		expect(result).not.toContain("Error");

		// Verify model_hint was cleared
		const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get(taskId) as any;
		expect(task.model_hint).toBeNull();
	});

	it("returns error when taskId is not available", async () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			// No taskId provided
		};

		const tool = createModelHintTool(toolCtx);
		const result = await tool.execute({ model: "opus" });

		expect(typeof result).toBe("string");
		expect(result).toContain("Error");
		expect(result).toContain("taskId");
	});

	it("returns error when neither model nor reset provided", async () => {
		const taskId = `task-${testRunId}`;
		db.prepare(
			`INSERT INTO tasks (id, type, thread_id, payload, status, trigger_spec, created_at, modified_at, deleted)
			 VALUES (?, 'cron', ?, '{}', 'pending', '{}', datetime('now'), datetime('now'), 0)`,
		).run(taskId, `thread-${testRunId}`);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			taskId,
		};

		const tool = createModelHintTool(toolCtx);
		const result = await tool.execute({});

		expect(typeof result).toBe("string");
		expect(result).toContain("Error");
		expect(result).toContain("model");
	});

	it("tool definition has correct shape", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createModelHintTool(toolCtx);

		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition.function.name).toBe("model_hint");
		expect(tool.toolDefinition.function.description).toContain("model hint");
		expect(typeof tool.execute).toBe("function");
	});
});
