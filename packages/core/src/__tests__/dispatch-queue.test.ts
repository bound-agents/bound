import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import {
	CLIENT_TOOL_CALL,
	TOOL_RESULT,
	acknowledgeBatch,
	acknowledgeClientToolCall,
	acknowledgeToolResultForCall,
	cancelClientToolCalls,
	claimPending,
	enqueueClientToolCall,
	enqueueMessage,
	enqueueNotification,
	enqueueToolResult,
	expireClientToolCalls,
	expireClientToolCallsForConnection,
	getPendingClientToolCalls,
	hasPending,
	hasPendingClientToolCalls,
	pruneAcknowledged,
	resetProcessing,
	resetProcessingForThread,
	resolveDeferredToolResult,
	updateClaimedBy,
} from "../dispatch";
import { applySchema } from "../schema";

let db: ReturnType<typeof createDatabase>;
let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

describe("dispatch_queue schema", () => {
	it("dispatch_queue table exists after applySchema", () => {
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_queue'")
			.all() as Array<{ name: string }>;
		expect(tables).toHaveLength(1);
	});

	it("supports INSERT and SELECT on dispatch_queue", () => {
		const msgId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, created_at, modified_at) VALUES (?, ?, 'pending', ?, ?)",
			[msgId, threadId, now, now],
		);

		const row = db.query("SELECT * FROM dispatch_queue WHERE message_id = ?").get(msgId) as {
			message_id: string;
			status: string;
		} | null;
		expect(row).not.toBeNull();
		expect(row?.status).toBe("pending");
	});
});

describe("enqueueMessage", () => {
	it("inserts a pending entry into dispatch_queue", () => {
		const msgId = randomUUID();
		const threadId = randomUUID();

		enqueueMessage(db, msgId, threadId);

		const row = db.query("SELECT * FROM dispatch_queue WHERE message_id = ?").get(msgId) as {
			message_id: string;
			thread_id: string;
			status: string;
		} | null;
		expect(row).not.toBeNull();
		expect(row?.thread_id).toBe(threadId);
		expect(row?.status).toBe("pending");
	});

	it("is idempotent — duplicate message_id does not throw", () => {
		const msgId = randomUUID();
		const threadId = randomUUID();

		enqueueMessage(db, msgId, threadId);
		enqueueMessage(db, msgId, threadId); // should not throw

		const count = db
			.query("SELECT COUNT(*) as c FROM dispatch_queue WHERE message_id = ?")
			.get(msgId) as { c: number };
		expect(count.c).toBe(1);
	});
});

describe("hasPending", () => {
	it("returns true when pending messages exist for thread", () => {
		const threadId = randomUUID();
		const msgId = randomUUID();

		enqueueMessage(db, msgId, threadId);

		expect(hasPending(db, threadId)).toBe(true);
	});

	it("returns false when no pending messages exist", () => {
		const threadId = randomUUID();
		expect(hasPending(db, threadId)).toBe(false);
	});

	it("returns false when all messages are processing", () => {
		const threadId = randomUUID();
		const siteId = randomBytes(8).toString("hex");
		const msgId = randomUUID();

		enqueueMessage(db, msgId, threadId);
		claimPending(db, threadId, siteId);

		expect(hasPending(db, threadId)).toBe(false);
	});

	// Regression: a pending client_tool_call row must NOT make hasPending true,
	// because claimPending skips them. Otherwise the executor drain loop spins
	// (hasPending=true → claim=[] → hasPending=true → ...), pegging CPU at 100%.
	it("returns false when only pending entry is a client_tool_call (drain-loop spin regression)", () => {
		const threadId = randomUUID();
		enqueueClientToolCall(
			db,
			threadId,
			{ call_id: "call-1", tool_name: "boundless_read", arguments: {} },
			"ws-conn-1",
		);

		expect(hasPending(db, threadId)).toBe(false);
	});

	it("returns true for a regular pending message even when a client_tool_call is also pending", () => {
		const threadId = randomUUID();
		enqueueClientToolCall(
			db,
			threadId,
			{ call_id: "call-1", tool_name: "boundless_read", arguments: {} },
			"ws-conn-1",
		);
		enqueueMessage(db, randomUUID(), threadId);

		expect(hasPending(db, threadId)).toBe(true);
	});
});

describe("claimPending", () => {
	it("returns pending messages for a thread and marks them processing", () => {
		const threadId = randomUUID();
		const msg1 = randomUUID();
		const msg2 = randomUUID();

		enqueueMessage(db, msg1, threadId);
		enqueueMessage(db, msg2, threadId);

		const claimed = claimPending(db, threadId, "host-1");

		expect(claimed).toHaveLength(2);
		expect(claimed.map((r) => r.message_id).sort()).toEqual([msg1, msg2].sort());

		// All should be processing now
		const rows = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as Array<{ status: string; claimed_by: string | null }>;
		for (const row of rows) {
			expect(row.status).toBe("processing");
			expect(row.claimed_by).toBe("host-1");
		}
	});

	it("returns empty array when no pending messages exist", () => {
		const threadId = randomUUID();
		const claimed = claimPending(db, threadId, "host-1");
		expect(claimed).toHaveLength(0);
	});

	it("does not claim messages from other threads", () => {
		const thread1 = randomUUID();
		const thread2 = randomUUID();
		const msg1 = randomUUID();
		const msg2 = randomUUID();

		enqueueMessage(db, msg1, thread1);
		enqueueMessage(db, msg2, thread2);

		const claimed = claimPending(db, thread1, "host-1");
		expect(claimed).toHaveLength(1);
		expect(claimed[0].message_id).toBe(msg1);

		// thread2's message should still be pending
		const row = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msg2) as {
			status: string;
		};
		expect(row.status).toBe("pending");
	});
});

