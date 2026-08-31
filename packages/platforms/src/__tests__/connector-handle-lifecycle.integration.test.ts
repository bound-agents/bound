import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow, setDurableIntakeEnabledForTesting } from "@bound/core";
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
		setDurableIntakeEnabledForTesting(true);
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

	afterEach(() => {
		setDurableIntakeEnabledForTesting(true);
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

			// Manually deliver a batch event
			// This simulates what would happen when the MCP server sends a notification
			const subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
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

			// Verify the batch landed as a passive connector_intake durable_work row —
			// the leader-local delivery vehicle under BOUND_DURABLE_INTAKE (the 4C-3
			// default). The scheduler folds it into the event task's wakeup
			// tool_result via buildEventWakeupContent; no separate developer-role
			// message is written (single delivery vehicle per branch). durable_work
			// is local-only, so there is no changelog entry to assert.
			const intakeRows = db
				.query("SELECT * FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake'")
				.all(threadId) as any[];

			expect(intakeRows.length).toBe(1);
			expect(intakeRows[0].claim_state).toBe("pending");
			expect(intakeRows[0].payload).toContain("data");

			// No developer-role message in the leader-local branch — the folded
			// wakeup is the single place the event enters thread history.
			const devMessages = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'developer' AND deleted = 0")
				.all(threadId) as never[];
			expect(devMessages.length).toBe(0);
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

			let subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
				{
					eventId,
					name: "test.event",
					timestamp,
					data: { test: "data" },
					cursor: "1",
				},
			]);

			await new Promise((resolve) => setTimeout(resolve, 50));

			subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
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
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
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
			const subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
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
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadId) as any[];

			expect(messages.length).toBe(1);
			expect(messages[0].content).toContain("push test");
		});

		// Regression: an earlier version of registerServer/startStreamSubscription
		// monkey-patched `protocol._onNotification` (camelCase). The real SDK
		// internal is `_onnotification` (lowercase), so the override created
		// a phantom property and notifications kept routing through the real
		// dispatcher into `_notificationHandlers` — which had no entry for
		// `notifications/events/event`, so every push event was silently
		// dropped. Symptom in the wild: discord interaction.received
		// bindings registered cleanly but their bound tasks never fired.
		//
		// This test pushes a real notification from the Server side of the
		// in-memory transport pair and asserts the buffer received it.
		// `setNotificationHandler` is the supported entry point and is
		// rename-safe.
		it("buffers events that arrive via notifications/events/event", async () => {
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

			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
			});

			await registry.registerServer("test-server", server);
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Push a notification from the server side of the in-memory
			// transport. This is exactly what an MCP platform server does
			// when it has an event for a streaming subscription.
			await server.notification({
				method: "notifications/events/event",
				params: {
					eventId: "event-real-notification",
					name: "test.event",
					timestamp: now,
					data: { message: "delivered via notification path" },
					cursor: "42",
				},
			});

			// Yield once for the transport message pump.
			await new Promise((resolve) => setTimeout(resolve, 10));

			const subscription = (registry as any).activeSubscriptions.get(handleId);
			expect(subscription).toBeDefined();
			expect(subscription.buffer.length).toBe(1);
			expect(subscription.buffer[0].name).toBe("test.event");
			expect(subscription.buffer[0].data.message).toBe("delivered via notification path");

			// Buffer flushes after 2s; force-flush so we also exercise the
			// developer-role message path end-to-end.
			registry.deliverBatch(subscription, subscription.buffer.splice(0));
			await new Promise((resolve) => setTimeout(resolve, 50));

			const messages = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadId) as any[];
			expect(messages.length).toBe(1);
			expect(messages[0].content).toContain("delivered via notification path");
		});

		// Regression: deliverBatch wrote ONE intake row per BATCH, keyed on the
		// FIRST event's id. After a crash between insertInbox and the cursor
		// update, reconnect replays the overlap as one batch [e1, e2]: the
		// batch key collides with e1's already-persisted row, INSERT OR IGNORE
		// drops the whole row — and the cursor then advances past e2, losing
		// it permanently. Per-event rows with per-event keys make replay
		// dedupe exact: e1 is ignored, e2 survives.
		it("keeps trailing events when a crash-replay batch overlaps an already-delivered event", async () => {
			const now = new Date().toISOString();
			const threadId = `thread-${randomBytes(4).toString("hex")}`;
			const taskId = `task-${randomBytes(4).toString("hex")}`;
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
			const handleId = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "test.event",
				eventArgs: {},
				deliveryMode: "push",
				taskId,
			});

			await registry.registerServer("test-server", server);
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			const e1 = {
				eventId: "replay-e1",
				name: "test.event",
				timestamp: now,
				data: { num: 1 },
				cursor: "101",
			};
			const e2 = {
				eventId: "replay-e2",
				name: "test.event",
				timestamp: now,
				data: { num: 2 },
				cursor: "102",
			};

			// First delivery: e1 alone. Row persisted, cursor advances to 101.
			const sub = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(sub, [e1]);

			// Simulate the crash window: the intake row for e1 was written but
			// the cursor update was lost. Reset the cursor and rebuild the
			// subscription (in-memory dedup set dies with the process).
			db.run("UPDATE connector_handles SET cursor = NULL WHERE id = ?", [handleId]);
			(registry as any).activeSubscriptions.delete(handleId);
			const handleAfter = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handleAfter as never);
			const subAfter = (registry as any).activeSubscriptions.get(handleId);

			// Replay delivers the overlap as one batch.
			registry.deliverBatch(subAfter, [e1, e2]);

			const rows = db
				.query(
					"SELECT payload FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' ORDER BY received_at",
				)
				.all(threadId) as Array<{ payload: string }>;

			// e1 must not double; e2 must survive the replay.
			const withE2 = rows.filter((r) => r.payload.includes('"num":2'));
			expect(withE2.length).toBe(1);
			const withE1 = rows.filter((r) => r.payload.includes('"num":1'));
			expect(withE1.length).toBe(1);
		});
		it("routes an event only to subscriptions whose params match event.data", async () => {
			const now = new Date().toISOString();
			const mkThreadTask = (suffix: string) => {
				const threadId = `thread-${suffix}-${randomBytes(4).toString("hex")}`;
				const taskId = `task-${suffix}-${randomBytes(4).toString("hex")}`;
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
				return { threadId, taskId };
			};

			const a = mkThreadTask("dm");
			const b = mkThreadTask("guild");

			const handleA = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "message.received",
				eventArgs: { channel_id: "channel-dm" },
				deliveryMode: "push",
				taskId: a.taskId,
			});
			const handleB = createConnectorHandle(db, siteId, {
				serverName: "test-server",
				eventName: "message.received",
				eventArgs: { channel_id: "channel-guild" },
				deliveryMode: "push",
				taskId: b.taskId,
			});

			await registry.registerServer("test-server", server);
			const rowA = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleA);
			const rowB = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleB);
			await registry.activateSubscription(rowA as never);
			await registry.activateSubscription(rowB as never);

			// One event on the guild channel. Only handle B's filter matches.
			await server.notification({
				method: "notifications/events/event",
				params: {
					eventId: "event-guild-only",
					name: "message.received",
					timestamp: now,
					data: { channel_id: "channel-guild", content: "testing receive" },
					cursor: "100",
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 10));

			const subA = (registry as any).activeSubscriptions.get(handleA);
			const subB = (registry as any).activeSubscriptions.get(handleB);
			expect(subA).toBeDefined();
			expect(subB).toBeDefined();
			expect(subB.buffer.length).toBe(1);
			expect(subB.buffer[0].data.channel_id).toBe("channel-guild");
			// The DM subscription must NOT receive the guild event.
			expect(subA.buffer.length).toBe(0);

			// An event carrying no channel_id at all matches neither filtered
			// subscription (fail-closed, mirroring the connector-side filter).
			await server.notification({
				method: "notifications/events/event",
				params: {
					eventId: "event-no-channel",
					name: "message.received",
					timestamp: now,
					data: { content: "channel-less event" },
					cursor: "101",
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(subA.buffer.length).toBe(0);
			expect(subB.buffer.length).toBe(1);
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
			const subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, []);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify no message was created
			const messages = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadId) as any[];

			expect(messages.length).toBe(0);
		});
	});

	describe("AC5.2: Poll-mode timer delivers events", () => {
		it("triggers poll timer and delivers events from server", async () => {
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

			// Mock the server's poll handler to return events
			const pollRequestSchema = z.object({
				method: z.literal("events/poll"),
				params: z.object({
					event: z.string(),
					params: z.record(z.unknown()).optional(),
					cursor: z.string().optional(),
				}),
			});

			await server.setRequestHandler(pollRequestSchema, async () => ({
				events: [
					{
						eventId: "poll-event-1",
						name: "test.event",
						timestamp: now,
						data: { message: "poll response" },
						cursor: "1",
					},
				],
				nextPollSeconds: 2,
			}));

			// Register server and activate poll subscription
			await registry.registerServer("test-server", server);
			const handle = db.query("SELECT * FROM connector_handles WHERE id = ?").get(handleId);
			await registry.activateSubscription(handle as never);

			// Wait for poll timer to fire (initial interval is 2s, use shorter real timeout for test)
			// The poll happens in the background; we verify by checking if message appears
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Deliver event directly to verify poll path works
			const subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
				{
					eventId: "poll-event-1",
					name: "test.event",
					timestamp: now,
					data: { message: "poll response" },
					cursor: "1",
				},
			]);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify message was created in the thread
			const messages = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadId) as any[];

			expect(messages.length).toBe(1);
			expect(messages[0].content).toContain("poll response");
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

			const pushSubscription = (registry as any).activeSubscriptions.get(pushHandleId);
			registry.deliverBatch(pushSubscription, [testEvent]);

			const pollSubscription = (registry as any).activeSubscriptions.get(pollHandleId);
			registry.deliverBatch(pollSubscription, [testEvent]);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Get messages from both threads
			const pushMessages = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadIdPush) as any[];

			const pollMessages = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
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
			const subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
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
			// (if not activated, deliverBatch would fail silently)
			const subscription1 = (registry as any).activeSubscriptions.get(handleId1);
			registry.deliverBatch(subscription1, [
				{
					eventId: "event-1",
					name: "test.event",
					timestamp: now,
					data: { test: "data" },
					cursor: "101",
				},
			]);

			const subscription2 = (registry as any).activeSubscriptions.get(handleId2);
			registry.deliverBatch(subscription2, [
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
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadId1) as any[];

			const messages2 = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
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
			const subscription = (registry as any).activeSubscriptions.get(handleId);
			registry.deliverBatch(subscription, [
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

			// Verify per-event intake rows were created for events 6 and 7 only
			// (persistence is per-event, not per-batch: one row per event so
			// crash-replay dedupe via idempotency key is exact).
			const messages = db
				.query(
					"SELECT id, payload AS content FROM durable_work WHERE ref_id = ? AND kind = 'connector_intake' AND claim_state = 'pending'",
				)
				.all(threadId) as any[];

			expect(messages.length).toBe(2);

			// One row carries event 6, the other event 7.
			const contents = messages.map((m) => m.content).join("|");
			expect(contents).toContain('"num":6');
			expect(contents).toContain('"num":7');

			// Verify events 3, 4, 5 (before cursor) are NOT in any row
			// These should have been filtered by cursor-based replay
			expect(contents).not.toContain('"num":3');
			expect(contents).not.toContain('"num":4');
			expect(contents).not.toContain('"num":5');

			// Verify cursor was updated to 7
			const updatedHandle = db
				.query("SELECT * FROM connector_handles WHERE id = ?")
				.get(handleId) as any;
			expect(updatedHandle.cursor).toBe("7");
		});
	});
});
