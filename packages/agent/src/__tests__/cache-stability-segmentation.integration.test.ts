import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { annotateMessages } from "../annotation/annotate";
import { resolveSegments, segmentAssembledMessages } from "../delegation-segments";

/**
 * AC.10 — prompt-cache stability survives segmentation.
 *
 * Across consecutive turns of a delegated thread where no PRIOR row changes, the
 * resolved cacheable prefix (the confirmed-synced range) must be byte-stable
 * turn-over-turn, and the inline→range fold (as sync confirmation advances)
 * must NOT move the cache breakpoint byte position.
 *
 * Model: a thread's history rows are confirmed-synced up to a watermark. Turn N
 * ships the confirmed prefix as a range + the unconfirmed tail inline. By turn
 * N+1 the tail has confirmed-synced, so it folds INTO the range. The bytes the
 * model sees for the unchanged prefix must be identical across turns — that is
 * what keeps the provider's prompt cache warm.
 */
describe("cache stability across segmentation (AC.10)", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	function seedMessage(role: "user" | "assistant", content: string, iso: string): void {
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, host_origin, tool_name, created_at, modified_at, metadata, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[randomUUID(), threadId, role, content, null, "spoke", null, iso, iso, null, 0],
		);
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cache-stability-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
		threadId = randomUUID();
		const base = Date.parse("2026-06-29T12:00:00.000Z");
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				"u1",
				"web",
				"spoke",
				0,
				"T",
				null,
				null,
				null,
				null,
				new Date(base).toISOString(),
				new Date(base).toISOString(),
				new Date(base).toISOString(),
				0,
			],
		);
		// Three history rows + a new tail row, monotonic timestamps.
		seedMessage("user", "turn 1 question", new Date(base + 1000).toISOString());
		seedMessage("assistant", "turn 1 answer", new Date(base + 2000).toISOString());
		seedMessage("user", "turn 2 question", new Date(base + 3000).toISOString());
		seedMessage("assistant", "turn 2 answer", new Date(base + 4000).toISOString());
	});

	afterEach(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	it("the confirmed-synced prefix resolves byte-stably as the inline tail folds into the range", () => {
		const nowMs = Date.parse("2026-06-29T12:00:10.000Z");

		// The producer's assembled messages = the annotated history (the producer
		// assembles the whole thing; here we use the annotated rows as the stable
		// stand-in for the cacheable history portion).
		const rows = db
			.query(
				"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at ASC, rowid ASC",
			)
			.all(threadId) as Parameters<typeof annotateMessages>[0]["messages"];
		const producerMessages = annotateMessages({ messages: rows, nowMs });

		// TURN N: only the first 2 rows are confirmed-synced; rows 3-4 are inline.
		const coverableFirst2 = new Set([rows[0].id, rows[1].id]);
		const segmentsTurnN = segmentAssembledMessages({
			db,
			threadId,
			producerMessages,
			nowMs,
			isRangeCoverable: (r) => coverableFirst2.has(r.id),
		});
		const resolvedN = resolveSegments(segmentsTurnN, db, nowMs);

		// TURN N+1: the tail has confirmed-synced — ALL 4 rows are now coverable.
		const segmentsTurnN1 = segmentAssembledMessages({
			db,
			threadId,
			producerMessages,
			nowMs,
			isRangeCoverable: () => true,
		});
		const resolvedN1 = resolveSegments(segmentsTurnN1, db, nowMs);

		// The fold changed the segment SHAPE (more covered by the range)...
		const rangeCountN = segmentsTurnN.filter((s) => s.kind === "range").length;
		const inlineCountN = segmentsTurnN.filter((s) => s.kind === "inline").length;
		const rangeCountN1 = segmentsTurnN1.filter((s) => s.kind === "range").length;
		const inlineCountN1 = segmentsTurnN1.filter((s) => s.kind === "inline").length;
		expect(rangeCountN).toBe(1);
		expect(rangeCountN1).toBe(1);
		// Turn N has an inline tail; turn N+1 folded it into the range.
		expect(inlineCountN1).toBeLessThan(inlineCountN);

		// ...but the RESOLVED bytes the model sees are byte-identical across turns
		// — the cache breakpoint (end of the resolved prefix) does not move.
		expect(JSON.stringify(resolvedN1)).toBe(JSON.stringify(resolvedN));
		expect(JSON.stringify(resolvedN)).toBe(JSON.stringify(producerMessages));
	});

	it("an unchanged prefix stays byte-identical across two consecutive resolves", () => {
		const nowMs = Date.parse("2026-06-29T12:00:10.000Z");
		const rows = db
			.query(
				"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at ASC, rowid ASC",
			)
			.all(threadId) as Parameters<typeof annotateMessages>[0]["messages"];
		const producerMessages = annotateMessages({ messages: rows, nowMs });

		const segs = segmentAssembledMessages({
			db,
			threadId,
			producerMessages,
			nowMs,
			isRangeCoverable: () => true,
		});
		// Two independent resolves of the same segments are byte-identical (no
		// hidden wall-clock / ordering nondeterminism in the range resolver).
		expect(JSON.stringify(resolveSegments(segs, db, nowMs))).toBe(
			JSON.stringify(resolveSegments(segs, db, nowMs)),
		);
	});
});
