import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { assert, TypedEventEmitter } from "@bound/shared";
import type { DiscordClientManager } from "../connectors/discord-client-manager.js";
import { DiscordInteractionConnector } from "../connectors/discord-interaction.js";

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

/**
 * Simulate Discord.js Collection behavior: filter() returns a Map-like object
 * whose for...of yields [key, value] entries (not just values like an Array).
 */
function createMockCollection<T>(items: T[]) {
	const map = new Map(items.map((item, i) => [String(i), item]));
	return {
		some: (fn: (item: T) => boolean) => items.some(fn),
		filter: (fn: (item: T) => boolean) => {
			const filtered = items.filter(fn);
			const result = new Map(filtered.map((item, i) => [String(i), item]));
			return result;
		},
		forEach: (fn: (item: T, key: string) => void) => map.forEach(fn),
		values: () => map.values(),
		[Symbol.iterator]: () => map[Symbol.iterator](),
	};
}

// Mock client manager with injected client
const createMockClientManagerWithClient = (mockClient: unknown): DiscordClientManager => {
	return {
		getClient: () => mockClient,
		connect: async () => {},
		disconnect: async () => {},
	} as unknown as DiscordClientManager;
};

// Mock interaction
interface MockInteraction {
	isMessageContextMenuCommand(): boolean;
	commandName?: string;
	deferReplyCalls: Array<Record<string, unknown>>;
	deferReply: (opts: Record<string, unknown>) => Promise<void>;
	user: { id: string };
	targetMessage: { id: string };
	editReplyCalls: Array<{ content: string }>;
	editReply: (opts: { content: string }) => Promise<void>;
}

