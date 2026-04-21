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
	cancelClientToolCalls,
	claimPending,
	enqueueClientToolCall,
	enqueueMessage,
	enqueueNotification,
	enqueueToolResult,
	expireClientToolCalls,
	getPendingClientToolCalls,
	hasPending,
	hasPendingClientToolCalls,
	pruneAcknowledged,
	resetProcessing,
	resetProcessingForThread,
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