describe("resetProcessingForThread", () => {
	it("only resets processing entries for the specified thread", () => {
		const thread1 = randomUUID();
		const thread2 = randomUUID();
		const msg1 = randomUUID();
		const msg2 = randomUUID();

		enqueueMessage(db, msg1, thread1);
		enqueueMessage(db, msg2, thread2);
		claimPending(db, thread1, "host-1");
		claimPending(db, thread2, "host-1");

		// Both are processing
		expect(
			(
				db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msg1) as {
					status: string;
				}
			).status,
		).toBe("processing");
		expect(
			(
				db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msg2) as {
					status: string;
				}
			).status,
		).toBe("processing");

		// Reset only thread1
		const count = resetProcessingForThread(db, thread1);
		expect(count).toBe(1);

		// thread1 is pending, thread2 is still processing
		expect(
			(
				db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msg1) as {
					status: string;
				}
			).status,
		).toBe("pending");
		expect(
			(
				db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msg2) as {
					status: string;
				}
			).status,
		).toBe("processing");
	});
});

describe("acknowledgeBatch", () => {
	it("marks processing messages as acknowledged", () => {
		const threadId = randomUUID();
		const msg1 = randomUUID();
		const msg2 = randomUUID();

		enqueueMessage(db, msg1, threadId);
		enqueueMessage(db, msg2, threadId);
		claimPending(db, threadId, "host-1");

		acknowledgeBatch(db, [msg1, msg2]);

		const rows = db
			.query("SELECT status FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as Array<{ status: string }>;
		for (const row of rows) {
			expect(row.status).toBe("acknowledged");
		}
	});
});

describe("resetProcessing", () => {
	it("resets all processing entries back to pending", () => {
		const threadId = randomUUID();
		const msg1 = randomUUID();

		enqueueMessage(db, msg1, threadId);
		claimPending(db, threadId, "host-1");

		const count = resetProcessing(db);

		expect(count).toBe(1);

		const row = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE message_id = ?")
			.get(msg1) as { status: string; claimed_by: string | null };
		expect(row.status).toBe("pending");
		expect(row.claimed_by).toBeNull();
	});

	it("does not touch acknowledged entries", () => {
		const threadId = randomUUID();
		const msg1 = randomUUID();

		enqueueMessage(db, msg1, threadId);
		claimPending(db, threadId, "host-1");
		acknowledgeBatch(db, [msg1]);

		const count = resetProcessing(db);
		expect(count).toBe(0);

		const row = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msg1) as {
			status: string;
		};
		expect(row.status).toBe("acknowledged");
	});
});

describe("pruneAcknowledged", () => {
	it("removes acknowledged entries older than the cutoff", () => {
		const threadId = randomUUID();
		const msg1 = randomUUID();
		const oldTime = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2 hours ago

		// Insert directly with old timestamps to simulate aged entry
		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, created_at, modified_at) VALUES (?, ?, 'acknowledged', ?, ?)",
			[msg1, threadId, oldTime, oldTime],
		);

		const cutoff = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
		const pruned = pruneAcknowledged(db, cutoff);

		expect(pruned).toBe(1);

		const row = db.query("SELECT * FROM dispatch_queue WHERE message_id = ?").get(msg1);
		expect(row).toBeNull();
	});

	it("does not prune recent acknowledged entries", () => {
		const threadId = randomUUID();
		const msg1 = randomUUID();

		enqueueMessage(db, msg1, threadId);
		claimPending(db, threadId, "host-1");
		acknowledgeBatch(db, [msg1]);

		const cutoff = new Date(Date.now() - 3600_000).toISOString();
		const pruned = pruneAcknowledged(db, cutoff);

		expect(pruned).toBe(0);
	});
});

describe("enqueueNotification", () => {
	it("inserts a pending entry with event_type and event_payload", () => {
		const threadId = randomUUID();
		const payload = { type: "task_complete", task_id: "abc", task_name: "Daily summary" };

		const entryId = enqueueNotification(db, threadId, payload);

		const row = db.query("SELECT * FROM dispatch_queue WHERE message_id = ?").get(entryId) as {
			message_id: string;
			thread_id: string;
			status: string;
			event_type: string;
			event_payload: string;
		} | null;

		expect(row).not.toBeNull();
		expect(row?.thread_id).toBe(threadId);
		expect(row?.status).toBe("pending");
		expect(row?.event_type).toBe("notification");
		expect(JSON.parse(row?.event_payload ?? "{}")).toEqual(payload);
	});

	it("triggers hasPending for the thread", () => {
		const threadId = randomUUID();

		expect(hasPending(db, threadId)).toBe(false);
		enqueueNotification(db, threadId, { type: "test" });
		expect(hasPending(db, threadId)).toBe(true);
	});

	it("is claimed alongside user messages", () => {
		const threadId = randomUUID();
		const msgId = randomUUID();

		enqueueMessage(db, msgId, threadId);
		enqueueNotification(db, threadId, { type: "advisory_created" });

		const claimed = claimPending(db, threadId, "host-1");
		expect(claimed).toHaveLength(2);
	});

	it("default enqueueMessage has event_type user_message", () => {
		const threadId = randomUUID();
		const msgId = randomUUID();

		enqueueMessage(db, msgId, threadId);

		const row = db
			.query("SELECT event_type FROM dispatch_queue WHERE message_id = ?")
			.get(msgId) as {
			event_type: string;
		} | null;

		expect(row?.event_type).toBe("user_message");
	});
});

