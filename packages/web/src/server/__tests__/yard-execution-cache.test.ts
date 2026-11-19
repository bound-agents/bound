import { describe, expect, it } from "bun:test";
import type { YardExecutionEvent } from "@bound/shared";
import { YardExecutionCache } from "../yard-execution-cache";

function event(overrides: Partial<YardExecutionEvent> = {}): YardExecutionEvent {
	return {
		thread_id: "thread-1",
		trace_id: "trace-1",
		run_id: "run-1",
		node_id: "run-1",
		parent_id: null,
		seq: 1,
		phase: "started",
		node: { kind: "run", depth: 0 },
		...overrides,
	};
}

describe("YardExecutionCache", () => {
	it("replays an active trace to a later subscriber in sequence", () => {
		const cache = new YardExecutionCache();
		cache.add(event());
		cache.add(
			event({
				node_id: "tool-1",
				parent_id: "run-1",
				seq: 2,
				node: { kind: "tool", name: "read" },
			}),
		);

		expect(cache.forThread("thread-1")).toEqual([
			expect.objectContaining({ node_id: "run-1", seq: 1 }),
			expect.objectContaining({ node_id: "tool-1", seq: 2 }),
		]);
	});

	it("evicts a trace as soon as its terminal root is delivered", () => {
		const cache = new YardExecutionCache();
		cache.add(event());
		cache.add(event({ phase: "completed", seq: 2 }));

		expect(cache.forThread("thread-1")).toEqual([]);
	});

	it("keeps the first event for a seq and ignores a later duplicate", () => {
		const cache = new YardExecutionCache();
		cache.add(event({ seq: 1, phase: "started" }));
		// A second event re-using seq 1 must not replace the first (dedup on seq).
		cache.add(event({ seq: 1, phase: "completed", node_id: "dup" }));
		const replayed = cache.forThread("thread-1");
		expect(replayed).toHaveLength(1);
		expect(replayed[0]).toMatchObject({ node_id: "run-1", phase: "started" });
	});

	it("isolates traces and filters forThread by thread id", () => {
		const cache = new YardExecutionCache();
		cache.add(event({ trace_id: "trace-a", thread_id: "thread-a", seq: 1 }));
		cache.add(
			event({
				trace_id: "trace-b",
				thread_id: "thread-b",
				run_id: "run-b",
				node_id: "run-b",
				seq: 1,
			}),
		);
		expect(cache.forThread("thread-a").map((e) => e.trace_id)).toEqual(["trace-a"]);
		expect(cache.forThread("thread-b").map((e) => e.trace_id)).toEqual(["trace-b"]);
		expect(cache.forThread("thread-missing")).toEqual([]);
	});
});

describe("Yard execution websocket replay", () => {
	it("replays only an active trace to a newly subscribed client", async () => {
		const { TypedEventEmitter } = await import("@bound/shared");
		const { createWebSocketHandler } = await import("../websocket");
		const eventBus = new TypedEventEmitter();
		const handler = createWebSocketHandler(eventBus);
		const sent: Array<Record<string, unknown>> = [];
		const ws = {
			readyState: 1,
			send(message: string) {
				sent.push(JSON.parse(message) as Record<string, unknown>);
			},
		};
		try {
			eventBus.emit("yard:execution", event());
			handler.open(ws as never);
			handler.message(
				ws as never,
				JSON.stringify({ type: "thread:subscribe", thread_id: "thread-1" }),
			);
			expect(sent).toContainEqual(expect.objectContaining({ type: "yard:execution", seq: 1 }));

			eventBus.emit("yard:execution", event({ phase: "completed", seq: 2 }));
			const lateSent: Array<Record<string, unknown>> = [];
			const lateWs = {
				readyState: 1,
				send(message: string) {
					lateSent.push(JSON.parse(message));
				},
			};
			handler.open(lateWs as never);
			handler.message(
				lateWs as never,
				JSON.stringify({ type: "thread:subscribe", thread_id: "thread-1" }),
			);
			expect(lateSent.some((message) => message.type === "yard:execution")).toBe(false);
		} finally {
			handler.cleanup();
		}
	});
});
