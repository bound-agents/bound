import { beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "../event-emitter.js";
import type { ContextDebugInfo, Message } from "../types.js";

describe("TypedEventEmitter", () => {
	let emitter: TypedEventEmitter;

	beforeEach(() => {
		emitter = new TypedEventEmitter();
	});

	it("emits and receives typed message:created events", () => {
		let receivedData: { message: Message; thread_id: string } | undefined;

		const mockMessage: Message = {
			id: "msg-1",
			thread_id: "thread-1",
			role: "user",
			content: "Hello",
			model_id: null,
			tool_name: null,
			created_at: "2026-03-22T00:00:00Z",
			modified_at: "2026-03-22T00:00:00Z",
			host_origin: "web",
		};

		emitter.on("message:created", (data) => {
			receivedData = data;
		});

		emitter.emit("message:created", {
			message: mockMessage,
			thread_id: "thread-1",
		});

		expect(receivedData).toBeDefined();
		expect(receivedData?.message.id).toBe("msg-1");
		expect(receivedData?.thread_id).toBe("thread-1");
	});

	it("emits and receives task:triggered events", () => {
		let receivedData: { task_id: string; trigger: string } | undefined;

		emitter.on("task:triggered", (data) => {
			receivedData = data;
		});

		emitter.emit("task:triggered", {
			task_id: "task-1",
			trigger: "cron",
		});

		expect(receivedData).toBeDefined();
		expect(receivedData?.task_id).toBe("task-1");
		expect(receivedData?.trigger).toBe("cron");
	});

	it("supports multiple listeners on same event", () => {
		const results: string[] = [];

		emitter.on("task:completed", (data) => {
			results.push(`listener1: ${data.task_id}`);
		});

		emitter.on("task:completed", (data) => {
			results.push(`listener2: ${data.task_id}`);
		});

		emitter.emit("task:completed", {
			task_id: "task-1",
			result: "success",
		});

		expect(results.length).toBe(2);
		expect(results).toContain("listener1: task-1");
		expect(results).toContain("listener2: task-1");
	});

	it("supports once() for single-fire listeners", () => {
		let callCount = 0;

		emitter.once("sync:completed", () => {
			callCount++;
		});

		emitter.emit("sync:completed", {
			peer_site_id: "peer-1",
			events_received: 10,
		});

		emitter.emit("sync:completed", {
			peer_site_id: "peer-1",
			events_received: 10,
		});

		expect(callCount).toBe(1);
	});

	it("supports off() to remove listeners", () => {
		let callCount = 0;

		const listener = () => {
			callCount++;
		};

		emitter.on("file:changed", listener);
		emitter.emit("file:changed", {
			path: "/test/file.txt",
			operation: "created",
		});

		expect(callCount).toBe(1);

		emitter.off("file:changed", listener);
		emitter.emit("file:changed", {
			path: "/test/file.txt",
			operation: "modified",
		});

		expect(callCount).toBe(1);
	});

	it("returns this for method chaining", () => {
		const result = emitter
			.on("message:created", () => {})
			.on("task:triggered", () => {})
			.once("sync:completed", () => {});

		expect(result).toBe(emitter);
	});

	it("emits returns boolean indicating listeners were called", () => {
		emitter.on("file:changed", () => {});

		const resultWithListener = emitter.emit("file:changed", {
			path: "/test/file.txt",
			operation: "created",
		});

		const resultWithoutListener = emitter.emit("alert:created", {
			message: {
				id: "alert-1",
				thread_id: "thread-1",
				role: "alert",
				content: "Warning",
				model_id: null,
				tool_name: null,
				created_at: "2026-03-22T00:00:00Z",
				modified_at: "2026-03-22T00:00:00Z",
				host_origin: "web",
			},
			thread_id: "thread-1",
		});

		expect(resultWithListener).toBe(true);
		expect(resultWithoutListener).toBe(false);
	});

	it("emits and receives context:debug events", () => {
		let receivedData:
			| {
					thread_id: string;
					turn_id: number;
					debug: ContextDebugInfo;
			  }
			| undefined;

		const mockDebugInfo: ContextDebugInfo = {
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

		emitter.on("context:debug", (data) => {
			receivedData = data;
		});

		emitter.emit("context:debug", {
			thread_id: "thread-1",
			turn_id: 42,
			debug: mockDebugInfo,
		});

		expect(receivedData).toBeDefined();
		expect(receivedData?.thread_id).toBe("thread-1");
		expect(receivedData?.turn_id).toBe(42);
		expect(receivedData?.debug).toEqual(mockDebugInfo);
	});
});