describe("enqueueClientToolCall", () => {
	it("inserts a pending entry with client_tool_call event_type and payload", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId);

		const row = db.query("SELECT * FROM dispatch_queue WHERE message_id = ?").get(entryId) as {
			message_id: string;
			thread_id: string;
			status: string;
			event_type: string;
			event_payload: string;
			claimed_by: string | null;
		} | null;

		expect(row).not.toBeNull();
		expect(row?.thread_id).toBe(threadId);
		expect(row?.status).toBe("pending");
		expect(row?.event_type).toBe(CLIENT_TOOL_CALL);
		expect(row?.claimed_by).toBe(connectionId);
		expect(JSON.parse(row?.event_payload ?? "{}")).toEqual(payload);
	});
});

describe("enqueueToolResult", () => {
	it("inserts a pending entry with tool_result event_type", () => {
		const threadId = randomUUID();
		const callId = "call-789";

		const entryId = enqueueToolResult(db, threadId, callId);

		const row = db.query("SELECT * FROM dispatch_queue WHERE message_id = ?").get(entryId) as {
			message_id: string;
			thread_id: string;
			status: string;
			event_type: string;
			event_payload: string;
		} | null;

		expect(row).not.toBeNull();
		expect(row?.thread_id).toBe(threadId);
		expect(row?.status).toBe("pending");
		expect(row?.event_type).toBe(TOOL_RESULT);
		expect(JSON.parse(row?.event_payload ?? "{}")).toEqual({ call_id: callId });
	});

	// R-UD9 / AC.7c — re-driving the same (thread_id, call_id) is a no-op so a
	// relayed client_result retry cannot double-enqueue or double-execute.
	it("is idempotent on (thread_id, call_id): a second enqueue is a no-op", () => {
		const threadId = randomUUID();
		const callId = "call-dup";

		const firstId = enqueueToolResult(db, threadId, callId);
		const secondId = enqueueToolResult(db, threadId, callId);

		// Same entry id returned, and exactly ONE row exists for this pair.
		expect(secondId).toBe(firstId);
		const count = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND event_type = ? AND event_payload = ?",
			)
			.get(threadId, TOOL_RESULT, JSON.stringify({ call_id: callId })) as { c: number };
		expect(count.c).toBe(1);
	});

	// Regression: boundless reuses call_1, call_2, …
	// every turn, so a call_id is NOT unique across a thread's lifetime — only
	// within one turn. The idempotency guard must dedup only while a re-drive is
	// still in flight (pending/processing). Once the re-drive row has been consumed
	// (acknowledged), a later turn reusing the same call_id must enqueue a FRESH
	// row — otherwise the loop never gets its wakeup and the thread stalls one
	// message per turn until a user message forces it forward.
	it("re-enqueues a reused call_id after the prior re-drive was acknowledged", () => {
		const threadId = randomUUID();
		const callId = "call_1";

		// Turn N: enqueue + consume (claim → acknowledge) the re-drive.
		const firstId = enqueueToolResult(db, threadId, callId);
		acknowledgeBatch(db, [firstId]);

		// Turn N+1: same call_id comes back. Must be a NEW pending row, not a no-op.
		const secondId = enqueueToolResult(db, threadId, callId);

		expect(secondId).not.toBe(firstId);
		const pending = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND event_type = ? AND status = 'pending'",
			)
			.get(threadId, TOOL_RESULT) as { c: number };
		expect(pending.c).toBe(1);
	});

	it("distinguishes different call_ids and different threads", () => {
		const threadA = randomUUID();
		const threadB = randomUUID();

		const a1 = enqueueToolResult(db, threadA, "call-1");
		const a2 = enqueueToolResult(db, threadA, "call-2"); // different call → new row
		const b1 = enqueueToolResult(db, threadB, "call-1"); // different thread → new row

		expect(a1).not.toBe(a2);
		expect(a1).not.toBe(b1);
		const total = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE event_type = ?")
			.get(TOOL_RESULT) as { c: number };
		expect(total.c).toBe(3);
	});
});

describe("acknowledgeClientToolCall", () => {
	it("transitions status from pending to acknowledged", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId);

		let row = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(entryId) as {
			status: string;
		};
		expect(row.status).toBe("pending");

		acknowledgeClientToolCall(db, entryId);

		row = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(entryId) as {
			status: string;
		};
		expect(row.status).toBe("acknowledged");
	});

	it("is idempotent when called on already-acknowledged entry", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId);
		acknowledgeClientToolCall(db, entryId);
		acknowledgeClientToolCall(db, entryId); // Should not throw

		const row = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(entryId) as {
			status: string;
		};
		expect(row.status).toBe("acknowledged");
	});
});

