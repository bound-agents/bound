/**
 * Dispatch queue wiring integration tests.
 *
 * These tests verify the event-driven conversation dispatch behavior:
 * - Message batching via debounce
 * - Cancel-and-redispatch on new user message during active loop
 * - Restart recovery (processing → pending)
 * - End-to-end dispatch lifecycle (pending → processing → acknowledged)
 *
 * Tests replicate the server.ts handler logic against a real test database
 * and verify observable side-effects in the dispatch_queue table.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acknowledgeBatch,
	acknowledgeClientToolCall,
	applySchema,
	claimPending,
	createDatabase,
	enqueueClientToolCall,
	enqueueMessage,
	enqueueToolResult,
	hasPending,
	hasPendingClientToolCalls,
	insertRow,
	resetProcessing,
} from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";

describe("Dispatch Queue Wiring", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `dispatch-wiring-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();
		db.run("DELETE FROM dispatch_queue");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM threads");
		db.run("DELETE FROM users");
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createThread(): { userId: string; threadId: string } {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, NULL, ?, ?, 0)",
			[userId, "TestUser", now, now],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', 'localhost', 0, 'test', NULL, ?, ?, ?, 0)",
			[threadId, userId, now, now, now],
		);
		return { userId, threadId };
	}

	function insertUserMessage(threadId: string, content = "Hello"): string {
		const msgId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "user",
				content,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "localhost",
				deleted: 0,
			},
			siteId,
		);
		return msgId;
	}

	function getDispatchStatus(messageId: string): string | null {
		const row = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(messageId) as { status: string } | null;
		return row?.status ?? null;
	}

	function countDispatch(threadId: string, status: string): number {
		const row = db
			.query("SELECT COUNT(*) as c FROM dispatch_queue WHERE thread_id = ? AND status = ?")
			.get(threadId, status) as { c: number };
		return row.c;
	}

	// -------------------------------------------------------------------
	// End-to-end dispatch lifecycle
	// -------------------------------------------------------------------
	describe("dispatch lifecycle", () => {
		it("enqueueMessage sets status to pending", () => {
			const { threadId } = createThread();
			const msgId = insertUserMessage(threadId);

			enqueueMessage(db, msgId, threadId);

			expect(getDispatchStatus(msgId)).toBe("pending");
		});

		it("claimPending transitions pending → processing", () => {
			const { threadId } = createThread();
			const msgId = insertUserMessage(threadId);
			enqueueMessage(db, msgId, threadId);

			const claimed = claimPending(db, threadId, siteId);

			expect(claimed).toHaveLength(1);
			expect(claimed[0].message_id).toBe(msgId);
			expect(getDispatchStatus(msgId)).toBe("processing");
		});

		it("acknowledgeBatch transitions processing → acknowledged", () => {
			const { threadId } = createThread();
			const msgId = insertUserMessage(threadId);
			enqueueMessage(db, msgId, threadId);
			claimPending(db, threadId, siteId);

			acknowledgeBatch(db, [msgId]);

			expect(getDispatchStatus(msgId)).toBe("acknowledged");
		});

		it("full lifecycle: pending → processing → acknowledged", () => {
			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "First message");
			const msg2 = insertUserMessage(threadId, "Second message");

			// Enqueue both
			enqueueMessage(db, msg1, threadId);
			enqueueMessage(db, msg2, threadId);
			expect(countDispatch(threadId, "pending")).toBe(2);

			// Claim
			const claimed = claimPending(db, threadId, siteId);
			expect(claimed).toHaveLength(2);
			expect(countDispatch(threadId, "processing")).toBe(2);
			expect(countDispatch(threadId, "pending")).toBe(0);

			// Acknowledge
			acknowledgeBatch(
				db,
				claimed.map((e) => e.message_id),
			);
			expect(countDispatch(threadId, "acknowledged")).toBe(2);
			expect(countDispatch(threadId, "processing")).toBe(0);
		});
	});

	// -------------------------------------------------------------------
	// Message batching
	// -------------------------------------------------------------------
	describe("message batching", () => {
		it("multiple messages enqueued before claim are all claimed together", () => {
			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "hey");
			const msg2 = insertUserMessage(threadId, "are you there?");
			const msg3 = insertUserMessage(threadId, "hello??");

			// Simulates: three rapid-fire messages all enqueued within the debounce window
			enqueueMessage(db, msg1, threadId);
			enqueueMessage(db, msg2, threadId);
			enqueueMessage(db, msg3, threadId);

			// Single claim picks up all three
			const claimed = claimPending(db, threadId, siteId);
			expect(claimed).toHaveLength(3);
			expect(claimed.map((c) => c.message_id)).toEqual(expect.arrayContaining([msg1, msg2, msg3]));
		});

		it("messages from different threads are independent", () => {
			const { threadId: thread1 } = createThread();
			const { threadId: thread2 } = createThread();
			const msgA = insertUserMessage(thread1, "thread 1 msg");
			const msgB = insertUserMessage(thread2, "thread 2 msg");

			enqueueMessage(db, msgA, thread1);
			enqueueMessage(db, msgB, thread2);

			// Claim only thread1
			const claimed = claimPending(db, thread1, siteId);
			expect(claimed).toHaveLength(1);
			expect(claimed[0].message_id).toBe(msgA);

			// thread2 still has a pending message
			expect(getDispatchStatus(msgB)).toBe("pending");
		});
	});

	// -------------------------------------------------------------------
	// Cancel-and-redispatch
	// -------------------------------------------------------------------
	describe("cancel-and-redispatch", () => {
		it("new message enqueued during active loop stays pending for re-dispatch", () => {
			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "first message");

			// Enqueue and claim msg1 (simulates: loop starts with msg1)
			enqueueMessage(db, msg1, threadId);
			const claimed = claimPending(db, threadId, siteId);
			expect(claimed).toHaveLength(1);
			expect(getDispatchStatus(msg1)).toBe("processing");

			// New message arrives while loop is active — enqueued but NOT claimed
			const msg2 = insertUserMessage(threadId, "correction: I meant this");
			enqueueMessage(db, msg2, threadId);
			expect(getDispatchStatus(msg2)).toBe("pending");

			// Simulate: agent:cancel fires, loop finishes, acknowledged the old batch
			acknowledgeBatch(db, [msg1]);
			expect(getDispatchStatus(msg1)).toBe("acknowledged");

			// Re-dispatch: claim the new pending message
			const reClaimed = claimPending(db, threadId, siteId);
			expect(reClaimed).toHaveLength(1);
			expect(reClaimed[0].message_id).toBe(msg2);
		});

		it("cancelled loop can acknowledge partial work then re-dispatch remainder", () => {
			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "original");
			const msg2 = insertUserMessage(threadId, "follow-up during inference");

			// Both enqueued
			enqueueMessage(db, msg1, threadId);
			enqueueMessage(db, msg2, threadId);

			// Only msg1 claimed initially (msg2 arrived after claim)
			// Simulate by manually claiming msg1 only
			db.run(
				"UPDATE dispatch_queue SET status = 'processing', claimed_by = ? WHERE message_id = ?",
				[siteId, msg1],
			);

			// Loop gets cancelled → acknowledge what was processed
			acknowledgeBatch(db, [msg1]);

			// msg2 is still pending — re-dispatch picks it up
			const pending = claimPending(db, threadId, siteId);
			expect(pending).toHaveLength(1);
			expect(pending[0].message_id).toBe(msg2);
		});
	});

	// -------------------------------------------------------------------
	// Restart recovery
	// -------------------------------------------------------------------
	describe("restart recovery", () => {
		it("resetProcessing moves all processing entries back to pending", () => {
			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "was being processed");
			const msg2 = insertUserMessage(threadId, "also processing");

			enqueueMessage(db, msg1, threadId);
			enqueueMessage(db, msg2, threadId);
			claimPending(db, threadId, siteId);

			// Both are processing
			expect(countDispatch(threadId, "processing")).toBe(2);

			// Simulate restart: reset all processing → pending
			const resetCount = resetProcessing(db);
			expect(resetCount).toBe(2);

			expect(countDispatch(threadId, "pending")).toBe(2);
			expect(countDispatch(threadId, "processing")).toBe(0);
		});

		it("resetProcessing clears claimed_by so any host can re-claim", () => {
			const { threadId } = createThread();
			const msgId = insertUserMessage(threadId, "test");

			enqueueMessage(db, msgId, threadId);
			claimPending(db, threadId, "host-A");

			const before = db
				.query("SELECT claimed_by FROM dispatch_queue WHERE message_id = ?")
				.get(msgId) as { claimed_by: string | null };
			expect(before.claimed_by).toBe("host-A");

			resetProcessing(db);

			const after = db
				.query("SELECT claimed_by FROM dispatch_queue WHERE message_id = ?")
				.get(msgId) as { claimed_by: string | null };
			expect(after.claimed_by).toBeNull();
		});

		it("resetProcessing does not touch acknowledged or pending entries", () => {
			const { threadId } = createThread();
			const msgAck = insertUserMessage(threadId, "already done");
			const msgPend = insertUserMessage(threadId, "waiting");

			enqueueMessage(db, msgAck, threadId);
			enqueueMessage(db, msgPend, threadId);

			// Acknowledge one, leave the other pending
			claimPending(db, threadId, siteId);
			acknowledgeBatch(db, [msgAck]);

			// Manually revert msgPend to pending (simulating it arrived after claim)
			db.run(
				"UPDATE dispatch_queue SET status = 'pending', claimed_by = NULL WHERE message_id = ?",
				[msgPend],
			);

			const resetCount = resetProcessing(db);
			expect(resetCount).toBe(0); // nothing was 'processing'

			expect(getDispatchStatus(msgAck)).toBe("acknowledged");
			expect(getDispatchStatus(msgPend)).toBe("pending");
		});

		it("recovery re-dispatch: after reset, pending threads can be discovered", () => {
			const { threadId: thread1 } = createThread();
			const { threadId: thread2 } = createThread();
			const msg1 = insertUserMessage(thread1, "thread 1 interrupted");
			const msg2 = insertUserMessage(thread2, "thread 2 interrupted");

			enqueueMessage(db, msg1, thread1);
			enqueueMessage(db, msg2, thread2);
			claimPending(db, thread1, siteId);
			claimPending(db, thread2, siteId);

			// Simulate crash: both are 'processing'
			resetProcessing(db);

			// Discovery query: find all threads with pending entries
			const pendingThreads = db
				.query("SELECT DISTINCT thread_id FROM dispatch_queue WHERE status = 'pending'")
				.all() as Array<{ thread_id: string }>;

			expect(pendingThreads).toHaveLength(2);
			const threadIds = pendingThreads.map((r) => r.thread_id).sort();
			expect(threadIds).toEqual([thread1, thread2].sort());
		});
	});

	// -------------------------------------------------------------------
	// Event bus integration
	// -------------------------------------------------------------------
	describe("event bus integration", () => {
		it("message:created handler enqueues user messages", () => {
			const { threadId } = createThread();
			const msgId = insertUserMessage(threadId);

			// Replicate the handler logic: enqueue on message:created for user messages
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(msgId) as {
				id: string;
				role: string;
			};

			if (message.role === "user") {
				enqueueMessage(db, message.id, threadId);
			}

			expect(getDispatchStatus(msgId)).toBe("pending");
		});

		it("message:created handler ignores non-user messages", () => {
			const { threadId } = createThread();
			const now = new Date().toISOString();
			const assistantMsgId = randomUUID();

			insertRow(
				db,
				"messages",
				{
					id: assistantMsgId,
					thread_id: threadId,
					role: "assistant",
					content: "I can help with that",
					model_id: "test-model",
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: "localhost",
					deleted: 0,
				},
				siteId,
			);

			// Replicate: only enqueue if role === "user"
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(assistantMsgId) as {
				id: string;
				role: string;
			};

			if (message.role === "user") {
				enqueueMessage(db, message.id, threadId);
			}

			// Should NOT be in dispatch_queue
			expect(getDispatchStatus(assistantMsgId)).toBeNull();
		});

		it("agent:cancel emits correctly via eventBus", () => {
			let cancelledThreadId: string | null = null;
			eventBus.on("agent:cancel", ({ thread_id }) => {
				cancelledThreadId = thread_id;
			});

			const threadId = randomUUID();
			eventBus.emit("agent:cancel", { thread_id: threadId });

			expect(cancelledThreadId).toBe(threadId);
		});
	});

	// -------------------------------------------------------------------
	// Client tool result barrier
	//
	// When a single tool_call turn dispatches multiple client tools in
	// parallel, their results arrive independently. The message:created
	// handler must NOT fire handleThread on the first arrival — it must
	// wait until EVERY outstanding client_tool_call for the thread has
	// been acknowledged. Otherwise the agent loop resumes with an
	// incomplete context and later stragglers land after the next
	// tool_call turn, poisoning context assembly and triggering
	// Bedrock tool_use_id_mismatch on the subsequent send.
	// -------------------------------------------------------------------
	describe("client tool result barrier", () => {
		function insertToolResultMessage(threadId: string, callId: string): string {
			const msgId = randomUUID();
			const now = new Date().toISOString();
			insertRow(
				db,
				"messages",
				{
					id: msgId,
					thread_id: threadId,
					role: "tool_result",
					content: JSON.stringify([{ type: "tool_result", tool_use_id: callId, content: "ok" }]),
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: "localhost",
					deleted: 0,
				},
				siteId,
			);
			return msgId;
		}

		/**
		 * Replicates the message:created handler logic from server.ts for
		 * tool_result rows: only resume if no client tool calls remain
		 * outstanding.
		 */
		function shouldResumeOnToolResult(threadId: string): boolean {
			return !hasPendingClientToolCalls(db, threadId);
		}

		it("does not resume when one of two parallel client tool calls is still pending", () => {
			const { threadId } = createThread();

			// Simulate turn 1: two client tool calls dispatched in parallel.
			const entryA = enqueueClientToolCall(
				db,
				threadId,
				{ call_id: "call-A", tool_name: "run_bash", arguments: { cmd: "fast" } },
				"ws-conn-1",
			);
			enqueueClientToolCall(
				db,
				threadId,
				{ call_id: "call-B", tool_name: "run_bash", arguments: { cmd: "slow" } },
				"ws-conn-1",
			);

			// Fast result for call-A lands first: ack + enqueue tool_result.
			acknowledgeClientToolCall(db, entryA);
			insertToolResultMessage(threadId, "call-A");
			enqueueToolResult(db, threadId, "call-A");

			// Barrier must hold — call-B is still outstanding.
			expect(hasPendingClientToolCalls(db, threadId)).toBe(true);
			expect(shouldResumeOnToolResult(threadId)).toBe(false);
		});

		it("resumes only after the final client tool call is acknowledged", () => {
			const { threadId } = createThread();

			const entryA = enqueueClientToolCall(
				db,
				threadId,
				{ call_id: "call-A", tool_name: "run_bash", arguments: { cmd: "fast" } },
				"ws-conn-1",
			);
			const entryB = enqueueClientToolCall(
				db,
				threadId,
				{ call_id: "call-B", tool_name: "run_bash", arguments: { cmd: "slow" } },
				"ws-conn-1",
			);

			// First result arrives, barrier holds.
			acknowledgeClientToolCall(db, entryA);
			insertToolResultMessage(threadId, "call-A");
			enqueueToolResult(db, threadId, "call-A");
			expect(shouldResumeOnToolResult(threadId)).toBe(false);

			// Second result arrives, barrier clears.
			acknowledgeClientToolCall(db, entryB);
			insertToolResultMessage(threadId, "call-B");
			enqueueToolResult(db, threadId, "call-B");
			expect(hasPendingClientToolCalls(db, threadId)).toBe(false);
			expect(shouldResumeOnToolResult(threadId)).toBe(true);
		});

		it("single client tool call resumes immediately on its result", () => {
			const { threadId } = createThread();

			const entryA = enqueueClientToolCall(
				db,
				threadId,
				{ call_id: "call-solo", tool_name: "run_bash", arguments: { cmd: "x" } },
				"ws-conn-1",
			);

			acknowledgeClientToolCall(db, entryA);
			insertToolResultMessage(threadId, "call-solo");
			enqueueToolResult(db, threadId, "call-solo");

			expect(shouldResumeOnToolResult(threadId)).toBe(true);
		});

		it("user messages bypass the barrier even when client tools are outstanding", () => {
			// User messages are not gated by pending client tool calls —
			// they cancel-and-redispatch; the agent loop will abort the
			// outstanding tool calls on its own.
			const { threadId } = createThread();

			enqueueClientToolCall(
				db,
				threadId,
				{ call_id: "call-X", tool_name: "run_bash", arguments: { cmd: "y" } },
				"ws-conn-1",
			);

			const userMsgId = insertUserMessage(threadId, "hello again");

			// Replicate handler: user branch ignores the barrier.
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(userMsgId) as {
				role: string;
			};
			if (message.role === "user") {
				enqueueMessage(db, userMsgId, threadId);
			}

			expect(hasPendingClientToolCalls(db, threadId)).toBe(true);
			expect(getDispatchStatus(userMsgId)).toBe("pending");
		});
	});

	// -------------------------------------------------------------------
	// Drain loop error recovery
	// -------------------------------------------------------------------
	describe("drain loop error recovery", () => {
		it("error during inference acknowledges failed batch without releasing lock", () => {
			// Simulates: inference fails mid-stream, batch is acknowledged,
			// and the drain loop can continue to next iteration

			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "will fail");

			enqueueMessage(db, msg1, threadId);
			const claimed = claimPending(db, threadId, siteId);
			expect(claimed).toHaveLength(1);

			// Simulate: error occurs, catch block acknowledges
			acknowledgeBatch(db, [msg1]);

			// New message arrives after failure
			const msg2 = insertUserMessage(threadId, "retry after failure");
			enqueueMessage(db, msg2, threadId);

			// Next iteration of drain loop picks it up
			const nextClaimed = claimPending(db, threadId, siteId);
			expect(nextClaimed).toHaveLength(1);
			expect(nextClaimed[0].message_id).toBe(msg2);
		});

		it("hasPending returns true when new messages arrive during processing", () => {
			const { threadId } = createThread();
			const msg1 = insertUserMessage(threadId, "original");

			enqueueMessage(db, msg1, threadId);
			claimPending(db, threadId, siteId);

			// msg1 is processing — hasPending should be false
			expect(hasPending(db, threadId)).toBe(false);

			// New message arrives
			const msg2 = insertUserMessage(threadId, "new arrival");
			enqueueMessage(db, msg2, threadId);

			// Now hasPending should be true (shouldYield trigger)
			expect(hasPending(db, threadId)).toBe(true);
		});
	});
});
