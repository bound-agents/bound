/**
 * Property tests for WebSocket stream:chunk forwarding.
 *
 * Properties:
 *
 *   F1 Thread-scoped delivery — a stream:chunk event for thread T is
 *      delivered to ALL clients subscribed to T, and ZERO clients not
 *      subscribed to T.
 *
 *   F2 Closed-socket safety — clients with readyState !== 1 never
 *      receive messages regardless of subscription state.
 *
 *   F3 Payload integrity — the chunk payload that arrives at the client
 *      exactly matches what was emitted on the event bus (no mutation,
 *      no field dropping).
 *
 *   F4 Subscription lifecycle — unsubscribing from a thread stops
 *      delivery; re-subscribing resumes it.
 */

import { afterEach, beforeEach, describe, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";
import fc from "fast-check";
import { createWebSocketHandler } from "../websocket";

class MockWebSocket {
	readyState = 1;
	messages: unknown[] = [];
	send(message: string | Buffer) {
		this.messages.push(typeof message === "string" ? JSON.parse(message) : message);
	}
}

// Arbitrary for a stream chunk payload (mirrors wsStreamChunkSchema variants)
const chunkArb = fc.oneof(
	fc.record({ type: fc.constant("text"), content: fc.string() }),
	fc.record({ type: fc.constant("thinking"), content: fc.string() }),
	fc.record({
		type: fc.constant("tool_use_start"),
		id: fc.string({ minLength: 1 }),
		name: fc.string({ minLength: 1 }),
	}),
	fc.record({
		type: fc.constant("tool_use_args"),
		id: fc.string({ minLength: 1 }),
		partial_json: fc.string(),
	}),
	fc.record({ type: fc.constant("tool_use_end"), id: fc.string({ minLength: 1 }) }),
	fc.record({
		type: fc.constant("done"),
		usage: fc.record({
			input_tokens: fc.nat(),
			output_tokens: fc.nat(),
			cache_write_tokens: fc.option(fc.nat(), { nil: null }),
			cache_read_tokens: fc.option(fc.nat(), { nil: null }),
			estimated: fc.boolean(),
		}),
	}),
	fc.record({ type: fc.constant("error"), error: fc.string({ minLength: 1 }) }),
);

// Thread ID arbitrary — ASCII alphanumeric + dashes (like a UUID segment)
const threadIdArb = fc.stringMatching(/^[a-z0-9-]{4,36}$/);

describe("WebSocket stream:chunk forwarding — property tests", () => {
	let eventBus: TypedEventEmitter;
	let handler: ReturnType<typeof createWebSocketHandler>;

	beforeEach(() => {
		eventBus = new TypedEventEmitter();
		handler = createWebSocketHandler(eventBus);
	});

	afterEach(() => {
		handler.cleanup();
	});

	it("F1: thread-scoped delivery — only subscribed clients receive the chunk", () => {
		fc.assert(
			fc.property(threadIdArb, threadIdArb, chunkArb, (targetThread, otherThread) => {
				// Skip degenerate case where both are the same thread
				if (targetThread === otherThread) return true;

				const subscribedWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				const unsubscribedWs = new MockWebSocket() as unknown as ServerWebSocket<unknown>;

				handler.open(subscribedWs);
				handler.open(unsubscribedWs);

				handler.message(
					subscribedWs,
					JSON.stringify({ type: "thread:subscribe", thread_id: targetThread }),
				);
				handler.message(
					unsubscribedWs,
					JSON.stringify({ type: "thread:subscribe", thread_id: otherThread }),
				);

				eventBus.emit("stream:chunk", {
					thread_id: targetThread,
					chunk: { type: "text", content: "test" },
				});

				const subscribedMsgs = (subscribedWs as unknown as MockWebSocket).messages;
				const unsubscribedMsgs = (unsubscribedWs as unknown as MockWebSocket).messages;

				// Cleanup before assertions
				handler.close(subscribedWs);
				handler.close(unsubscribedWs);

				return subscribedMsgs.length === 1 && unsubscribedMsgs.length === 0;
			}),
			{ numRuns: 100 },
		);
	});

	it("F2: closed-socket safety — no delivery to readyState !== 1", () => {
		fc.assert(
			fc.property(threadIdArb, chunkArb, fc.constantFrom(0, 2, 3), (thread, chunk, readyState) => {
				const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				handler.open(ws);
				handler.message(ws, JSON.stringify({ type: "thread:subscribe", thread_id: thread }));

				// Close the socket
				(ws as unknown as MockWebSocket).readyState = readyState;

				eventBus.emit("stream:chunk", { thread_id: thread, chunk });

				const result = (ws as unknown as MockWebSocket).messages.length === 0;
				handler.close(ws);
				return result;
			}),
			{ numRuns: 50 },
		);
	});

	it("F3: payload integrity — chunk arrives unmodified at the client", () => {
		fc.assert(
			fc.property(threadIdArb, chunkArb, (thread, chunk) => {
				const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				handler.open(ws);
				handler.message(ws, JSON.stringify({ type: "thread:subscribe", thread_id: thread }));

				eventBus.emit("stream:chunk", { thread_id: thread, chunk });

				const msgs = (ws as unknown as MockWebSocket).messages;
				if (msgs.length !== 1) {
					handler.close(ws);
					return false;
				}

				const received = msgs[0] as Record<string, unknown>;
				const chunkMatch = JSON.stringify(received.chunk) === JSON.stringify(chunk);
				const threadMatch = received.thread_id === thread;
				const typeMatch = received.type === "stream:chunk";

				handler.close(ws);
				return chunkMatch && threadMatch && typeMatch;
			}),
			{ numRuns: 200 },
		);
	});

	it("F4: subscription lifecycle — unsubscribe stops delivery, re-subscribe resumes", () => {
		fc.assert(
			fc.property(threadIdArb, (thread) => {
				const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
				handler.open(ws);

				// Subscribe and receive
				handler.message(ws, JSON.stringify({ type: "thread:subscribe", thread_id: thread }));
				eventBus.emit("stream:chunk", { thread_id: thread, chunk: { type: "text", content: "a" } });
				const afterSub = (ws as unknown as MockWebSocket).messages.length;

				// Unsubscribe and should NOT receive
				handler.message(ws, JSON.stringify({ type: "thread:unsubscribe", thread_id: thread }));
				eventBus.emit("stream:chunk", { thread_id: thread, chunk: { type: "text", content: "b" } });
				const afterUnsub = (ws as unknown as MockWebSocket).messages.length;

				// Re-subscribe and should receive again
				handler.message(ws, JSON.stringify({ type: "thread:subscribe", thread_id: thread }));
				eventBus.emit("stream:chunk", { thread_id: thread, chunk: { type: "text", content: "c" } });
				const afterResub = (ws as unknown as MockWebSocket).messages.length;

				handler.close(ws);
				return afterSub === 1 && afterUnsub === 1 && afterResub === 2;
			}),
			{ numRuns: 50 },
		);
	});
});
