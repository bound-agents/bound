/**
 * Truncation marker byte stability — the bucket-transition cliff.
 *
 * Background. When `assembleContext` runs out of budget and drops earlier
 * messages, it injects a developer-role "[Context note: N earlier messages
 * were truncated...This thread has M total messages...]" marker so the agent
 * knows context was lost and can query for it. The two counts (`N`
 * truncated, `M` total) are read fresh from the DB on EVERY cold-path
 * assembly:
 *
 *   - `truncatedCount`: returned by `truncateHistoryToBudget`; advances
 *     when more messages get dropped under tighter budget.
 *   - `totalInThread`: a fresh `SELECT COUNT(*) FROM messages` each cold
 *     path; advances by 1 (or 2) per inner-loop iteration as new
 *     assistant + tool_result messages append.
 *
 * The bridge converts this trailing-developer marker into msg[0]'s head-
 * user content (concatenated with the thread summary). msg[0] sits in the
 * cached prefix of EVERY message-level cachePoint. When the marker bytes
 * mutate per turn, the prefix bytes leading up to the cachePoint change,
 * Bedrock's prefix-match misses, and the cumulative cache prefix never
 * grows past the system-anchor floor.
 *
 * Live evidence (thread `7339231f-…` post-throttle):
 *   16:57:16  msg[0]_hash=5ef1e3ab84fd  "This thread has 58 total messages"
 *   16:57:24  msg[0]_hash=39444050f251  "This thread has 60 total messages"
 *   16:57:43  msg[0]_hash=ad69766c78c8  ... etc — different hash every turn
 * cachePoint position byte-stable at 147,044, but the prefix bytes leading
 * to it differ → cache_read stuck at 84,764 (system anchor only) for 7+
 * consecutive turns even though cw=61,164 was being written and the
 * bucket-aligned placer was holding rock-steady.
 *
 * Property pinned here:
 *
 *   T1 (load-bearing) — calling `assembleContext` twice on a truncating
 *      thread with INNER-LOOP-STYLE growth (a few new tool_call /
 *      tool_result messages appended between calls) MUST produce a
 *      byte-equal truncation marker. Today this FAILS because both
 *      `truncatedCount` and `totalInThread` advance by the new-message
 *      delta, mutating the marker bytes.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { assembleContext } from "../context-assembly";

let tmpDir: string;
let db: Database;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "trunc-marker-test-"));
	const dbPath = join(tmpDir, "test.db");
	db = createDatabase(dbPath);
	applySchema(db);
});

afterAll(async () => {
	db.close();
	await cleanupTmpDir(tmpDir);
});

function insertThread(threadId: string, userId: string): void {
	const now = new Date("2026-02-01T02:30:00Z").toISOString();
	db.run(
		"INSERT OR REPLACE INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
		[userId, "Trunc User", now, now, 0],
	);
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[threadId, userId, "web", "local", 0, "T", null, null, null, null, now, now, now, 0],
	);
}

function insertMsg(threadId: string, role: string, content: string, ts: string): void {
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[randomUUID(), threadId, role, content, null, null, ts, ts, "local"],
	);
}

describe("Truncation marker byte stability — bucket-transition cliff", () => {
	it("T1 (load-bearing): inner-loop appends must NOT mutate the truncation marker bytes", () => {
		const threadId = randomUUID();
		const userId = randomUUID();
		insertThread(threadId, userId);

		// Build enough history to force truncation under a tight budget.
		// 60 messages of 200 chars each = ~3.5k tokens at 4 chars/token
		// — comfortably above the 1000-token contextWindow we'll pass.
		const baseTime = new Date("2026-02-01T02:30:00Z").getTime();
		for (let i = 0; i < 60; i++) {
			const role = i % 2 === 0 ? "user" : "assistant";
			const ts = new Date(baseTime + i * 1000).toISOString();
			insertMsg(threadId, role, `Msg ${i} ${"y".repeat(150)}`, ts);
		}

		// Cold path #1.
		const r1 = assembleContext({
			db,
			threadId,
			userId,
			contextWindow: 1000,
		});
		expect(r1.debug.truncated).toBeGreaterThan(0);
		const marker1 = r1.messages.find(
			(m) =>
				m.role === "developer" &&
				typeof m.content === "string" &&
				m.content.includes("earlier messages"),
		);
		expect(marker1).toBeDefined();
		const marker1Bytes = typeof marker1?.content === "string" ? marker1.content : "";

		// Inner-loop append: 2 new messages (asst + tool_result) at later
		// timestamps, mimicking what the agent loop does between cold paths.
		const tailTime = baseTime + 100 * 1000;
		insertMsg(
			threadId,
			"assistant",
			`Inner-loop turn ${"z".repeat(150)}`,
			new Date(tailTime).toISOString(),
		);
		insertMsg(
			threadId,
			"tool_result",
			`Inner-loop result ${"w".repeat(150)}`,
			new Date(tailTime + 1000).toISOString(),
		);

		// Cold path #2 — same thread, 2 more messages in DB.
		const r2 = assembleContext({
			db,
			threadId,
			userId,
			contextWindow: 1000,
		});
		const marker2 = r2.messages.find(
			(m) =>
				m.role === "developer" &&
				typeof m.content === "string" &&
				m.content.includes("earlier messages"),
		);
		expect(marker2).toBeDefined();
		const marker2Bytes = typeof marker2?.content === "string" ? marker2.content : "";

		// LOAD-BEARING: the marker bytes that ride msg[0]'s cached prefix
		// must be byte-equal across consecutive cold-path assemblies on
		// the same thread, otherwise Bedrock's prefix-match misses every
		// turn and the message-level cachePoint never reads back.
		expect(marker2Bytes).toBe(marker1Bytes);
	});
});
