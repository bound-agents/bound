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
		attachments?: unknown[];
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
		attachments?: unknown[],
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
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify the mock's deliver() was called with correct arguments (AC5.5)
			expect(mockConnector.deliverCalls.length).toBe(1);
			const call = mockConnector.deliverCalls[0];
			expect(call.threadId).toBe("thread-1");
			expect(call.messageId).toBe("msg-1");
			expect(call.content).toBe("Test message");

			registry.stop();
		});

		it("should not route to non-leader connectors", async () => {
			// Setup: create a leader for a different platform
			const connectorConfig: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 100,
				allowed_users: [],
			};

			const platformsConfig: PlatformsConfig = {
				connectors: [connectorConfig],
			};

			const registry = new PlatformConnectorRegistry(mockAppContext, platformsConfig);
			registry.start();

			// Give leader election time to complete
			await new Promise((resolve) => setTimeout(resolve, 150));

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

			await new Promise((resolve) => setTimeout(resolve, 150));

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

			await new Promise((resolve) => setTimeout(resolve, 150));

			// Emit webhook event
			const payload = {
				platform: "webhook-stub",
				rawBody: "test body",
				headers: {},
			};

			// Should not throw
			eventBus.emit("platform:webhook", payload);

			await new Promise((resolve) => setTimeout(resolve, 50));

			registry.stop();
		});
	});
});
