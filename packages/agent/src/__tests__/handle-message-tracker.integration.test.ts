/**
 * Integration tests for the close-condition contract between
 * `HandleMessageTracker.maybeCloseTurnIfIdle` and the dispatch_queue
 * lifecycle. The unit tests in `handle-message-tracker.test.ts` cover the
 * tracker in isolation; this file exercises the close-condition probe
 * against a real schema'd database with the actual dispatch_queue helpers
 * the production code uses.
 *
 * Regression context: the first cut of the close-condition probe excluded
 * `client_tool_call` rows from the pending count, which closed the turn
 * the instant the first handler returned and fragmented one logical
 * message-handling cycle into one Jaeger trace per dispatch. The
 * `keeps the turn open while a client_tool_call is pending` case below
 * pins this behavior so the regression cannot reappear.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	acknowledgeBatch,
	acknowledgeClientToolCall,
	applySchema,
	claimPending,
	enqueueClientToolCall,
	enqueueMessage,
	enqueueNotification,
	enqueueToolResult,
} from "@bound/core";
import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { HandleMessageTracker } from "../handle-message-tracker";

describe("HandleMessageTracker.maybeCloseTurnIfIdle (dispatch_queue integration)", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeAll(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		trace.setGlobalTracerProvider(provider);
	});

	afterAll(async () => {
		await provider.shutdown();
		trace.disable();
	});

	let db: Database;
	let tracker: HandleMessageTracker;
	const threadId = "thread-1";
	const siteId = "site-test";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		tracker = new HandleMessageTracker({ watchdogIntervalMs: 0 });
		exporter.reset();
	});

	it("closes the turn when the dispatch_queue has no pending or processing rows", () => {
		tracker.openTurn(threadId);
		const closed = tracker.maybeCloseTurnIfIdle(db, threadId);
		expect(closed).toBe(true);
		expect(tracker.listOpenTurns()).toEqual([]);
	});

	it("keeps the turn open while a user_message row is pending", () => {
		tracker.openTurn(threadId);
		const messageId = randomUUID();
		// Insert a real `messages` row so enqueueMessage's FK-friendly insert lands.
		db.prepare(
			`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
			 VALUES (?, ?, 'user', 'hi', ?, ?, ?, 0)`,
		).run(messageId, threadId, new Date().toISOString(), new Date().toISOString(), siteId);
		enqueueMessage(db, messageId, threadId);

		const closed = tracker.maybeCloseTurnIfIdle(db, threadId);
		expect(closed).toBe(false);
		expect(tracker.listOpenTurns()).toEqual([threadId]);
	});

	it("keeps the turn open while a client_tool_call is pending (regression: don't fragment traces)", () => {
		tracker.openTurn(threadId);
		// Simulate the agent loop enqueueing a client tool dispatch. The
		// resulting dispatch_queue row sits in `pending` until the WS handler
		// receives the tool result and calls acknowledgeClientToolCall. Our
		// close probe MUST treat that row as "work in flight."
		enqueueClientToolCall(
			db,
			threadId,
			{
				call_id: "call-1",
				tool_name: "boundless_bash",
				arguments: { cmd: "ls" },
			},
			"conn-1",
		);

		const closed = tracker.maybeCloseTurnIfIdle(db, threadId);
		expect(closed).toBe(false);
		expect(tracker.listOpenTurns()).toEqual([threadId]);
	});

	it("keeps the turn open while a notification row is pending", () => {
		tracker.openTurn(threadId);
		enqueueNotification(db, threadId, { type: "task_complete", task_name: "x" });

		const closed = tracker.maybeCloseTurnIfIdle(db, threadId);
		expect(closed).toBe(false);
	});

	it("simulates the full client tool round-trip and only closes on the resumed handler's terminal turn", () => {
		// Open turn at the start of handler #1.
		tracker.openTurn(threadId);

		// Handler #1 claims the user message and runs the agent loop. The
		// agent dispatches a client tool — we simulate that via
		// enqueueClientToolCall.
		const userMsgId = randomUUID();
		db.prepare(
			`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
			 VALUES (?, ?, 'user', 'hi', ?, ?, ?, 0)`,
		).run(userMsgId, threadId, new Date().toISOString(), new Date().toISOString(), siteId);
		enqueueMessage(db, userMsgId, threadId);
		const claimed1 = claimPending(db, threadId, siteId);
		expect(claimed1.length).toBe(1);
		expect(claimed1[0]?.event_type).toBe("user_message");

		const ctcId = enqueueClientToolCall(
			db,
			threadId,
			{ call_id: "call-1", tool_name: "boundless_bash", arguments: {} },
			"conn-1",
		);

		// Handler #1 finishes: agent loop returned, batch acknowledged. The
		// close probe runs and MUST keep the turn open because the client
		// tool dispatch is still in flight.
		acknowledgeBatch(
			db,
			claimed1.map((c) => c.message_id),
		);
		expect(tracker.maybeCloseTurnIfIdle(db, threadId)).toBe(false);
		expect(tracker.listOpenTurns()).toEqual([threadId]);

		// WS handler receives the tool result: it acknowledges the client
		// tool call entry and enqueues a tool_result row that drives the
		// resume.
		acknowledgeClientToolCall(db, ctcId);
		enqueueToolResult(db, threadId, "call-1");

		// Handler #2 claims the tool_result row, runs the agent loop's final
		// turn, acknowledges the batch.
		const claimed2 = claimPending(db, threadId, siteId);
		expect(claimed2.length).toBe(1);
		expect(claimed2[0]?.event_type).toBe("tool_result");
		acknowledgeBatch(
			db,
			claimed2.map((c) => c.message_id),
		);

		// Now the dispatch_queue is fully drained — turn closes.
		expect(tracker.maybeCloseTurnIfIdle(db, threadId)).toBe(true);
		expect(tracker.listOpenTurns()).toEqual([]);
	});

	it("error close paths through maybeCloseTurnIfIdle propagate status and reason", () => {
		tracker.openTurn(threadId);
		const closed = tracker.maybeCloseTurnIfIdle(db, threadId, "error", "loop_failed");
		expect(closed).toBe(true);
		const span = exporter.getFinishedSpans().find((s) => s.name === "agent.handle-message");
		expect(span?.status.code).toBe(2); // ERROR
		expect(span?.status.message).toBe("loop_failed");
		expect(span?.attributes["error.reason"]).toBe("loop_failed");
	});

	it("is a no-op when no turn is open for the thread", () => {
		// Pre-condition: dispatch_queue is empty.
		const closed = tracker.maybeCloseTurnIfIdle(db, threadId);
		// Returns true (idle), but no span is emitted because nothing was open.
		expect(closed).toBe(true);
		expect(tracker.listOpenTurns()).toEqual([]);
	});

	it("does not close turns for OTHER threads when scoped to one thread", () => {
		const otherThread = "thread-other";
		tracker.openTurn(threadId);
		tracker.openTurn(otherThread);

		// `otherThread` has a pending user_message; thread-1 is idle.
		const otherMsgId = randomUUID();
		db.prepare(
			`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
			 VALUES (?, ?, 'user', 'hi', ?, ?, ?, 0)`,
		).run(otherMsgId, otherThread, new Date().toISOString(), new Date().toISOString(), siteId);
		enqueueMessage(db, otherMsgId, otherThread);

		expect(tracker.maybeCloseTurnIfIdle(db, threadId)).toBe(true);
		expect(tracker.listOpenTurns()).toEqual([otherThread]);

		expect(tracker.maybeCloseTurnIfIdle(db, otherThread)).toBe(false);
		expect(tracker.listOpenTurns()).toEqual([otherThread]);
	});
});
