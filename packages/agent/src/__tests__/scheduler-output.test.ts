import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { AgentLoop } from "../agent-loop";
import { Scheduler } from "../scheduler";

describe("R-O3: Task output delivered to original scheduling thread", () => {
	let dbPath: string;
	let db: Database;
	let ctx: AppContext;
	let threadId: string;
	let userId: string;
	let taskId: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		// Set up site_id and host_name
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", "test-site-123"]);
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["host_name", "test-host"]);

		// Create AppContext
		ctx = {
			db,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { models: [], default: "test-model" },
			},
			optionalConfig: {},
			eventBus: new TypedEventEmitter(),
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId: "test-site-123",
			hostName: "test-host",
		};

		// Create a test user
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

		// Create a test thread
		threadId = randomUUID();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"test-host",
				0,
				"Test Thread",
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Create a test task pointing to that thread
		taskId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (id, type, trigger_spec, thread_id, status, created_by, model_hint,
			 created_at, modified_at, next_run_at, claimed_by, claimed_at, lease_id, heartbeat_at,
			 last_run_at, run_count, no_quiescence, result, error, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				taskId,
				"event",
				"test:event",
				threadId,
				"claimed",
				"system",
				null,
				now,
				now,
				now,
				"test-host",
				now,
				null,
				null,
				null,
				0,
				0,
				null,
				null,
				0,
			],
		);
	});

	afterEach(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("delivers task output to the original thread", async () => {
		let capturedThreadId: string | undefined;
		let capturedTaskId: string | undefined;

		// Mock agent loop factory that persists a message
		const mockAgentLoopFactory = (config: {
			threadId: string;
			taskId?: string;
			userId: string;
			modelId?: string;
		}): AgentLoop => {
			capturedThreadId = config.threadId;
			capturedTaskId = config.taskId;

			return {
				run: async () => {
					// Persist a message to the thread using insertRow
					const msgId = randomUUID();
					const now = new Date().toISOString();
					insertRow(
						db,
						"messages",
						{
							id: msgId,
							thread_id: config.threadId,
							role: "assistant",
							content: "Task output message",
							model_id: "test-model",
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: "test-host",
							deleted: 0,
						},
						"test-site-123",
					);

					return { success: true };
				},
			} as AgentLoop;
		};

		const scheduler = new Scheduler(ctx, mockAgentLoopFactory);
		const handle = scheduler.start(50);

		// Give the scheduler time to process the claimed task
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, 200);
		});

		handle.stop();

		// Verify the agent loop was called with the correct thread_id
		expect(capturedThreadId).toBe(threadId);
		expect(capturedTaskId).toBe(taskId);

		// Verify messages were persisted to the ORIGINAL thread
		const messages = db.query("SELECT * FROM messages WHERE thread_id = ?").all(threadId) as Array<{
			id: string;
			thread_id: string;
			role: string;
			content: string;
		}>;

		expect(messages.length).toBeGreaterThanOrEqual(1);

		const taskMessage = messages.find((m) => m.content === "Task output message");
		expect(taskMessage).toBeDefined();
		expect(taskMessage?.thread_id).toBe(threadId);
	});

	it("does not create a new thread for task output", async () => {
		// Count threads before
		const threadsBefore = db.query("SELECT COUNT(*) as count FROM threads").get() as {
			count: number;
		};

		const mockAgentLoopFactory = (config: {
			threadId: string;
			taskId?: string;
			userId: string;
			modelId?: string;
		}): AgentLoop => {
			return {
				run: async () => {
					const msgId = randomUUID();
					const now = new Date().toISOString();
					insertRow(
						db,
						"messages",
						{
							id: msgId,
							thread_id: config.threadId,
							role: "assistant",
							content: "Another task output",
							model_id: "test-model",
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: "test-host",
							deleted: 0,
						},
						"test-site-123",
					);

					return { success: true };
				},
			} as AgentLoop;
		};

		const scheduler = new Scheduler(ctx, mockAgentLoopFactory);
		const handle = scheduler.start(50);

		await new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, 200);
		});

		handle.stop();

		// Count threads after
		const threadsAfter = db.query("SELECT COUNT(*) as count FROM threads").get() as {
			count: number;
		};

		// Should not have created any new threads
		expect(threadsAfter.count).toBe(threadsBefore.count);
	});

	it("persists task failure alert to the original thread", async () => {
		// Update task to be claimed
		const now = new Date().toISOString();
		db.run("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?", [
			"test-host",
			now,
			taskId,
		]);

		// Mock agent loop that throws an error
		const mockAgentLoopFactory = (_config: {
			threadId: string;
			taskId?: string;
			userId: string;
			modelId?: string;
		}): AgentLoop => {
			return {
				run: async () => {
					throw new Error("Task execution failed");
				},
			} as AgentLoop;
		};

		const scheduler = new Scheduler(ctx, mockAgentLoopFactory);
		const handle = scheduler.start(50);

		// Wait for the async task to fail
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, 200);
		});

		handle.stop();

		// Verify alert message was persisted to the original thread
		const alerts = db
			.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{
			id: string;
			thread_id: string;
			role: string;
			content: string;
		}>;

		expect(alerts.length).toBeGreaterThanOrEqual(1);

		const failureAlert = alerts[0];
		expect(failureAlert.role).toBe("alert");
		expect(failureAlert.content).toContain("failed");
		expect(failureAlert.thread_id).toBe(threadId);
	});
});
