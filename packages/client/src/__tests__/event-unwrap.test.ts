import { describe, expect, it } from "bun:test";
import { BoundClient } from "../client";

/**
 * Test that the BoundClient correctly unwraps WS events before emitting
 * to registered listeners.
 *
 * The server sends events in two formats:
 *   - Nested: { type: "message:created", data: { id, role, content, ... } }
 *   - Flat:   { type: "thread:status", thread_id: ..., active: ..., ... }
 *
 * The client must unwrap nested events so that listeners receive the
 * inner `data` payload, not the entire WS frame.
 */
describe("BoundClient event unwrapping", () => {
	it("message:created listener receives the Message, not the WS frame", () => {
		const client = new BoundClient("http://localhost:3001");
		let received: unknown = null;

		client.on("message:created", (msg) => {
			received = msg;
		});

		const wsFrame = {
			type: "message:created",
			data: {
				id: "msg-123",
				role: "user",
				content: "hello world",
				thread_id: "t-1",
				created_at: "2026-04-19T00:00:00Z",
			},
		};

		client.handleWsMessage(JSON.stringify(wsFrame));

		expect(received).not.toBeNull();
		expect((received as Record<string, unknown>).role).toBe("user");
		expect((received as Record<string, unknown>).content).toBe("hello world");
		expect((received as Record<string, unknown>).id).toBe("msg-123");
		// Must NOT have the `type` field from the WS frame
		expect((received as Record<string, unknown>).type).toBeUndefined();
	});

	it("thread:status listener receives flat data (already correct)", () => {
		const client = new BoundClient("http://localhost:3001");
		let received: unknown = null;

		client.on("thread:status", (msg) => {
			received = msg;
		});

		// thread:status is flat — fields at top level, no `data` wrapper
		const wsFrame = {
			type: "thread:status",
			thread_id: "t-1",
			active: true,
			state: "LLM_CALL",
			tokens: 500,
			model: "opus",
		};

		client.handleWsMessage(JSON.stringify(wsFrame));

		expect(received).not.toBeNull();
		expect((received as Record<string, unknown>).thread_id).toBe("t-1");
		expect((received as Record<string, unknown>).active).toBe(true);
	});

	it("task:updated listener receives the inner data object", () => {
		const client = new BoundClient("http://localhost:3001");
		let received: unknown = null;

		client.on("task:updated", (msg) => {
			received = msg;
		});

		const wsFrame = {
			type: "task:updated",
			data: {
				taskId: "task-1",
				status: "completed",
			},
		};

		client.handleWsMessage(JSON.stringify(wsFrame));

		expect(received).not.toBeNull();
		expect((received as Record<string, unknown>).taskId).toBe("task-1");
		expect((received as Record<string, unknown>).status).toBe("completed");
	});

	it("file:updated listener receives the inner data object", () => {
		const client = new BoundClient("http://localhost:3001");
		let received: unknown = null;

		client.on("file:updated", (msg) => {
			received = msg;
		});

		const wsFrame = {
			type: "file:updated",
			data: {
				path: "/src/main.ts",
				operation: "modified",
			},
		};

		client.handleWsMessage(JSON.stringify(wsFrame));

		expect(received).not.toBeNull();
		expect((received as Record<string, unknown>).path).toBe("/src/main.ts");
	});
});
