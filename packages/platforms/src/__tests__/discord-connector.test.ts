import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { DiscordClientManager } from "../connectors/discord-client-manager.js";
import { DiscordConnector } from "../connectors/discord.js";

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// Mock client manager
const createMockClientManager = (): DiscordClientManager => {
	// Phase 5: connect() no longer calls clientManager.connect(), so getClient()
	// must return a valid mock immediately (registry drives manager lifecycle)
	const mockClient = {
		on: () => {},
		off: () => {},
	};
	return {
		getClient: () => mockClient,
		connect: async () => {},
		disconnect: async () => {},
	} as unknown as DiscordClientManager;
};

// Mock client manager with injected client
const createMockClientManagerWithClient = (mockClient: unknown): DiscordClientManager => {
	return {
		getClient: () => mockClient,
		connect: async () => {},
		disconnect: async () => {},
	} as unknown as DiscordClientManager;
};

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
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockDiscordClient),
			);

			await connector.deliver(threadId, "msg-1", content);

			// Should have called send twice
			expect(mockChannel.sendCalls.length).toBe(2);
			expect(mockChannel.sendCalls[0]?.length).toBe(2000);
			expect(mockChannel.sendCalls[1]?.length).toBe(1001);
		});
	});

	describe("AC6.4: No shouldActivate method (hostname check removed)", () => {
		it("should not have shouldActivate method", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			expect("shouldActivate" in connector).toBe(false);
		});
	});

	describe("AC6.5: Reads allowed_users from platforms.json config", () => {
		it("should reject non-allowlisted users", async () => {
			config.allowed_users = ["allowed123"];

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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

	describe("Double connect() handler guard", () => {
		it("should only register one messageCreate handler even if connect() is called twice", async () => {
			const handlerRegistrations: Array<{ event: string; fn: unknown }> = [];
			const mockClient = {
				on: (event: string, fn: unknown) => {
					handlerRegistrations.push({ event, fn });
				},
				off: (event: string, _fn: unknown) => {
					const idx = handlerRegistrations.findIndex(
						(h) => h.event === event && h.fn === _fn,
					);
					if (idx >= 0) handlerRegistrations.splice(idx, 1);
				},
			};

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await connector.connect(); // second connect() call

			const messageCreateHandlers = handlerRegistrations.filter(
				(h) => h.event === "messageCreate",
			);
			expect(messageCreateHandlers.length).toBe(1);
		});

		it("should produce only one intake per Discord message after double connect()", async () => {
			const handlerRegistrations: Array<{ event: string; fn: Function }> = [];
			const mockClient = {
				on: (event: string, fn: Function) => {
					handlerRegistrations.push({ event, fn });
				},
				off: (event: string, fn: Function) => {
					const idx = handlerRegistrations.findIndex(
						(h) => h.event === event && h.fn === fn,
					);
					if (idx >= 0) handlerRegistrations.splice(idx, 1);
				},
			};

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await connector.connect(); // double connect

			// Simulate a Discord message by firing all registered messageCreate handlers
			const mockMsg = {
				id: "discord-msg-double",
				author: { id: "user123", bot: false, username: "alice", displayName: "Alice" },
				channel: { type: 1, sendTyping: async () => {} },
				content: "test",
				attachments: { values: () => [] },
			};

			for (const h of handlerRegistrations.filter((r) => r.event === "messageCreate")) {
				h.fn(mockMsg);
			}

			// Wait for async onMessage calls to settle
			await new Promise((r) => setTimeout(r, 50));

			const intakes = db.query("SELECT * FROM relay_outbox WHERE kind = 'intake'").all();
			expect(intakes.length).toBe(1);
		});
		it("should deduplicate gateway-replayed messageCreate events", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

			const mockMsg = {
				id: "discord-msg-replay",
				author: { id: "user123", bot: false, username: "alice", displayName: "Alice" },
				channel: { type: 1, sendTyping: async () => {} },
				content: "replayed message",
			};

			// Call onMessage twice with the same Discord message ID (gateway replay)
			await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMsg);
			await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMsg);

			const messages = db.query("SELECT * FROM messages WHERE content = 'replayed message'").all();
			expect(messages.length).toBe(1);

			const intakes = db.query("SELECT * FROM relay_outbox WHERE kind = 'intake'").all();
			expect(intakes.length).toBe(1);
		});
	});

	describe("Connector interface requirements", () => {
		it("should have platform = discord", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			expect(connector.platform).toBe("discord");
		});

		it("should have delivery = broadcast", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			expect(connector.delivery).toBe("broadcast");
		});

		it("should have connect and disconnect methods", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			expect(typeof connector.connect).toBe("function");
			expect(typeof connector.disconnect).toBe("function");
		});

		it("should have deliver method", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			expect(typeof connector.deliver).toBe("function");
		});
	});

	describe("Edge cases", () => {
		it("should reuse existing user and thread on subsequent messages", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
		it("should return early when thread not found", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

			// Deliver to a non-existent thread should not throw, just return
			await connector.deliver("nonexistent-thread", "msg-1", "content");
			// Test passes if no error is thrown
		});

		it("should keep typing active while getDMChannelForThread() is resolving", async () => {
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

			const mockChannel = {
				sendCalls: [] as string[],
				async send(msg: string) {
					this.sendCalls.push(msg);
				},
			};

			// Track how many typing timers are active at the moment getDMChannelForThread resolves
			let typingTimerCountDuringFetch = -1;

			const mockDiscordClient = {
				users: {
					fetch: async (_id: string) => {
						// Capture the timer state right as we're about to return the channel
						const typingTimers = (connector as { typingTimers: Map<string, unknown> }).typingTimers;
						typingTimerCountDuringFetch = typingTimers.size;
						return {
							createDM: async () => mockChannel,
						};
					},
				},
			};

			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockDiscordClient),
			);
			const typingTimers = (connector as { typingTimers: Map<string, unknown> }).typingTimers;

			// Start typing for this thread (simulating what onMessage does)
			const mockTypingChannel = { sendTyping: async () => {} };
			(connector as { startTyping: (id: string, ch: unknown) => void }).startTyping(
				threadId,
				mockTypingChannel,
			);

			expect(typingTimers.size).toBe(1);

			await connector.deliver(threadId, "msg-1", "hello");

			// Typing should have still been active when getDMChannelForThread() ran
			expect(typingTimerCountDuringFetch).toBe(1);
			// Typing should be cleared after deliver() completes
			expect(typingTimers.size).toBe(0);
		});

		it("should log warning when thread not found", async () => {
			let warningLogged = false;
			const mockLoggerWithSpy: Logger = {
				info: () => {},
				warn: () => {
					warningLogged = true;
				},
				error: () => {},
				debug: () => {},
			};

			const mockClient = {};
			const connectorWithSpy = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLoggerWithSpy,
				createMockClientManagerWithClient(mockClient),
			);

			await connectorWithSpy.deliver("nonexistent-thread", "msg-1", "content");

			expect(warningLogged).toBe(true);
		});
	});

	describe("writeOutbox error handling (item #8)", () => {
		it("should stop typing timer if writeOutbox throws after startTyping", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
				await (
					connector as {
						onMessage: (msg: MockDiscordMessage) => Promise<void>;
					}
				).onMessage(mockMsg);
			} catch (_err) {
				// Error is caught internally and handled
			}

			// AFTER FIX: typing timer should be cleaned up (size === 0)
			expect(typingTimersMap.size).toBe(0);
		});
	});

	describe("Typing timer management (item #1)", () => {
		it("should store both interval and timeout handles (not just interval)", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);

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

			const typingTimersBeforeDisconnect = (connector as { typingTimers: unknown })
				.typingTimers as Map<string, unknown>;
			expect(typingTimersBeforeDisconnect.size).toBe(2);

			// Disconnect (mocking that client is not actually connected)
			await connector.disconnect();

			// All timers should be cleared
			const typingTimersAfterDisconnect = (connector as { typingTimers: unknown })
				.typingTimers as Map<string, unknown>;
			expect(typingTimersAfterDisconnect.size).toBe(0);
		});
	});

	describe("DiscordConnector.getPlatformTools()", () => {
		it("returns map with discord_send_message tool definition (AC2.1)", () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();

			const tools = connector.getPlatformTools(threadId);

			expect(tools.has("discord_send_message")).toBe(true);
			const tool = tools.get("discord_send_message");
			expect(tool).toBeDefined();
			expect(tool?.toolDefinition.function.name).toBe("discord_send_message");
			expect(tool?.toolDefinition.function.parameters.required).toContain("content");
		});

		it("execute closure is bound to the provided threadId (AC2.2)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();

			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			const deliverCalls: Array<{
				threadId: string;
				messageId: string;
				content: string;
				attachments?: Array<{ filename: string; data: Buffer }>;
			}> = [];
			(connector as { deliver: unknown }).deliver = async (
				tId: string,
				mId: string,
				content: string,
				attachments?: Array<{ filename: string; data: Buffer }>,
			) => {
				deliverCalls.push({ threadId: tId, messageId: mId, content, attachments });
				return Promise.resolve();
			};

			const tools = connector.getPlatformTools(threadId);
			const execute = tools.get("discord_send_message")?.execute;

			await execute?.({ content: "hi" });

			expect(deliverCalls.length).toBe(1);
			expect(deliverCalls[0]?.threadId).toBe(threadId);
		});

		it("valid content under 2000 chars calls deliver() and returns 'sent' (AC1.1)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			let deliverCalled = false;
			(connector as { deliver: unknown }).deliver = async () => {
				deliverCalled = true;
				return Promise.resolve();
			};

			const tools = connector.getPlatformTools(threadId);
			const execute = tools.get("discord_send_message")?.execute;
			const result = await execute?.({ content: "hello" });

			expect(deliverCalled).toBe(true);
			expect(result).toBe("sent");
		});

		it("content exactly 2000 chars succeeds (AC1.6)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			let deliverCalled = false;
			(connector as { deliver: unknown }).deliver = async () => {
				deliverCalled = true;
				return Promise.resolve();
			};

			const tools = connector.getPlatformTools(threadId);
			const execute = tools.get("discord_send_message")?.execute;
			const result = await execute?.({ content: "x".repeat(2000) });

			expect(result).toBe("sent");
			expect(deliverCalled).toBe(true);
		});

		it("content over 2000 chars returns error, deliver not called (AC1.4)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();

			let deliverCalled = false;
			(connector as { deliver: unknown }).deliver = async () => {
				deliverCalled = true;
				return Promise.resolve();
			};

			const tools = connector.getPlatformTools(threadId);
			const execute = tools.get("discord_send_message")?.execute;
			const result = await execute?.({ content: "x".repeat(2001) });

			expect(typeof result).toBe("string");
			expect(result?.startsWith("Error")).toBe(true);
			expect(deliverCalled).toBe(false);
		});

		it("readable attachment path calls deliver() with loaded buffer and returns 'sent' (AC1.2)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			const testId = randomBytes(4).toString("hex");
			const tmpFile = join(tmpdir(), `test-attachment-${testId}.txt`);
			writeFileSync(tmpFile, "test file content");

			try {
				let deliverCalled = false;
				let deliverAttachments: Array<{ filename: string; data: Buffer }> | undefined;
				(connector as { deliver: unknown }).deliver = async (
					_tId: string,
					_mId: string,
					_content: string,
					attachments?: Array<{ filename: string; data: Buffer }>,
				) => {
					deliverCalled = true;
					deliverAttachments = attachments;
					return Promise.resolve();
				};

				const tools = connector.getPlatformTools(threadId);
				const execute = tools.get("discord_send_message")?.execute;
				const result = await execute?.({ content: "hi", attachments: [tmpFile] });

				expect(result).toBe("sent");
				expect(deliverCalled).toBe(true);
				expect(deliverAttachments).toBeDefined();
				expect(deliverAttachments?.length).toBe(1);
				expect(deliverAttachments?.[0]?.filename).toBe(`test-attachment-${testId}.txt`);
				expect(deliverAttachments?.[0]?.data).toBeDefined();
			} finally {
				unlinkSync(tmpFile);
			}
		});

		it("unreadable attachment path returns error, deliver not called (AC1.5)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();

			let deliverCalled = false;
			(connector as { deliver: unknown }).deliver = async () => {
				deliverCalled = true;
				return Promise.resolve();
			};

			const tools = connector.getPlatformTools(threadId);
			const execute = tools.get("discord_send_message")?.execute;
			const result = await execute?.({
				content: "hi",
				attachments: ["/no/such/file.txt"],
			});

			expect(typeof result).toBe("string");
			expect(result?.startsWith("Error")).toBe(true);
			expect(result?.includes("cannot read attachment")).toBe(true);
			expect(deliverCalled).toBe(false);
		});

		it("multiple execute() calls each invoke deliver() separately (AC1.3)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			let deliverCallCount = 0;
			(connector as { deliver: unknown }).deliver = async () => {
				deliverCallCount++;
				return Promise.resolve();
			};

			const tools = connector.getPlatformTools(threadId);
			const execute = tools.get("discord_send_message")?.execute;

			await execute?.({ content: "msg1" });
			await execute?.({ content: "msg2" });

			expect(deliverCallCount).toBe(2);
		});

		it("uses readFileFn when provided to read attachments (virtual FS support)", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			// Mock readFileFn for virtual FS
			const mockData = new TextEncoder().encode("virtual file content");
			const mockReadFileFn = async (path: string): Promise<Uint8Array> => {
				if (path === "/virtual/file.txt") {
					return mockData;
				}
				throw new Error(`File not found: ${path}`);
			};

			let deliverCalled = false;
			let deliverAttachments: Array<{ filename: string; data: Buffer }> | undefined;
			(connector as { deliver: unknown }).deliver = async (
				_tId: string,
				_mId: string,
				_content: string,
				attachments?: Array<{ filename: string; data: Buffer }>,
			) => {
				deliverCalled = true;
				deliverAttachments = attachments;
				return Promise.resolve();
			};

			const tools = (
				connector as {
					getPlatformTools(
						threadId: string,
						readFileFn?: (path: string) => Promise<Uint8Array>,
					): Map<
						string,
						{
							toolDefinition: { type: string; function: Record<string, unknown> };
							execute: (input: Record<string, unknown>) => Promise<string>;
						}
					>;
				}
			).getPlatformTools(threadId, mockReadFileFn);
			const execute = tools.get("discord_send_message")?.execute;
			const result = await execute?.({ content: "hi", attachments: ["/virtual/file.txt"] });

			expect(result).toBe("sent");
			expect(deliverCalled).toBe(true);
			expect(deliverAttachments?.length).toBe(1);
			expect(deliverAttachments?.[0]?.filename).toBe("file.txt");
			// Verify Buffer was created from Uint8Array
			expect(deliverAttachments?.[0]?.data).toBeDefined();
		});

		it("falls back to node:fs/promises.readFile when readFileFn not provided", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();
			const userId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "Alice", JSON.stringify({ discord: "user123" }), now, now, 0],
			);

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, "discord", "site-1", 0, null, null, null, null, null, now, now, now, 0],
			);

			const testId = randomBytes(4).toString("hex");
			const tmpFile = join(tmpdir(), `test-attachment-fallback-${testId}.txt`);
			writeFileSync(tmpFile, "real filesystem content");

			try {
				let deliverCalled = false;
				let deliverAttachments: Array<{ filename: string; data: Buffer }> | undefined;
				(connector as { deliver: unknown }).deliver = async (
					_tId: string,
					_mId: string,
					_content: string,
					attachments?: Array<{ filename: string; data: Buffer }>,
				) => {
					deliverCalled = true;
					deliverAttachments = attachments;
					return Promise.resolve();
				};

				// Call without readFileFn — should use node:fs/promises
				const tools = connector.getPlatformTools(threadId);
				const execute = tools.get("discord_send_message")?.execute;
				const result = await execute?.({ content: "hi", attachments: [tmpFile] });

				expect(result).toBe("sent");
				expect(deliverCalled).toBe(true);
				expect(deliverAttachments?.length).toBe(1);
				expect(deliverAttachments?.[0]?.data).toBeDefined();
			} finally {
				unlinkSync(tmpFile);
			}
		});

		it("includes error message in attachment failure when readFileFn throws", async () => {
			const connector = new DiscordConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManager(),
			);
			const threadId = randomUUID();

			// Mock readFileFn that throws
			const mockReadFileFn = async (_path: string): Promise<Uint8Array> => {
				throw new Error("access denied");
			};

			let deliverCalled = false;
			(connector as { deliver: unknown }).deliver = async () => {
				deliverCalled = true;
				return Promise.resolve();
			};

			const tools = (
				connector as {
					getPlatformTools(
						threadId: string,
						readFileFn?: (path: string) => Promise<Uint8Array>,
					): Map<
						string,
						{
							toolDefinition: { type: string; function: Record<string, unknown> };
							execute: (input: Record<string, unknown>) => Promise<string>;
						}
					>;
				}
			).getPlatformTools(threadId, mockReadFileFn);
			const execute = tools.get("discord_send_message")?.execute;
			const result = await execute?.({ content: "hi", attachments: ["/file.txt"] });

			expect(typeof result).toBe("string");
			expect(result?.startsWith("Error")).toBe(true);
			expect(result?.includes("access denied")).toBe(true);
			expect(deliverCalled).toBe(false);
		});
	});
});