describe("claimPending with client_tool_call filtering", () => {
	it("skips client_tool_call entries and only claims other types", () => {
		const threadId = randomUUID();
		const userMsgId = randomUUID();
		const connectionId = "ws-conn-123";
		const toolPayload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		enqueueMessage(db, userMsgId, threadId);
		enqueueClientToolCall(db, threadId, toolPayload, connectionId);

		const claimed = claimPending(db, threadId, "host-1");

		expect(claimed).toHaveLength(1);
		expect(claimed[0].message_id).toBe(userMsgId);
		expect(claimed[0].event_type).toBe("user_message");

		// client_tool_call should still be pending
		const toolCall = db
			.query("SELECT status FROM dispatch_queue WHERE event_type = ?")
			.get(CLIENT_TOOL_CALL) as { status: string };
		expect(toolCall.status).toBe("pending");
	});

	it("claims user_message and notification but not client_tool_call from same thread", () => {
		const threadId = randomUUID();
		const userMsgId = randomUUID();
		const notifPayload = { type: "advisory" };
		const connectionId = "ws-conn-123";
		const toolPayload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		enqueueMessage(db, userMsgId, threadId);
		enqueueNotification(db, threadId, notifPayload);
		enqueueClientToolCall(db, threadId, toolPayload, connectionId);

		const claimed = claimPending(db, threadId, "host-1");

		expect(claimed).toHaveLength(2);
		expect(claimed.map((c) => c.event_type).sort()).toEqual(
			["notification", "user_message"].sort(),
		);
	});
});

describe("hasPendingClientToolCalls", () => {
	it("returns true when pending client_tool_call entries exist", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		expect(hasPendingClientToolCalls(db, threadId)).toBe(false);
		enqueueClientToolCall(db, threadId, payload, connectionId);
		expect(hasPendingClientToolCalls(db, threadId)).toBe(true);
	});

	it("returns true for processing entries", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId);

		// Manually update to processing
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, entryId);

		expect(hasPendingClientToolCalls(db, threadId)).toBe(true);
	});

	it("returns false when all entries are acknowledged", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId);
		acknowledgeClientToolCall(db, entryId);

		expect(hasPendingClientToolCalls(db, threadId)).toBe(false);
	});

	it("returns false when no client_tool_call entries exist", () => {
		const threadId = randomUUID();
		const userMsgId = randomUUID();

		enqueueMessage(db, userMsgId, threadId);

		expect(hasPendingClientToolCalls(db, threadId)).toBe(false);
	});
});

describe("getPendingClientToolCalls", () => {
	it("returns pending/processing client_tool_call entries for a thread", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload1 = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test1" },
		};
		const payload2 = {
			call_id: "call-789",
			tool_name: "fetch",
			arguments: { url: "https://example.com" },
		};

		const id1 = enqueueClientToolCall(db, threadId, payload1, connectionId);
		const id2 = enqueueClientToolCall(db, threadId, payload2, connectionId);

		const calls = getPendingClientToolCalls(db, threadId);

		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.message_id).sort()).toEqual([id1, id2].sort());
		expect(JSON.parse(calls[0].event_payload ?? "{}")).toHaveProperty("call_id");
	});

	it("returns empty array when no pending/processing entries exist", () => {
		const threadId = randomUUID();

		const calls = getPendingClientToolCalls(db, threadId);
		expect(calls).toHaveLength(0);
	});

	it("excludes acknowledged entries", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload1 = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test1" },
		};
		const payload2 = {
			call_id: "call-789",
			tool_name: "fetch",
			arguments: { url: "https://example.com" },
		};

		const id1 = enqueueClientToolCall(db, threadId, payload1, connectionId);
		const id2 = enqueueClientToolCall(db, threadId, payload2, connectionId);
		acknowledgeClientToolCall(db, id1);

		const calls = getPendingClientToolCalls(db, threadId);

		expect(calls).toHaveLength(1);
		expect(calls[0].message_id).toBe(id2);
	});
});

describe("expireClientToolCalls", () => {
	it("expires old entries but not recent ones", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		// Insert old entry (2 hours ago)
		const oldTime = new Date(Date.now() - 2 * 3600_000).toISOString();
		const oldId = randomUUID();
		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
			[oldId, threadId, CLIENT_TOOL_CALL, JSON.stringify(payload), connectionId, oldTime, oldTime],
		);

		// Insert recent entry (5 minutes ago)
		const recentId = enqueueClientToolCall(db, threadId, payload, connectionId);

		// Expire with 1-hour TTL
		const ttlMs = 3600_000;
		const expired = expireClientToolCalls(db, ttlMs);

		expect(expired).toHaveLength(1);
		expect(expired[0].message_id).toBe(oldId);

		// Check status changes
		const oldRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(oldId) as { status: string };
		expect(oldRow.status).toBe("expired");

		const recentRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(recentId) as { status: string };
		expect(recentRow.status).toBe("pending");
	});

	it("does not expire entries for threads in the exclusion set", () => {
		const liveThread = randomUUID();
		const deadThread = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "boundless_write",
			arguments: { path: "/tmp/x" },
		};

		const oldTime = new Date(Date.now() - 2 * 3600_000).toISOString();
		const liveId = randomUUID();
		const deadId = randomUUID();

		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at) VALUES (?, ?, 'processing', ?, ?, ?, ?, ?)",
			[
				liveId,
				liveThread,
				CLIENT_TOOL_CALL,
				JSON.stringify(payload),
				connectionId,
				oldTime,
				oldTime,
			],
		);
		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at) VALUES (?, ?, 'processing', ?, ?, ?, ?, ?)",
			[
				deadId,
				deadThread,
				CLIENT_TOOL_CALL,
				JSON.stringify(payload),
				connectionId,
				oldTime,
				oldTime,
			],
		);

		// liveThread has a live client session — its call is holding for a
		// passenger (human approval / slow local exec), not stuck. Exclude it.
		const expired = expireClientToolCalls(db, 3600_000, undefined, [liveThread]);

		expect(expired).toHaveLength(1);
		expect(expired[0].thread_id).toBe(deadThread);

		const liveRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(liveId) as { status: string };
		expect(liveRow.status).toBe("processing");

		const deadRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(deadId) as { status: string };
		expect(deadRow.status).toBe("expired");
	});

	it("expires only entries for specified thread when threadId provided", () => {
		const thread1 = randomUUID();
		const thread2 = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const oldTime = new Date(Date.now() - 2 * 3600_000).toISOString();
		const oldId1 = randomUUID();
		const oldId2 = randomUUID();

		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
			[oldId1, thread1, CLIENT_TOOL_CALL, JSON.stringify(payload), connectionId, oldTime, oldTime],
		);
		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
			[oldId2, thread2, CLIENT_TOOL_CALL, JSON.stringify(payload), connectionId, oldTime, oldTime],
		);

		// Expire only thread1's entries
		const ttlMs = 3600_000;
		const expired = expireClientToolCalls(db, ttlMs, thread1);

		expect(expired).toHaveLength(1);
		expect(expired[0].thread_id).toBe(thread1);

		// Check thread2's entry is still pending
		const thread2Row = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(oldId2) as { status: string };
		expect(thread2Row.status).toBe("pending");
	});

	it("hasPendingClientToolCalls returns false after expiry", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const oldTime = new Date(Date.now() - 2 * 3600_000).toISOString();
		const oldId = randomUUID();
		db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
			[oldId, threadId, CLIENT_TOOL_CALL, JSON.stringify(payload), connectionId, oldTime, oldTime],
		);

		expect(hasPendingClientToolCalls(db, threadId)).toBe(true);

		const ttlMs = 3600_000;
		expireClientToolCalls(db, ttlMs);

		expect(hasPendingClientToolCalls(db, threadId)).toBe(false);
	});
});

