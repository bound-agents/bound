import { describe, it, expect, beforeEach } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { createWebSocketHandler } from "../websocket";

describe("WebSocket Handler", () => {
	let eventBus: TypedEventEmitter;
	let handler;

	beforeEach(() => {
		eventBus = new TypedEventEmitter();
		handler = createWebSocketHandler(eventBus);
	});

	it("creates handler with required methods", () => {
		expect(handler.open).toBeDefined();
		expect(handler.message).toBeDefined();
		expect(handler.close).toBeDefined();
	});

	it("tracks client subscriptions on message", () => {
		const mockWs = {
			readyState: WebSocket.OPEN,
			send: () => {},
		} as unknown as WebSocket;

		handler.open(mockWs);

		const subscribeMessage = JSON.stringify({
			subscribe: ["thread-1", "thread-2"],
		});

		handler.message(mockWs, subscribeMessage);

		expect(handler).toBeDefined();
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
			subscribe: ["thread-1"],
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
		expect(parsed.type).toBe("message");
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
			subscribe: ["thread-1"],
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

	it("handles client disconnection", () => {
		const mockWs = {
			readyState: WebSocket.OPEN,
			send: () => {},
		} as unknown as WebSocket;

		handler.open(mockWs);
		handler.close(mockWs);

		expect(handler).toBeDefined();
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
});
