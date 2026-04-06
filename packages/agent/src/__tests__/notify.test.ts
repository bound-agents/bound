import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, TypedEventEmitter, deterministicUUID } from "@bound/shared";
import { notify } from "../commands/notify";

describe("notify command", () => {
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;
	let eventBus: TypedEventEmitter;
	let siteId: string;

	const testUsername = "karashiiro";
	const testPlatform = "discord";
	const testPlatformUserId = "123456789";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-notify-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		siteId = randomUUID();
		eventBus = new TypedEventEmitter();

		ctx = {
			db,
			siteId,
			eventBus,
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
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	function seedUser(username: string, platforms?: Record<string, string>): string {
		const userId = deterministicUUID(BOUND_NAMESPACE, username);
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			[userId, username, platforms ? JSON.stringify(platforms) : null, now, now],
		);
		return userId;
	}

	function seedThread(userId: string, iface: string): string {
		const threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			[threadId, userId, iface, siteId, now, now, now],
		);
		return threadId;
	}

	describe("argument validation", () => {
		it("requires --platform flag", async () => {
			const result = await notify.handler({ user: testUsername, message: "hello" }, ctx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("--platform");
		});

		it("requires --user or --all", async () => {
			const result = await notify.handler({ platform: testPlatform, message: "hello" }, ctx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/--user|--all/);
		});

		it("rejects --user and --all together", async () => {
			const result = await notify.handler(
				{ user: testUsername, all: "true", platform: testPlatform, message: "hello" },
				ctx,
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("mutually exclusive");
		});

		it("requires a message", async () => {
			seedUser(testUsername, { [testPlatform]: testPlatformUserId });
			const result = await notify.handler({ user: testUsername, platform: testPlatform }, ctx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("message");
		});
	});

	describe("user resolution", () => {
		it("returns error when user not found", async () => {
			const result = await notify.handler(
				{ user: "nonexistent", platform: testPlatform, message: "hello" },
				ctx,
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("nonexistent");
		});

		it("returns error when no thread exists for platform", async () => {
			seedUser(testUsername, { [testPlatform]: testPlatformUserId });
			// No thread seeded
			const result = await notify.handler(
				{ user: testUsername, platform: testPlatform, message: "hello" },
				ctx,
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("No discord thread found");
		});
	});

	describe("single user notification", () => {
		it("enqueues notification to the user's DM thread", async () => {
			const userId = seedUser(testUsername, { [testPlatform]: testPlatformUserId });
			const threadId = seedThread(userId, testPlatform);

			// Set source thread via context
			ctx.threadId = "source-thread-id";

			const result = await notify.handler(
				{ user: testUsername, platform: testPlatform, message: "deep read completed" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(testUsername);

			// Verify dispatch_queue entry
			const entries = db
				.query("SELECT * FROM dispatch_queue WHERE thread_id = ? AND event_type = 'notification'")
				.all(threadId) as Array<{
				message_id: string;
				thread_id: string;
				event_type: string;
				event_payload: string;
				status: string;
			}>;

			expect(entries).toHaveLength(1);
			const payload = JSON.parse(entries[0].event_payload);
			expect(payload.type).toBe("proactive");
			expect(payload.source_thread).toBe("source-thread-id");
			expect(payload.content).toBe("deep read completed");
			expect(entries[0].status).toBe("pending");
		});

		it("picks the most recent thread when multiple exist", async () => {
			const userId = seedUser(testUsername, { [testPlatform]: testPlatformUserId });

			// Seed older thread
			const oldThreadId = randomUUID();
			const oldTime = new Date(Date.now() - 86400000).toISOString();
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
				[oldThreadId, userId, testPlatform, siteId, oldTime, oldTime, oldTime],
			);

			// Seed newer thread
			const newThreadId = randomUUID();
			const newTime = new Date().toISOString();
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
				[newThreadId, userId, testPlatform, siteId, newTime, newTime, newTime],
			);

			const result = await notify.handler(
				{ user: testUsername, platform: testPlatform, message: "test" },
				ctx,
			);

			expect(result.exitCode).toBe(0);

			// Should target the newer thread
			const entry = db
				.query("SELECT thread_id FROM dispatch_queue WHERE event_type = 'notification'")
				.get() as { thread_id: string };
			expect(entry.thread_id).toBe(newThreadId);
		});
	});

	describe("--all broadcast", () => {
		it("enqueues notifications for all users with platform threads", async () => {
			const user1Id = seedUser("alice", { discord: "111" });
			const user2Id = seedUser("bob", { discord: "222" });
			seedUser("charlie", { slack: "333" }); // no discord

			const thread1 = seedThread(user1Id, "discord");
			const thread2 = seedThread(user2Id, "discord");

			const result = await notify.handler(
				{ all: "true", platform: "discord", message: "broadcast test" },
				ctx,
			);

			expect(result.exitCode).toBe(0);

			const entries = db
				.query(
					"SELECT thread_id FROM dispatch_queue WHERE event_type = 'notification' ORDER BY thread_id",
				)
				.all() as Array<{ thread_id: string }>;

			const threadIds = entries.map((e) => e.thread_id).sort();
			expect(threadIds).toEqual([thread1, thread2].sort());
		});

		it("reports partial success when some users have no thread", async () => {
			const user1Id = seedUser("alice", { discord: "111" });
			seedUser("bob", { discord: "222" }); // has platform but no thread

			seedThread(user1Id, "discord");

			const result = await notify.handler(
				{ all: "true", platform: "discord", message: "broadcast test" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("1"); // at least 1 delivered
		});
	});

	describe("self-target guard", () => {
		it("rejects notification targeting the current thread", async () => {
			const userId = seedUser(testUsername, { [testPlatform]: testPlatformUserId });
			const threadId = seedThread(userId, testPlatform);

			// Set ctx.threadId to the SAME thread that would be resolved
			ctx.threadId = threadId;

			const result = await notify.handler(
				{ user: testUsername, platform: testPlatform, message: "hello self" },
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("current thread");

			// Verify no dispatch entry was created
			const entries = db.query("SELECT * FROM dispatch_queue WHERE thread_id = ?").all(threadId);
			expect(entries).toHaveLength(0);
		});

		it("allows notification when source and target threads differ", async () => {
			const userId = seedUser(testUsername, { [testPlatform]: testPlatformUserId });
			seedThread(userId, testPlatform);

			// Source thread is different from target
			ctx.threadId = "different-source-thread";

			const result = await notify.handler(
				{ user: testUsername, platform: testPlatform, message: "hello" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
		});
	});

	describe("event emission", () => {
		it("emits notify:enqueued event for each target thread", async () => {
			const userId = seedUser(testUsername, { [testPlatform]: testPlatformUserId });
			const threadId = seedThread(userId, testPlatform);

			const emittedThreadIds: string[] = [];
			eventBus.on("notify:enqueued", ({ thread_id }) => {
				emittedThreadIds.push(thread_id);
			});

			const result = await notify.handler(
				{ user: testUsername, platform: testPlatform, message: "test" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(emittedThreadIds).toEqual([threadId]);
		});

		it("emits notify:enqueued for each user in --all mode", async () => {
			const user1Id = seedUser("alice", { discord: "111" });
			const user2Id = seedUser("bob", { discord: "222" });
			const thread1 = seedThread(user1Id, "discord");
			const thread2 = seedThread(user2Id, "discord");

			const emittedThreadIds: string[] = [];
			eventBus.on("notify:enqueued", ({ thread_id }) => {
				emittedThreadIds.push(thread_id);
			});

			const result = await notify.handler(
				{ all: "true", platform: "discord", message: "broadcast" },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(emittedThreadIds.sort()).toEqual([thread1, thread2].sort());
		});
	});
});
