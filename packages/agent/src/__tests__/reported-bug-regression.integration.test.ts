import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { assembleContext, frozenClock } from "../context-assembly";
import { resolveSegments, segmentAssembledMessages } from "../delegation-segments";

/**
 * AC.6 / R-UD15 — reported-bug regression.
 *
 * The original incident: a new web thread's first user message was whole-loop
 * delegated to the hub, which re-assembled context from its own replica BEFORE
 * the spoke's changelog push (carrying that first message) had arrived. Stage 1
 * returned empty history → the model was called with `history: 0` and no user
 * message.
 *
 * Under the single delegation path the producer assembles locally and ships
 * SEGMENTS; the consumer never re-assembles. This test reproduces the failure
 * precondition deterministically: the changelog push to the hub is "held" — the
 * consumer's confirmed-sync watermark is HLC_ZERO, so NO message row is
 * range-coverable. The segmenter must therefore ship the ENTIRE history
 * (including the first user message) INLINE, and the consumer's resolved
 * messages must be non-empty and carry the user message verbatim.
 *
 * On the OLD `process` path this scenario produced empty history; here it
 * cannot, because the producer assembled where the data provably exists and the
 * inline segments carry it on the wire regardless of sync state.
 */
describe("reported-bug regression: delegated first message (AC.6 / R-UD15)", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;
	let userId: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "reported-bug-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);

		userId = randomUUID();
		threadId = randomUUID();
		const iso = "2026-06-29T12:00:00.000Z";
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Kara", null, iso, iso, 0],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[threadId, userId, "web", "spoke", 0, "New Thread", null, null, null, null, iso, iso, iso, 0],
		);
		// The first user message — the one that vanished in the original bug.
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, host_origin, tool_name, created_at, modified_at, metadata, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId,
				"user",
				"What is my first message?",
				null,
				"spoke",
				null,
				iso,
				iso,
				null,
				0,
			],
		);
	});

	afterEach(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	it("delivers the first user message inline when the changelog push is held (history non-empty)", () => {
		const clock = frozenClock(Date.parse("2026-06-29T12:00:05.000Z"));

		// Producer assembles locally — where the message provably exists.
		const assembled = assembleContext({ db, threadId, userId, clock });
		expect(assembled.messages.length).toBeGreaterThan(0);

		// The changelog push to the consumer (hub) is HELD: nothing is
		// confirmed-synced. Model the held push by making EVERY row
		// non-range-coverable (confirmed watermark HLC_ZERO ⇒ no row qualifies).
		const segments = segmentAssembledMessages({
			db,
			threadId,
			producerMessages: assembled.messages,
			nowMs: clock.nowMs(),
			isRangeCoverable: () => false, // held push: nothing confirmed-synced
		});

		// With nothing confirmed-synced, there is NO range segment — the entire
		// history travels inline.
		expect(segments.every((s) => s.kind === "inline")).toBe(true);
		expect(segments.length).toBe(assembled.messages.length);

		// The consumer resolves the segments WITHOUT re-assembling from its own
		// (un-synced) replica. History is non-empty and byte-identical to the
		// producer's — the user message is present.
		const resolved = resolveSegments(segments, db, clock.nowMs());
		expect(resolved.length).toBe(assembled.messages.length);
		expect(JSON.stringify(resolved)).toBe(JSON.stringify(assembled.messages));

		// Concretely: the first user message survived to the consumer's prompt.
		const flat = JSON.stringify(resolved);
		expect(flat).toContain("What is my first message?");
	});

	it("still delivers the user message inline even when the consumer DB has no rows (cross-host)", () => {
		// Simulate the consumer being a DIFFERENT host whose replica has not
		// synced the thread at all: resolve the producer's segments against an
		// empty consumer DB. Because the segments are all-inline (held push),
		// resolution does not touch the consumer's message rows — so it succeeds
		// with the full history even though the consumer holds nothing.
		const clock = frozenClock(Date.parse("2026-06-29T12:00:05.000Z"));
		const assembled = assembleContext({ db, threadId, userId, clock });
		const segments = segmentAssembledMessages({
			db,
			threadId,
			producerMessages: assembled.messages,
			nowMs: clock.nowMs(),
			isRangeCoverable: () => false,
		});

		const consumerTmp = mkdtempSync(join(tmpdir(), "reported-bug-consumer-"));
		const consumerDb = createDatabase(join(consumerTmp, "consumer.db"));
		try {
			applySchema(consumerDb);
			applyMetricsSchema(consumerDb);
			// Consumer DB is EMPTY for this thread (un-synced replica).
			const resolved = resolveSegments(segments, consumerDb, clock.nowMs());
			expect(resolved.length).toBe(assembled.messages.length);
			expect(JSON.stringify(resolved)).toContain("What is my first message?");
		} finally {
			consumerDb.close();
			void cleanupTmpDir(consumerTmp);
		}
	});
});
