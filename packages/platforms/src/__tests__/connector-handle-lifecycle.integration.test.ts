import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
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
	let _client: Client;

	beforeEach(async () => {
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

		// Define request schemas for events/stream and events/poll
		const streamRequestSchema = z.object({
			method: z.literal("events/stream"),
			params: z.object({
				event: z.string(),
				params: z.record(z.unknown()).optional(),
				cursor: z.string().optional(),
			}),
		});

		const pollRequestSchema = z.object({
			method: z.literal("events/poll"),
			params: z.object({
				event: z.string(),
				params: z.record(z.unknown()).optional(),
				cursor: z.string().optional(),
			}),
		});

		// Add request handlers for events/stream and events/poll
		await server.setRequestHandler(streamRequestSchema, async () => ({}));

		await server.setRequestHandler(pollRequestSchema, async () => ({
			events: [],
			nextPollSeconds: 2,
		}));
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

			// Register server in registry (which creates transport and connects)
			const entry = await registry.registerServer("test-server", server);
			_client = entry.client;

			// Activate subscription
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Manually deliver a batch event via the public test method
			// This simulates what would happen when the MCP server sends a notification
			registry.testDeliverBatch(handleId, [
				{
					eventId: "event-1",
					name: "test.event",
					timestamp: now,
					data: { test: "data" },
					cursor: "1",
				},
			]);

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

			// Register server in registry (which creates transport and connects)
			const entry = await registry.registerServer("test-server", server);
			_client = entry.client;

			// Activate subscription
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Emit the same event twice via the test method
			const eventId = "event-1";
			const timestamp = now;

			registry.testDeliverBatch(handleId, [
				{
					eventId,
					name: "test.event",
					timestamp,
					data: { test: "data" },
					cursor: "1",
				},
			]);

			await new Promise((resolve) => setTimeout(resolve, 50));

			registry.testDeliverBatch(handleId, [
				{
					eventId,
					name: "test.event",
					timestamp,
					data: { test: "data" },
					cursor: "1",
				},
			]);

			// Give time for async operations
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify only one developer message was created
			const messages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId) as never[];

			expect(messages.length).toBe(1);
		});
	});

	describe("AC5.1: Push-mode event notification", () => {
		it("delivers event notification through push subscription", async () => {
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

			// Create connector handle with push mode
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
			});

			// Register server and activate subscription
			await registry.registerServer("test-server", server);
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Deliver batch
			registry.testDeliverBatch(handleId, [
				{
					eventId: "event-1",
					name: "test.event",
					timestamp: now,
					data: { message: "push test" },
					cursor: "10",
				},
			]);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify message was created
			const messages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId) as any[];

			expect(messages.length).toBe(1);
			expect(messages[0].content).toContain("push test");
		});
	});

	describe("AC5.3: Poll with no events", () => {
		it("does not create message or emit event when poll returns empty", async () => {
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

			// Create connector handle with poll mode
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "poll",
				taskId,
			});

			// Register server and activate subscription
			await registry.registerServer("test-server", server);
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Deliver empty batch (simulates poll with no events)
			registry.testDeliverBatch(handleId, []);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify no message was created
			const messages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId) as any[];

			expect(messages.length).toBe(0);
		});
	});

	describe("AC5.4: Push and poll identical messages", () => {
		it("produces identical developer-role messages from push and poll modes", async () => {
			// Setup: Create two tasks with threads, one for push, one for poll
			const threadIdPush = `thread-${randomBytes(4).toString("hex")}`;
			const taskIdPush = `task-${randomBytes(4).toString("hex")}`;

			const threadIdPoll = `thread-${randomBytes(4).toString("hex")}`;
			const taskIdPoll = `task-${randomBytes(4).toString("hex")}`;

			const now = new Date().toISOString();

			// Create push thread and task
			insertRow(
				db,
				"threads",
				{
					id: threadIdPush,
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
					id: taskIdPush,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskIdPush}`,
					thread_id: threadIdPush,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Create poll thread and task
			insertRow(
				db,
				"threads",
				{
					id: threadIdPoll,
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
					id: taskIdPoll,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskIdPoll}`,
					thread_id: threadIdPoll,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Create push handle
			const pushHandleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId: taskIdPush,
			});

			// Create poll handle (use different event args to get different ID)
			const pollHandleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: { poll: true },
				deliveryMode: "poll",
				taskId: taskIdPoll,
			});

			// Register server and activate both subscriptions
			await registry.registerServer("test-server", server);

			const pushHandle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(pushHandleId);
			await registry.activateSubscription(pushHandle as never);

			const pollHandle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(pollHandleId);
			await registry.activateSubscription(pollHandle as never);

			// Deliver same event to both handles
			const testEvent = {
				eventId: "event-same",
				name: "test.event",
				timestamp: now,
				data: { test: "data", value: 42 },
				cursor: "5",
			};

			registry.testDeliverBatch(pushHandleId, [testEvent]);
			registry.testDeliverBatch(pollHandleId, [testEvent]);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Get messages from both threads
			const pushMessages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadIdPush) as any[];

			const pollMessages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadIdPoll) as any[];

			// Verify both have exactly one message
			expect(pushMessages.length).toBe(1);
			expect(pollMessages.length).toBe(1);

			// Verify content is identical
			expect(pushMessages[0].content).toBe(pollMessages[0].content);
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

			// Register server in registry (which creates transport and connects)
			const entry = await registry.registerServer("test-server", server);
			_client = entry.client;

			// Activate subscription
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Emit event via test method
			registry.testDeliverBatch(handleId, [
				{
					eventId: "event-1",
					name: "test.event",
					timestamp: now,
					data: { test: "data" },
					cursor: "42",
				},
			]);

			// Give time for async operations
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify cursor was updated
			const updatedHandle = db
				.query("SELECT * FROM connector_handles WHERE id = ?")
				.get(handleId) as any;

			expect(updatedHandle.cursor).toBe("42");
		});
	});

	describe("AC6.3: Failover reconnection", () => {
		it("reconstitutes subscriptions from connector_handles table on failover", async () => {
			// Setup: Create tasks with threads
			const threadId1 = `thread-${randomBytes(4).toString("hex")}`;
			const taskId1 = `task-${randomBytes(4).toString("hex")}`;

			const threadId2 = `thread-${randomBytes(4).toString("hex")}`;
			const taskId2 = `task-${randomBytes(4).toString("hex")}`;

			const now = new Date().toISOString();

			// Create threads and tasks
			insertRow(
				db,
				"threads",
				{
					id: threadId1,
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
					id: taskId1,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskId1}`,
					thread_id: threadId1,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			insertRow(
				db,
				"threads",
				{
					id: threadId2,
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
					id: taskId2,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${taskId2}`,
					thread_id: threadId2,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Create two handles
			const handleId1 = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId: taskId1,
				cursor: "100",
			});

			const handleId2 = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: { variant: "2" },
				deliveryMode: "poll",
				taskId: taskId2,
				cursor: "200",
			});

			// Register server
			await registry.registerServer("test-server", server);

			// Call reconnectAll to activate all handles from the DB
			await registry.reconnectAll();

			// Verify subscriptions were activated by checking if we can deliver batches
			// (if not activated, testDeliverBatch would fail silently)
			registry.testDeliverBatch(handleId1, [
				{
					eventId: "event-1",
					name: "test.event",
					timestamp: now,
					data: { test: "data" },
					cursor: "101",
				},
			]);

			registry.testDeliverBatch(handleId2, [
				{
					eventId: "event-2",
					name: "test.event",
					timestamp: now,
					data: { test: "data2" },
					cursor: "201",
				},
			]);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify messages were created in both threads
			const messages1 = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId1) as any[];

			const messages2 = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId2) as any[];

			expect(messages1.length).toBe(1);
			expect(messages2.length).toBe(1);
		});
	});

	describe("AC6.4: Stored cursor enables replay", () => {
		it("resumes from stored cursor, delivering only newer events", async () => {
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

			// Create connector handle with cursor "5" (already received events up to 5)
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
				cursor: "5",
			});

			// Register server and activate
			await registry.registerServer("test-server", server);
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Deliver events 3, 4, 5 (should be deduplicated/ignored) and 6, 7 (should be delivered)
			// Events 3, 4, 5 are "old" (before cursor), 6, 7 are "new"
			registry.testDeliverBatch(handleId, [
				{
					eventId: "event-3",
					name: "test.event",
					timestamp: now,
					data: { num: 3 },
					cursor: "3",
				},
				{
					eventId: "event-4",
					name: "test.event",
					timestamp: now,
					data: { num: 4 },
					cursor: "4",
				},
				{
					eventId: "event-5",
					name: "test.event",
					timestamp: now,
					data: { num: 5 },
					cursor: "5",
				},
				{
					eventId: "event-6",
					name: "test.event",
					timestamp: now,
					data: { num: 6 },
					cursor: "6",
				},
				{
					eventId: "event-7",
					name: "test.event",
					timestamp: now,
					data: { num: 7 },
					cursor: "7",
				},
			]);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify only one message was created (containing events 6 and 7)
			const messages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId) as any[];

			expect(messages.length).toBe(1);

			// Verify the message contains both 6 and 7
			const content = messages[0].content;
			expect(content).toContain("6");
			expect(content).toContain("7");

			// Verify cursor was updated to 7
			const updatedHandle = db
				.query("SELECT * FROM connector_handles WHERE id = ?")
				.get(handleId) as any;
			expect(updatedHandle.cursor).toBe("7");
		});
	});
});
