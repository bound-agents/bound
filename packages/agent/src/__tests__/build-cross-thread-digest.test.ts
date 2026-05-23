import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { buildCrossThreadDigest } from "../summary-extraction.js";

let db: Database;
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

describe("buildCrossThreadDigest", () => {
	const now = new Date().toISOString();

	function createThread(
		db: Database,
		userId: string,
		threadId: string,
		title: string,
		messageCount: number,
		summary?: string,
	): string {
		const lastMessageAt = new Date(Date.now() + Math.random() * 10000).toISOString();
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: Math.floor(Math.random() * 8),
				title,
				summary: summary || null,
				created_at: now,
				last_message_at: lastMessageAt,
				modified_at: now,
				deleted: 0,
			},
			userId,
		);

		// Add messages to the thread
		for (let i = 0; i < messageCount; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`msg-${randomBytes(8).toString("hex")}`,
					threadId,
					"user",
					"test",
					null,
					now,
					now,
					"local",
					0,
				],
			);
		}

		return lastMessageAt;
	}

	it("does not include 'Summary:' line in output text (R-VC23)", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId1 = randomBytes(8).toString("hex");
		const threadId2 = randomBytes(8).toString("hex");

		createThread(db, userId, threadId1, "Thread One", 2, "This is a very important summary.");
		createThread(db, userId, threadId2, "Thread Two", 3, "Another important summary.");

		const result = buildCrossThreadDigest(db, userId);

		// Should not contain the summary excerpt pattern "  Summary: ..."
		expect(result.text).not.toContain("  Summary:");
		expect(result.text).not.toContain("This is a very important summary.");
		expect(result.text).not.toContain("Another important summary.");
	});

	it("populates entries[] array with structured rows", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId1 = randomBytes(8).toString("hex");
		const threadId2 = randomBytes(8).toString("hex");

		// Create threads with fixed timestamps to ensure ordering
		// The query sorts by last_message_at DESC, so ts2 will be first
		const ts1Old = new Date(Date.now() - 5000).toISOString();
		const ts2New = new Date(Date.now() + 5000).toISOString();

		insertRow(
			db,
			"threads",
			{
				id: threadId1,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "First Thread",
				summary: "Summary A",
				created_at: now,
				last_message_at: ts1Old,
				modified_at: now,
				deleted: 0,
			},
			userId,
		);
		for (let i = 0; i < 5; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`msg-${randomBytes(8).toString("hex")}`,
					threadId1,
					"user",
					"test",
					null,
					now,
					now,
					"local",
					0,
				],
			);
		}

		insertRow(
			db,
			"threads",
			{
				id: threadId2,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 1,
				title: "Second Thread",
				summary: "Summary B",
				created_at: now,
				last_message_at: ts2New,
				modified_at: now,
				deleted: 0,
			},
			userId,
		);
		for (let i = 0; i < 3; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`msg-${randomBytes(8).toString("hex")}`,
					threadId2,
					"user",
					"test",
					null,
					now,
					now,
					"local",
					0,
				],
			);
		}

		const result = buildCrossThreadDigest(db, userId);

		expect(result.entries).toHaveLength(2);

		// Most recent first (DESC order by last_message_at)
		const entry1 = result.entries[0];
		const entry2 = result.entries[1];

		expect(entry1).toEqual({
			title: "Second Thread",
			messageCount: 3,
			lastUpdatedAt: ts2New,
		});

		expect(entry2).toEqual({
			title: "First Thread",
			messageCount: 5,
			lastUpdatedAt: ts1Old,
		});
	});

	it("excludeThreadId excludes that thread from entries", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId1 = randomBytes(8).toString("hex");
		const threadId2 = randomBytes(8).toString("hex");
		const threadId3 = randomBytes(8).toString("hex");

		createThread(db, userId, threadId1, "Thread A", 1);
		createThread(db, userId, threadId2, "Thread B", 2);
		createThread(db, userId, threadId3, "Thread C", 3);

		const result = buildCrossThreadDigest(db, userId, threadId2);

		// Should exclude threadId2
		expect(result.entries).toHaveLength(2);
		expect(result.entries.map((e) => e.title)).not.toContain("Thread B");
		expect(result.entries.map((e) => e.title)).toContain("Thread A");
		expect(result.entries.map((e) => e.title)).toContain("Thread C");
	});

	it("empty result preserves empty-result string", () => {
		const userId = randomBytes(8).toString("hex");

		const result = buildCrossThreadDigest(db, userId);

		expect(result.text).toBe("No recent activity.");
		expect(result.entries).toHaveLength(0);
		expect(result.sources).toHaveLength(0);
	});

	it("text line shape matches R-VC7 pattern", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId1 = randomBytes(8).toString("hex");
		const threadId2 = randomBytes(8).toString("hex");

		createThread(db, userId, threadId1, "First Thread", 5);
		createThread(db, userId, threadId2, "Second Thread", 3);

		const result = buildCrossThreadDigest(db, userId);
		const lines = result.text.split("\n");

		// Pattern: - <title>: N messages (last updated <timestamp>)
		const pattern = /^- .+: \d+ messages \(last updated .+\)$/;

		for (const line of lines) {
			expect(line).toMatch(pattern);
		}
	});

	it("CrossThreadSource preservation (back-compat)", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId1 = randomBytes(8).toString("hex");
		const threadId2 = randomBytes(8).toString("hex");

		createThread(db, userId, threadId1, "Thread with Summary", 2, "Summary content");
		createThread(db, userId, threadId2, "Thread without Summary", 1);

		const result = buildCrossThreadDigest(db, userId);

		// Only threads with summaries are in sources
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]).toHaveProperty("threadId");
		expect(result.sources[0]).toHaveProperty("title");
		expect(result.sources[0]).toHaveProperty("color");
		expect(result.sources[0]).toHaveProperty("messageCount");
		expect(result.sources[0]).toHaveProperty("lastMessageAt");
	});
});
