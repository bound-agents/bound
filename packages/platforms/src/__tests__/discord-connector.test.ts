import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { DiscordConnector } from "../connectors/discord.js";

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// Mock Discord message
interface MockDiscordMessage {
	id: string;
	author: {
		id: string;
		bot: boolean;
		displayName?: string;
		username: string;
	};
	channel: {
		type: number;
		sendTyping?: () => Promise<void>;
	};
	content: string;
}

let db: Database;
let testDbPath: string;
let eventBus: TypedEventEmitter;
let mockLogger: Logger;
let config: PlatformConnectorConfig;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-discord-connector-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);

	eventBus = new TypedEventEmitter();
	mockLogger = createMockLogger();

	config = {
		platform: "discord",
		token: "test-token",
		failover_threshold_ms: 30000,
		allowed_users: [],
	};

	// Initialize cluster_hub
	db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
		"cluster_hub",
		"hub-site-id",
		new Date().toISOString(),
	]);
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

describe("DiscordConnector", () => {
	describe("AC6.1: Writes intake relay to outbox on message", () => {
		it("should write intake relay to relay_outbox", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			// Create a test Discord message
			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "user123",
					bot: false,
					username: "alice",
					displayName: "Alice",
				},
				channel: { type: 1, sendTyping: async () => {} }, // DM channel
				content: "Hello!",
			};

			// Call onMessage (cast to access private method for testing)
			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			// Verify relay_outbox entry was created
			const outboxEntries = db.query("SELECT * FROM relay_outbox WHERE kind = ?").all("intake");
			expect(outboxEntries.length).toBeGreaterThan(0);

			const outboxEntry = outboxEntries[0] as Record<string, unknown>;
			expect(outboxEntry.kind).toBe("intake");

			const payload = JSON.parse(outboxEntry.payload as string);
			expect(payload.platform).toBe("discord");
			expect(payload.platform_event_id).toBe("discord-msg-1");
			expect(payload.content).toBe("Hello!");
		});
	});

	describe("AC6.2: Persists user message via insertRow", () => {
		it("should create messages table entry with role = user", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "user123",
					bot: false,
					username: "alice",
					displayName: "Alice",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "Hello!",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			// Verify messages table entry was created
			const messages = db.query("SELECT * FROM messages WHERE content = ?").all("Hello!");
			expect(messages.length).toBeGreaterThan(0);

			const message = messages[0] as Record<string, unknown>;
			expect(message.role).toBe("user");
			expect(message.content).toBe("Hello!");

			// AC6.2 requirement: verify change_log entry was created (proving insertRow was used)
			const messageId = message.id as string;
			const changeLogEntries = db
				.query("SELECT * FROM change_log WHERE table_name = ? AND row_id = ?")
				.all("messages", messageId);
			expect(changeLogEntries.length).toBeGreaterThan(0);
		});

		it("should create users and threads tables on first message", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "user123",
					bot: false,
					username: "alice",
					displayName: "Alice",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "Hello!",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			// Verify users table entry
			const users = db
				.query("SELECT * FROM users WHERE json_extract(platform_ids, '$.discord') = ?")
				.all("user123");
			expect(users.length).toBe(1);

			// Verify threads table entry
			const threads = db
				.query("SELECT * FROM threads WHERE interface = ? AND deleted = 0")
				.all("discord");
			expect(threads.length).toBeGreaterThan(0);
		});
	});

	describe("AC6.3: Chunks content at Discord's 2000 character limit", () => {
		it("should chunk long content when delivering", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			// Setup: create user and thread
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			const threadId = randomUUID();
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			// Create long content (3001 characters)
			const content = "x".repeat(3001);

			// Mock Discord client and channel
			const mockChannel = {
				sendCalls: [] as string[],
				async send(msg: string) {
					this.sendCalls.push(msg);
					return Promise.resolve();
				},
			};

			const mockDiscordUser = {
				async createDM() {
					return mockChannel;
				},
			};

			const mockDiscordClient = {
				users: {
					async fetch(_id: string) {
						return mockDiscordUser;
					},
				},
			};

			// Set the private client field (for testing)
			(connector as { client: unknown }).client = mockDiscordClient;

			await connector.deliver(threadId, "msg-1", content);

			// Should have called send twice
			expect(mockChannel.sendCalls.length).toBe(2);
			expect(mockChannel.sendCalls[0]?.length).toBe(2000);
			expect(mockChannel.sendCalls[1]?.length).toBe(1001);
		});
	});

	describe("AC6.4: No shouldActivate method (hostname check removed)", () => {
		it("should not have shouldActivate method", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);
			expect("shouldActivate" in connector).toBe(false);
		});
	});

	describe("AC6.5: Reads allowed_users from platforms.json config", () => {
		it("should reject non-allowlisted users", async () => {
			config.allowed_users = ["allowed123"];

			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "other456", // Not in allowlist
					bot: false,
					username: "bob",
					displayName: "Bob",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "Hello!",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			// Verify NO messages were created
			const messages = db.query("SELECT * FROM messages WHERE content = ?").all("Hello!");
			expect(messages.length).toBe(0);

			// Verify NO relay_outbox entries were created
			const outboxEntries = db.query("SELECT * FROM relay_outbox WHERE kind = ?").all("intake");
			expect(outboxEntries.length).toBe(0);
		});

		it("should accept allowlisted users", async () => {
			config.allowed_users = ["allowed123"];

			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "allowed123",
					bot: false,
					username: "alice",
					displayName: "Alice",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "Hello!",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			// Verify message was created
			const messages = db.query("SELECT * FROM messages WHERE content = ?").all("Hello!");
			expect(messages.length).toBeGreaterThan(0);
		});

		it("should accept all users when allowlist is empty", async () => {
			config.allowed_users = [];

			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "anyone",
					bot: false,
					username: "user",
					displayName: "User",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "Hello!",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			// Verify message was created
			const messages = db.query("SELECT * FROM messages WHERE content = ?").all("Hello!");
			expect(messages.length).toBeGreaterThan(0);
		});
	});

	describe("Connector interface requirements", () => {
		it("should have platform = discord", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);
			expect(connector.platform).toBe("discord");
		});

		it("should have delivery = broadcast", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);
			expect(connector.delivery).toBe("broadcast");
		});

		it("should have connect and disconnect methods", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);
			expect(typeof connector.connect).toBe("function");
			expect(typeof connector.disconnect).toBe("function");
		});

		it("should have deliver method", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);
			expect(typeof connector.deliver).toBe("function");
		});
	});

	describe("Edge cases", () => {
		it("should reuse existing user and thread on subsequent messages", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockMsg: MockDiscordMessage = {
				id: "msg-1",
				author: {
					id: "user123",
					bot: false,
					username: "alice",
					displayName: "Alice",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "First message",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg,
			);

			const userCount1 = (
				db.query("SELECT COUNT(*) as count FROM users").all()[0] as Record<string, unknown>
			).count as number;
			const threadCount1 = (
				db.query("SELECT COUNT(*) as count FROM threads").all()[0] as Record<string, unknown>
			).count as number;

			// Send another message from the same user
			const mockMsg2 = {
				...mockMsg,
				id: "msg-2",
				content: "Second message",
			};

			await (connector as { onMessage: (msg: MockDiscordMessage) => Promise<void> }).onMessage(
				mockMsg2,
			);

			const userCount2 = (
				db.query("SELECT COUNT(*) as count FROM users").all()[0] as Record<string, unknown>
			).count as number;
			const threadCount2 = (
				db.query("SELECT COUNT(*) as count FROM threads").all()[0] as Record<string, unknown>
			).count as number;

			// User and thread counts should not increase
			expect(userCount2).toBe(userCount1);
			expect(threadCount2).toBe(threadCount1);

			// But message count should increase
			const messageCount = (
				db.query("SELECT COUNT(*) as count FROM messages").all()[0] as Record<string, unknown>
			).count as number;
			expect(messageCount).toBe(2);
		});
	});

	describe("deliver() behavior", () => {
		it("should throw when not connected", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			// connector.client is null, so deliver should throw
			await expect(connector.deliver("thread-1", "msg-1", "content")).rejects.toThrow();
		});

		it("should log warning when thread not found", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			// Set up a mock client
			(connector as { client: unknown }).client = {};

			let warningLogged = false;
			const mockLoggerWithSpy: Logger = {
				info: () => {},
				warn: () => {
					warningLogged = true;
				},
				error: () => {},
				debug: () => {},
			};

			const connectorWithSpy = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLoggerWithSpy,
			);
			(connectorWithSpy as { client: unknown }).client = {};

			await connectorWithSpy.deliver("nonexistent-thread", "msg-1", "content");

			expect(warningLogged).toBe(true);
		});
	});

	describe("writeOutbox error handling (item #8)", () => {
		it("should stop typing timer if writeOutbox throws after startTyping", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			// First, create user/thread records
			const userId = randomUUID();
			const threadId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			// Patch findOrCreateUser and findOrCreateThread to return our records
			(connector as { findOrCreateUser: unknown }).findOrCreateUser = () => ({
				id: userId,
				display_name: "Alice",
				platform_ids: JSON.stringify({ discord: "user123" }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			});

			(connector as { findOrCreateThread: unknown }).findOrCreateThread = () => ({
				id: threadId,
				user_id: userId,
				interface: "discord",
				host_origin: "site-1",
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
			});

			const mockMsg: MockDiscordMessage = {
				id: "discord-msg-1",
				author: {
					id: "user123",
					bot: false,
					username: "alice",
					displayName: "Alice",
				},
				channel: { type: 1, sendTyping: async () => {} },
				content: "Hello!",
			};

			const typingTimersMap = (connector as { typingTimers: unknown }).typingTimers as Map<
				string,
				unknown
			>;

			// Mock getHubSiteId to throw error, simulating writeOutbox failure path
			(connector as { getHubSiteId: unknown }).getHubSiteId = () => {
				throw new Error("Database query failed for cluster_hub");
			};

			// Call onMessage - it will get past user/thread creation and startTyping,
			// but fail when trying to write to outbox
			try {
				await (connector as {
					onMessage: (msg: MockDiscordMessage) => Promise<void>;
				}).onMessage(mockMsg);
			} catch (err) {
				// Error is caught internally and handled
			}

			// AFTER FIX: typing timer should be cleaned up (size === 0)
			expect(typingTimersMap.size).toBe(0);
		});
	});

	describe("Typing timer management (item #1)", () => {
		it("should store both interval and timeout handles (not just interval)", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockChannel = {
				sendTypingCalls: 0,
				async sendTyping() {
					this.sendTypingCalls++;
					return Promise.resolve();
				},
			};

			// Call startTyping for thread A
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				"thread-A",
				mockChannel,
			);

			// Access the internal map to verify the structure
			const typingTimersMap = (connector as { typingTimers: unknown }).typingTimers as Map<
				string,
				{ interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }
			>;
			expect(typingTimersMap.size).toBe(1);

			const timerEntry = typingTimersMap.get("thread-A");
			expect(timerEntry).toBeDefined();
			expect(timerEntry).toHaveProperty("interval");
			expect(timerEntry).toHaveProperty("timeout");
			expect(timerEntry?.interval).toBeDefined();
			expect(timerEntry?.timeout).toBeDefined();
		});

		it("should clear both handles when stopTyping called", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockChannel = {
				sendTypingCalls: 0,
				async sendTyping() {
					this.sendTypingCalls++;
					return Promise.resolve();
				},
			};

			// Start typing
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				"thread-A",
				mockChannel,
			);

			const typingTimersMap = (connector as { typingTimers: unknown }).typingTimers as Map<
				string,
				unknown
			>;
			expect(typingTimersMap.size).toBe(1);

			// Stop typing
			(connector as { stopTyping: (id: string) => void }).stopTyping("thread-A");

			// Should be completely cleaned up
			expect(typingTimersMap.size).toBe(0);
		});

		it("should replace old handles when startTyping called twice for same thread", () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockChannel = {
				sendTypingCalls: 0,
				async sendTyping() {
					this.sendTypingCalls++;
					return Promise.resolve();
				},
			};

			// Call startTyping for thread A
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				"thread-A",
				mockChannel,
			);

			const typingTimersMap = (connector as { typingTimers: unknown }).typingTimers as Map<
				string,
				{ interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }
			>;
			const firstEntry = typingTimersMap.get("thread-A");
			const firstInterval = firstEntry?.interval;

			// Call startTyping again for thread A (should replace with new handles)
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				"thread-A",
				mockChannel,
			);

			const secondEntry = typingTimersMap.get("thread-A");
			const secondInterval = secondEntry?.interval;

			// The interval handle should be different (new timer created)
			expect(secondInterval).not.toBe(firstInterval);

			// Still should have exactly 1 entry
			expect(typingTimersMap.size).toBe(1);

			// Stop and verify cleanup
			(connector as { stopTyping: (id: string) => void }).stopTyping("thread-A");
			expect(typingTimersMap.size).toBe(0);
		});

		it("should clear typing timers on disconnect", async () => {
			const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);

			const mockChannel = {
				sendTypingCalls: 0,
				async sendTyping() {
					this.sendTypingCalls++;
					return Promise.resolve();
				},
			};

			// Start typing for multiple threads
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				"thread-1",
				mockChannel,
			);
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				"thread-2",
				mockChannel,
			);

			const typingTimersBeforeDisconnect = (connector as { typingTimers: unknown }).typingTimers as Map<
				string,
				unknown
			>;
			expect(typingTimersBeforeDisconnect.size).toBe(2);

			// Disconnect (mocking that client is not actually connected)
			(connector as { client: unknown }).client = null;
			await connector.disconnect();

			// All timers should be cleared
			const typingTimersAfterDisconnect = (connector as { typingTimers: unknown }).typingTimers as Map<
				string,
				unknown
			>;
			expect(typingTimersAfterDisconnect.size).toBe(0);
		});
	});
});
