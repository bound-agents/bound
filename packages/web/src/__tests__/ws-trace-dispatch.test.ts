import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";
import { createWebSocketHandler } from "../server/websocket";

class MockWebSocket {
	readyState = 1;
	messages: unknown[] = [];

	send(message: string | Buffer) {
		this.messages.push(typeof message === "string" ? JSON.parse(message) : message);
	}
}

describe("WebSocket tool:call trace dispatch", () => {
	let eventBus: TypedEventEmitter;
	let handler: ReturnType<typeof createWebSocketHandler>;

	beforeEach(() => {
		eventBus = new TypedEventEmitter();
		handler = createWebSocketHandler(eventBus);
	});

	afterEach(() => {
		handler.cleanup();
	});

	function configureToolAndSubscribe(): MockWebSocket {
		const ws = new MockWebSocket();
		handler.open(ws as unknown as ServerWebSocket<unknown>);
		handler.message(
			ws as unknown as ServerWebSocket<unknown>,
			JSON.stringify({
				type: "session:configure",
				tools: [
					{
						type: "function",
						function: {
							name: "test_tool",
							description: "A test tool",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			}),
		);
		handler.message(
			ws as unknown as ServerWebSocket<unknown>,
			JSON.stringify({ type: "thread:subscribe", thread_id: "thread-1" }),
		);
		return ws;
	}

	it("forwards traceContext from event payload into tool:call frame", () => {
		const ws = configureToolAndSubscribe();

		const carrier = {
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		};

		eventBus.emit("client_tool_call:created", {
			threadId: "thread-1",
			callId: "call-1",
			entryId: "entry-1",
			toolName: "test_tool",
			arguments: { foo: "bar" },
			traceContext: carrier,
		});

		const toolCall = ws.messages.find(
			(m): m is { type: string; trace_context: string } =>
				typeof m === "object" && m !== null && (m as { type: string }).type === "tool:call",
		);
		expect(toolCall).toBeDefined();
		expect(toolCall?.trace_context).toBeDefined();
		expect(JSON.parse(toolCall?.trace_context as string)).toEqual(carrier);
	});

	it("omits trace_context when event payload has no traceContext", () => {
		const ws = configureToolAndSubscribe();

		eventBus.emit("client_tool_call:created", {
			threadId: "thread-1",
			callId: "call-2",
			entryId: "entry-2",
			toolName: "test_tool",
			arguments: { foo: "bar" },
		});

		const toolCall = ws.messages.find(
			(m): m is Record<string, unknown> =>
				typeof m === "object" && m !== null && (m as { type: string }).type === "tool:call",
		);
		expect(toolCall).toBeDefined();
		expect("trace_context" in (toolCall as Record<string, unknown>)).toBe(false);
	});

	it("omits trace_context when event payload sets traceContext explicitly null", () => {
		const ws = configureToolAndSubscribe();

		eventBus.emit("client_tool_call:created", {
			threadId: "thread-1",
			callId: "call-3",
			entryId: "entry-3",
			toolName: "test_tool",
			arguments: {},
			traceContext: null,
		});

		const toolCall = ws.messages.find(
			(m): m is Record<string, unknown> =>
				typeof m === "object" && m !== null && (m as { type: string }).type === "tool:call",
		);
		expect(toolCall).toBeDefined();
		expect("trace_context" in (toolCall as Record<string, unknown>)).toBe(false);
	});
});
