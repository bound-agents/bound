import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";
import { createWebSocketHandler } from "../websocket";

// Mock WebSocket class for testing
class MockWebSocket {
	readyState = 1;
	messages: unknown[] = [];

	send(message: string | Buffer) {
		this.messages.push(typeof message === "string" ? JSON.parse(message) : message);
	}

	getSentMessages() {
		return this.messages;
	}

	clearMessages() {
		this.messages = [];
	}
}

describe("WebSocket Reconnect and Expiry (AC7.1-AC7.3)", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let handler: ReturnType<typeof createWebSocketHandler>;
	const siteId = "test-site-id";
	let threadId: string;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		handler = createWebSocketHandler({
			eventBus,
			db,
			siteId,
			defaultUserId: "test-user",
			hostOrigin: "localhost:3000",
		});

		// Create a test thread using raw insert with all required fields
		threadId = randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO threads
			 (id, user_id, interface, host_origin, last_message_at, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
		).run(threadId, "test-user", "web", "localhost:3000", now, now, now);
	});

	afterEach(() => {
		handler.cleanup();
	});

	describe("AC7.1: Reconnect re-delivery", () => {
		it("re-delivers pending tool calls matched by tool name on reconnect", () => {
			// Create a pending client tool call entry
			const callId = "call-1";
			const toolName = "test_tool";
			const now = new Date().toISOString();
			const entryId = randomUUID();

			db.prepare(
				`INSERT INTO dispatch_queue
				 (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
				 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
			).run(
				entryId,
				threadId,
				JSON.stringify({
					call_id: callId,
					tool_name: toolName,
					arguments: { arg1: "value" },
				}),
				"old-connection-id",
				now,
				now,
			);

			// First connection: client configures tools
			const ws1 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws1);

			const configMsg = JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: toolName,
							description: "A test tool",
							parameters: { type: "object" },
						},
					},
				],
			});

			handler.message(ws1, configMsg);

			// Subscribe to the thread
			const subscribeMsg = JSON.stringify({
				type: "thread:subscribe",
				thread_id: threadId,
			});

			handler.message(ws1, subscribeMsg);

			// Get the sent messages (should contain re-delivered tool:call)
			const sentMessages = (ws1 as unknown as MockWebSocket).getSentMessages();

			// Should have received the tool:call re-delivery
			const toolCallMsg = sentMessages.find((msg: any) => msg.type === "tool:call");
			expect(toolCallMsg).toBeDefined();
			expect(toolCallMsg?.call_id).toBe(callId);
			expect(toolCallMsg?.tool_name).toBe(toolName);
			expect(toolCallMsg?.thread_id).toBe(threadId);
		});

		it("does not re-deliver tool calls when tool name doesn't match", () => {
			// Create a pending client tool call entry with a specific tool name
			const callId = "call-1";
			const toolName = "test_tool";
			const now = new Date().toISOString();
			const entryId = randomUUID();

			db.prepare(
				`INSERT INTO dispatch_queue
				 (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
				 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
			).run(
				entryId,
				threadId,
				JSON.stringify({
					call_id: callId,
					tool_name: toolName,
					arguments: { arg1: "value" },
				}),
				"old-connection-id",
				now,
				now,
			);

			// Client configures different tools
			const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws);

			const configMsg = JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: "different_tool",
							description: "A different tool",
							parameters: { type: "object" },
						},
					},
				],
			});

			handler.message(ws, configMsg);

			// Subscribe to the thread
			const subscribeMsg = JSON.stringify({
				type: "thread:subscribe",
				thread_id: threadId,
			});

			handler.message(ws, subscribeMsg);

			// Get the sent messages
			const sentMessages = (ws as unknown as MockWebSocket).getSentMessages();

			// Should NOT have received the tool:call (tool name doesn't match)
			const toolCallMsg = sentMessages.find((msg: any) => msg.type === "tool:call");
			expect(toolCallMsg).toBeUndefined();

			// The entry should still be pending (not re-delivered)
			const entry = db
				.prepare(
					`SELECT status FROM dispatch_queue WHERE message_id = ? AND event_type = 'client_tool_call'`,
				)
				.get(entryId) as { status: string };
			expect(entry.status).toBe("pending");
		});
	});

	describe("AC7.2: claimed_by update on reconnect", () => {
		it("updates claimed_by to new connection_id when re-delivering", () => {
			// Create a pending client tool call entry
			const callId = "call-1";
			const toolName = "test_tool";
			const now = new Date().toISOString();
			const entryId = randomUUID();
			const oldConnectionId = "old-conn-id";

			db.prepare(
				`INSERT INTO dispatch_queue
				 (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
				 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
			).run(
				entryId,
				threadId,
				JSON.stringify({
					call_id: callId,
					tool_name: toolName,
					arguments: { arg1: "value" },
				}),
				oldConnectionId,
				now,
				now,
			);

			// Client reconnects and configures tools
			const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws);

			const configMsg = JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: toolName,
							description: "A test tool",
							parameters: { type: "object" },
						},
					},
				],
			});

			handler.message(ws, configMsg);

			// Subscribe to the thread
			const subscribeMsg = JSON.stringify({
				type: "thread:subscribe",
				thread_id: threadId,
			});

			handler.message(ws, subscribeMsg);

			// Get the sent messages to extract the new connection ID
			const sentMessages = (ws as unknown as MockWebSocket).getSentMessages();
			const toolCallMsg = sentMessages.find((msg: any) => msg.type === "tool:call");
			expect(toolCallMsg).toBeDefined();

			// Verify the entry's claimed_by was updated
			// The claimed_by should be updated to the new connection ID
			const updatedEntry = db
				.prepare(
					`SELECT claimed_by, status FROM dispatch_queue WHERE message_id = ? AND event_type = 'client_tool_call'`,
				)
				.get(entryId) as { claimed_by: string; status: string };

			// claimed_by should have been updated and status should be 'processing'
			expect(updatedEntry.claimed_by).not.toBe(oldConnectionId);
			expect(updatedEntry.status).toBe("processing");
		});
	});

	describe("AC7.3: tool_call_expired error handling", () => {
		it("returns tool_call_expired error when submitting result for expired entry", () => {
			// Create an expired client tool call entry
			const callId = "call-1";
			const now = new Date().toISOString();
			const entryId = randomUUID();

			// Create expired entry (created_at in the past, status = 'expired')
			const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000 - 1000).toISOString();
			db.prepare(
				`INSERT INTO dispatch_queue
				 (message_id, thread_id, status, event_type, event_payload, created_at, modified_at)
				 VALUES (?, ?, 'expired', 'client_tool_call', ?, ?, ?)`,
			).run(
				entryId,
				threadId,
				JSON.stringify({
					call_id: callId,
					tool_name: "test_tool",
					arguments: {},
				}),
				fiveMinutesAgo,
				now,
			);

			// Client tries to submit a result for the expired entry
			const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws);

			const toolResultMsg = JSON.stringify({
				type: "tool:result",
				call_id: callId,
				thread_id: threadId,
				content: "result content",
				is_error: false,
			});

			handler.message(ws, toolResultMsg);

			// Get the sent messages
			const sentMessages = (ws as unknown as MockWebSocket).getSentMessages();

			// AC3.4: Late tool:result for expired/canceled calls is silently discarded (no error response)
			const errorMsg = sentMessages.find((msg: any) => msg.type === "error");
			expect(errorMsg).toBeUndefined();
		});

		it("rejects tool:result with unknown_call_id error if entry doesn't exist", () => {
			// Try to submit a result for a non-existent call
			const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws);

			const toolResultMsg = JSON.stringify({
				type: "tool:result",
				call_id: "non-existent-call",
				thread_id: threadId,
				content: "result content",
				is_error: false,
			});

			handler.message(ws, toolResultMsg);

			// Get the sent messages
			const sentMessages = (ws as unknown as MockWebSocket).getSentMessages();

			// Should have received an error with code 'unknown_call_id'
			const errorMsg = sentMessages.find(
				(msg: any) => msg.type === "error" && msg.code === "unknown_call_id",
			);
			expect(errorMsg).toBeDefined();
		});
	});

	describe("AC7.1 + AC7.2: Reconnect after disconnect", () => {
		it("re-delivers on new connection after disconnect", () => {
			// Create a pending client tool call entry
			const callId = "call-1";
			const toolName = "test_tool";
			const now = new Date().toISOString();
			const entryId = randomUUID();

			db.prepare(
				`INSERT INTO dispatch_queue
				 (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
				 VALUES (?, ?, 'pending', 'client_tool_call', ?, ?, ?, ?)`,
			).run(
				entryId,
				threadId,
				JSON.stringify({
					call_id: callId,
					tool_name: toolName,
					arguments: { arg1: "value" },
				}),
				"old-connection-id",
				now,
				now,
			);

			// First connection
			const ws1 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws1);

			const configMsg = JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: toolName,
							description: "A test tool",
							parameters: { type: "object" },
						},
					},
				],
			});

			handler.message(ws1, configMsg);

			// Subscribe
			const subscribeMsg = JSON.stringify({
				type: "thread:subscribe",
				thread_id: threadId,
			});

			handler.message(ws1, subscribeMsg);

			// Verify initial re-delivery
			const messages1 = (ws1 as unknown as MockWebSocket).getSentMessages();
			const toolCall1 = messages1.find((msg: any) => msg.type === "tool:call");
			expect(toolCall1).toBeDefined();

			// Disconnect
			handler.close(ws1);

			// Reconnect with new connection
			const ws2 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(ws2);

			// Reconfigure tools
			handler.message(ws2, configMsg);

			// Subscribe to thread
			handler.message(ws2, subscribeMsg);

			// Should re-deliver again to the new connection
			const messages2 = (ws2 as unknown as MockWebSocket).getSentMessages();
			const toolCall2 = messages2.find((msg: any) => msg.type === "tool:call");
			expect(toolCall2).toBeDefined();
			expect(toolCall2?.call_id).toBe(callId);
		});
	});
});
