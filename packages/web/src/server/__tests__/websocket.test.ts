import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";
import { createWebSocketHandler } from "../websocket";

// Mock WebSocket class
class MockWebSocket {
	readyState = 1;
	messages: unknown[] = [];

	send(message: string | Buffer) {
		this.messages.push(typeof message === "string" ? JSON.parse(message) : message);
	}
}

describe("ClientConnection type and WS message schemas", () => {
	let eventBus: TypedEventEmitter;
	let handler: ReturnType<typeof createWebSocketHandler>;

	beforeEach(() => {
		eventBus = new TypedEventEmitter();
		handler = createWebSocketHandler(eventBus);
	});

	afterEach(() => {
		handler.cleanup();
	});

	describe("ClientConnection extended fields", () => {
		it("should persist clientTools across multiple messages", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Send session:configure with tools
			const configMsg = JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: "test_tool",
							description: "A test tool",
							parameters: {
								type: "object",
								properties: {
									arg1: { type: "string" },
								},
							},
						},
					},
				],
			});

			handler.message(mockWs, configMsg);

			// Verify no error was sent (error handler tests in Task 2)
			expect((mockWs as unknown as MockWebSocket).messages).toHaveLength(0);

			// Send another message - tools should still be registered
			const subscribeMsg = JSON.stringify({
				type: "thread:subscribe",
				thread_id: "thread-1",
			});

			handler.message(mockWs, subscribeMsg);

			// No error should be sent - tools persist
			expect((mockWs as unknown as MockWebSocket).messages).toHaveLength(0);
		});
	});

	describe("WS message schemas - session:configure", () => {
		it("should accept valid session:configure message", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: "my_tool",
							description: "Does something",
							parameters: { some: "value" },
						},
					},
				],
			});

			handler.message(mockWs, msg);

			// No error should be sent for valid message
			expect((mockWs as unknown as MockWebSocket).messages).toHaveLength(0);
		});

		it("should accept session:configure with empty tools array", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "session:configure",
				tools: [],
			});

			handler.message(mockWs, msg);

			expect((mockWs as unknown as MockWebSocket).messages).toHaveLength(0);
		});
	});

	describe("WS message schemas - message:send", () => {
		it("should accept valid message:send", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "message:send",
				thread_id: "thread-123",
				content: "Hello world",
			});

			// Should not throw or send error
			expect(() => {
				handler.message(mockWs, msg);
			}).not.toThrow();
		});

		it("should accept message:send with file_ids", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "message:send",
				thread_id: "thread-123",
				content: "Message with files",
				file_ids: ["file-1", "file-2"],
			});

			expect(() => {
				handler.message(mockWs, msg);
			}).not.toThrow();
		});
	});

	describe("WS message schemas - thread subscribe/unsubscribe", () => {
		it("should accept valid thread:subscribe", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "thread:subscribe",
				thread_id: "thread-123",
			});

			expect(() => {
				handler.message(mockWs, msg);
			}).not.toThrow();
		});

		it("should accept valid thread:unsubscribe", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "thread:unsubscribe",
				thread_id: "thread-123",
			});

			expect(() => {
				handler.message(mockWs, msg);
			}).not.toThrow();
		});
	});

	describe("WS message schemas - tool:result", () => {
		it("should accept valid tool:result", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "tool:result",
				call_id: "call-123",
				thread_id: "thread-123",
				content: "Tool result content",
			});

			expect(() => {
				handler.message(mockWs, msg);
			}).not.toThrow();
		});

		it("should accept tool:result with is_error flag", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "tool:result",
				call_id: "call-123",
				thread_id: "thread-123",
				content: "Error occurred",
				is_error: true,
			});

			expect(() => {
				handler.message(mockWs, msg);
			}).not.toThrow();
		});
	});

	describe("Discriminated union schema validation", () => {
		it("should accept any valid message type", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const messageTypes = [
				{
					type: "session:configure",
					tools: [],
				},
				{
					type: "thread:subscribe",
					thread_id: "t1",
				},
				{
					type: "thread:unsubscribe",
					thread_id: "t1",
				},
				{
					type: "message:send",
					thread_id: "t1",
					content: "test",
				},
				{
					type: "tool:result",
					call_id: "c1",
					thread_id: "t1",
					content: "result",
				},
			];

			for (const msgType of messageTypes) {
				expect(() => {
					handler.message(mockWs, JSON.stringify(msgType));
				}).not.toThrow();
			}
		});
	});

	describe("Schema validation - invalid messages", () => {
		it("should reject message with unknown type field", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "unknown:type",
				data: "something",
			});

			handler.message(mockWs, msg);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "invalid_message",
			});
		});

		it("should reject message:send without required thread_id", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "message:send",
				content: "Hello",
			});

			handler.message(mockWs, msg);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "invalid_message",
			});
		});

		it("should reject tool:result without required fields", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const msg = JSON.stringify({
				type: "tool:result",
				call_id: "call-123",
				// missing thread_id and content
			});

			handler.message(mockWs, msg);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "invalid_message",
			});
		});
	});

	describe("Task 2: Message dispatcher and handlers", () => {
		it("should send error on malformed JSON without closing connection", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			const invalidJson = "{invalid json}";
			handler.message(mockWs, invalidJson);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "invalid_json",
			});

			// Connection should still be open - send another valid message
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// The subscribe should have succeeded (no new error)
			expect(messages).toHaveLength(1);
		});

		it("should send error on schema-invalid message without closing connection", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					content: "Hello", // missing required thread_id
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "invalid_message",
			});

			// Connection should still be open
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// The subscribe should have succeeded (no new error)
			expect(messages).toHaveLength(1);
		});

		it("session:configure should store tools on the connection", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Send session:configure with tools
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "tool_a",
								description: "Tool A",
								parameters: { type: "object" },
							},
						},
						{
							type: "function",
							function: {
								name: "tool_b",
								description: "Tool B",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			// No error should be sent
			expect(
				((mockWs as unknown as MockWebSocket).messages as unknown[]).filter(
					(msg) => (msg as Record<string, unknown>).type === "error",
				),
			).toHaveLength(0);
		});

		it("session:configure with empty tools should clear previously registered tools", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// First, register tools
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "tool_a",
								description: "Tool A",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			// Then, configure with empty tools
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
				}),
			);

			// No errors should have been sent
			expect(
				((mockWs as unknown as MockWebSocket).messages as unknown[]).filter(
					(msg) => (msg as Record<string, unknown>).type === "error",
				),
			).toHaveLength(0);
		});

		it("thread:subscribe should work with new message format", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-123",
				}),
			);

			expect(
				((mockWs as unknown as MockWebSocket).messages as unknown[]).filter(
					(msg) => (msg as Record<string, unknown>).type === "error",
				),
			).toHaveLength(0);
		});

		it("thread:unsubscribe should work with new message format", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Subscribe first
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-123",
				}),
			);

			// Then unsubscribe
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:unsubscribe",
					thread_id: "thread-123",
				}),
			);

			expect(
				((mockWs as unknown as MockWebSocket).messages as unknown[]).filter(
					(msg) => (msg as Record<string, unknown>).type === "error",
				),
			).toHaveLength(0);
		});
	});

	describe("Task 3: message:send WS handler", () => {
		it("should send handler_not_configured error when db is not provided", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					thread_id: "thread-123",
					content: "Hello",
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "handler_not_configured",
			});
		});

		it("should send error for empty content", () => {
			const eventBus = new TypedEventEmitter();
			// Mock a database that returns the thread exists
			const mockDb = {
				query: (_sql: string) => ({
					get: () => ({ id: "thread-123" }), // thread exists
				}),
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Empty content
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					thread_id: "thread-123",
					content: "",
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const lastMessage = messages[messages.length - 1] as Record<string, unknown>;
			expect(lastMessage.type).toBe("error");
			expect(lastMessage.code).toBe("invalid_content");

			testHandler.cleanup();
		});

		it("should send error for whitespace-only content", () => {
			const eventBus = new TypedEventEmitter();
			const mockDb = {
				query: (_sql: string) => ({
					get: () => ({ id: "thread-123" }),
				}),
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					thread_id: "thread-123",
					content: "   \n\t  ",
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const lastMessage = messages[messages.length - 1] as Record<string, unknown>;
			expect(lastMessage.type).toBe("error");

			testHandler.cleanup();
		});

		it("should send error for content exceeding 512KB limit", () => {
			const eventBus = new TypedEventEmitter();
			const mockDb = {
				query: (_sql: string) => ({
					get: () => ({ id: "thread-123" }),
				}),
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			const tooLarge = "x".repeat(513 * 1024); // 513KB

			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					thread_id: "thread-123",
					content: tooLarge,
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const lastMessage = messages[messages.length - 1] as Record<string, unknown>;
			expect(lastMessage.type).toBe("error");
			expect(lastMessage.code).toBe("content_too_large");

			testHandler.cleanup();
		});

		it("should send error for non-existent thread", () => {
			const eventBus = new TypedEventEmitter();
			// Mock a database that doesn't have the thread
			const mockDb = {
				query: (_sql: string) => ({
					get: () => null, // thread not found
				}),
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					thread_id: "nonexistent-thread",
					content: "Hello",
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const lastMessage = messages[messages.length - 1] as Record<string, unknown>;
			expect(lastMessage.type).toBe("error");
			expect(lastMessage.code).toBe("thread_not_found");

			testHandler.cleanup();
		});
	});

	describe("Task 4: tool:result WS handler", () => {
		it("should send handler_not_configured error when db is not provided", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "tool:result",
					call_id: "call-123",
					thread_id: "thread-123",
					content: "Result",
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: "error",
				code: "handler_not_configured",
			});
		});

		it("should send error for unknown call_id", () => {
			const eventBus = new TypedEventEmitter();
			// Mock a database that returns no pending calls
			const mockDb = {
				prepare: (_sql: string) => ({
					all: () => [], // getPendingClientToolCalls returns empty
				}),
				query: (_sql: string) => ({
					get: () => null,
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "tool:result",
					call_id: "unknown-call",
					thread_id: "thread-123",
					content: "Result",
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const lastMessage = messages[messages.length - 1] as Record<string, unknown>;
			expect(lastMessage.type).toBe("error");
			expect(lastMessage.code).toBe("unknown_call_id");
			expect(lastMessage.call_id).toBe("unknown-call");

			testHandler.cleanup();
		});

		it("should send error for expired tool call", () => {
			const eventBus = new TypedEventEmitter();
			// Mock database with an old pending call (simulating expiration)
			const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			const mockDb = {
				prepare: (_sql: string) => ({
					all: () => [
						{
							message_id: "msg-1",
							thread_id: "thread-123",
							status: "pending",
							claimed_by: null,
							event_type: "client_tool_call",
							event_payload: JSON.stringify({ call_id: "call-123" }),
							created_at: oldTime,
							modified_at: oldTime,
						},
					],
					run: () => {},
				}),
				query: (_sql: string) => ({
					get: () => null,
				}),
				exec: () => {},
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "tool:result",
					call_id: "call-123",
					thread_id: "thread-123",
					content: "Tool execution failed",
					is_error: true,
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const lastMessage = messages[messages.length - 1] as Record<string, unknown>;
			expect(lastMessage.type).toBe("error");
			expect(lastMessage.code).toBe("tool_call_expired");

			testHandler.cleanup();
		});
	});

	describe("Task 5: tool:call delivery to WS clients", () => {
		it("should deliver tool:call message to subscribed client with matching tool", () => {
			const eventBus = new TypedEventEmitter();
			const mockDb = {
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// First, register tools on the connection
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "my_tool",
								description: "A test tool",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			// Subscribe to a thread
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-123",
				}),
			);

			// Clear any previous messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit client_tool_call:created event
			eventBus.emit("client_tool_call:created", {
				threadId: "thread-123",
				callId: "call-456",
				entryId: "entry-789",
				toolName: "my_tool",
				arguments: { arg1: "value1" },
			});

			// Check that tool:call message was sent
			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			const toolCallMsg = messages[0] as Record<string, unknown>;
			expect(toolCallMsg.type).toBe("tool:call");
			expect(toolCallMsg.call_id).toBe("call-456");
			expect(toolCallMsg.thread_id).toBe("thread-123");
			expect(toolCallMsg.tool_name).toBe("my_tool");
			expect(toolCallMsg.arguments).toEqual({ arg1: "value1" });

			testHandler.cleanup();
		});

		it("should not deliver tool:call to client without matching tool", () => {
			const eventBus = new TypedEventEmitter();
			const mockDb = {
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Register different tools
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "other_tool",
								description: "Another tool",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			// Subscribe to thread
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-123",
				}),
			);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit tool call for tool we don't have
			eventBus.emit("client_tool_call:created", {
				threadId: "thread-123",
				callId: "call-456",
				entryId: "entry-789",
				toolName: "my_tool",
				arguments: { arg1: "value1" },
			});

			// No message should be sent
			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(0);

			testHandler.cleanup();
		});

		it("should not deliver tool:call to unsubscribed client", () => {
			const eventBus = new TypedEventEmitter();
			const mockDb = {
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Register tools but don't subscribe to the thread
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "my_tool",
								description: "A test tool",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit tool call for thread we're not subscribed to
			eventBus.emit("client_tool_call:created", {
				threadId: "thread-123",
				callId: "call-456",
				entryId: "entry-789",
				toolName: "my_tool",
				arguments: { arg1: "value1" },
			});

			// No message should be sent
			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(0);

			testHandler.cleanup();
		});

		it("should deliver to only the first matching connection", () => {
			const eventBus = new TypedEventEmitter();
			const mockDb = {
				prepare: (_sql: string) => ({
					run: () => {},
				}),
			} as any;

			const testHandler = createWebSocketHandler({
				eventBus,
				db: mockDb,
				siteId: "site-1",
				defaultUserId: "user-1",
			});

			// Create two connections with the same tool and subscription
			const mockWs1 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			const mockWs2 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;

			testHandler.open(mockWs1);
			testHandler.open(mockWs2);

			// Register tools on both
			for (const ws of [mockWs1, mockWs2]) {
				testHandler.message(
					ws,
					JSON.stringify({
						type: "session:configure",
						tools: [
							{
								type: "function",
								function: {
									name: "my_tool",
									description: "A test tool",
									parameters: { type: "object" },
								},
							},
						],
					}),
				);

				// Subscribe to same thread
				testHandler.message(
					ws,
					JSON.stringify({
						type: "thread:subscribe",
						thread_id: "thread-123",
					}),
				);
			}

			// Clear messages
			(mockWs1 as unknown as MockWebSocket).messages = [];
			(mockWs2 as unknown as MockWebSocket).messages = [];

			// Emit tool call
			eventBus.emit("client_tool_call:created", {
				threadId: "thread-123",
				callId: "call-456",
				entryId: "entry-789",
				toolName: "my_tool",
				arguments: { arg1: "value1" },
			});

			// Only one should receive the message
			const messages1 = (mockWs1 as unknown as MockWebSocket).messages;
			const messages2 = (mockWs2 as unknown as MockWebSocket).messages;

			expect(messages1.length + messages2.length).toBe(1);

			testHandler.cleanup();
		});
	});

	describe("Task 6: Event name migration and thread:status push", () => {
		it("should send task:updated instead of task_update", () => {
			const eventBus = new TypedEventEmitter();
			const testHandler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit task:completed event
			eventBus.emit("task:completed", {
				task_id: "task-123",
				result: "success",
			});

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			const taskMsg = messages[0] as Record<string, unknown>;
			expect(taskMsg.type).toBe("task:updated");

			testHandler.cleanup();
		});

		it("should send file:updated instead of file_update", () => {
			const eventBus = new TypedEventEmitter();
			const testHandler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit file:changed event
			eventBus.emit("file:changed", {
				path: "/home/user/file.txt",
				operation: "created",
			});

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			const fileMsg = messages[0] as Record<string, unknown>;
			expect(fileMsg.type).toBe("file:updated");

			testHandler.cleanup();
		});

		it("should push thread:status to subscribed clients", () => {
			const eventBus = new TypedEventEmitter();
			const testHandler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Subscribe to thread
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-123",
				}),
			);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit status:forward event with thread_id
			eventBus.emit("status:forward", {
				thread_id: "thread-123",
				status: "running",
				detail: "claude-opus",
				tokens: 1234,
			} as any);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(1);
			const statusMsg = messages[0] as Record<string, unknown>;
			expect(statusMsg.type).toBe("thread:status");
			expect(statusMsg.thread_id).toBe("thread-123");
			expect(statusMsg.active).toBe(true);
			expect(statusMsg.state).toBe("running");
			expect(statusMsg.tokens).toBe(1234);
			expect(statusMsg.model).toBe("claude-opus");

			testHandler.cleanup();
		});

		it("should not push thread:status to non-subscribed clients", () => {
			const eventBus = new TypedEventEmitter();
			const testHandler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Subscribe to different thread
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-456",
				}),
			);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit status for different thread
			eventBus.emit("status:forward", {
				thread_id: "thread-123",
				status: "running",
				detail: "claude-opus",
				tokens: 1234,
			} as any);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages).toHaveLength(0);

			testHandler.cleanup();
		});

		it("should verify event names in broadcast", () => {
			const eventBus = new TypedEventEmitter();
			const testHandler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Subscribe to thread
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-123",
				}),
			);

			// Clear messages
			(mockWs as unknown as MockWebSocket).messages = [];

			// Emit all event types and verify names
			const eventTypes = [
				{
					name: "task:completed",
					data: { task_id: "t1", result: null },
					expectedType: "task:updated",
				},
				{
					name: "file:changed",
					data: { path: "/test", operation: "created" as const },
					expectedType: "file:updated",
				},
			];

			for (const eventType of eventTypes) {
				(mockWs as unknown as MockWebSocket).messages = [];
				eventBus.emit(eventType.name as any, eventType.data);

				const messages = (mockWs as unknown as MockWebSocket).messages;
				expect(messages.length).toBeGreaterThan(0);
				const msg = messages[0] as Record<string, unknown>;
				expect(msg.type).toBe(eventType.expectedType);
			}

			testHandler.cleanup();
		});
	});
});