describe("cancelClientToolCalls", () => {
	it("expires all pending entries for a thread regardless of age", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload1 = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};
		const payload2 = {
			call_id: "call-789",
			tool_name: "fetch",
			arguments: { url: "https://example.com" },
		};

		enqueueClientToolCall(db, threadId, payload1, connectionId);
		enqueueClientToolCall(db, threadId, payload2, connectionId);

		const count = cancelClientToolCalls(db, threadId);

		expect(count).toBe(2);

		const entries = db
			.query("SELECT status FROM dispatch_queue WHERE thread_id = ? AND event_type = ?")
			.all(threadId, CLIENT_TOOL_CALL) as Array<{ status: string }>;
		for (const entry of entries) {
			expect(entry.status).toBe("expired");
		}
	});

	it("returns 0 when no pending entries exist", () => {
		const threadId = randomUUID();

		const count = cancelClientToolCalls(db, threadId);
		expect(count).toBe(0);
	});

	it("does not affect other threads", () => {
		const thread1 = randomUUID();
		const thread2 = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const id1 = enqueueClientToolCall(db, thread1, payload, connectionId);
		const id2 = enqueueClientToolCall(db, thread2, payload, connectionId);

		cancelClientToolCalls(db, thread1);

		const row1 = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(id1) as {
			status: string;
		};
		expect(row1.status).toBe("expired");

		const row2 = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(id2) as {
			status: string;
		};
		expect(row2.status).toBe("pending");
	});
});

describe("updateClaimedBy", () => {
	it("updates claimed_by and status to processing", () => {
		const threadId = randomUUID();
		const connectionId1 = "ws-conn-123";
		const connectionId2 = "ws-conn-456";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId1);

		updateClaimedBy(db, entryId, connectionId2);

		const row = db
			.query("SELECT claimed_by, status FROM dispatch_queue WHERE message_id = ?")
			.get(entryId) as { claimed_by: string; status: string };

		expect(row.claimed_by).toBe(connectionId2);
		expect(row.status).toBe("processing");
	});
});

describe("resetProcessing with client_tool_call filtering", () => {
	it("does not touch client_tool_call entries", () => {
		const threadId = randomUUID();
		const userMsgId = randomUUID();
		const connectionId = "ws-conn-123";
		const toolPayload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		enqueueMessage(db, userMsgId, threadId);
		const toolCallId = enqueueClientToolCall(db, threadId, toolPayload, connectionId);

		// Mark both as processing
		claimPending(db, threadId, "host-1");

		// Manually update tool call to processing
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, toolCallId);

		const count = resetProcessing(db);

		expect(count).toBe(1); // Only user_message, not client_tool_call

		const userMsgRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(userMsgId) as { status: string };
		expect(userMsgRow.status).toBe("pending");

		const toolCallRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(toolCallId) as { status: string };
		expect(toolCallRow.status).toBe("processing"); // Unchanged
	});
});

describe("resetProcessingForThread with client_tool_call filtering", () => {
	it("does not touch client_tool_call entries for the thread", () => {
		const threadId = randomUUID();
		const userMsgId = randomUUID();
		const connectionId = "ws-conn-123";
		const toolPayload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		enqueueMessage(db, userMsgId, threadId);
		const toolCallId = enqueueClientToolCall(db, threadId, toolPayload, connectionId);

		// Claim user message
		claimPending(db, threadId, "host-1");

		// Manually update tool call to processing
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, toolCallId);

		const count = resetProcessingForThread(db, threadId);

		expect(count).toBe(1); // Only user_message

		const userMsgRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(userMsgId) as { status: string };
		expect(userMsgRow.status).toBe("pending");

		const toolCallRow = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(toolCallId) as { status: string };
		expect(toolCallRow.status).toBe("processing"); // Unchanged
	});
});

