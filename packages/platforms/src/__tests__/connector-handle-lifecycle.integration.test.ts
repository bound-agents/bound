import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createConnectorHandle } from "../connector-handle.js";
import { PlatformMcpRegistry } from "../mcp-registry.js";

// Simple mock logger
const mockLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

// Simple event bus for testing
class SimpleEventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();

	on<K extends string>(event: K, handler: (payload: unknown) => void): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(handler);
	}

	emit<K extends string>(event: K, payload: unknown): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				handler(payload);
			}
		}
	}

	off<K extends string>(event: K, handler: (payload: unknown) => void): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			handlers.delete(handler);
		}
	}
}

describe("Connector Handle Lifecycle", () => {
	let db: Database.Database;
	let siteId: string;
	let eventBus: SimpleEventBus;
	let registry: PlatformMcpRegistry;
	let server: Server;
	let client: Client;

	beforeEach(() => {
		// Setup database
		const dbPath = ":memory:";
		db = new Database(dbPath);
		applySchema(db);

		siteId = `test-site-${randomBytes(4).toString("hex")}`;

		eventBus = new SimpleEventBus();

		// Create registry
		registry = new PlatformMcpRegistry({
			db,
			siteId,
			eventBus: eventBus as unknown as TypedEventEmitter,
			logger: mockLogger,
		});

		// Create minimal MCP server that can emit events
		server = new Server({
			name: "test-server",
			version: "1.0.0",
		});
	});

	describe("AC1.2: Event persisted as developer-role message", () => {
		it("delivers event batch as developer-role message in task thread", async () => {
			// Setup: Create task with thread
			const threadId = `thread-${randomBytes(4).toString("hex")}`;
			const taskId = `task-${randomBytes(4).toString("hex")}`;

			const now = new Date().toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "test-user",
					interface: "test",
					host_origin: siteId,
					summary: null,
					last_message_at: now,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskId}`,
					thread_id: threadId,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Create connector handle
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
			});

			// Setup InMemoryTransport pair
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

			// Connect server and client
			await server.connect(serverTransport);
			client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
			await client.connect(clientTransport);

			// Register server in registry
			await registry.registerServer("test-server", server);

			// Activate subscription
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Emit event from server
			server.notification({
				method: "notifications/events/event",
				params: {
					eventId: "event-1",
					name: "test.event",
					timestamp: new Date().toISOString(),
					data: { test: "data" },
					cursor: "1",
				},
			} as never);

			// Give time for async operations
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify message was created in the thread
			const messages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND deleted = 0")
				.all(threadId) as never[];

			expect(messages.length).toBeGreaterThan(0);

			const devMessage = messages.find((m: any) => m.role === "developer");
			expect(devMessage).toBeDefined();
			expect(devMessage?.thread_id).toBe(threadId);

			// Verify changelog entry exists
			const changelog = db
				.query("SELECT * FROM change_log WHERE row_id = ? AND table_name = 'messages'")
				.all(devMessage?.id) as never[];
			expect(changelog.length).toBeGreaterThan(0);
		});
	});

	describe("AC1.3: Duplicate events not persisted twice", () => {
		it("deduplicates events with same eventId", async () => {
			// Setup: Create task with thread
			const threadId = `thread-${randomBytes(4).toString("hex")}`;
			const taskId = `task-${randomBytes(4).toString("hex")}`;

			const now = new Date().toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "test-user",
					interface: "test",
					host_origin: siteId,
					summary: null,
					last_message_at: now,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskId}`,
					thread_id: threadId,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Create connector handle
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
			});

			// Setup InMemoryTransport pair
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

			// Connect server and client
			await server.connect(serverTransport);
			client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
			await client.connect(clientTransport);

			// Register server in registry
			await registry.registerServer("test-server", server);

			// Activate subscription
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Emit the same event twice
			const eventId = "event-1";
			const timestamp = new Date().toISOString();

			server.notification({
				method: "notifications/events/event",
				params: {
					eventId,
					name: "test.event",
					timestamp,
					data: { test: "data" },
					cursor: "1",
				},
			} as never);

			await new Promise((resolve) => setTimeout(resolve, 50));

			server.notification({
				method: "notifications/events/event",
				params: {
					eventId,
					name: "test.event",
					timestamp,
					data: { test: "data" },
					cursor: "1",
				},
			} as never);

			// Give time for async operations
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify only one developer message was created
			const messages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId) as never[];

			expect(messages.length).toBe(1);
		});
	});

	describe("AC5.5: Cursor persisted after batch delivery", () => {
		it("updates connector handle cursor after successful delivery", async () => {
			// Setup: Create task with thread
			const threadId = `thread-${randomBytes(4).toString("hex")}`;
			const taskId = `task-${randomBytes(4).toString("hex")}`;

			const now = new Date().toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "test-user",
					interface: "test",
					host_origin: siteId,
					summary: null,
					last_message_at: now,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskId}`,
					thread_id: threadId,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Create connector handle
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
				cursor: null,
			});

			// Setup InMemoryTransport pair
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

			// Connect server and client
			await server.connect(serverTransport);
			client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
			await client.connect(clientTransport);

			// Register server in registry
			await registry.registerServer("test-server", server);

			// Activate subscription
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Emit event
			server.notification({
				method: "notifications/events/event",
				params: {
					eventId: "event-1",
					name: "test.event",
					timestamp: new Date().toISOString(),
					data: { test: "data" },
					cursor: "42",
				},
			} as never);

			// Give time for async operations
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify cursor was updated
			const updatedHandle = db
				.query("SELECT * FROM connector_handles WHERE id = ?")
				.get(handleId) as any;

			expect(updatedHandle.cursor).toBe("42");
		});
	});
});
