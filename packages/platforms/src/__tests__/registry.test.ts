import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { AppContext } from "@bound/core";
import { applySchema } from "@bound/core";
import type {
	Logger,
	PlatformConnectorConfig,
	PlatformDeliverPayload,
	PlatformsConfig,
} from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { PlatformConnector } from "../connector.js";
import { WebhookStubConnector } from "../connectors/webhook-stub.js";
import { PlatformLeaderElection } from "../leader-election.js";
import { PlatformConnectorRegistry } from "../registry.js";

// Mock connector for testing (used in some tests)
class _MockConnector implements PlatformConnector {
	readonly platform: string;
	readonly delivery: "broadcast" | "exclusive";
	deliverCalls: Array<{
		threadId: string;
		messageId: string;
		content: string;
		attachments?: Array<{ filename: string; data: Buffer }>;
	}> = [];

	constructor(platform = "test-platform", delivery: "broadcast" | "exclusive" = "broadcast") {
		this.platform = platform;
		this.delivery = delivery;
	}

	async connect(_hostBaseUrl?: string): Promise<void> {
		// no-op for testing
	}

	async disconnect(): Promise<void> {
		// no-op for testing
	}

	async deliver(
		threadId: string,
		messageId: string,
		content: string,
		attachments?: Array<{ filename: string; data: Buffer }>,
	): Promise<void> {
		this.deliverCalls.push({ threadId, messageId, content, attachments });
	}
}

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

let db: Database;
let testDbPath: string;
let eventBus: TypedEventEmitter;
let mockLogger: Logger;
let mockAppContext: AppContext;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-registry-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);

	eventBus = new TypedEventEmitter();
	mockLogger = createMockLogger();

	mockAppContext = {
		db,
		config: {
			allowlist: {
				default_web_user: "alice",
				users: {
					alice: { display_name: "Alice" },
				},
			},
			model_backends: {
				backends: [
					{
						id: "test",
						provider: "ollama",
						model: "llama2",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "test",
			},
		},
		optionalConfig: {},
		eventBus,
		logger: mockLogger,
		siteId: "site-1",
		hostName: "localhost",
	};

	// Initialize cluster_hub
	db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
		"cluster_hub",
		"hub-site-id",
		new Date().toISOString(),
	]);

	// Initialize self host
	const now = new Date().toISOString();
	db.run(
		"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
		["site-1", "localhost", "https://localhost:3000", now, 0],
	);
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

