import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { awaitCmd } from "../commands/await-cmd";
import { cancel } from "../commands/cancel";
import { emit } from "../commands/emit";
import { forget } from "../commands/forget";
import { help, setCommandRegistry } from "../commands/help";
import { memorize } from "../commands/memorize";
import { purge } from "../commands/purge";
import { query } from "../commands/query";
import { schedule } from "../commands/schedule";

describe("defineCommand implementations", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "commands-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		const siteId = randomUUID();
		eventBus = new TypedEventEmitter();

		ctx = {
			db,
			siteId,
			eventBus,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: randomUUID(),
			taskId: randomUUID(),
		};
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	describe("query command", () => {
		it("should execute a SELECT query and return results", async () => {
			const userId = randomUUID();
			db.run(
				`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
			);

			const result = await query.handler(
				{ query: "SELECT id, display_name FROM users WHERE deleted = 0" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Test User");
		});

		it("should reject non-SELECT queries", async () => {
			const result = await query.handler({ query: "INSERT INTO users (id) VALUES ('test')" }, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("SELECT-only");
		});
	});

	describe("memorize command", () => {
		it("should create a semantic_memory entry", async () => {
			const result = await memorize.handler({ key: "test_key", value: "test_value" }, ctx);

			expect(result.exitCode).toBe(0);

			const memoryId = deterministicUUID(BOUND_NAMESPACE, "test_key");
			const row = db.query("SELECT * FROM semantic_memory WHERE id = ?").get(memoryId) as Record<
				string,
				unknown
			>;

			expect(row).toBeDefined();
			expect(row.key).toBe("test_key");
			expect(row.value).toBe("test_value");
		});

		it("should update an existing memory entry", async () => {
			await memorize.handler({ key: "existing_key", value: "value1" }, ctx);

			await memorize.handler({ key: "existing_key", value: "value2" }, ctx);

			const memoryId = deterministicUUID(BOUND_NAMESPACE, "existing_key");
			const row = db
				.query("SELECT value FROM semantic_memory WHERE id = ?")
				.get(memoryId) as Record<string, unknown>;

			expect(row.value).toBe("value2");
		});
	});

	describe("forget command", () => {
		it("should soft-delete a semantic_memory entry", async () => {
			await memorize.handler({ key: "delete_me", value: "content" }, ctx);

			const result = await forget.handler({ key: "delete_me" }, ctx);

			expect(result.exitCode).toBe(0);

			const memoryId = deterministicUUID(BOUND_NAMESPACE, "delete_me");
			const row = db
				.query("SELECT deleted FROM semantic_memory WHERE id = ?")
				.get(memoryId) as Record<string, unknown>;

			expect(row.deleted).toBe(1);
		});
	});

	describe("schedule command", () => {
		it("should create a deferred task", async () => {
			const result = await schedule.handler(
				{
					in: "5m",
					payload: JSON.stringify({ test: "data" }),
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			const taskId = result.stdout.trim();
			expect(taskId.length).toBeGreaterThan(0);

			const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			expect(row.type).toBe("deferred");
		});

		it("should create a cron task", async () => {
			const result = await schedule.handler(
				{
					every: "0 9 * * *",
					payload: JSON.stringify({ test: "data" }),
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			const taskId = result.stdout.trim();

			const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			expect(row.type).toBe("cron");
		});

		it("should create an event-driven task", async () => {
			const result = await schedule.handler(
				{
					on: "message:created",
					payload: JSON.stringify({ test: "data" }),
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			const taskId = result.stdout.trim();

			const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			expect(row.type).toBe("event");
		});
	});

	describe("cancel command", () => {
		it("should cancel a task", async () => {
			const scheduleResult = await schedule.handler(
				{
					in: "5m",
					payload: JSON.stringify({ test: "data" }),
				},
				ctx,
			);

			const taskId = scheduleResult.stdout.trim();

			const result = await cancel.handler({ "task-id": taskId }, ctx);

			expect(result.exitCode).toBe(0);

			const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			expect(row.status).toBe("cancelled");
		});
	});

	describe("emit command", () => {
		it("should emit a custom event via the EventBus", async () => {
			let eventFired = false;
			const listener = () => {
				eventFired = true;
			};

			eventBus.on("test.custom.event", listener);

			const result = await emit.handler(
				{
					event: "test.custom.event",
					payload: JSON.stringify({ data: "test" }),
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(eventFired).toBe(true);

			eventBus.off("test.custom.event", listener);
		});
	});

	describe("purge command", () => {
		it("should create a purge message targeting specific IDs", async () => {
			const userId = randomUUID();
			const threadId = randomUUID();
			const msgId1 = randomUUID();
			const msgId2 = randomUUID();

			db.run(
				`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[userId, "Test", null, new Date().toISOString(), new Date().toISOString(), 0],
			);

			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through,
					summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					threadId,
					userId,
					"web",
					"http://localhost",
					0,
					null,
					null,
					null,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			db.run(
				`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					msgId1,
					threadId,
					"user",
					"Message 1",
					null,
					null,
					new Date().toISOString(),
					null,
					"http://localhost",
				],
			);

			db.run(
				`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					msgId2,
					threadId,
					"assistant",
					"Response",
					null,
					null,
					new Date().toISOString(),
					null,
					"http://localhost",
				],
			);

			const result = await purge.handler(
				{
					ids: `${msgId1},${msgId2}`,
					summary: "true",
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
		});

		it("should create a purge message targeting last N messages", async () => {
			const userId = randomUUID();
			const threadId = randomUUID();

			db.run(
				`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[userId, "Test", null, new Date().toISOString(), new Date().toISOString(), 0],
			);

			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through,
					summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					threadId,
					userId,
					"web",
					"http://localhost",
					0,
					null,
					null,
					null,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			for (let i = 0; i < 5; i++) {
				db.run(
					`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						randomUUID(),
						threadId,
						"user",
						`Message ${i}`,
						null,
						null,
						new Date(Date.now() + i * 1000).toISOString(),
						null,
						"http://localhost",
					],
				);
			}

			const result = await purge.handler(
				{
					last: "3",
					"thread-id": threadId,
				},
				ctx,
			);

			if (result.exitCode !== 0) {
				console.log("Purge error:", result.stderr);
			}
			expect(result.exitCode).toBe(0);
		});
	});

	describe("await command", () => {
		it("should poll until tasks reach terminal state", async () => {
			const scheduleResult = await schedule.handler(
				{
					in: "5m",
					payload: JSON.stringify({ test: "data" }),
				},
				ctx,
			);

			const taskId = scheduleResult.stdout.trim();

			// Manually set task to completed
			db.run("UPDATE tasks SET status = ? WHERE id = ?", ["completed", taskId]);

			const result = await awaitCmd.handler({ "task-ids": taskId }, ctx);

			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			expect(output).toHaveProperty(taskId);
			expect(output[taskId].status).toBe("completed");
		});
	});

	describe("commands command", () => {
		it("should show LOCAL and REMOTE tiers with LOCAL MCP tools (mcp-relay.AC8.5)", async () => {
			// Set up command registry with a builtin and an MCP tool
			setCommandRegistry([
				help,
				{ name: "query", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
				{ name: "test-server-tool1", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
				{ name: "remote-server-tool2", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			]);

			// Mock MCPClient with listTools method
			const mockMcpClient = {
				listTools: async () => [{ name: "tool1" }],
			};

			// Set up context with MCPClients map
			const ctxWithMcp = {
				...ctx,
				mcpClients: new Map([["test-server", mockMcpClient]]),
			};

			// Insert a remote host with MCP tools
			db.run(
				`INSERT INTO hosts (site_id, host_name, mcp_tools, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					"remote-site-id",
					"remote-host",
					JSON.stringify([{ server: "remote-server", name: "tool2" }]),
					new Date().toISOString(),
					0,
				],
			);

			const result = await help.handler({}, ctxWithMcp);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("query");
			expect(result.stdout).toContain("LOCAL (MCP):");
			expect(result.stdout).toContain("test-server-tool1");
			expect(result.stdout).toContain("REMOTE (via relay):");
			expect(result.stdout).toContain("remote-server-tool2");
			expect(result.stdout).toContain("[host: remote-host]");
		});

		it("should only show LOCAL (MCP) when no remote tools (mcp-relay.AC8.5)", async () => {
			// Set up command registry
			setCommandRegistry([
				help,
				{ name: "query", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
				{ name: "local-server-tool", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			]);

			// Mock MCPClient
			const mockMcpClient = {
				listTools: async () => [{ name: "tool" }],
			};

			const ctxWithMcp = {
				...ctx,
				mcpClients: new Map([["local-server", mockMcpClient]]),
			};

			const result = await help.handler({}, ctxWithMcp);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("LOCAL (MCP):");
			expect(result.stdout).toContain("local-server-tool");
			expect(result.stdout).not.toContain("REMOTE (via relay):");
		});

		it("should work without mcpClients map (backwards compatibility)", async () => {
			// Set up command registry
			setCommandRegistry([
				help,
				{ name: "query", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			]);

			const result = await help.handler({}, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("query");
		});
	});
});
