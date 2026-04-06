import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { createAppContext } from "../app-context";
import { insertRow } from "../change-log";

describe("Phase 1 Integration", () => {
	let configDir: string;
	let dbPath: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);

		// Create valid config files
		const allowlist = {
			default_web_user: "alice",
			users: {
				alice: { display_name: "Alice", platforms: { discord: "alice-discord" } },
				bob: { display_name: "Bob" },
			},
		};

		const backends = {
			backends: [
				{
					id: "ollama-local",
					provider: "ollama",
					model: "llama3",
					context_window: 4096,
					tier: 1,
					base_url: "http://localhost:11434",
				},
				{
					id: "anthropic-api",
					provider: "anthropic",
					model: "claude-opus-4",
					context_window: 200000,
					tier: 5,
					api_key: "test-key",
				},
			],
			default: "ollama-local",
		};

		writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));
		writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));
	});

	afterEach(async () => {
		try {
			await cleanupTmpDir(configDir);
		} catch {
			// ignore
		}
		try {
			const fs = require("node:fs");
			fs.unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("complete Phase 1 vertical slice: create context, verify database, insert user, emit event", () => {
		// Step 1: Create AppContext with full initialization
		const ctx = createAppContext(configDir, dbPath);

		expect(ctx).toBeDefined();
		expect(ctx.db).toBeDefined();
		expect(ctx.config).toBeDefined();
		expect(ctx.eventBus).toBeDefined();
		expect(ctx.logger).toBeDefined();
		expect(ctx.siteId).toBeDefined();

		// Step 2: Verify database has all 20 tables
		const tables = ctx.db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>;

		expect(tables.length).toBe(21); // 16 main tables (incl. skills, memory_edges) + 3 relay + dispatch_queue + 2 metrics - 1 (host_meta is local) = 21

		const tableNames = tables.map((t) => t.name);
		const expectedTables = [
			"advisories",
			"change_log",
			"cluster_config",
			"daily_summary",
			"files",
			"host_meta",
			"hosts",
			"memory_edges",
			"messages",
			"overlay_index",
			"relay_cycles",
			"relay_inbox",
			"relay_outbox",
			"semantic_memory",
			"sync_state",
			"tasks",
			"threads",
			"turns",
			"users",
		];

		for (const table of expectedTables) {
			expect(tableNames).toContain(table);
		}

		// Step 3: Verify WAL mode is active
		const journalMode = ctx.db.query("PRAGMA journal_mode").get() as {
			journal_mode: string;
		};
		expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

		// Step 4: Insert a user row via insertRow and verify it's in the database
		const userId = randomUUID();
		const now = new Date().toISOString();

		const userData = {
			id: userId,
			display_name: "Charlie",
			platform_ids: null,
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(ctx.db, "users", userData, ctx.siteId);

		// Verify user was inserted
		const user = ctx.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		>;
		expect(user).toBeDefined();
		expect(user.display_name).toBe("Charlie");

		// Step 5: Verify change_log entry was created
		const changeLogEntry = ctx.db
			.query("SELECT * FROM change_log WHERE row_id = ?")
			.get(userId) as Record<string, unknown>;

		expect(changeLogEntry).toBeDefined();
		expect(changeLogEntry.table_name).toBe("users");
		expect(changeLogEntry.site_id).toBe(ctx.siteId);

		const rowData = JSON.parse(changeLogEntry.row_data as string);
		expect(rowData.display_name).toBe("Charlie");

		// Step 6: Emit an event on the typed event bus
		let messageCreatedEvent: unknown = null;
		ctx.eventBus.on("message:created", (data) => {
			messageCreatedEvent = data;
		});

		const threadId = randomUUID();
		const message = {
			id: randomUUID(),
			thread_id: threadId,
			role: "user" as const,
			content: "Hello, world!",
			model_id: null,
			tool_name: null,
			created_at: now,
			modified_at: now,
			host_origin: ctx.siteId,
		};

		ctx.eventBus.emit("message:created", {
			message: message as Message,
			thread_id: threadId,
		});

		// Verify event was received with correct typing
		expect(messageCreatedEvent).toBeDefined();
		if (messageCreatedEvent && typeof messageCreatedEvent === "object") {
			expect((messageCreatedEvent as { thread_id: string }).thread_id).toBe(threadId);
		}

		// Step 7: Verify config was loaded correctly
		expect(ctx.config.allowlist.default_web_user).toBe("alice");
		expect(ctx.config.allowlist.users).toHaveProperty("alice");
		expect(ctx.config.allowlist.users).toHaveProperty("bob");
		expect(ctx.config.modelBackends.backends).toHaveLength(2);
		expect(ctx.config.modelBackends.default).toBe("ollama-local");

		// Step 8: Verify site_id is stored and can be retrieved
		const storedSiteId = ctx.db
			.query("SELECT value FROM host_meta WHERE key = 'site_id'")
			.get() as { value: string };

		expect(storedSiteId.value).toBe(ctx.siteId);

		ctx.db.close();
	});

	it("vertical slice with multiple users and threads", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();

		// Insert multiple users
		const alice = {
			id: randomUUID(),
			display_name: "Alice",
			platform_ids: JSON.stringify({ discord: "alice-123" }),
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		const bob = {
			id: randomUUID(),
			display_name: "Bob",
			platform_ids: null,
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(ctx.db, "users", alice, ctx.siteId);
		insertRow(ctx.db, "users", bob, ctx.siteId);

		// Verify both users exist
		const users = ctx.db
			.query("SELECT id, display_name FROM users WHERE deleted = 0")
			.all() as Array<{ id: string; display_name: string }>;

		expect(users.length).toBeGreaterThanOrEqual(2);
		const userNames = users.map((u) => u.display_name);
		expect(userNames).toContain("Alice");
		expect(userNames).toContain("Bob");

		// Create threads for users
		const thread1 = {
			id: randomUUID(),
			user_id: alice.id,
			interface: "web",
			host_origin: ctx.siteId,
			color: 0,
			title: null,
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(ctx.db, "threads", thread1, ctx.siteId);

		// Verify thread exists
		const thread = ctx.db.query("SELECT * FROM threads WHERE id = ?").get(thread1.id) as Record<
			string,
			unknown
		>;
		expect(thread).toBeDefined();
		expect(thread.user_id).toBe(alice.id);

		// Insert messages for the thread
		const msg1 = {
			id: randomUUID(),
			thread_id: thread1.id,
			role: "user",
			content: "Hello",
			model_id: null,
			tool_name: null,
			created_at: now,
			modified_at: now,
			host_origin: ctx.siteId,
		};

		const msg2 = {
			id: randomUUID(),
			thread_id: thread1.id,
			role: "assistant",
			content: "Hi there!",
			model_id: "ollama/llama3",
			tool_name: null,
			created_at: new Date(new Date(now).getTime() + 1000).toISOString(),
			modified_at: now,
			host_origin: ctx.siteId,
		};

		insertRow(ctx.db, "messages", msg1, ctx.siteId);
		insertRow(ctx.db, "messages", msg2, ctx.siteId);

		// Verify messages exist
		const messages = ctx.db
			.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at")
			.all(thread1.id) as Array<Record<string, unknown>>;

		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify change_log has entries for all changes
		const changeLogEntries = ctx.db
			.query("SELECT table_name FROM change_log ORDER BY seq")
			.all() as Array<{ table_name: string }>;

		expect(changeLogEntries.length).toBeGreaterThanOrEqual(5); // 2 users + 1 thread + 2 messages

		ctx.db.close();
	});

	it("semantic memory and tasks storage", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();

		// Insert semantic memory
		const memory = {
			id: randomUUID(),
			key: "project.acme.status",
			value: "in review",
			source: randomUUID(),
			created_at: now,
			modified_at: now,
			last_accessed_at: null,
			deleted: 0,
		};

		insertRow(ctx.db, "semantic_memory", memory, ctx.siteId);

		// Verify memory exists
		const stored = ctx.db
			.query("SELECT * FROM semantic_memory WHERE key = ?")
			.get("project.acme.status") as Record<string, unknown>;

		expect(stored).toBeDefined();
		expect(stored.value).toBe("in review");

		// Insert a task
		const task = {
			id: randomUUID(),
			type: "cron",
			status: "pending",
			trigger_spec: "0 * * * *",
			payload: JSON.stringify({ action: "check_status" }),
			created_at: now,
			created_by: null,
			thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: now,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: JSON.stringify(["github"]),
			model_hint: null,
			no_history: 0,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 1,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			modified_at: now,
			deleted: 0,
		};

		insertRow(ctx.db, "tasks", task, ctx.siteId);

		// Verify task exists
		const storedTask = ctx.db.query("SELECT * FROM tasks WHERE id = ?").get(task.id) as Record<
			string,
			unknown
		>;

		expect(storedTask).toBeDefined();
		expect(storedTask.type).toBe("cron");
		expect(storedTask.status).toBe("pending");

		ctx.db.close();
	});
});