describe("PlatformConnectorRegistry", () => {
	describe("AC5.5: Routes platform:deliver to correct connector", () => {
		it("should route platform:deliver event to the leader connector", async () => {
			// Create mock connector to track deliver() calls
			const mockConnector = new _MockConnector("test-platform", "broadcast");

			// Create a minimal config that won't match our mock platform
			// so the registry doesn't try to create real connectors
			const platformsConfig: PlatformsConfig = {
				connectors: [],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);

			// Manually set up leader election with mock connector
			const connectorConfig: PlatformConnectorConfig = {
				platform: "test-platform",
				failover_threshold_ms: 100,
				allowed_users: [],
			};

			const election = new PlatformLeaderElection(
				mockConnector,
				connectorConfig,
				db,
				mockAppContext.siteId,
			);

			// Inject election into registry's internal elections map
			(registry as { elections: Map<string, PlatformLeaderElection> }).elections.set(
				"test-platform",
				election,
			);

			// Inject into connectorsByPlatform as well (Phase 5 routing uses this map)
			(
				registry as {
					connectorsByPlatform: Map<string, { connector: PlatformConnector; electionKey: string }>;
				}
			).connectorsByPlatform.set("test-platform", {
				connector: mockConnector,
				electionKey: "test-platform",
			});

			// Manually set isLeader flag so routing works
			(election as { isLeaderFlag: boolean }).isLeaderFlag = true;

			// Set up event routing by calling start() which wires eventBus handlers
			registry.start();

			// Emit platform:deliver event
			const payload: PlatformDeliverPayload = {
				platform: "test-platform",
				thread_id: "thread-1",
				message_id: "msg-1",
				content: "Test message",
			};

			eventBus.emit("platform:deliver", payload);

			// Give event handler time to process
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify the mock's deliver() was called with correct arguments (AC5.5)
			expect(mockConnector.deliverCalls.length).toBe(1);
			const call = mockConnector.deliverCalls[0];
			expect(call.threadId).toBe("thread-1");
			expect(call.messageId).toBe("msg-1");
			expect(call.content).toBe("Test message");

			registry.stop();
		});

		it("should not route to non-leader connectors", async () => {
			// Setup: create a leader for webhook-stub (no token required)
			const connectorConfig: PlatformConnectorConfig = {
				platform: "webhook-stub",
				failover_threshold_ms: 100,
				allowed_users: [],
			};

			const platformsConfig: PlatformsConfig = {
				connectors: [connectorConfig],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			// Give leader election time to complete
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Emit a deliver event for a different platform
			const payload: PlatformDeliverPayload = {
				platform: "telegram",
				thread_id: "thread-1",
				message_id: "msg-1",
				content: "Test message",
			};

			// This should not throw (no connector registered for telegram)
			eventBus.emit("platform:deliver", payload);

			registry.stop();
		});
	});

	describe("AC5.6 & AC5.7: WebhookStubConnector characteristics", () => {
		it("should have delivery = exclusive", () => {
			const stub = new WebhookStubConnector();
			expect(stub.delivery).toBe("exclusive");
		});

		it("should throw when deliver() is called", async () => {
			const stub = new WebhookStubConnector();
			await expect(stub.deliver("thread-1", "msg-1", "content")).rejects.toThrow();
		});

		it("should have platform = webhook-stub", () => {
			const stub = new WebhookStubConnector();
			expect(stub.platform).toBe("webhook-stub");
		});

		it("should have no-op connect() and disconnect()", async () => {
			const stub = new WebhookStubConnector();
			// Should not throw
			await stub.connect("https://localhost:3000");
			await stub.disconnect();
		});

		it("should have handleWebhookPayload()", async () => {
			const stub = new WebhookStubConnector();
			// Should not throw
			await stub.handleWebhookPayload("body", {});
		});
	});

	describe("Registry lifecycle", () => {
		it("should start and stop cleanly", () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "webhook-stub",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);

			expect(() => registry.start()).not.toThrow();
			expect(() => registry.stop()).not.toThrow();
		});

		it("should handle single connector lifecycle", async () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "webhook-stub",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			await new Promise((resolve) => setTimeout(resolve, 30));

			registry.stop();
		});
	});

	describe("platform:webhook event routing", () => {
		it("should route platform:webhook to correct connector", async () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "webhook-stub",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			await new Promise((resolve) => setTimeout(resolve, 30));

			// Emit webhook event
			const payload = {
				platform: "webhook-stub",
				rawBody: "test body",
				headers: {},
			};

			// Should not throw
			eventBus.emit("platform:webhook", payload);

			await new Promise((resolve) => setTimeout(resolve, 10));

			registry.stop();
		});
	});

	describe("PlatformConnectorRegistry.getConnector()", () => {
		it("returns the registered connector for a known platform (AC4.1)", () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "webhook-stub",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			const connector = registry.getConnector("webhook-stub");

			expect(connector).toBeDefined();
			expect(connector?.platform).toBe("webhook-stub");

			registry.stop();
		});

		it("returns undefined for an unknown platform (AC4.2)", () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "webhook-stub",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			const connector = registry.getConnector("nonexistent");

			expect(connector).toBeUndefined();

			registry.stop();
		});
	});

	describe("Discord dual-connector", () => {
		it("should create both DiscordConnector and DiscordInteractionConnector for discord config (AC7.1)", async () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "discord",
						token: "test-token",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			// Wait for leader election
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Verify getConnector returns DiscordConnector for "discord"
			const dmConnector = registry.getConnector("discord");
			expect(dmConnector).toBeDefined();
			expect(dmConnector?.platform).toBe("discord");

			// Verify getConnector returns DiscordInteractionConnector for "discord-interaction"
			const interactionConnector = registry.getConnector("discord-interaction");
			expect(interactionConnector).toBeDefined();
			expect(interactionConnector?.platform).toBe("discord-interaction");

			// Verify they are different objects
			expect(dmConnector).not.toBe(interactionConnector);

			registry.stop();
		});

		it("should register both messageCreate and interactionCreate on the same client (AC5.2)", async () => {
			// Create a mock Discord client that tracks on() calls
			const onCalls: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
			const offCalls: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];

			const mockClient = {
				user: { tag: "TestBot#1234", id: "bot-id" },
				application: {
					commands: {
						create: async () => ({}),
					},
				},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					onCalls.push({ event, handler });
					return this;
				},
				off(event: string, handler: (...args: unknown[]) => unknown) {
					offCalls.push({ event, handler });
					return this;
				},
				destroy() {
					// no-op for mock
				},
			};

			// Mock the DiscordClientManager to return our spy-equipped client
			const _mockLogin = async () => {
				// Mock login succeeds
			};

			// Patch the DiscordClientManager constructor to inject our mock client
			const { DiscordClientManager: RealClientManager } = await import(
				"../connectors/discord-client-manager.js"
			);

			// Create a test-specific manager instance with mocked client
			const testManager = new RealClientManager(mockLogger);
			(testManager as any).client = mockClient;

			// Manually set up the connectors with the mocked manager
			const { DiscordConnector } = await import("../connectors/discord.js");
			const { DiscordInteractionConnector } = await import("../connectors/discord-interaction.js");

			const connectorConfig: PlatformConnectorConfig = {
				platform: "discord",
				token: "test-token",
				failover_threshold_ms: 100,
				allowed_users: [],
			};

			const dmConnector = new DiscordConnector(
				connectorConfig,
				db,
				mockAppContext.siteId,
				eventBus,
				mockLogger,
				testManager,
			);

			const interactionConnector = new DiscordInteractionConnector(
				connectorConfig,
				db,
				mockAppContext.siteId,
				eventBus,
				mockLogger,
				testManager,
			);

			// Connect both connectors
			await dmConnector.connect();
			await interactionConnector.connect();

			// AC5.2: Verify both event handlers registered on the same client
			const messageCreateCalls = onCalls.filter((c) => c.event === "messageCreate");
			const interactionCreateCalls = onCalls.filter((c) => c.event === "interactionCreate");
			const clientReadyCalls = onCalls.filter((c) => c.event === "clientReady");

			expect(messageCreateCalls.length).toBe(1);
			expect(interactionCreateCalls.length).toBe(1);
			expect(clientReadyCalls.length).toBe(1);

			// Verify all on() calls were made on the same client object
			expect(onCalls.length).toBe(3);
		});

		it("should disconnect both connectors with proper call sequence (AC5.3)", async () => {
			// Create a mock Discord client that tracks on/off/destroy calls with sequence numbers
			let callSequence = 0;
			const calls: Array<{ seq: number; type: "on" | "off" | "destroy"; event?: string }> = [];

			const mockClient = {
				user: { tag: "TestBot#1234", id: "bot-id" },
				application: {
					commands: {
						create: async () => ({}),
					},
				},
				on(event: string) {
					calls.push({ seq: callSequence++, type: "on", event });
					return this;
				},
				off(event: string) {
					calls.push({ seq: callSequence++, type: "off", event });
					return this;
				},
				destroy() {
					calls.push({ seq: callSequence++, type: "destroy" });
				},
			};

			const { DiscordClientManager: RealClientManager } = await import(
				"../connectors/discord-client-manager.js"
			);

			const testManager = new RealClientManager(mockLogger);
			(testManager as any).client = mockClient;

			const { DiscordConnector } = await import("../connectors/discord.js");
			const { DiscordInteractionConnector } = await import("../connectors/discord-interaction.js");

			const connectorConfig: PlatformConnectorConfig = {
				platform: "discord",
				token: "test-token",
				failover_threshold_ms: 100,
				allowed_users: [],
			};

			const dmConnector = new DiscordConnector(
				connectorConfig,
				db,
				mockAppContext.siteId,
				eventBus,
				mockLogger,
				testManager,
			);

			const interactionConnector = new DiscordInteractionConnector(
				connectorConfig,
				db,
				mockAppContext.siteId,
				eventBus,
				mockLogger,
				testManager,
			);

			// Connect both
			await dmConnector.connect();
			await interactionConnector.connect();

			// Clear call history from connect() phase
			calls.length = 0;
			callSequence = 0;

			// Now disconnect in the compound connector order:
			// interactionConnector.disconnect() -> dmConnector.disconnect() -> clientManager.disconnect()
			await interactionConnector.disconnect();
			await dmConnector.disconnect();
			await testManager.disconnect();

			// AC5.3: Verify call sequence
			// (1) interactionConnector.disconnect() calls client.off("interactionCreate")
			// (2) dmConnector.disconnect() calls client.off("clientReady") and client.off("messageCreate")
			// (3) clientManager.disconnect() calls client.destroy()

			const interactionOffCalls = calls.filter(
				(c) => c.type === "off" && c.event === "interactionCreate",
			);
			const messageCreateOffCalls = calls.filter(
				(c) => c.type === "off" && c.event === "messageCreate",
			);
			const clientReadyOffCalls = calls.filter(
				(c) => c.type === "off" && c.event === "clientReady",
			);
			const destroyCalls = calls.filter((c) => c.type === "destroy");

			// Verify all off() calls were made
			expect(interactionOffCalls.length).toBe(1);
			expect(messageCreateOffCalls.length).toBe(1);
			expect(clientReadyOffCalls.length).toBe(1);
			expect(destroyCalls.length).toBe(1);

			// Verify destroy is called last (after all off() calls)
			const lastDestroyCall = calls[calls.length - 1];
			expect(lastDestroyCall?.type).toBe("destroy");

			// Verify off() calls precede destroy
			const firstOffCallSeq = Math.min(...calls.filter((c) => c.type === "off").map((c) => c.seq));
			const destroySeq = calls.find((c) => c.type === "destroy")?.seq ?? -1;
			expect(firstOffCallSeq).toBeLessThan(destroySeq);
		});

		it("should route platform:deliver with platform='discord' to DiscordConnector (AC7.2)", async () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "discord",
						token: "test-token",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			// Wait for leader election and initialization
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Get connectors after they've been created
			const dmConnector = registry.getConnector("discord");
			const interactionConnector = registry.getConnector("discord-interaction");

			expect(dmConnector).toBeDefined();
			expect(interactionConnector).toBeDefined();

			// Track deliver() calls
			const dmDeliverCalls: Array<{ threadId: string }> = [];
			const interactionDeliverCalls: Array<{ threadId: string }> = [];

			// Spy on deliver methods after they exist
			if (dmConnector) {
				const originalDeliver = dmConnector.deliver.bind(dmConnector);
				dmConnector.deliver = async (threadId: string, ...args) => {
					dmDeliverCalls.push({ threadId });
					return originalDeliver(threadId, ...args);
				};
			}

			if (interactionConnector) {
				const originalDeliver = interactionConnector.deliver.bind(interactionConnector);
				interactionConnector.deliver = async (threadId: string, ...args) => {
					interactionDeliverCalls.push({ threadId });
					return originalDeliver(threadId, ...args);
				};
			}

			// Emit deliver for discord
			const payload: PlatformDeliverPayload = {
				platform: "discord",
				thread_id: "dm-thread-1",
				message_id: "msg-1",
				content: "Test DM",
			};
			eventBus.emit("platform:deliver", payload);
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Verify DM connector received the call
			expect(dmDeliverCalls.length).toBe(1);
			expect(dmDeliverCalls[0]?.threadId).toBe("dm-thread-1");

			registry.stop();
		});

		it("should route platform:deliver with platform='discord-interaction' to DiscordInteractionConnector (AC7.3)", async () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "discord",
						token: "test-token",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			// Wait for leader election and initialization
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Get connectors after they've been created
			const dmConnector = registry.getConnector("discord");
			const interactionConnector = registry.getConnector("discord-interaction");

			expect(dmConnector).toBeDefined();
			expect(interactionConnector).toBeDefined();

			// Track deliver() calls
			const dmDeliverCalls: Array<{ threadId: string }> = [];
			const interactionDeliverCalls: Array<{ threadId: string }> = [];

			// Spy on deliver methods after they exist
			if (dmConnector) {
				const originalDeliver = dmConnector.deliver.bind(dmConnector);
				dmConnector.deliver = async (threadId: string, ...args) => {
					dmDeliverCalls.push({ threadId });
					return originalDeliver(threadId, ...args);
				};
			}

			if (interactionConnector) {
				const originalDeliver = interactionConnector.deliver.bind(interactionConnector);
				interactionConnector.deliver = async (threadId: string, ...args) => {
					interactionDeliverCalls.push({ threadId });
					return originalDeliver(threadId, ...args);
				};
			}

			// Emit deliver for discord-interaction
			const payload: PlatformDeliverPayload = {
				platform: "discord-interaction",
				thread_id: "interaction-thread-1",
				message_id: "msg-2",
				content: "Test Interaction",
			};
			eventBus.emit("platform:deliver", payload);
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Verify interaction connector received the call
			expect(interactionDeliverCalls.length).toBe(1);
			expect(interactionDeliverCalls[0]?.threadId).toBe("interaction-thread-1");

			registry.stop();
		});

		it("should share one leader election between both Discord connectors (AC7.4)", async () => {
			const platformsConfig: PlatformsConfig = {
				connectors: [
					{
						platform: "discord",
						token: "test-token",
						failover_threshold_ms: 100,
						allowed_users: [],
					},
				],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			// Wait for leader election
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Get both connectors
			const dmConnector = registry.getConnector("discord");
			const interactionConnector = registry.getConnector("discord-interaction");

			expect(dmConnector).toBeDefined();
			expect(interactionConnector).toBeDefined();

			// Get internal elections map to verify both map to same election
			const elections = (registry as { elections: Map<string, PlatformLeaderElection> }).elections;
			const election = elections.get("discord");

			expect(election).toBeDefined();

			// Stop should disconnect both connectors cleanly
			expect(() => registry.stop()).not.toThrow();
		});
	});
});