let db: Database;
let testDbPath: string;
let eventBus: TypedEventEmitter;
let mockLogger: Logger;
let config: PlatformConnectorConfig;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-discord-interaction-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);

	eventBus = new TypedEventEmitter();
	mockLogger = createMockLogger();

	config = {
		platform: "discord-interaction",
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

describe("DiscordInteractionConnector", () => {
	describe("AC1.1: Context menu command registration", () => {
		it("should register 'File for Later' command on connect()", async () => {
			const createCalls: unknown[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async (opts: unknown) => {
							createCalls.push(opts);
						},
					},
				},
				on: () => {},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			expect(createCalls.length).toBe(2);
			const fileCmd = createCalls.find(
				(c) => (c as Record<string, unknown>).name === "File for Later",
			) as Record<string, unknown>;
			expect(fileCmd).toBeDefined();
			expect(fileCmd.type).toBe(3); // ApplicationCommandType.Message
			const modelCmd = createCalls.find(
				(c) => (c as Record<string, unknown>).name === "model",
			) as Record<string, unknown>;
			expect(modelCmd).toBeDefined();
			expect(modelCmd.type).toBe(1); // ApplicationCommandType.ChatInput
		});
	});

	describe("AC1.2: Idempotent upsert on reconnect", () => {
		it("should call commands.create each time connect() is called (idempotent server-side)", async () => {
			const createCalls: unknown[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async (opts: unknown) => {
							createCalls.push(opts);
						},
					},
				},
				on: () => {},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			// First connect (registers 2 commands: File for Later + /model)
			await connector.connect();
			expect(createCalls.length).toBe(2);

			// Second connect (simulating reconnect — registers both again)
			await connector.connect();
			expect(createCalls.length).toBe(4);
		});
	});

	describe("AC2.1: Ephemeral deferral on interaction", () => {
		it("should call deferReply with flags (not deprecated ephemeral) for File for Later command", async () => {
			const deferCalls: Array<Record<string, unknown>> = [];
			const mockInteraction: MockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReplyCalls: deferCalls,
				deferReply: async (opts) => {
					deferCalls.push(opts);
				},
				user: { id: "user123" },
				targetMessage: { id: "msg123" },
				editReplyCalls: [],
				editReply: async () => {},
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// Fire the interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			expect(deferCalls.length).toBe(1);
			// MessageFlags.Ephemeral = 1 << 6 = 64
			expect(deferCalls[0]?.flags).toBe(64);
			// Must NOT use deprecated ephemeral property
			expect(deferCalls[0]?.ephemeral).toBeUndefined();
		});
	});

	describe("AC2.5: Ignore non-matching interactions", () => {
		it("should not call deferReply for non-context-menu interactions", async () => {
			const deferCalls: Array<{ ephemeral: boolean }> = [];
			const mockInteraction: MockInteraction = {
				isMessageContextMenuCommand: () => false,
				commandName: "File for Later",
				deferReplyCalls: deferCalls,
				deferReply: async (opts) => {
					deferCalls.push(opts);
				},
				user: { id: "user123" },
				targetMessage: { id: "msg123" },
				editReplyCalls: [],
				editReply: async () => {},
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// Fire the interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			expect(deferCalls.length).toBe(0);
		});

		it("should not call deferReply for context-menu commands with different names", async () => {
			const deferCalls: Array<{ ephemeral: boolean }> = [];
			const mockInteraction: MockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "Other Command",
				deferReplyCalls: deferCalls,
				deferReply: async (opts) => {
					deferCalls.push(opts);
				},
				user: { id: "user123" },
				targetMessage: { id: "msg123" },
				editReplyCalls: [],
				editReply: async () => {},
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// Fire the interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			expect(deferCalls.length).toBe(0);
		});
	});

	describe("AC6.1: Deliver via editReply with stored interaction", () => {
		it("should call editReply on stored interaction with content", async () => {
			const editReplyCalls: Array<{ content: string }> = [];
			const mockInteraction = {
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);

			const threadId = randomUUID();
			connector.storeInteraction(threadId, mockInteraction);

			await connector.deliver(threadId, "msg-1", "Hello, world!");

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toBe("Hello, world!");
		});
	});

	describe("AC6.2: Truncate content to 2000 characters", () => {
		it("should truncate content longer than 2000 chars to exactly 2000", async () => {
			const editReplyCalls: Array<{ content: string }> = [];
			const mockInteraction = {
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);

			const threadId = randomUUID();
			connector.storeInteraction(threadId, mockInteraction);

			const longContent = "x".repeat(2500);
			await connector.deliver(threadId, "msg-1", longContent);

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toBe("x".repeat(2000));
		});

		it("should not truncate content exactly 2000 chars", async () => {
			const editReplyCalls: Array<{ content: string }> = [];
			const mockInteraction = {
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);

			const threadId = randomUUID();
			connector.storeInteraction(threadId, mockInteraction);

			const content = "x".repeat(2000);
			await connector.deliver(threadId, "msg-1", content);

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toBe(content);
		});
	});

	describe("AC6.3: Handle missing and expired interactions gracefully", () => {
		it("should warn and not throw when no stored interaction exists", async () => {
			let warnCalled = false;
			const mockLoggerWithSpy: Logger = {
				info: () => {},
				warn: () => {
					warnCalled = true;
				},
				error: () => {},
				debug: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLoggerWithSpy,
				createMockClientManagerWithClient({}),
			);

			// Don't store any interaction
			await connector.deliver(randomUUID(), "msg-1", "test");

			expect(warnCalled).toBe(true);
		});

		it("should warn and not throw when interaction is expired", async () => {
			let warnCalled = false;
			const mockLoggerWithSpy: Logger = {
				info: () => {},
				warn: () => {
					warnCalled = true;
				},
				error: () => {},
				debug: () => {},
			};

			const mockInteraction = {
				editReply: async () => {
					throw new Error("Should not call editReply on expired token");
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLoggerWithSpy,
				createMockClientManagerWithClient({}),
			);

			const threadId = randomUUID();
			// Store with immediate expiration (in the past)
			(connector as { interactions: Map<string, unknown> }).interactions.set(threadId, {
				interaction: mockInteraction,
				expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second in the past
			});

			// Deliver should warn but not throw
			await connector.deliver(threadId, "msg-1", "test");

			expect(warnCalled).toBe(true);
		});
	});

	describe("storeInteraction() and TTL management", () => {
		it("should store interaction with TTL expiration time", async () => {
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);

			const mockInteraction = {
				editReply: async () => {},
			};
			const threadId = randomUUID();

			const beforeStore = Date.now();
			connector.storeInteraction(threadId, mockInteraction);
			const afterStore = Date.now();

			const stored = (connector as { interactions: Map<string, unknown> }).interactions.get(
				threadId,
			);
			expect(stored).toBeDefined();

			const expiresAtTime = new Date(stored?.expiresAt as string).getTime();
			const expectedTTL = 14 * 60 * 1000; // 14 minutes in ms

			// Allow ±1 second variance for test execution
			expect(expiresAtTime - beforeStore).toBeGreaterThanOrEqual(expectedTTL - 1000);
			expect(expiresAtTime - afterStore).toBeLessThanOrEqual(expectedTTL + 1000);
		});

		it("should clean up expired interaction on deliver attempt", async () => {
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);

			const mockInteraction = {
				editReply: async () => {},
			};
			const threadId = randomUUID();

			// Store with immediate expiration
			(connector as { interactions: Map<string, unknown> }).interactions.set(threadId, {
				interaction: mockInteraction,
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			});

			// Verify stored
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(
				true,
			);

			// Attempt deliver
			await connector.deliver(threadId, "msg-1", "test");

			// Verify cleaned up
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(
				false,
			);
		});

		it("should clean up interaction after successful deliver", async () => {
			const editReplyCalls: Array<{ content: string }> = [];
			const mockInteraction = {
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);

			const threadId = randomUUID();
			connector.storeInteraction(threadId, mockInteraction);

			// Verify stored
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(
				true,
			);

			await connector.deliver(threadId, "msg-1", "test");

			// Verify cleaned up after deliver
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(
				false,
			);
		});
	});

	describe("disconnect()", () => {
		it("should clear all stored interactions on disconnect", async () => {
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: () => {},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// Store multiple interactions
			const mockInteraction = {
				editReply: async () => {},
			};
			connector.storeInteraction(randomUUID(), mockInteraction);
			connector.storeInteraction(randomUUID(), mockInteraction);

			const interactionsMap = (connector as { interactions: Map<string, unknown> }).interactions;
			expect(interactionsMap.size).toBe(2);

			// Disconnect
			await connector.disconnect();

			// Verify cleared
			expect(interactionsMap.size).toBe(0);
		});

		it("should remove event listener on disconnect", async () => {
			const offCalls: Array<{ event: string; handler: unknown }> = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: () => {},
				off: (event: string, handler: unknown) => {
					offCalls.push({ event, handler });
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// Disconnect
			await connector.disconnect();

			expect(offCalls.length).toBe(1);
			expect(offCalls[0]?.event).toBe("interactionCreate");
		});
	});

	describe("Connector interface requirements", () => {
		it("should have platform = discord-interaction", () => {
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);
			expect(connector.platform).toBe("discord-interaction");
		});

		it("should have delivery = broadcast", () => {
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);
			expect(connector.delivery).toBe("broadcast");
		});

		it("should have connect and disconnect methods", () => {
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);
			expect(typeof connector.connect).toBe("function");
			expect(typeof connector.disconnect).toBe("function");
		});

		it("should have deliver method", () => {
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient({}),
			);
			expect(typeof connector.deliver).toBe("function");
		});
	});

	describe("Filing flow", () => {
		it("AC2.3: allowlist rejection — should reject non-allowlisted user and not create any data", async () => {
			config.allowed_users = ["allowed-user"];
			const editReplyCalls: Array<{ content: string }> = [];

			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
				user: { id: "other-user", displayName: "Other User", username: "other" },
				targetMessage: {
					id: "msg123",
					content: "Some content",
					author: { id: "author-id", bot: false, displayName: "Author", username: "author" },
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Verify error response
			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toContain("not authorized");

			// Verify no data was created
			const users = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
			expect(users.count).toBe(0);

			const threads = db.query("SELECT COUNT(*) as count FROM threads").get() as { count: number };
			expect(threads.count).toBe(0);

			const messages = db.query("SELECT COUNT(*) as count FROM messages").get() as {
				count: number;
			};
			expect(messages.count).toBe(0);

			const outbox = db.query("SELECT COUNT(*) as count FROM relay_outbox").get() as {
				count: number;
			};
			expect(outbox.count).toBe(0);
		});

		it("AC2.4: empty content — should reject and not invoke pipeline", async () => {
			const editReplyCalls: Array<{ content: string }> = [];

			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
				user: { id: "user123", displayName: "User", username: "user" },
				targetMessage: {
					id: "msg123",
					content: "", // Empty content
					author: { id: "author-id", bot: false, displayName: "Author", username: "author" },
					attachments: createMockCollection([]), // No images
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Verify error response
			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toContain("no extractable content");

			// Verify no pipeline was invoked
			const threads = db.query("SELECT COUNT(*) as count FROM threads").get() as { count: number };
			expect(threads.count).toBe(0);
		});

		it("should download file-only attachments and store in files table", async () => {
			const originalFetch = global.fetch;
			const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF header
			global.fetch = async (url: string | URL | Request) => {
				if (String(url) === "https://cdn.discord.com/doc.pdf") {
					return new Response(pdfBytes, {
						status: 200,
						headers: { "Content-Type": "application/pdf" },
					});
				}
				return originalFetch(url);
			};

			try {
				const editReplyCalls: Array<{ content: string }> = [];

				const mockInteraction = {
					isMessageContextMenuCommand: () => true,
					commandName: "File for Later",
					deferReply: async () => {},
					editReply: async (opts: { content: string }) => {
						editReplyCalls.push(opts);
					},
					user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
					targetMessage: {
						id: "msg-file-only",
						content: "", // No text content
						author: {
							id: "author-id",
							bot: false,
							displayName: "Author",
							username: "author",
						},
						attachments: createMockCollection([
							{
								contentType: "application/pdf",
								url: "https://cdn.discord.com/doc.pdf",
								name: "report.pdf",
								size: pdfBytes.length,
							},
						]),
						createdAt: new Date("2026-04-01T10:00:00.000Z"),
					},
					channel: { name: "general" },
					guild: { name: "Test Guild" },
				};

				const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
				const mockClient = {
					application: { commands: { create: async () => {} } },
					on: (event: string, handler: (interaction: unknown) => void) => {
						if (event === "interactionCreate") onInteractionCreateHandlers.push(handler);
					},
					off: () => {},
				};

				const connector = new DiscordInteractionConnector(
					config,
					db,
					"site-1",
					eventBus,
					mockLogger,
					createMockClientManagerWithClient(mockClient),
				);

				await connector.connect();
				await onInteractionCreateHandlers[0]?.(mockInteraction);
				// The handler is fire-and-forget; flush microtasks so fetch completes
				await new Promise((r) => setTimeout(r, 10));

				// Should NOT have rejected with "no extractable content"
				const errorReply = editReplyCalls.find((c) => c.content.includes("no extractable content"));
				expect(errorReply).toBeUndefined();

				// File should be stored in files table at /home/user/uploads/
				const files = db.query("SELECT * FROM files").all() as Array<{
					path: string;
					content: string;
					is_binary: number;
					size_bytes: number;
				}>;
				expect(files.length).toBe(1);
				expect(files[0]?.path).toBe("/home/user/uploads/report.pdf");
				expect(files[0]?.is_binary).toBe(1);
				expect(files[0]?.size_bytes).toBe(pdfBytes.length);

				// Filing prompt should reference the local path, not the CDN URL
				const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as Array<{
					content: string;
				}>;
				expect(messages.length).toBe(1);
				expect(messages[0]?.content).toContain("/home/user/uploads/report.pdf");
				expect(messages[0]?.content).not.toContain("https://cdn.discord.com/doc.pdf");
			} finally {
				global.fetch = originalFetch;
			}
		});

		it("AC3.1: user creation — should create user and reuse on subsequent calls", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: { id: "author-id", bot: false, displayName: "Author", username: "author" },
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// First interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const usersAfterFirst = db.query("SELECT * FROM users WHERE deleted = 0").all() as unknown[];
			expect(usersAfterFirst.length).toBe(1);
			const firstUserId = (usersAfterFirst[0] as { id: string }).id;

			// Second interaction (same user)
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const usersAfterSecond = db.query("SELECT * FROM users WHERE deleted = 0").all() as unknown[];
			expect(usersAfterSecond.length).toBe(1); // Still just 1, not duplicated
			const secondUserId = (usersAfterSecond[0] as { id: string }).id;

			expect(secondUserId).toBe(firstUserId); // Same user ID
		});

		it("AC3.2: thread creation — should create thread with interface = discord-interaction and reuse", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: { id: "author-id", bot: false, displayName: "Author", username: "author" },
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();

			// First interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const threadsAfterFirst = db
				.query("SELECT * FROM threads WHERE deleted = 0")
				.all() as unknown[];
			expect(threadsAfterFirst.length).toBe(1);
			const firstThread = threadsAfterFirst[0] as { id: string; interface: string };
			expect(firstThread.interface).toBe("discord-interaction");

			// Second interaction (same user)
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const threadsAfterSecond = db
				.query("SELECT * FROM threads WHERE deleted = 0")
				.all() as unknown[];
			expect(threadsAfterSecond.length).toBe(1); // Still just 1, not duplicated
			const secondThread = threadsAfterSecond[0] as { id: string };
			expect(secondThread.id).toBe(firstThread.id); // Same thread ID
		});

		it("AC3.3: message persistence — should persist filing prompt with correct format", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg123",
					content: "original message content",
					author: {
						id: "author-id",
						bot: false,
						displayName: "Bob",
						username: "bob",
					},
					attachments: createMockCollection([]),
					createdAt: new Date("2026-03-30T14:22:00.000Z"),
				},
				channel: { name: "general" },
				guild: { name: "TestGuild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
			expect(messages.length).toBe(1);

			const msg = messages[0] as { id: string; content: string };
			expect(msg.content).toContain("File this message for future reference");
			expect(msg.content).toContain("@Bob");
			expect(msg.content).toContain("#general");
			expect(msg.content).toContain("TestGuild");
			expect(msg.content).toContain("2026-03-30T14:22:00.000Z");
			expect(msg.content).toContain("original message content");

			// Verify change_log entry exists (proves insertRow was used)
			const changeLogEntries = db
				.query("SELECT * FROM change_log WHERE table_name = ? AND row_id = ?")
				.all("messages", msg.id);
			expect(changeLogEntries.length).toBeGreaterThan(0);
		});

		it("should show guild name from guildId when guild object is null (not cached)", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg123",
					content: "guild message content",
					author: {
						id: "author-id",
						bot: false,
						displayName: "Bob",
						username: "bob",
					},
					attachments: createMockCollection([]),
					createdAt: new Date("2026-03-30T14:22:00.000Z"),
				},
				channel: { name: "general" },
				// guild is null (not cached) but guildId is set — this is normal in Discord.js
				guild: null,
				guildId: "123456789012345678",
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: { commands: { create: async () => {} } },
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") onInteractionCreateHandlers.push(handler);
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
			expect(messages.length).toBe(1);

			const msg = messages[0] as { content: string };
			// Must NOT say "DM" — this is a guild interaction
			expect(msg.content).not.toContain("in DM");
			// Should include the guild ID as fallback
			expect(msg.content).toContain("123456789012345678");
		});

		it("should include image attachment URLs in filing prompt", async () => {
			const originalFetch = global.fetch;
			const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
			global.fetch = async (url: string | URL | Request) => {
				if (String(url) === "https://cdn.discord.com/doc.pdf") {
					return new Response(pdfBytes, {
						status: 200,
						headers: { "Content-Type": "application/pdf" },
					});
				}
				return originalFetch(url);
			};

			try {
				const mockInteraction = {
					isMessageContextMenuCommand: () => true,
					commandName: "File for Later",
					deferReply: async () => {},
					editReply: async () => {},
					user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
					targetMessage: {
						id: "msg123",
						content: "check out these images",
						author: {
							id: "author-id",
							bot: false,
							displayName: "Bob",
							username: "bob",
						},
						attachments: createMockCollection([
							{
								contentType: "image/png",
								url: "https://cdn.discord.com/img1.png",
								name: "screenshot.png",
							},
							{
								contentType: "image/jpeg",
								url: "https://cdn.discord.com/img2.jpg",
								name: "photo.jpg",
							},
							{
								contentType: "application/pdf",
								url: "https://cdn.discord.com/doc.pdf",
								name: "doc.pdf",
								size: pdfBytes.length,
							},
						]),
						createdAt: new Date("2026-03-30T14:22:00.000Z"),
					},
					channel: { name: "general" },
					guild: { name: "TestGuild" },
				};

				const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
				const mockClient = {
					application: { commands: { create: async () => {} } },
					on: (event: string, handler: (interaction: unknown) => void) => {
						if (event === "interactionCreate") onInteractionCreateHandlers.push(handler);
					},
					off: () => {},
				};

				const connector = new DiscordInteractionConnector(
					config,
					db,
					"site-1",
					eventBus,
					mockLogger,
					createMockClientManagerWithClient(mockClient),
				);

				await connector.connect();
				await onInteractionCreateHandlers[0]?.(mockInteraction);
				await new Promise((r) => setTimeout(r, 10));

				const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
				expect(messages.length).toBe(1);

				const msg = messages[0] as { content: string };
				// Image URLs should be included in the filing prompt
				expect(msg.content).toContain("https://cdn.discord.com/img1.png");
				expect(msg.content).toContain("https://cdn.discord.com/img2.jpg");
				// Non-image file attachment should be stored and referenced by local path
				expect(msg.content).toContain("/home/user/uploads/doc.pdf");
			} finally {
				global.fetch = originalFetch;
			}
		});

		it("should include image URLs even when there is no text content", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg456",
					content: "",
					author: {
						id: "author-id",
						bot: false,
						displayName: "Bob",
						username: "bob",
					},
					attachments: createMockCollection([
						{
							contentType: "image/png",
							url: "https://cdn.discord.com/img1.png",
							name: "screenshot.png",
						},
					]),
					createdAt: new Date("2026-03-30T14:22:00.000Z"),
				},
				channel: { name: "general" },
				guild: { name: "TestGuild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: { commands: { create: async () => {} } },
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") onInteractionCreateHandlers.push(handler);
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
			expect(messages.length).toBe(1);

			const msg = messages[0] as { content: string };
			// Image URL should be in the prompt
			expect(msg.content).toContain("https://cdn.discord.com/img1.png");
			// Should still have the filing header
			expect(msg.content).toContain("File this message for future reference");
		});

		it("AC3.4: intake relay — should write relay_outbox with platform = discord-interaction", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: { id: "author-id", bot: false, displayName: "Author", username: "author" },
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Verify relay_outbox entry
			const outboxEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = 'intake'")
				.all() as unknown[];
			expect(outboxEntries.length).toBe(1);

			const outbox = outboxEntries[0] as { payload: string };
			const payload = JSON.parse(outbox.payload);

			expect(payload.platform).toBe("discord-interaction");
			expect(payload.platform_event_id).toBe("msg123");
			expect(payload.thread_id).toBeDefined();
			expect(payload.user_id).toBeDefined();
			expect(payload.message_id).toBeDefined();
			expect(payload.content).toBeDefined();
		});

		it("AC4.1: recognized user — should include trust signal with bound user name", async () => {
			// Pre-insert a bound user in the users table
			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					"alice",
					JSON.stringify({ discord: "target-author-id" }),
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "user-123", displayName: "User", username: "user" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: {
						id: "target-author-id",
						bot: false,
						displayName: "Alice",
						username: "alice",
					},
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
				user: null,
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
			const msg = messages[0] as { content: string };

			expect(msg.content).toContain('(recognized — bound user "alice")');
		});

		it("AC4.2: unrecognized user — should include (unrecognized) trust signal", async () => {
			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "user-123", displayName: "User", username: "user" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: {
						id: "unknown-author-id",
						bot: false,
						displayName: "Unknown",
						username: "unknown",
					},
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
				user: null,
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
			const msg = messages[0] as { content: string };

			expect(msg.content).toContain("(unrecognized)");
		});

		it("AC4.3: bot message — should include (this bot) trust signal", async () => {
			const botUserId = "bot-id-123";

			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async () => {},
				user: { id: "user-123", displayName: "User", username: "user" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: {
						id: botUserId,
						bot: true,
						displayName: "BotName",
						username: "botname",
					},
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
				user: {
					id: botUserId,
				},
			};

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
			);

			await connector.connect();
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			const messages = db.query("SELECT * FROM messages WHERE role = 'user'").all() as unknown[];
			const msg = messages[0] as { content: string };

			expect(msg.content).toContain("(this bot)");
		});
	});

	describe("Response polling", () => {
		/**
		 * Helper to create a full interaction mock that completes the filing flow.
		 * Returns { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls }
		 */
		const createFullMockSetup = () => {
			const onInteractionCreateHandlers: ((interaction: unknown) => void)[] = [];
			const editReplyCalls: Array<{ content: string }> = [];

			const mockInteraction = {
				isMessageContextMenuCommand: () => true,
				commandName: "File for Later",
				deferReply: async () => {},
				editReply: async (opts: { content: string }) => {
					editReplyCalls.push(opts);
				},
				user: { id: "discord-user-123", displayName: "Alice", username: "alice" },
				targetMessage: {
					id: "msg123",
					content: "Test content",
					author: {
						id: "author-id",
						bot: false,
						displayName: "Author",
						username: "author",
					},
					attachments: createMockCollection([]),
					createdAt: new Date(),
				},
				channel: { name: "general" },
				guild: { name: "Test Guild" },
			};

			const mockClient = {
				application: {
					commands: {
						create: async () => {},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") {
						onInteractionCreateHandlers.push(handler);
					}
				},
				off: () => {},
			};

			return { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls };
		};

		it("AC8.1 (immediate response): should find pre-inserted assistant message and deliver", async () => {
			const { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls } =
				createFullMockSetup();

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
				200, // 200ms timeout for testing
			);

			await connector.connect();

			// Fire the interaction to create user, thread, message
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Get the created thread ID to pre-insert a response
			const threads = db.query("SELECT * FROM threads WHERE deleted = 0").all() as Array<{
				id: string;
			}>;
			expect(threads.length).toBe(1);
			const threadId = threads[0].id;

			// Pre-insert assistant response (created shortly after user message)
			const responseTime = new Date(Date.now() + 10).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					threadId,
					"assistant",
					"This is the assistant response.",
					null,
					null,
					responseTime,
					responseTime,
					"site-1",
					0,
				],
			);

			// Wait for editReply to be called (polling should find the response)
			await new Promise<void>((resolve) => {
				const checkEditReply = () => {
					if (editReplyCalls.length > 0) {
						resolve();
					} else {
						setTimeout(checkEditReply, 10);
					}
				};
				checkEditReply();
			});

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toBe("This is the assistant response.");
		});

		it("AC8.1 (delayed response): should find assistant message inserted during polling", async () => {
			const { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls } =
				createFullMockSetup();

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
				1000, // 1s timeout for testing
			);

			await connector.connect();

			// Fire the interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Get thread ID
			const threads = db.query("SELECT * FROM threads WHERE deleted = 0").all() as Array<{
				id: string;
			}>;
			const threadId = threads[0].id;

			// Simulate delayed response insertion (200ms delay)
			setTimeout(() => {
				const responseTime = new Date().toISOString();
				db.run(
					"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						randomUUID(),
						threadId,
						"assistant",
						"Delayed response from agent.",
						null,
						null,
						responseTime,
						responseTime,
						"site-1",
						0,
					],
				);
			}, 200);

			// Wait for polling to complete
			await new Promise<void>((resolve) => {
				const checkEditReply = () => {
					if (editReplyCalls.length > 0) {
						resolve();
					} else {
						setTimeout(checkEditReply, 10);
					}
				};
				checkEditReply();
			});

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toBe("Delayed response from agent.");
		});

		it("AC8.2 (timeout): should deliver timeout error when no response appears", async () => {
			const { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls } =
				createFullMockSetup();

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
				300, // 300ms timeout for testing
			);

			await connector.connect();

			// Fire the interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Do NOT insert any response — let polling timeout

			// Wait for timeout to occur (poll timeout + some buffer)
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), 600);
			});

			// Should have called editReply with timeout message
			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toContain(
				"Error: Timed out waiting for agent response after 5 minutes.",
			);
		});

		it("AC8.1 + AC6.2 (truncation): should truncate long response to 2000 chars", async () => {
			const { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls } =
				createFullMockSetup();

			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(mockClient),
				200, // 200ms timeout
			);

			await connector.connect();

			// Fire the interaction
			await onInteractionCreateHandlers[0]?.(mockInteraction);

			// Get thread ID
			const threads = db.query("SELECT * FROM threads WHERE deleted = 0").all() as Array<{
				id: string;
			}>;
			const threadId = threads[0].id;

			// Pre-insert a very long response (3000 chars)
			const longContent = "x".repeat(3000);
			const responseTime = new Date(Date.now() + 10).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					threadId,
					"assistant",
					longContent,
					null,
					null,
					responseTime,
					responseTime,
					"site-1",
					0,
				],
			);

			// Wait for editReply
			await new Promise<void>((resolve) => {
				const checkEditReply = () => {
					if (editReplyCalls.length > 0) {
						resolve();
					} else {
						setTimeout(checkEditReply, 10);
					}
				};
				checkEditReply();
			});

			expect(editReplyCalls.length).toBe(1);
			// Verify truncation to exactly 2000 chars
			expect(editReplyCalls[0]?.content).toBe("x".repeat(2000));
		});

		describe("rxjs-async-refactor AC4: RxJS polling observable behavior", () => {
			it("AC4.4: Disconnect mid-poll completes cleanly (takeUntil prevents timeout error)", async () => {
				const { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls } =
					createFullMockSetup();

				const connector = new DiscordInteractionConnector(
					config,
					db,
					"site-1",
					eventBus,
					mockLogger,
					createMockClientManagerWithClient(mockClient),
					10000, // Very long timeout (10s) to ensure disconnect fires first
				);

				await connector.connect();

				// Fire interaction handler
				const handlerPromise = onInteractionCreateHandlers[0]?.(mockInteraction);

				// Let handler store the interaction
				await new Promise<void>((resolve) => setTimeout(() => resolve(), 10));
				const stored = (connector as { interactions: Map<string, unknown> }).interactions;

				// Verify interaction was stored
				expect(stored.size).toBe(1);

				// Disconnect while polling is waiting for response
				// This fires disconnecting$.next(), which triggers takeUntil()
				await connector.disconnect();

				// Wait for handler to complete its polling attempt
				await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
				await handlerPromise;

				// AC4.4: No timeout error message should have been sent
				// The takeUntil(disconnecting$) completes the observable cleanly
				// without error or timeout, so handlePollTimeout() is never called
				expect(editReplyCalls.length).toBe(0);

				// Interactions map should be cleared by disconnect()
				expect(stored.size).toBe(0);
			});

			it("AC4.4 variant: Disconnect during active polling interval", async () => {
				const { mockInteraction, onInteractionCreateHandlers, mockClient, editReplyCalls } =
					createFullMockSetup();

				const connector = new DiscordInteractionConnector(
					config,
					db,
					"site-1",
					eventBus,
					mockLogger,
					createMockClientManagerWithClient(mockClient),
					5000, // 5s timeout (will not fire if disconnect works)
				);

				await connector.connect();

				// Fire interaction
				const handlerPromise = onInteractionCreateHandlers[0]?.(mockInteraction);

				// Wait for polling to enter its interval loop
				await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));

				// Disconnect while polling is between interval ticks
				await connector.disconnect();

				// Wait for handler to finish
				await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
				await handlerPromise;

				// AC4.4: takeUntil(disconnecting$) fires when disconnect() is called,
				// completing the observable without timeout error
				expect(editReplyCalls.length).toBe(0);
			});
		});
	});

	describe("/model slash command", () => {
		function createSlashCommandInteraction(
			commandName: string,
			userId: string,
			options: Record<string, string> = {},
		) {
			const deferReplyCalls: Array<Record<string, unknown>> = [];
			const editReplyCalls: Array<{ content: string }> = [];
			return {
				interaction: {
					isMessageContextMenuCommand: () => false,
					isChatInputCommand: () => true,
					commandName,
					options: {
						getString: (name: string) => options[name] ?? null,
					},
					user: { id: userId, displayName: "Test User", username: "testuser" },
					deferReply: async (opts: Record<string, unknown>) => {
						deferReplyCalls.push(opts);
					},
					editReply: async (opts: { content: string }) => {
						editReplyCalls.push(opts);
					},
				},
				deferReplyCalls,
				editReplyCalls,
			};
		}

		function createMockClientWithHandlers() {
			const handlers: ((interaction: unknown) => void)[] = [];
			const createCalls: unknown[] = [];
			const client = {
				application: {
					commands: {
						create: async (opts: unknown) => {
							createCalls.push(opts);
						},
					},
				},
				on: (event: string, handler: (interaction: unknown) => void) => {
					if (event === "interactionCreate") handlers.push(handler);
				},
				off: () => {},
			};
			return { client, handlers, createCalls };
		}

		it("registers the /model slash command on connect()", async () => {
			const { client, createCalls } = createMockClientWithHandlers();
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(client),
			);
			await connector.connect();

			// Should register both "File for Later" and "model"
			expect(createCalls.length).toBe(2);
			const modelCmd = createCalls.find(
				(c) => (c as Record<string, unknown>).name === "model",
			) as Record<string, unknown>;
			expect(modelCmd).toBeDefined();
			expect(modelCmd.type).toBe(1); // ChatInputCommand
		});

		it("sets threads.model_hint to the specified model for the user's DM thread", async () => {
			const { client, handlers } = createMockClientWithHandlers();
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(client),
			);
			await connector.connect();

			// Pre-create a user and their DM thread (interface="discord")
			const userId = randomUUID();
			const threadId = randomUUID();
			const now = new Date().toISOString();
			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
				[userId, "Test User", JSON.stringify({ discord: "discord-user-123" }), now, now],
			);
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'discord', 'site-1', 0, ?, ?, ?, 0)",
				[threadId, userId, now, now, now],
			);

			const { interaction, editReplyCalls } = createSlashCommandInteraction(
				"model",
				"discord-user-123",
				{ model: "opus" },
			);

			await handlers[0]?.(interaction);

			// Should have replied with confirmation
			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toContain("opus");

			// Should have updated threads.model_hint = "opus"
			const thread = db.query("SELECT model_hint FROM threads WHERE id = ?").get(threadId) as {
				model_hint: string | null;
			} | null;
			assert(thread);
			expect(thread.model_hint).toBe("opus");
		});

		it("replies with error when user has no DM thread", async () => {
			const { client, handlers } = createMockClientWithHandlers();
			const connector = new DiscordInteractionConnector(
				config,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(client),
			);
			await connector.connect();

			// Create user but no DM thread
			const userId = randomUUID();
			const now = new Date().toISOString();
			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
				[userId, "Test User", JSON.stringify({ discord: "discord-user-456" }), now, now],
			);

			const { interaction, editReplyCalls } = createSlashCommandInteraction(
				"model",
				"discord-user-456",
				{ model: "opus" },
			);

			await handlers[0]?.(interaction);

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toContain("No DM thread");
		});

		it("respects allowlist for /model command", async () => {
			const restrictedConfig = { ...config, allowed_users: ["allowed-user"] };
			const { client, handlers } = createMockClientWithHandlers();
			const connector = new DiscordInteractionConnector(
				restrictedConfig,
				db,
				"site-1",
				eventBus,
				mockLogger,
				createMockClientManagerWithClient(client),
			);
			await connector.connect();

			const { interaction, editReplyCalls } = createSlashCommandInteraction(
				"model",
				"not-allowed-user",
				{ model: "opus" },
			);

			await handlers[0]?.(interaction);

			expect(editReplyCalls.length).toBe(1);
			expect(editReplyCalls[0]?.content).toContain("not authorized");
		});
	});
});
