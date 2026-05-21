import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { HandleMessageTracker } from "../handle-message-tracker";

describe("HandleMessageTracker", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeAll(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		trace.setGlobalTracerProvider(provider);
	});

	beforeEach(() => {
		exporter.reset();
	});

	afterAll(async () => {
		await provider.shutdown();
		trace.disable();
	});

	function findSpan(name: string): ReadableSpan | undefined {
		return exporter.getFinishedSpans().find((s) => s.name === name);
	}

	function findSpans(name: string): ReadableSpan[] {
		return exporter.getFinishedSpans().filter((s) => s.name === name);
	}

	it("opens and closes an agent.handle-message span", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		expect(tracker.listOpenTurns()).toEqual(["thread-1"]);
		tracker.closeTurn("thread-1");
		expect(tracker.listOpenTurns()).toEqual([]);
		const span = findSpan("agent.handle-message");
		expect(span).toBeDefined();
		expect(span?.attributes["thread.id"]).toBe("thread-1");
	});

	it("close is no-op when nothing is open", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		expect(() => tracker.closeTurn("ghost")).not.toThrow();
		expect(findSpans("agent.handle-message").length).toBe(0);
	});

	it("opening a turn while one is open closes the prior turn first", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openTurn("thread-1");
		// Two spans should now be ended on flush.
		tracker.closeTurn("thread-1");
		const spans = findSpans("agent.handle-message");
		expect(spans.length).toBe(2);
	});

	it("error close stamps status and reason attribute", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.closeTurn("thread-1", "error", "user_canceled");
		const span = findSpan("agent.handle-message");
		expect(span?.status.code).toBe(2); // ERROR
		expect(span?.status.message).toBe("user_canceled");
		expect(span?.attributes["error.reason"]).toBe("user_canceled");
	});

	it("dispatches parent under the open turn so they share a trace", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openDispatch("thread-1", "call-1", "boundless_bash");
		tracker.closeDispatch("call-1");
		tracker.closeTurn("thread-1");

		const turn = findSpan("agent.handle-message");
		const dispatch = findSpan("tool.dispatch");
		expect(turn).toBeDefined();
		expect(dispatch).toBeDefined();
		expect(dispatch?.spanContext().traceId).toBe(turn?.spanContext().traceId);
		expect(dispatch?.parentSpanId).toBe(turn?.spanContext().spanId);
	});

	it("parallel dispatches share the same parent turn span", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openDispatch("thread-1", "call-a", "tool_a");
		tracker.openDispatch("thread-1", "call-b", "tool_b");
		tracker.closeDispatch("call-a");
		tracker.closeDispatch("call-b");
		tracker.closeTurn("thread-1");

		const dispatches = findSpans("tool.dispatch");
		expect(dispatches.length).toBe(2);
		const parentIds = new Set(dispatches.map((s) => s.parentSpanId));
		expect(parentIds.size).toBe(1);
	});

	it("reopening a dispatch with the same callId closes the prior with ERROR", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openDispatch("thread-1", "call-1", "tool_a");
		tracker.openDispatch("thread-1", "call-1", "tool_a");
		tracker.closeDispatch("call-1");
		tracker.closeTurn("thread-1");

		const dispatches = findSpans("tool.dispatch");
		expect(dispatches.length).toBe(2);
		const errored = dispatches.find((s) => s.status.code === 2);
		expect(errored?.attributes["error.reason"]).toBe("dispatch_replaced");
	});

	it("closeDispatchesForThread closes all matching dispatches", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openTurn("thread-2");
		tracker.openDispatch("thread-1", "call-1", "tool_a");
		tracker.openDispatch("thread-1", "call-2", "tool_b");
		tracker.openDispatch("thread-2", "call-3", "tool_c");
		const closed = tracker.closeDispatchesForThread("thread-1", "thread_canceled");
		expect(closed).toBe(2);
		expect(tracker.listOpenDispatches()).toEqual(["call-3"]);
	});

	it("getDispatchContext returns null after close", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openDispatch("thread-1", "call-1", "tool_a");
		expect(tracker.getDispatchContext("call-1")).not.toBeNull();
		tracker.closeDispatch("call-1");
		expect(tracker.getDispatchContext("call-1")).toBeNull();
	});

	it("watchdog sweep closes spans older than the timeout", () => {
		const tracker = new HandleMessageTracker({
			watchdogIntervalMs: 0,
			watchdogTimeoutMs: 1_000,
		});
		tracker.openTurn("thread-1");
		tracker.openDispatch("thread-1", "call-1", "tool_a");

		// First sweep: nothing old enough.
		expect(tracker.sweep(Date.now())).toBe(0);

		// Advance virtual clock past the timeout.
		const closed = tracker.sweep(Date.now() + 5_000);
		expect(closed).toBe(2);
		expect(tracker.listOpenTurns()).toEqual([]);
		expect(tracker.listOpenDispatches()).toEqual([]);

		const turn = findSpan("agent.handle-message");
		const dispatch = findSpan("tool.dispatch");
		expect(turn?.status.code).toBe(2); // ERROR
		expect(turn?.attributes["error.reason"]).toBe("watchdog_timeout");
		expect(dispatch?.attributes["error.reason"]).toBe("watchdog_timeout");
	});

	it("touchTurn refreshes lastActivityAt so sweep does not close fresh activity", async () => {
		const tracker = new HandleMessageTracker({
			watchdogIntervalMs: 0,
			watchdogTimeoutMs: 50,
		});
		tracker.openTurn("thread-1");

		// Wait long enough that the original openedAt would be sweep-eligible.
		await new Promise((r) => setTimeout(r, 75));

		// Without a touch, sweep would close it.
		// Touch refreshes lastActivityAt to roughly "now", inside the 50ms window.
		tracker.touchTurn("thread-1");
		const closed = tracker.sweep();
		expect(closed).toBe(0);
		expect(tracker.listOpenTurns()).toEqual(["thread-1"]);
		tracker.closeTurn("thread-1");
	});

	it("watchdog closes turns whose lastActivityAt is older than the timeout", async () => {
		const tracker = new HandleMessageTracker({
			watchdogIntervalMs: 0,
			watchdogTimeoutMs: 25,
		});
		tracker.openTurn("thread-1");
		// Sleep past the timeout without touching.
		await new Promise((r) => setTimeout(r, 60));
		const closed = tracker.sweep();
		expect(closed).toBe(1);
		expect(tracker.listOpenTurns()).toEqual([]);
	});

	it("endAllOpenSpans flushes both maps", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openTurn("thread-1");
		tracker.openTurn("thread-2");
		tracker.openDispatch("thread-1", "call-1", "tool_a");
		tracker.endAllOpenSpans("shutdown");
		expect(tracker.listOpenTurns()).toEqual([]);
		expect(tracker.listOpenDispatches()).toEqual([]);
		const turns = findSpans("agent.handle-message");
		const dispatches = findSpans("tool.dispatch");
		expect(turns.length).toBe(2);
		expect(dispatches.length).toBe(1);
		for (const s of [...turns, ...dispatches]) {
			expect(s.attributes["end.reason"]).toBe("shutdown");
		}
	});

	it("startWatchdog/stopWatchdog are idempotent", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 50 });
		tracker.startWatchdog();
		tracker.startWatchdog();
		tracker.stopWatchdog();
		tracker.stopWatchdog();
		// No assertions — just verifying no throw and clean teardown.
	});

	it("getTurnContext returns null when no turn is open", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		expect(tracker.getTurnContext("ghost")).toBeNull();
	});

	it("dispatch without an open turn still creates a span (logged-but-not-fatal)", () => {
		const tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		tracker.openDispatch("thread-orphan", "call-1", "tool_a");
		expect(tracker.listOpenDispatches()).toEqual(["call-1"]);
		tracker.closeDispatch("call-1");
		const dispatch = findSpan("tool.dispatch");
		expect(dispatch).toBeDefined();
	});
});
