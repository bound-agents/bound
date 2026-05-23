import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import {
	type BuilderContext,
	makeAppliedAdvisory,
	makeDetail,
	makeFileMod,
	makePinned,
	makeSiblingThread,
	makeStaleChild,
	makeSummary,
} from "./builders";

describe("volatile-context builders smoke tests", () => {
	let db: Database;
	const siteId = "test-site";
	const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("makePinned creates pinned entries", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		makePinned(ctx, 5);
		const result = db
			.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE tier='pinned'")
			.get() as { count: number };
		expect(result.count).toBe(5);
	});

	it("makeSummary creates summary entries", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		makeSummary(ctx, 3);
		const result = db
			.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE tier='summary'")
			.get() as { count: number };
		expect(result.count).toBe(3);
	});

	it("makeDetail creates detail entries with edges", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		const summaryKeys = makeSummary(ctx, 1);
		makeDetail(ctx, 4, summaryKeys[0]);
		const detailResult = db
			.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE tier='detail'")
			.get() as { count: number };
		expect(detailResult.count).toBe(4);

		const edgeResult = db
			.prepare("SELECT COUNT(*) as count FROM memory_edges WHERE deleted=0")
			.get() as { count: number };
		expect(edgeResult.count).toBe(4);
	});

	it("makeStaleChild creates stale child with edge", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		const summaryKeys = makeSummary(ctx, 1);
		const staleKey = makeStaleChild(ctx, summaryKeys[0], new Date(ctx.nowMs - 5000).toISOString());
		const edgeResult = db
			.prepare("SELECT COUNT(*) as count FROM memory_edges WHERE target_key=? AND deleted=0", [
				staleKey,
			])
			.get() as { count: number };
		expect(edgeResult.count).toBe(1);
	});

	it("makeSiblingThread creates thread with messages", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		const threadId = makeSiblingThread(ctx, "Test Thread", 3, "Optional summary");

		const threadResult = db
			.prepare("SELECT COUNT(*) as count FROM threads WHERE id=? AND deleted=0", [threadId])
			.get() as { count: number };
		expect(threadResult.count).toBe(1);

		const msgResult = db
			.prepare("SELECT COUNT(*) as count FROM messages WHERE thread_id=? AND deleted=0", [threadId])
			.get() as { count: number };
		expect(msgResult.count).toBe(3);
	});

	it("makeAppliedAdvisory creates applied advisory", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		makeAppliedAdvisory(ctx, "Test Advisory", 2);
		const result = db
			.prepare("SELECT COUNT(*) as count FROM advisories WHERE status='applied' AND deleted=0")
			.get() as { count: number };
		expect(result.count).toBe(1);
	});

	it("makeFileMod creates file tracking entry", () => {
		const ctx: BuilderContext = { db, siteId, nowMs };
		const threadId = makeSiblingThread(ctx, "Test Thread", 1, null);
		makeFileMod(ctx, "/test/file.txt", threadId);

		const result = db
			.prepare(
				"SELECT COUNT(*) as count FROM semantic_memory WHERE key LIKE '_internal.file_thread.%' AND deleted=0",
			)
			.get() as { count: number };
		expect(result.count).toBe(1);
	});

	it("builders use deterministic UUIDs for idempotence", () => {
		// Verify that calling with the same input produces the same UUID
		// by checking the generated key
		const ctx: BuilderContext = { db, siteId, nowMs };
		const summaryKeys1 = makeSummary(ctx, 1);
		const expectedKey = "_summary:topic-0";
		expect(summaryKeys1[0]).toBe(expectedKey);

		// Verify thread ID is deterministic based on title
		// by checking that the UUID is always the same for the same input
		const threadId1 = makeSiblingThread(ctx, "DeterministicTest", 1, null);
		const threadId2 = deterministicUUID(BOUND_NAMESPACE, "DeterministicTest:thread");
		expect(threadId1).toBe(threadId2);
	});
});