describe("Bootstrap recovery for client_tool_call entries (Task 4)", () => {
	it("resets client_tool_call entries from processing to pending with claimed_by = NULL", () => {
		const threadId = randomUUID();
		const connectionId = "ws-conn-123";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		// Simulate crash: tool call was being delivered (processing)
		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId);
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, entryId);

		// Simulate bootstrap recovery: reset processing entries
		db.prepare(
			`UPDATE dispatch_queue
			 SET status = 'pending', claimed_by = NULL, modified_at = ?
			 WHERE event_type = 'client_tool_call' AND status = 'processing'`,
		).run(now);

		const row = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE message_id = ?")
			.get(entryId) as { status: string; claimed_by: string | null };

		expect(row.status).toBe("pending");
		expect(row.claimed_by).toBeNull();
	});

	it("does not affect user_message entries when recovering client_tool_call", () => {
		const threadId = randomUUID();
		const userMsgId = randomUUID();
		const connectionId = "ws-conn-123";
		const toolPayload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		// Enqueue both types
		enqueueMessage(db, userMsgId, threadId);
		const toolCallId = enqueueClientToolCall(db, threadId, toolPayload, connectionId);

		// Claim both (puts them in processing)
		claimPending(db, threadId, "host-1");

		// Manually update tool call to processing (claimPending would have claimed it if we hadn't filtered)
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, toolCallId);

		// Simulate bootstrap recovery: only reset client_tool_call entries
		db.prepare(
			`UPDATE dispatch_queue
			 SET status = 'pending', claimed_by = NULL, modified_at = ?
			 WHERE event_type = 'client_tool_call' AND status = 'processing'`,
		).run(now);

		const userMsgRow = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE message_id = ?")
			.get(userMsgId) as { status: string; claimed_by: string | null };
		const toolCallRow = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE message_id = ?")
			.get(toolCallId) as { status: string; claimed_by: string | null };

		// User message should still be processing from claimPending
		expect(userMsgRow.status).toBe("processing");
		expect(userMsgRow.claimed_by).toBe("host-1");

		// Tool call should be reset
		expect(toolCallRow.status).toBe("pending");
		expect(toolCallRow.claimed_by).toBeNull();
	});

	it("respects claimed_by field set by reconnecting client on re-delivery", () => {
		const threadId = randomUUID();
		const connectionId1 = "ws-conn-old";
		const connectionId2 = "ws-conn-new";
		const payload = {
			call_id: "call-456",
			tool_name: "search",
			arguments: { query: "test" },
		};

		// Original connection delivered the call
		const entryId = enqueueClientToolCall(db, threadId, payload, connectionId1);
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, entryId);

		// Server crashes and recovers
		db.prepare(
			`UPDATE dispatch_queue
			 SET status = 'pending', claimed_by = NULL, modified_at = ?
			 WHERE event_type = 'client_tool_call' AND status = 'processing'`,
		).run(now);

		// New client reconnects and requests re-delivery
		updateClaimedBy(db, entryId, connectionId2);

		const row = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE message_id = ?")
			.get(entryId) as { status: string; claimed_by: string };

		expect(row.status).toBe("processing");
		expect(row.claimed_by).toBe(connectionId2);
	});
});

describe("expireClientToolCallsForConnection", () => {
	it("expires pending and processing calls claimed by the given connection", () => {
		const thread1 = randomUUID();
		const thread2 = randomUUID();
		const dyingConn = "ws-conn-dying";
		const liveConn = "ws-conn-live";
		const payload = { call_id: "call-1", tool_name: "boundless_edit", arguments: {} };

		// A pending call and a delivered ('processing') call, both on the dying connection.
		const pendingId = enqueueClientToolCall(db, thread1, { ...payload, call_id: "p" }, dyingConn);
		const processingId = enqueueClientToolCall(
			db,
			thread1,
			{ ...payload, call_id: "q" },
			dyingConn,
		);
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE dispatch_queue SET status = 'processing', modified_at = ? WHERE message_id = ?",
		).run(now, processingId);

		// An unrelated call on a different (still-live) connection must be untouched.
		const otherId = enqueueClientToolCall(db, thread2, { ...payload, call_id: "r" }, liveConn);

		const expired = expireClientToolCallsForConnection(db, dyingConn);

		// Both of the dying connection's calls are returned, the other is not.
		expect(expired.map((e) => e.message_id).sort()).toEqual([pendingId, processingId].sort());

		const statusOf = (id: string) =>
			(
				db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(id) as {
					status: string;
				}
			).status;
		expect(statusOf(pendingId)).toBe("expired");
		expect(statusOf(processingId)).toBe("expired");
		expect(statusOf(otherId)).toBe("pending");

		// The barrier on the dying connection's thread is cleared; the other thread's stands.
		expect(hasPendingClientToolCalls(db, thread1)).toBe(false);
		expect(hasPendingClientToolCalls(db, thread2)).toBe(true);
	});

	it("returns an empty array when the connection has no in-flight calls", () => {
		const threadId = randomUUID();
		enqueueClientToolCall(
			db,
			threadId,
			{ call_id: "x", tool_name: "read", arguments: {} },
			"other",
		);
		expect(expireClientToolCallsForConnection(db, "ws-conn-empty")).toHaveLength(0);
	});
});

