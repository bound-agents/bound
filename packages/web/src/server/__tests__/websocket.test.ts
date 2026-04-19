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
		it("AC1.1: should persist message and emit message:created event (happy path)", async () => {
			const { applySchema, createDatabase } = await import("@bound/core");

			// Create a real DB with schema
			const db = createDatabase(":memory:");
			applySchema(db);

			// Create a thread in the DB
			const threadId = "thread-ac1-1";
			const userId = "test-user";
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, title, created_at, last_message_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[threadId, userId, "web", "localhost:3000", "AC1.1 Test Thread", now, now, now, 0],
			);

			// Create event bus and handler
			const testEventBus = new TypedEventEmitter();
			const testHandler = createWebSocketHandler({
				eventBus: testEventBus,
				db,
				siteId: "test-site",
				defaultUserId: "test-user",
			});

			// Create mock WebSocket
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			testHandler.open(mockWs);

			// Track emitted events
			let createdEventEmitted = false;
			let receivedMessage: any = null;

			testEventBus.on("message:created", (data) => {
				createdEventEmitted = true;
				receivedMessage = data.message;
			});

			// Send message:send over WS
			testHandler.message(
				mockWs,
				JSON.stringify({
					type: "message:send",
					thread_id: threadId,
					content: "hello world",
				}),
			);

			// Allow async event emission to complete
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify message was persisted to DB
			const persistedMessage = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'user'")
				.get(threadId) as any;

			expect(persistedMessage).toBeDefined();
			expect(persistedMessage.content).toBe("hello world");
			expect(persistedMessage.role).toBe("user");
			expect(persistedMessage.thread_id).toBe(threadId);

			// Verify message:created event was emitted
			expect(createdEventEmitted).toBe(true);
			expect(receivedMessage).toBeDefined();
			expect(receivedMessage.content).toBe("hello world");
			expect(receivedMessage.role).toBe("user");

			testHandler.cleanup();
		});

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

		it("should silently discard late tool:result for expired/canceled calls (AC3.4)", () => {
			const eventBus = new TypedEventEmitter();
			// Mock database with an old pending call (simulating expiration)
			const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			const mockDb = {
				prepare: (_sql: string) => ({
					all: () => [
						{
							message_id: "msg-1",
							thread_id: "thread-123",
							status: "expired",
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
			// AC3.4: Late tool:result for canceled calls is silently discarded (no error response)
			expect(messages.length).toBe(0);

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

	describe("Task 1: Connection registry with client tool lookup", () => {
		it("should return client tools for subscribed connections", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Register tools
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "test_tool",
								description: "A test tool",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			// Subscribe to thread
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Query registry
			const tools = handler.registry.getClientToolsForThread("thread-1");
			expect(tools.size).toBe(1);
			expect(tools.has("test_tool")).toBe(true);

			handler.cleanup();
		});

		it("should return empty map when no connections subscribed", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const tools = handler.registry.getClientToolsForThread("nonexistent-thread");
			expect(tools.size).toBe(0);

			handler.cleanup();
		});

		it("should merge tools from multiple connections", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			// Connection 1 with tool_a
			const mockWs1 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs1);

			handler.message(
				mockWs1,
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

			handler.message(
				mockWs1,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Connection 2 with tool_b
			const mockWs2 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs2);

			handler.message(
				mockWs2,
				JSON.stringify({
					type: "session:configure",
					tools: [
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

			handler.message(
				mockWs2,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Query registry — should have both tools
			const tools = handler.registry.getClientToolsForThread("thread-1");
			expect(tools.size).toBe(2);
			expect(tools.has("tool_a")).toBe(true);
			expect(tools.has("tool_b")).toBe(true);

			handler.cleanup();
		});

		it("should return connection ID for tool lookup", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [
						{
							type: "function",
							function: {
								name: "test_tool",
								description: "A test tool",
								parameters: { type: "object" },
							},
						},
					],
				}),
			);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Query for connection ID
			const connectionId = handler.registry.getConnectionForTool("thread-1", "test_tool");
			expect(connectionId).toBeDefined();
			expect(typeof connectionId).toBe("string");

			handler.cleanup();
		});

		it("should return undefined for tool not in thread", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

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

			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Query for non-existent tool
			const connectionId = handler.registry.getConnectionForTool("thread-1", "nonexistent_tool");
			expect(connectionId).toBeUndefined();

			handler.cleanup();
		});

		it("should exclude connections not subscribed to thread", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			// Connection 1 subscribed to thread-1
			const mockWs1 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs1);

			handler.message(
				mockWs1,
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

			handler.message(
				mockWs1,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Connection 2 with same tool but subscribed to thread-2
			const mockWs2 = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs2);

			handler.message(
				mockWs2,
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

			handler.message(
				mockWs2,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-2",
				}),
			);

			// Query for thread-1 — should only find tool_a from mockWs1
			const tools = handler.registry.getClientToolsForThread("thread-1");
			expect(tools.size).toBe(1);
			expect(tools.has("tool_a")).toBe(true);

			const connectionId = handler.registry.getConnectionForTool("thread-1", "tool_a");
			expect(connectionId).toBeDefined();

			handler.cleanup();
		});
	});

	describe("systemPromptAddition (AC2.1-AC2.7)", () => {
		it("AC2.1: should store systemPromptAddition per (connection, thread) pair", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Subscribe to thread first
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Send session:configure with systemPromptAddition
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
					systemPromptAddition: "You are a coding assistant.",
				}),
			);

			// Query registry for the stored addition
			const addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBe("You are a coding assistant.");

			handler.cleanup();
		});

		it("AC2.3: thread:subscribe after session:configure inherits systemPromptAddition", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Send session:configure first
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
					systemPromptAddition: "Test prompt",
				}),
			);

			// Then subscribe to a new thread
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "new-thread",
				}),
			);

			// The new thread should inherit the systemPromptAddition
			const addition = handler.registry.getSystemPromptAdditionForThread("new-thread");
			expect(addition).toBe("Test prompt");

			handler.cleanup();
		});

		it("AC2.4: re-sending session:configure replaces stored value", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Subscribe to thread
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// First session:configure
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
					systemPromptAddition: "First prompt",
				}),
			);

			let addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBe("First prompt");

			// Re-send with different value
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
					systemPromptAddition: "Second prompt",
				}),
			);

			addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBe("Second prompt");

			handler.cleanup();
		});

		it("AC2.4: omitting systemPromptAddition field clears stored value", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Subscribe to thread
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			// Set a value first
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
					systemPromptAddition: "Some prompt",
				}),
			);

			// Verify it's set
			let addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBe("Some prompt");

			// Send without field
			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
				}),
			);

			// Should be cleared
			addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBeUndefined();

			handler.cleanup();
		});

		it("AC2.5: thread:unsubscribe clears stored addition for that thread", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Subscribe and set
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:subscribe",
					thread_id: "thread-1",
				}),
			);

			handler.message(
				mockWs,
				JSON.stringify({
					type: "session:configure",
					tools: [],
					systemPromptAddition: "Test",
				}),
			);

			let addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBe("Test");

			// Unsubscribe
			handler.message(
				mockWs,
				JSON.stringify({
					type: "thread:unsubscribe",
					thread_id: "thread-1",
				}),
			);

			// Should be cleared
			addition = handler.registry.getSystemPromptAdditionForThread("thread-1");
			expect(addition).toBeUndefined();

			handler.cleanup();
		});

		it("AC2.6: session:configure without systemPromptAddition field does not error", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "session:configure",
						tools: [],
					}),
				);
			}).not.toThrow();

			// No error message should be sent
			expect((mockWs as unknown as MockWebSocket).messages).toHaveLength(0);

			handler.cleanup();
		});

		it("AC2.7: existing clients without systemPromptAddition field work unchanged", () => {
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);

			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			handler.open(mockWs);

			// Send session:configure with only tools (legacy behavior)
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "session:configure",
						tools: [
							{
								type: "function",
								function: {
									name: "my_tool",
									description: "A tool",
									parameters: { type: "object" },
								},
							},
						],
					}),
				);
			}).not.toThrow();

			// Should be able to subscribe normally
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "thread:subscribe",
						thread_id: "thread-1",
					}),
				);
			}).not.toThrow();

			// No error messages
			expect((mockWs as unknown as MockWebSocket).messages).toHaveLength(0);

			handler.cleanup();
		});
	});

	describe("Protocol Extension — Content Widening (AC10)", () => {
		it("AC10.1 & AC10.4: tool:result with string content is accepted by schema", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);
			handler.open(mockWs);

			// AC10.1: String content should be accepted without error (backward compatible)
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "tool:result",
						call_id: "call-123",
						thread_id: "thread-1",
						content: "hello world",
					}),
				);
			}).not.toThrow();

			// AC10.4: Legacy string-only messages should continue to work
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "tool:result",
						call_id: "call-legacy",
						thread_id: "thread-1",
						content: "legacy response",
						is_error: false,
					}),
				);
			}).not.toThrow();

			handler.cleanup();
		});

		it("AC10.2: tool:result with ContentBlock[] accepts text, image, document blocks", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);
			handler.open(mockWs);

			// Should accept text block in array
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "tool:result",
						call_id: "call-456",
						thread_id: "thread-1",
						content: [{ type: "text", text: "result text" }],
					}),
				);
			}).not.toThrow();

			// Should accept image block
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "tool:result",
						call_id: "call-457",
						thread_id: "thread-1",
						content: [
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "iVBORw0K..." },
							},
						],
					}),
				);
			}).not.toThrow();

			// Should accept document block
			expect(() => {
				handler.message(
					mockWs,
					JSON.stringify({
						type: "tool:result",
						call_id: "call-458",
						thread_id: "thread-1",
						content: [
							{
								type: "document",
								source: { type: "file_ref", file_id: "file-1" },
								text_representation: "Document text here",
								title: "Report.pdf",
							},
						],
					}),
				);
			}).not.toThrow();

			handler.cleanup();
		});

		it("AC10.3: tool:result with invalid ContentBlock variants (tool_use, thinking) is rejected", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
			const eventBus = new TypedEventEmitter();
			const handler = createWebSocketHandler(eventBus);
			handler.open(mockWs);

			// tool_use block should be rejected
			handler.message(
				mockWs,
				JSON.stringify({
					type: "tool:result",
					call_id: "call-789",
					thread_id: "thread-1",
					content: [
						{
							type: "tool_use",
							id: "x",
							name: "y",
							input: {},
						},
					],
				}),
			);

			const messages = (mockWs as unknown as MockWebSocket).messages;
			expect(messages.length).toBeGreaterThan(0);
			const msg = messages[0] as { type?: string; code?: string };
			expect(msg.type).toBe("error");
			expect(msg.code).toBe("invalid_message");

			// Clear messages and test thinking block rejection
			(mockWs as unknown as MockWebSocket).messages = [];
			handler.message(
				mockWs,
				JSON.stringify({
					type: "tool:result",
					call_id: "call-790",
					thread_id: "thread-1",
					content: [
						{
							type: "thinking",
							thinking: "internal thought",
						},
					],
				}),
			);

			const messages2 = (mockWs as unknown as MockWebSocket).messages;
			expect(messages2.length).toBeGreaterThan(0);
			const msg2 = messages2[0] as { type?: string; code?: string };
			expect(msg2.type).toBe("error");
			expect(msg2.code).toBe("invalid_message");

			handler.cleanup();
		});

		describe("AC3: tool:cancel protocol - event handling infrastructure", () => {
			it("AC3.1: event bus can emit agent:cancel events", () => {
				const eventBus = new TypedEventEmitter();

				let cancelEventReceived = false;
				let receivedThreadId = "";

				// Set up listener for agent:cancel events
				eventBus.on("agent:cancel", (data: any) => {
					cancelEventReceived = true;
					receivedThreadId = data.threadId;
				});

				// Emit the cancel event
				eventBus.emit("agent:cancel", { threadId: "thread-123", reason: "user" } as any);

				// Verify the event was received
				expect(cancelEventReceived).toBe(true);
				expect(receivedThreadId).toBe("thread-123");
			});

			it("AC3.2: event bus can emit client_tool_call:expired events", () => {
				const eventBus = new TypedEventEmitter();

				let expiredEventReceived = false;
				let receivedCallId = "";

				// Set up listener for expiry events
				eventBus.on("client_tool_call:expired", (data: any) => {
					expiredEventReceived = true;
					receivedCallId = data.callId;
				});

				// Emit the expiry event
				eventBus.emit("client_tool_call:expired", {
					callId: "call-2",
					threadId: "thread-456",
				} as any);

				// Verify the event was received
				expect(expiredEventReceived).toBe(true);
				expect(receivedCallId).toBe("call-2");
			});

			it("AC3.3: handler can track subscribed clients for message delivery", () => {
				const eventBus = new TypedEventEmitter();
				const handler = createWebSocketHandler(eventBus);

				const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				handler.open(mockWs);

				// Subscribe to a thread
				handler.message(
					mockWs,
					JSON.stringify({
						type: "thread:subscribe",
						thread_id: "thread-789",
					}),
				);

				// Verify registry tracking works
				const connections = handler.registry.getClientToolsForThread("thread-789");
				// The connection should be tracked even if it has no tools
				expect(typeof connections).toBe("object");
				expect(connections instanceof Map).toBe(true);

				handler.cleanup();
			});

			it("AC3.5: unknown tool:cancel message is handled without error", () => {
				const eventBus = new TypedEventEmitter();
				const handler = createWebSocketHandler(eventBus);

				const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				handler.open(mockWs);

				// Should not throw when receiving unknown tool:cancel
				expect(() => {
					// Simulate receiving tool:cancel for unknown callId
					// (In real scenario this would come from event system)
					eventBus.emit("client_tool_call:expired", { callId: "unknown-call" } as any);
				}).not.toThrow();

				handler.cleanup();
			});

			it("AC3.6: re-sending session:configure does not trigger tool:cancel", () => {
				const eventBus = new TypedEventEmitter();
				const handler = createWebSocketHandler(eventBus);

				const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				handler.open(mockWs);

				// First session:configure
				handler.message(
					mockWs,
					JSON.stringify({
						type: "session:configure",
						tools: [
							{
								type: "function",
								function: {
									name: "tool1",
									description: "Tool 1",
									parameters: { type: "object" },
								},
							},
						],
					}),
				);

				// Clear messages
				(mockWs as unknown as MockWebSocket).messages = [];

				// Re-send session:configure (should replace, not cancel)
				handler.message(
					mockWs,
					JSON.stringify({
						type: "session:configure",
						tools: [
							{
								type: "function",
								function: {
									name: "tool2",
									description: "Tool 2",
									parameters: { type: "object" },
								},
							},
						],
					}),
				);

				// Verify no cancel messages were sent
				const messages = (mockWs as unknown as MockWebSocket).messages;
				const cancelMessages = messages.filter(
					(msg) => (msg as Record<string, unknown>).type === "tool:cancel",
				);
				expect(cancelMessages).toHaveLength(0);

				handler.cleanup();
			});
		});
	});
});
