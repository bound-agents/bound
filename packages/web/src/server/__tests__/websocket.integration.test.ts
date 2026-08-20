import { beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { type WebSocketConfig, createWebSocketHandler } from "../websocket";

type SentMessage = Record<string, unknown>;

async function waitForWebSocketMessage(
	messages: SentMessage[],
	predicate: (message: SentMessage) => boolean,
	description: string,
	timeoutMs = 1_000,
): Promise<SentMessage> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const message = messages.find(predicate);
		if (message) return message;
		await Bun.sleep(1);
	}
	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for ${description}; received: ${JSON.stringify(messages)}`,
	);
}

async function waitForNoWebSocketMessages(
	messages: SentMessage[],
	description: string,
	quietMs = 20,
): Promise<void> {
	await Bun.sleep(quietMs);
	if (messages.length > 0) {
		throw new Error(`Expected no ${description}; received: ${JSON.stringify(messages)}`);
	}
}

describe("WebSocket Handler", () => {
	let eventBus: TypedEventEmitter;
	let handler: WebSocketConfig;

	beforeEach(() => {
		eventBus = new TypedEventEmitter();
		handler = createWebSocketHandler(eventBus);
	});

	it("creates handler with required methods", () => {
		expect(typeof handler.open).toBe("function");
		expect(typeof handler.message).toBe("function");
		expect(typeof handler.close).toBe("function");
	});

	it("tracks client subscriptions on message", () => {
		const mockWs = {
			readyState: WebSocket.OPEN,
			send: () => {},
		} as unknown as WebSocket;

		handler.open(mockWs);

		const subscribeMessage1 = JSON.stringify({
			type: "thread:subscribe",
			thread_id: "thread-1",
		});

		const subscribeMessage2 = JSON.stringify({
			type: "thread:subscribe",
			thread_id: "thread-2",
		});

		expect(() => {
			handler.message(mockWs, subscribeMessage1);
			handler.message(mockWs, subscribeMessage2);
		}).not.toThrow();
	});

	it("broadcasts message:created events to subscribed clients", async () => {
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);

		const subscribeMessage = JSON.stringify({
			type: "thread:subscribe",
			thread_id: "thread-1",
		});
		handler.message(mockWs, subscribeMessage);

		eventBus.emit("message:created", {
			message: {
				id: "msg-1",
				content: "Hello",
				role: "user",
			},
			thread_id: "thread-1",
		});

		const parsed = await waitForWebSocketMessage(
			messages,
			(message) => message.type === "message:created",
			"message:created",
		);
		expect(parsed.type).toBe("message:created");
		expect(parsed.data.role).toBe("user");
	});

	it("does not broadcast to clients not subscribed to thread", async () => {
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);

		const subscribeMessage = JSON.stringify({
			type: "thread:subscribe",
			thread_id: "thread-1",
		});
		handler.message(mockWs, subscribeMessage);

		eventBus.emit("message:created", {
			message: {
				id: "msg-1",
				content: "Hello",
				role: "user",
			},
			thread_id: "thread-2",
		});

		await waitForNoWebSocketMessages(messages, "messages for an unsubscribed thread");
	});

	it("broadcasts message:broadcast events to subscribed clients", async () => {
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);
		handler.message(
			mockWs,
			JSON.stringify({
				type: "thread:subscribe",
				thread_id: "thread-1",
			}),
		);

		eventBus.emit("message:broadcast", {
			message: {
				id: "msg-1",
				content: "Here is my answer",
				role: "assistant",
			} as any,
			thread_id: "thread-1",
		});

		const parsed = await waitForWebSocketMessage(
			messages,
			(message) => message.type === "message:created",
			"message:created",
		);
		expect(parsed.type).toBe("message:created");
		expect(parsed.data.role).toBe("assistant");
	});

	it("does NOT push message:broadcast to non-subscribed clients", async () => {
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);
		handler.message(
			mockWs,
			JSON.stringify({
				type: "thread:subscribe",
				thread_id: "thread-1",
			}),
		);

		eventBus.emit("message:broadcast", {
			message: { id: "msg-2", content: "Other", role: "assistant" } as any,
			thread_id: "thread-2", // not subscribed
		});

		await waitForNoWebSocketMessages(messages, "messages for an unsubscribed thread");
	});

	it("handles client disconnection", () => {
		const mockWs = {
			readyState: WebSocket.OPEN,
			send: () => {},
		} as unknown as WebSocket;

		handler.open(mockWs);
		expect(() => {
			handler.close(mockWs);
		}).not.toThrow();
	});

	it("ignores invalid message format", () => {
		const mockWs = {
			readyState: WebSocket.OPEN,
			send: () => {},
		} as unknown as WebSocket;

		handler.open(mockWs);

		expect(() => {
			handler.message(mockWs, "invalid json");
		}).not.toThrow();
	});

	it("broadcasts context:debug events to subscribed clients", async () => {
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);

		const subscribeMessage = JSON.stringify({
			type: "thread:subscribe",
			thread_id: "thread-1",
		});
		handler.message(mockWs, subscribeMessage);

		const debugInfo = {
			contextWindow: 200000,
			totalEstimated: 15000,
			model: "claude-3-5-sonnet",
			sections: [
				{ name: "system", tokens: 500 },
				{ name: "history", tokens: 14000 },
			],
			budgetPressure: false,
			truncated: 0,
		};

		eventBus.emit("context:debug", {
			thread_id: "thread-1",
			turn_id: 42,
			debug: debugInfo,
		});

		const parsed = await waitForWebSocketMessage(
			messages,
			(message) => message.type === "context:debug",
			"context:debug",
		);
		expect(parsed.type).toBe("context:debug");
		expect(parsed.data.turn_id).toBe(42);
		expect(parsed.data.debug).toEqual(debugInfo);
	});

	it("includes thread_id in context:debug payload so clients can filter by thread", async () => {
		// Regression test: the payload previously omitted thread_id, causing the
		// client-side filter (debugData.thread_id === threadId) to always fail and
		// the context debugger to never update reactively.
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);
		handler.message(mockWs, JSON.stringify({ type: "thread:subscribe", thread_id: "thread-1" }));

		eventBus.emit("context:debug", {
			thread_id: "thread-1",
			turn_id: "turn-abc",
			debug: {
				contextWindow: 100000,
				totalEstimated: 5000,
				sections: [],
				budgetPressure: false,
				truncated: 0,
			},
		});

		const parsed = await waitForWebSocketMessage(
			messages,
			(message) => message.type === "context:debug",
			"context:debug",
		);
		expect(parsed.data.thread_id).toBe("thread-1");
	});

	it("does not broadcast context:debug to clients not subscribed to thread", async () => {
		const messages: SentMessage[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(JSON.parse(data));
			},
		} as unknown as WebSocket;

		handler.open(mockWs);

		const subscribeMessage = JSON.stringify({
			type: "thread:subscribe",
			thread_id: "thread-1",
		});
		handler.message(mockWs, subscribeMessage);

		const debugInfo = {
			contextWindow: 200000,
			totalEstimated: 15000,
			model: "claude-3-5-sonnet",
			sections: [{ name: "system", tokens: 500 }],
			budgetPressure: false,
			truncated: 0,
		};

		eventBus.emit("context:debug", {
			thread_id: "thread-2",
			turn_id: 42,
			debug: debugInfo,
		});

		await waitForNoWebSocketMessages(messages, "messages for an unsubscribed thread");
	});
});