// #76 — tool backgrounding. A tool that returns a DeferredToolResult gets a
// placeholder tool_result written by the loop; when its background work lands,
// resolveDeferredToolResult swaps the placeholder content for the real result
// and re-wakes the loop through the same enqueueToolResult path the WS
// client-tool track uses.
describe("resolveDeferredToolResult", () => {
	const siteId = "test-site";

	function insertPlaceholder(
		threadId: string,
		callId: string,
		content = "[Background: running]",
		opts: { deleted?: number; role?: string; createdAt?: string } = {},
	): string {
		const id = randomUUID();
		const now = opts.createdAt ?? new Date().toISOString();
		db.run(
			`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted, exit_code, metadata)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
			[
				id,
				threadId,
				opts.role ?? "tool_result",
				content,
				callId,
				now,
				now,
				siteId,
				opts.deleted ?? 0,
			],
		);
		return id;
	}

	function contentOf(id: string): { content: string; exit_code: number | null } {
		return db.query("SELECT content, exit_code FROM messages WHERE id = ?").get(id) as {
			content: string;
			exit_code: number | null;
		};
	}

	it("swaps the placeholder content for the real result and enqueues a re-wake", () => {
		const threadId = randomUUID();
		const callId = "call-bg-1";
		const placeholderId = insertPlaceholder(threadId, callId);

		resolveDeferredToolResult(db, threadId, callId, "aux found 3 files", false, siteId);

		const row = contentOf(placeholderId);
		expect(row.content).toBe("aux found 3 files");
		expect(row.exit_code).toBe(0);

		const pending = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND event_type = ? AND event_payload = ? AND status = 'pending'",
			)
			.get(threadId, TOOL_RESULT, JSON.stringify({ call_id: callId })) as { c: number };
		expect(pending.c).toBe(1);
	});

	it("marks exit_code 1 when the background work failed", () => {
		const threadId = randomUUID();
		const callId = "call-bg-err";
		const placeholderId = insertPlaceholder(threadId, callId);

		resolveDeferredToolResult(db, threadId, callId, "Error: aux blew up", true, siteId);

		const row = contentOf(placeholderId);
		expect(row.content).toBe("Error: aux blew up");
		expect(row.exit_code).toBe(1);
	});

	// Race: background work can finish before the loop has persisted the
	// placeholder. The enqueue must still happen so the loop wakes and reads
	// whatever it wrote on its own iteration — dropping it would stall the thread.
	it("still enqueues the re-wake when no placeholder exists yet", () => {
		const threadId = randomUUID();
		const callId = "call-bg-race";

		resolveDeferredToolResult(db, threadId, callId, "result arrived early", false, siteId);

		const pending = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND event_type = ? AND status = 'pending'",
			)
			.get(threadId, TOOL_RESULT) as { c: number };
		expect(pending.c).toBe(1);
	});

	// call_ids are reused across turns (boundless emits call_1, call_2, … every
	// turn), so the newest row for a given (thread, call_id) is the live one.
	it("resolves the most recent placeholder when a call_id was reused", () => {
		const threadId = randomUUID();
		const callId = "call_1";
		const oldId = insertPlaceholder(threadId, callId, "[old turn placeholder]", {
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const newId = insertPlaceholder(threadId, callId, "[current turn placeholder]", {
			createdAt: "2026-06-01T00:00:00.000Z",
		});

		resolveDeferredToolResult(db, threadId, callId, "fresh result", false, siteId);

		expect(contentOf(newId).content).toBe("fresh result");
		expect(contentOf(oldId).content).toBe("[old turn placeholder]");
	});

	it("ignores soft-deleted placeholders", () => {
		const threadId = randomUUID();
		const callId = "call-bg-deleted";
		const deletedId = insertPlaceholder(threadId, callId, "[tombstoned]", { deleted: 1 });

		resolveDeferredToolResult(db, threadId, callId, "should not land here", false, siteId);

		expect(contentOf(deletedId).content).toBe("[tombstoned]");
	});

	it("does not touch rows of other roles that share the tool_name", () => {
		const threadId = randomUUID();
		const callId = "call-bg-role";
		const toolCallId = insertPlaceholder(threadId, callId, "[the tool_call row]", {
			role: "tool_call",
		});

		resolveDeferredToolResult(db, threadId, callId, "real result", false, siteId);

		expect(contentOf(toolCallId).content).toBe("[the tool_call row]");
	});

	it("scopes resolution to the owning thread", () => {
		const threadA = randomUUID();
		const threadB = randomUUID();
		const callId = "call-shared";
		const aId = insertPlaceholder(threadA, callId, "[thread A placeholder]");
		const bId = insertPlaceholder(threadB, callId, "[thread B placeholder]");

		resolveDeferredToolResult(db, threadA, callId, "A's result", false, siteId);

		expect(contentOf(aId).content).toBe("A's result");
		expect(contentOf(bId).content).toBe("[thread B placeholder]");
	});

	// The re-wake rides enqueueToolResult, which is idempotent on
	// (thread_id, call_id) while a prior re-drive is still in flight.
	it("is idempotent on repeat resolution while the re-wake is still pending", () => {
		const threadId = randomUUID();
		const callId = "call-bg-dup";
		insertPlaceholder(threadId, callId);

		resolveDeferredToolResult(db, threadId, callId, "first", false, siteId);
		resolveDeferredToolResult(db, threadId, callId, "second", false, siteId);

		const pending = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND event_type = ? AND status = 'pending'",
			)
			.get(threadId, TOOL_RESULT) as { c: number };
		expect(pending.c).toBe(1);
	});

	it("routes the placeholder update through the change-log outbox", () => {
		const threadId = randomUUID();
		const callId = "call-bg-sync";
		const placeholderId = insertPlaceholder(threadId, callId);
		const before = db.query("SELECT COUNT(*) AS c FROM change_log").get() as { c: number };

		resolveDeferredToolResult(db, threadId, callId, "synced result", false, siteId);

		const after = db.query("SELECT COUNT(*) AS c FROM change_log").get() as { c: number };
		expect(after.c).toBeGreaterThan(before.c);
		const entry = db
			.query(
				"SELECT table_name, row_id FROM change_log WHERE row_id = ? ORDER BY rowid DESC LIMIT 1",
			)
			.get(placeholderId) as { table_name: string; row_id: string } | null;
		expect(entry?.table_name).toBe("messages");
	});
});
// #201 — a NESTED (aux) loop resolves client tools inline and keeps running, so
// nothing will ever claim the re-wake `enqueueToolResult` queued. Left pending it
// becomes a phantom wakeup that crash recovery re-dispatches on the next boot.
describe("acknowledgeToolResultForCall", () => {
	function statusesFor(threadId: string): string[] {
		return (
			db
				.query(
					"SELECT status FROM dispatch_queue WHERE thread_id = ? AND event_type = ? ORDER BY created_at",
				)
				.all(threadId, TOOL_RESULT) as Array<{ status: string }>
		).map((r) => r.status);
	}

	it("acknowledges a pending tool_result entry for the call", () => {
		const threadId = randomUUID();
		enqueueToolResult(db, threadId, "call-1");

		acknowledgeToolResultForCall(db, threadId, "call-1");

		expect(statusesFor(threadId)).toEqual(["acknowledged"]);
	});

	it("acknowledges an entry already claimed into processing", () => {
		const threadId = randomUUID();
		const entryId = enqueueToolResult(db, threadId, "call-1");
		updateClaimedBy(db, entryId, "conn-1");

		acknowledgeToolResultForCall(db, threadId, "call-1");

		expect(statusesFor(threadId)).toEqual(["acknowledged"]);
	});

	it("leaves other call_ids on the same thread untouched", () => {
		const threadId = randomUUID();
		enqueueToolResult(db, threadId, "call-1");
		enqueueToolResult(db, threadId, "call-2");

		acknowledgeToolResultForCall(db, threadId, "call-1");

		const rows = db
			.query(
				"SELECT event_payload, status FROM dispatch_queue WHERE thread_id = ? AND event_type = ?",
			)
			.all(threadId, TOOL_RESULT) as Array<{ event_payload: string; status: string }>;
		const byCall = new Map(
			rows.map((r) => [(JSON.parse(r.event_payload) as { call_id: string }).call_id, r.status]),
		);
		expect(byCall.get("call-1")).toBe("acknowledged");
		expect(byCall.get("call-2")).toBe("pending");
	});

	it("scopes to the owning thread", () => {
		const threadA = randomUUID();
		const threadB = randomUUID();
		enqueueToolResult(db, threadA, "call-1");
		enqueueToolResult(db, threadB, "call-1");

		acknowledgeToolResultForCall(db, threadA, "call-1");

		expect(statusesFor(threadA)).toEqual(["acknowledged"]);
		expect(statusesFor(threadB)).toEqual(["pending"]);
	});

	// The inline resolver calls this unconditionally, including on paths where no
	// entry was ever queued (e.g. no live session), so it must not throw.
	it("is a no-op when no matching entry exists", () => {
		const threadId = randomUUID();
		expect(() => acknowledgeToolResultForCall(db, threadId, "never")).not.toThrow();
		expect(statusesFor(threadId)).toEqual([]);
	});

	it("is idempotent on repeat calls", () => {
		const threadId = randomUUID();
		enqueueToolResult(db, threadId, "call-1");

		acknowledgeToolResultForCall(db, threadId, "call-1");
		acknowledgeToolResultForCall(db, threadId, "call-1");

		expect(statusesFor(threadId)).toEqual(["acknowledged"]);
	});

	// Acknowledging clears the in-flight guard, so a later turn reusing the same
	// call_id enqueues a fresh row rather than colliding with the closed one.
	it("frees the call_id for a later turn to re-enqueue", () => {
		const threadId = randomUUID();
		const first = enqueueToolResult(db, threadId, "call_1");
		acknowledgeToolResultForCall(db, threadId, "call_1");

		const second = enqueueToolResult(db, threadId, "call_1");

		expect(second).not.toBe(first);
		expect(statusesFor(threadId).sort()).toEqual(["acknowledged", "pending"]);
	});

	it("does not touch client_tool_call entries for the same thread", () => {
		const threadId = randomUUID();
		enqueueClientToolCall(
			db,
			threadId,
			{ call_id: "call-1", tool_name: "boundless_read", arguments: {} },
			"conn-1",
		);
		enqueueToolResult(db, threadId, "call-1");

		acknowledgeToolResultForCall(db, threadId, "call-1");

		const ct = db
			.query("SELECT status FROM dispatch_queue WHERE thread_id = ? AND event_type = ?")
			.get(threadId, CLIENT_TOOL_CALL) as { status: string };
		expect(ct.status).toBe("pending");
	});
});
