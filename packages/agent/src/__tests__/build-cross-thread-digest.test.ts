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

	it("attaches client-session host(s) to the matching entry, tagged live/stale", () => {
		const userId = randomBytes(8).toString("hex");
		const liveThreadId = randomBytes(8).toString("hex");
		const staleThreadId = randomBytes(8).toString("hex");
		const noSessThreadId = randomBytes(8).toString("hex");

		// Newest -> oldest so the DESC ordering is deterministic.
		const tsLive = new Date(Date.now() + 9000).toISOString();
		const tsStale = new Date(Date.now() + 6000).toISOString();
		const tsNone = new Date(Date.now() + 3000).toISOString();
		createThread(db, userId, liveThreadId, "Live Session Thread", 1);
		createThread(db, userId, staleThreadId, "Stale Session Thread", 1);
		createThread(db, userId, noSessThreadId, "No Session Thread", 1);
		// Pin the last_message_at ordering (createThread randomizes it).
		db.run("UPDATE threads SET last_message_at = ? WHERE id = ?", [tsLive, liveThreadId]);
		db.run("UPDATE threads SET last_message_at = ? WHERE id = ?", [tsStale, staleThreadId]);
		db.run("UPDATE threads SET last_message_at = ? WHERE id = ?", [tsNone, noSessThreadId]);

		const liveSite = randomBytes(8).toString("hex");
		const staleSite = randomBytes(8).toString("hex");
		// A host with a fresh modified_at is "live"; one well past the staleness window is "stale".
		const fresh = new Date().toISOString();
		const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: liveSite,
				host_name: "mac-studio",
				online_at: fresh,
				modified_at: fresh,
				deleted: 0,
			},
			userId,
		);
		insertRow(
			db,
			"hosts",
			{ site_id: staleSite, host_name: "old-laptop", online_at: old, modified_at: old, deleted: 0 },
			userId,
		);
		insertRow(
			db,
			"client_sessions",
			{
				id: randomBytes(8).toString("hex"),
				connection_id: randomBytes(8).toString("hex"),
				thread_id: liveThreadId,
				site_id: liveSite,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			userId,
		);
		insertRow(
			db,
			"client_sessions",
			{
				id: randomBytes(8).toString("hex"),
				connection_id: randomBytes(8).toString("hex"),
				thread_id: staleThreadId,
				site_id: staleSite,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			userId,
		);

		const result = buildCrossThreadDigest(db, userId);
		const byTitle = new Map(result.entries.map((e) => [e.title, e]));

		expect(byTitle.get("Live Session Thread")?.sessions).toEqual([
			{ hostName: "mac-studio", live: true },
		]);
		expect(byTitle.get("Stale Session Thread")?.sessions).toEqual([
			{ hostName: "old-laptop", live: false },
		]);
		// A thread with no client session carries no sessions field at all.
		expect(byTitle.get("No Session Thread")?.sessions).toBeUndefined();
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
