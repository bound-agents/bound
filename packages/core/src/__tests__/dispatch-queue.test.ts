import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import {
	acknowledgeBatch,
	claimPending,
	enqueueMessage,
	enqueueNotification,
	hasPending,
	pruneAcknowledged,
	resetProcessing,
	resetProcessingForThread,
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
