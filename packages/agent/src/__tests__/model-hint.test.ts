import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import type { LLMBackend } from "@bound/llm";
import type { CommandContext } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { modelHint } from "../commands/model-hint";

// Mock LLM Backend
class MockBackend implements LLMBackend {
	name = "mock";

	async chat() {
		return (async function* () {
			yield { type: "text", text: "test" };
		})();
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
		};
	}
}

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-model-hint-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("model-hint command", () => {
	describe("AC2.3: Validate against cluster-wide pool", () => {
		it("accepts valid local model with modelRouter validation", async () => {
			// Create a task first
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, deleted, created_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["task-1", "test", "pending", "{}", 0, new Date().toISOString(), new Date().toISOString()],
			);

			// Create a modelRouter with a local backend
			const mockBackend = new MockBackend();
			const modelRouter = new ModelRouter(new Map([["claude-3", mockBackend]]), "claude-3");

			const eventBus = new TypedEventEmitter();
			const logger = {
				info: () => {},
				warn: () => {},
				error: () => {},
			};

			const ctx: CommandContext = {
				db,
				siteId: "local-site",
				eventBus,
				logger,
				taskId: "task-1",
				modelRouter,
			};

			const result = await modelHint.handler({ model: "claude-3" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Model hint set to: claude-3");

			// Verify the hint was stored
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get("task-1") as
				| { model_hint: string | null }
				| undefined;
			expect(task?.model_hint).toBe("claude-3");
		});

		it("rejects unknown model with validation error", async () => {
			// Create a task first
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, deleted, created_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["task-1", "test", "pending", "{}", 0, new Date().toISOString(), new Date().toISOString()],
			);

			// Create a modelRouter with a local backend
			const mockBackend = new MockBackend();
			const modelRouter = new ModelRouter(new Map([["claude-3", mockBackend]]), "claude-3");

			const eventBus = new TypedEventEmitter();
			const logger = {
				info: () => {},
				warn: () => {},
				error: () => {},
			};

			const ctx: CommandContext = {
				db,
				siteId: "local-site",
				eventBus,
				logger,
				taskId: "task-1",
				modelRouter,
			};

			const result = await modelHint.handler({ model: "unknown-model-xyz" }, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unknown-model-xyz");
			expect(result.stderr).toContain("Unknown model");

			// Verify the hint was NOT stored
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get("task-1") as
				| { model_hint: string | null }
				| undefined;
			expect(task?.model_hint).toBeNull();
		});

		it("accepts model from remote host", async () => {
			// Create a task first
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, deleted, created_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["task-1", "test", "pending", "{}", 0, new Date().toISOString(), new Date().toISOString()],
			);

			// Insert a remote host with a model
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["remote-1", "Remote Host", JSON.stringify(["gpt-4", "gpt-3.5"]), 0, now, now],
			);

			// Create a modelRouter with only a local backend
			const mockBackend = new MockBackend();
			const modelRouter = new ModelRouter(new Map([["claude-3", mockBackend]]), "claude-3");

			const eventBus = new TypedEventEmitter();
			const logger = {
				info: () => {},
				warn: () => {},
				error: () => {},
			};

			const ctx: CommandContext = {
				db,
				siteId: "local-site",
				eventBus,
				logger,
				taskId: "task-1",
				modelRouter,
			};

			// Try to set model that only exists on remote host
			const result = await modelHint.handler({ model: "gpt-4" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Model hint set to: gpt-4");

			// Verify the hint was stored
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get("task-1") as
				| { model_hint: string | null }
				| undefined;
			expect(task?.model_hint).toBe("gpt-4");
		});

		it("skips validation if modelRouter not available", async () => {
			// Create a task first
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, deleted, created_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["task-1", "test", "pending", "{}", 0, new Date().toISOString(), new Date().toISOString()],
			);

			const eventBus = new TypedEventEmitter();
			const logger = {
				info: () => {},
				warn: () => {},
				error: () => {},
			};

			const ctx: CommandContext = {
				db,
				siteId: "local-site",
				eventBus,
				logger,
				taskId: "task-1",
				// No modelRouter
			};

			// Without modelRouter, any model should be accepted
			const result = await modelHint.handler({ model: "unknown-model" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Model hint set to: unknown-model");

			// Verify the hint was stored
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get("task-1") as
				| { model_hint: string | null }
				| undefined;
			expect(task?.model_hint).toBe("unknown-model");
		});

		it("clears hint with reset", async () => {
			// Create a task with existing hint
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, model_hint, deleted, created_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["task-1", "test", "pending", "{}", "claude-3", 0, new Date().toISOString(), new Date().toISOString()],
			);

			const eventBus = new TypedEventEmitter();
			const logger = {
				info: () => {},
				warn: () => {},
				error: () => {},
			};

			const ctx: CommandContext = {
				db,
				siteId: "local-site",
				eventBus,
				logger,
				taskId: "task-1",
			};

			const result = await modelHint.handler({ reset: "true" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Model hint cleared");

			// Verify the hint was cleared
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get("task-1") as
				| { model_hint: string | null }
				| undefined;
			expect(task?.model_hint).toBeNull();
		});
	});
});
