import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { DiscordInteractionConnector } from "../connectors/discord-interaction.js";
import type { DiscordClientManager } from "../connectors/discord-client-manager.js";

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

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
	deferReplyCalls: Array<{ ephemeral: boolean }>;
	deferReply: (opts: { ephemeral: boolean }) => Promise<void>;
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

			expect(createCalls.length).toBe(1);
			const call = createCalls[0] as Record<string, unknown>;
			expect(call.name).toBe("File for Later");
			expect(call.type).toBe(3); // ApplicationCommandType.Message
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

			// First connect
			await connector.connect();
			expect(createCalls.length).toBe(1);

			// Second connect (simulating reconnect)
			await connector.connect();
			expect(createCalls.length).toBe(2);
		});
	});

	describe("AC2.1: Ephemeral deferral on interaction", () => {
		it("should call deferReply({ ephemeral: true }) for File for Later command", async () => {
			const deferCalls: Array<{ ephemeral: boolean }> = [];
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
			expect(deferCalls[0]?.ephemeral).toBe(true);
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

			const stored = (connector as { interactions: Map<string, unknown> }).interactions.get(threadId);
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
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(true);

			// Attempt deliver
			await connector.deliver(threadId, "msg-1", "test");

			// Verify cleaned up
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(false);
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
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(true);

			await connector.deliver(threadId, "msg-1", "test");

			// Verify cleaned up after deliver
			expect((connector as { interactions: Map<string, unknown> }).interactions.has(threadId)).toBe(false);
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
});
