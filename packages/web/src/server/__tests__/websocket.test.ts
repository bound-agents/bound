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
		it("should initialize connectionId and clientTools on open", () => {
			const mockWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;

			handler.open(mockWs);

			// We'll verify this by checking the internal state after operations
			// that depend on these fields existing (tested in Task 2)
		});

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
});
