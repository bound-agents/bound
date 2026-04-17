import { beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { type WebSocketConfig, createWebSocketHandler } from "../websocket";

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
		const messages: string[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(data);
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

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.length).toBe(1);
		const parsed = JSON.parse(messages[0]);
		expect(parsed.type).toBe("message:created");
		expect(parsed.data.role).toBe("user");
	});

	it("does not broadcast to clients not subscribed to thread", async () => {
		const messages: string[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(data);
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

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.length).toBe(0);
	});

	it("broadcasts message:broadcast events to subscribed clients", async () => {
		const messages: string[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(data);
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

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.length).toBe(1);
		const parsed = JSON.parse(messages[0]);
		expect(parsed.type).toBe("message:created");
		expect(parsed.data.role).toBe("assistant");
	});

	it("does NOT push message:broadcast to non-subscribed clients", async () => {
		const messages: string[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(data);
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

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.length).toBe(0);
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
		const messages: string[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(data);
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

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.length).toBe(1);
		const parsed = JSON.parse(messages[0]);
		expect(parsed.type).toBe("context:debug");
		expect(parsed.data.turn_id).toBe(42);
		expect(parsed.data.debug).toEqual(debugInfo);
	});

	it("does not broadcast context:debug to clients not subscribed to thread", async () => {
		const messages: string[] = [];
		const mockWs = {
			readyState: WebSocket.OPEN,
			send(data: string): void {
				messages.push(data);
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

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(messages.length).toBe(0);
	});
});
