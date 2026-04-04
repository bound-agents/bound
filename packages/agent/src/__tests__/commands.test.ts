import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { advisory } from "../commands/advisory";
import { awaitCmd } from "../commands/await-cmd";
import { cancel } from "../commands/cancel";
import { emit } from "../commands/emit";
import { help, setCommandRegistry } from "../commands/help";
import { memory } from "../commands/memory";
import { purge } from "../commands/purge";
import { query } from "../commands/query";
import { schedule } from "../commands/schedule";

class MinimalMockBackend implements LLMBackend {
	async *chat(): AsyncIterable<StreamChunk> {
		yield { type: "done", usage: { input_tokens: 0, output_tokens: 0 } };
	}
	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

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
				`INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
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

		it("should return error when query is undefined", async () => {
			const result = await query.handler({}, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("no SQL query provided");
		});

		it("should return error when query is empty string", async () => {
			const result = await query.handler({ query: "" }, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("no SQL query provided");
		});
	});

	describe("memory command", () => {
		function getMemorySource(key: string): string | null {
			const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
			const row = db.prepare("SELECT source FROM semantic_memory WHERE id = ?").get(memoryId) as {
				source: string | null;
			} | null;
			return row?.source ?? null;
		}

		describe("store subcommand", () => {
			it("should create a semantic_memory entry", async () => {
				const result = await memory.handler(
					{ subcommand: "store", source: "test_key", target: "test_value" },
					ctx,
				);

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
				await memory.handler(
					{ subcommand: "store", source: "existing_key", target: "value1" },
					ctx,
				);

				await memory.handler(
					{ subcommand: "store", source: "existing_key", target: "value2" },
					ctx,
				);

				const memoryId = deterministicUUID(BOUND_NAMESPACE, "existing_key");
				const row = db
					.query("SELECT value FROM semantic_memory WHERE id = ?")
					.get(memoryId) as Record<string, unknown>;

				expect(row.value).toBe("value2");
			});

			it("stores source as taskId when ctx.taskId is set", async () => {
				await memory.handler(
					{ subcommand: "store", source: "source_task_key", target: "v" },
					ctx,
				);
				const source = getMemorySource("source_task_key");
				expect(source).toBe(ctx.taskId);
			});

			it("stores source as threadId when only ctx.threadId is set", async () => {
				const threadOnlyCtx: CommandContext = { ...ctx, taskId: undefined };
				await memory.handler(
					{ subcommand: "store", source: "source_thread_key", target: "v" },
					threadOnlyCtx,
				);
				const source = getMemorySource("source_thread_key");
				expect(source).toBe(ctx.threadId);
			});

			it("stores source as 'agent' when neither taskId nor threadId is set", async () => {
				const noCtx: CommandContext = { ...ctx, taskId: undefined, threadId: undefined };
				await memory.handler(
					{ subcommand: "store", source: "source_agent_key", target: "v" },
					noCtx,
				);
				const source = getMemorySource("source_agent_key");
				expect(source).toBe("agent");
			});

			it("stores explicit source_tag argument over ctx values", async () => {
				await memory.handler(
					{
						subcommand: "store",
						source: "source_explicit_key",
						target: "v",
						source_tag: "custom-source-id",
					},
					ctx,
				);
				const source = getMemorySource("source_explicit_key");
				expect(source).toBe("custom-source-id");
			});

			it("restores a previously soft-deleted key without UNIQUE constraint error", async () => {
				const key = "forget_then_store_key";
				const memoryId = deterministicUUID(BOUND_NAMESPACE, key);

				// Step 1: Create the memory
				await memory.handler({ subcommand: "store", source: key, target: "original_value" }, ctx);
				const row1 = db
					.query("SELECT deleted, value FROM semantic_memory WHERE id = ?")
					.get(memoryId) as {
					deleted: number;
					value: string;
				};
				expect(row1.deleted).toBe(0);
				expect(row1.value).toBe("original_value");

				// Step 2: Soft-delete it via forget
				await memory.handler({ subcommand: "forget", source: key }, ctx);
				const row2 = db
					.query("SELECT deleted FROM semantic_memory WHERE id = ?")
					.get(memoryId) as {
					deleted: number;
				};
				expect(row2.deleted).toBe(1);

				// Step 3: Re-store the same key — this must succeed, not throw UNIQUE constraint
				const result = await memory.handler(
					{ subcommand: "store", source: key, target: "restored_value" },
					ctx,
				);
				expect(result.exitCode).toBe(0);

				// The memory should be restored with the new value and deleted=0
				const row3 = db
					.query("SELECT deleted, value FROM semantic_memory WHERE id = ?")
					.get(memoryId) as {
					deleted: number;
					value: string;
				};
				expect(row3.deleted).toBe(0);
				expect(row3.value).toBe("restored_value");
			});
		});

		describe("forget subcommand", () => {
			it("should soft-delete a semantic_memory entry", async () => {
				await memory.handler(
					{ subcommand: "store", source: "delete_me", target: "content" },
					ctx,
				);

				const result = await memory.handler({ subcommand: "forget", source: "delete_me" }, ctx);

				expect(result.exitCode).toBe(0);

				const memoryId = deterministicUUID(BOUND_NAMESPACE, "delete_me");
				const row = db
					.query("SELECT deleted FROM semantic_memory WHERE id = ?")
					.get(memoryId) as Record<string, unknown>;

				expect(row.deleted).toBe(1);
			});
		});

		describe("search subcommand", () => {
			it("should return entries matching keywords in key", async () => {
				await memory.handler(
					{ subcommand: "store", source: "scheduler_v3", target: "task runner" },
					ctx,
				);

				const result = await memory.handler(
					{ subcommand: "search", source: "scheduler" },
					ctx,
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("scheduler_v3");
				expect(result.stdout).toContain("Found 1 memories");
			});

			it("should return entries matching keywords in value", async () => {
				await memory.handler(
					{ subcommand: "store", source: "timing_config", target: "interval math" },
					ctx,
				);

				const result = await memory.handler(
					{ subcommand: "search", source: "interval" },
					ctx,
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("timing_config");
				expect(result.stdout).toContain("Found 1 memories");
			});

			it("should return union of matches with multiple keywords", async () => {
				await memory.handler(
					{ subcommand: "store", source: "key_one", target: "apple fruit" },
					ctx,
				);
				await memory.handler(
					{ subcommand: "store", source: "key_two", target: "banana fruit" },
					ctx,
				);

				const result = await memory.handler(
					{ subcommand: "search", source: "apple banana" },
					ctx,
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Found 2 memories");
			});

			it("should return message when query has only stop words", async () => {
				const result = await memory.handler(
					{ subcommand: "search", source: "the a an" },
					ctx,
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("No searchable keywords found");
			});

			it("should return message when no memories matched", async () => {
				const result = await memory.handler(
					{ subcommand: "search", source: "nonexistent_keyword_xyz" },
					ctx,
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("No memories matched");
			});

			it("should return message when less than 3 char keyword is filtered", async () => {
				const result = await memory.handler(
					{ subcommand: "search", source: "ab" },
					ctx,
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("No searchable keywords found");
			});
		});

		it("should return error for unknown subcommand", async () => {
			const result = await memory.handler(
				{ subcommand: "nonexistent" },
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unknown subcommand");
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

		it("rejects unknown model-hint when modelRouter is available", async () => {
			const modelRouter = new ModelRouter(
				new Map([["claude-3", new MinimalMockBackend()]]),
				"claude-3",
			);
			const ctxWithRouter: CommandContext = { ...ctx, modelRouter };

			const result = await schedule.handler(
				{ in: "5m", payload: "test", "model-hint": "unknown-model-xyz" },
				ctxWithRouter,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unknown-model-xyz");
		});

		it("accepts known model-hint when modelRouter is available", async () => {
			const modelRouter = new ModelRouter(
				new Map([["claude-3", new MinimalMockBackend()]]),
				"claude-3",
			);
			const ctxWithRouter: CommandContext = { ...ctx, modelRouter };

			const result = await schedule.handler(
				{ in: "5m", payload: "test", "model-hint": "claude-3" },
				ctxWithRouter,
			);

			expect(result.exitCode).toBe(0);
			const taskId = result.stdout.trim();
			const row = db.query("SELECT model_hint FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			expect(row.model_hint).toBe("claude-3");
		});

		it("allows any model-hint when no modelRouter is available (backward compat)", async () => {
			// ctx has no modelRouter — validation is skipped
			const result = await schedule.handler(
				{ in: "5m", payload: "test", "model-hint": "some-future-model" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
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
				`INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
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
				`INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
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

		// Bug: purge --last N requires explicit --thread-id even though ctx.threadId
		// is always set when the agent is running in a thread. The condition on line 23
		// of purge.ts required BOTH args.last AND args["thread-id"], but ctx.threadId
		// was only used further down (line 77) after the guard had already rejected.
		it("should create a purge message with --last when ctx.threadId is used (no explicit --thread-id)", async () => {
			const userId = randomUUID();
			const threadId = randomUUID();

			db.run(
				`INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[userId, "Purge Ctx User", null, new Date().toISOString(), new Date().toISOString(), 0],
			);
			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through,
					summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					threadId,
					userId,
					"web",
					"local",
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
			for (let i = 0; i < 3; i++) {
				db.run(
					`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						randomUUID(),
						threadId,
						"user",
						`Msg ${i}`,
						null,
						null,
						new Date(Date.now() + i * 1000).toISOString(),
						null,
						"local",
					],
				);
			}

			// No --thread-id arg — should infer from ctx.threadId
			const ctxWithThread = { ...ctx, threadId };
			const result = await purge.handler({ last: "2" }, ctxWithThread);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Targeted 2 messages");
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

	describe("advisory command", () => {
		it("creates an advisory row in the DB and returns its ID", async () => {
			const ctx: CommandContext = {
				db,
				siteId: "test-site",
				eventBus: new TypedEventEmitter(),
				logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			};

			const result = await advisory.handler(
				{
					title: "Test advisory",
					detail: "Detailed description of the issue",
					action: "Recommended fix",
					impact: "Minor inconvenience",
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			// Output should contain the advisory ID (a UUID)
			expect(result.stdout).toMatch(/^Advisory created: [0-9a-f-]{36}\n$/);

			// Advisory must be persisted in the DB
			const row = db
				.prepare(
					"SELECT id, type, status, title, detail, action, impact FROM advisories WHERE title = ?",
				)
				.get("Test advisory") as {
				id: string;
				type: string;
				status: string;
				title: string;
				detail: string;
				action: string | null;
				impact: string | null;
			} | null;

			expect(row).not.toBeNull();
			expect(row?.type).toBe("general");
			expect(row?.status).toBe("proposed");
			expect(row?.detail).toBe("Detailed description of the issue");
			expect(row?.action).toBe("Recommended fix");
			expect(row?.impact).toBe("Minor inconvenience");

			// Cleanup
			if (row) db.run("DELETE FROM advisories WHERE id = ?", [row.id]);
		});

		it("creates advisory with only required args (title + detail)", async () => {
			const ctx: CommandContext = {
				db,
				siteId: "test-site",
				eventBus: new TypedEventEmitter(),
				logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			};

			const result = await advisory.handler(
				{ title: "Minimal advisory", detail: "Just the detail" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/Advisory created: /);

			// Cleanup
			db.run("DELETE FROM advisories WHERE title = ?", ["Minimal advisory"]);
		});

		it("returns error when title is missing", async () => {
			const ctx: CommandContext = {
				db,
				siteId: "test-site",
				eventBus: new TypedEventEmitter(),
				logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			};

			const result = await advisory.handler({ detail: "no title" }, ctx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("title");
		});
	});

	describe("commands command", () => {
		// Clean up hosts table before each test
		beforeEach(() => {
			db.run("DELETE FROM hosts WHERE deleted = 0");
		});

		it("should show LOCAL and REMOTE tiers with LOCAL MCP server (mcp-subcommand-dispatch.AC6.1, AC6.3)", async () => {
			// Register: builtin + local MCP server "test-server" + unrelated builtin
			setCommandRegistry(
				[
					help,
					{
						name: "query",
						args: [],
						handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					},
					{
						name: "test-server",
						args: [
							{
								name: "subcommand",
								required: false,
								description: "Subcommand",
							},
						],
						handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					},
				],
				new Set(["test-server"]),
			);

			// Insert a remote host with flat string[] mcp_tools
			db.run(
				`INSERT INTO hosts (site_id, host_name, mcp_tools, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					"remote-site-id-2",
					"remote-host",
					JSON.stringify(["remote-server"]),
					new Date().toISOString(),
					0,
				],
			);

			const result = await help.handler({}, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("query");
			expect(result.stdout).toContain("LOCAL (MCP):");
			expect(result.stdout).toContain("test-server");
			expect(result.stdout).toContain("REMOTE (via relay):");
			expect(result.stdout).toContain("remote-server");
			expect(result.stdout).toContain("[host: remote-host]");
			// Must NOT contain old-style per-tool names
			expect(result.stdout).not.toContain("test-server-tool1");
			expect(result.stdout).not.toContain("remote-server-tool2");
		});

		it("should only show LOCAL (MCP) when no remote tools (mcp-subcommand-dispatch.AC6.1)", async () => {
			// Set up command registry
			setCommandRegistry(
				[
					help,
					{
						name: "query",
						args: [],
						handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					},
					{
						name: "local-server",
						args: [
							{
								name: "subcommand",
								required: false,
								description: "Subcommand",
							},
						],
						handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					},
				],
				new Set(["local-server"]),
			);

			const result = await help.handler({}, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("LOCAL (MCP):");
			expect(result.stdout).toContain("local-server");
			expect(result.stdout).not.toContain("REMOTE (via relay):");
		});

		it("should work without serverNames registry (backwards compatibility)", async () => {
			// Set up command registry without serverNames
			setCommandRegistry([
				help,
				{
					name: "query",
					args: [],
					handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				},
			]);

			const result = await help.handler({}, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("query");
		});

		it("should render subcommand listing for MCP server command (mcp-subcommand-dispatch.AC6.2)", async () => {
			setCommandRegistry(
				[
					help,
					{
						name: "github",
						args: [
							{
								name: "subcommand",
								required: false,
								description: "Subcommand",
							},
						],
						handler: async (args) => {
							if (args.help !== undefined) {
								return {
									stdout:
										"github subcommands:\n\n  create_issue — Create an issue\n  list_issues — List issues\n",
									stderr: "",
									exitCode: 0,
								};
							}
							return {
								stdout: "",
								stderr: "no subcommand",
								exitCode: 1,
							};
						},
					},
				],
				new Set(["github"]),
			);

			const result = await help.handler({ command: "github" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("github subcommands:");
			expect(result.stdout).toContain("create_issue");
		});

		it("should list meta-commands as builtins (mcp-subcommand-dispatch.AC7.1, AC7.2)", async () => {
			// Register meta-commands without adding them to serverNames
			setCommandRegistry(
				[
					help,
					{
						name: "resources",
						args: [],
						handler: async () => ({
							stdout: "resources output",
							stderr: "",
							exitCode: 0,
						}),
					},
					{
						name: "resource",
						args: [
							{
								name: "uri",
								required: true,
								description: "Resource URI",
							},
						],
						handler: async () => ({
							stdout: "resource output",
							stderr: "",
							exitCode: 0,
						}),
					},
					{
						name: "prompts",
						args: [],
						handler: async () => ({
							stdout: "prompts output",
							stderr: "",
							exitCode: 0,
						}),
					},
					{
						name: "prompt",
						args: [
							{
								name: "name",
								required: true,
								description: "Prompt name",
							},
						],
						handler: async () => ({
							stdout: "prompt output",
							stderr: "",
							exitCode: 0,
						}),
					},
				],
				new Set(),
			);

			const result = await help.handler({}, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Built-in:");
			expect(result.stdout).toContain("resources");
			expect(result.stdout).toContain("resource <uri>");
			expect(result.stdout).toContain("prompts");
			expect(result.stdout).toContain("prompt <name>");
		});
	});
});
