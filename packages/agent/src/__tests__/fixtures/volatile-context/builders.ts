import type { Database } from "bun:sqlite";
import { insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID, randomUUID } from "@bound/shared";
import { upsertEdge } from "../../../graph-queries";

export interface BuilderContext {
	db: Database;
	siteId: string;
	nowMs: number;
}

/**
 * Insert N pinned memory entries with deterministic UUIDs and timestamps.
 */
export function makePinned(ctx: BuilderContext, count: number, prefix = "_pinned:"): void {
	for (let i = 0; i < count; i++) {
		const key = `${prefix}${i}`;
		const timestamp = new Date(ctx.nowMs - i * 1000).toISOString();
		insertRow(
			ctx.db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, key),
				key,
				value: `pinned body ${i}`,
				tier: "pinned",
				source: "fixture",
				created_at: timestamp,
				modified_at: timestamp,
				last_accessed_at: timestamp,
				deleted: 0,
			},
			ctx.siteId,
		);
	}
}

/**
 * Insert N summary memory entries and return their keys.
 */
export function makeSummary(ctx: BuilderContext, count: number): string[] {
	const keys: string[] = [];
	for (let i = 0; i < count; i++) {
		const key = `_summary:topic-${i}`;
		keys.push(key);
		const timestamp = new Date(ctx.nowMs - (i + 1) * 1000).toISOString();
		insertRow(
			ctx.db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, key),
				key,
				value: `Summary for topic ${i}: this is a brief overview.`,
				tier: "summary",
				source: "fixture",
				created_at: timestamp,
				modified_at: timestamp,
				last_accessed_at: timestamp,
				deleted: 0,
			},
			ctx.siteId,
		);
	}
	return keys;
}

/**
 * Insert N detail memory entries, optionally as children of a parent summary.
 * Returns the keys of the inserted entries.
 */
export function makeDetail(
	ctx: BuilderContext,
	count: number,
	parentKey: string | null = null,
): string[] {
	const keys: string[] = [];
	for (let i = 0; i < count; i++) {
		const suffix = randomSuffix();
		const key = `curiosity:item-${i}-${suffix}`;
		keys.push(key);

		// Stagger timestamps so entries are ordered by last_accessed_at
		const timestamp = new Date(ctx.nowMs - (i + 100) * 1000).toISOString();
		insertRow(
			ctx.db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, key),
				key,
				value: `Detail entry ${i}: specific observation or fact.`,
				tier: "detail",
				source: "fixture",
				created_at: timestamp,
				modified_at: timestamp,
				last_accessed_at: timestamp,
				deleted: 0,
			},
			ctx.siteId,
		);

		// Link to parent summary if provided
		if (parentKey) {
			upsertEdge(ctx.db, parentKey, key, "summarizes", 1.0, ctx.siteId);
		}
	}
	return keys;
}

/**
 * Create a stale-child detail entry (modified after its parent summary).
 * Returns the key of the inserted entry.
 */
export function makeStaleChild(
	ctx: BuilderContext,
	parentSummaryKey: string,
	parentModifiedAt: string,
): string {
	const suffix = randomSuffix();
	const key = `detail:stale-${suffix}`;

	// Child modified AFTER parent
	const parentMs = new Date(parentModifiedAt).getTime();
	const childTimestamp = new Date(parentMs + 2000).toISOString();

	insertRow(
		ctx.db,
		"semantic_memory",
		{
			id: deterministicUUID(BOUND_NAMESPACE, key),
			key,
			value: "Stale child detail: added after parent was finalized.",
			tier: "detail",
			source: "fixture",
			created_at: childTimestamp,
			modified_at: childTimestamp,
			last_accessed_at: childTimestamp,
			deleted: 0,
		},
		ctx.siteId,
	);

	// Link to parent
	upsertEdge(ctx.db, parentSummaryKey, key, "summarizes", 1.0, ctx.siteId);

	return key;
}

/**
 * Create a sibling thread (not the current agent thread) with optional summary.
 * Returns the thread ID.
 */
export function makeSiblingThread(
	ctx: BuilderContext,
	title: string,
	messageCount: number,
	summaryText: string | null,
): string {
	const threadId = randomUUID();
	const userId = `user-${randomSuffix()}`;

	const now = new Date(ctx.nowMs).toISOString();

	insertRow(
		ctx.db,
		"threads",
		{
			id: threadId,
			user_id: userId,
			interface: "web",
			host_origin: "fixture-host",
			color: 0,
			title,
			summary: summaryText,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: new Date(ctx.nowMs - messageCount * 1000).toISOString(),
			modified_at: now,
			deleted: 0,
			model_hint: null,
		},
		ctx.siteId,
	);

	// Insert N messages
	for (let i = 0; i < messageCount; i++) {
		const msgId = randomUUID();
		const msgTime = new Date(ctx.nowMs - (messageCount - i) * 1000).toISOString();
		insertRow(
			ctx.db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: i % 2 === 0 ? "user" : "assistant",
				content: `Message ${i} in thread ${title}`,
				created_at: msgTime,
				host_origin: "fixture-host",
				deleted: 0,
				model_id: null,
				tool_name: null,
				modified_at: null,
				exit_code: null,
				metadata: null,
			},
			ctx.siteId,
		);
	}

	return threadId;
}

/**
 * Create an advisory with status='applied' and resolved_at set to N hours ago.
 */
export function makeAppliedAdvisory(
	ctx: BuilderContext,
	title: string,
	appliedHoursAgo: number,
): void {
	const resolvedAt = new Date(ctx.nowMs - appliedHoursAgo * 3600_000).toISOString();
	const now = new Date(ctx.nowMs).toISOString();

	insertRow(
		ctx.db,
		"advisories",
		{
			id: randomUUID(),
			type: "general",
			status: "applied",
			title,
			detail: `Advisory detail for: ${title}`,
			action: null,
			impact: null,
			evidence: null,
			proposed_at: new Date(ctx.nowMs - (appliedHoursAgo + 1) * 3600_000).toISOString(),
			defer_until: null,
			resolved_at: resolvedAt,
			created_by: null,
			modified_at: now,
			deleted: 0,
		},
		ctx.siteId,
	);
}

/**
 * Record a file modification for the given path.
 * Uses insertRow to create a tracking entry if needed.
 */
export function makeFileMod(ctx: BuilderContext, path: string, _threadTitle: string): void {
	const now = new Date(ctx.nowMs).toISOString();

	insertRow(
		ctx.db,
		"files",
		{
			id: deterministicUUID(BOUND_NAMESPACE, path),
			path,
			content: null,
			is_binary: 0,
			size_bytes: 1024,
			created_at: now,
			modified_at: now,
			deleted: 0,
			created_by: null,
			host_origin: "fixture-host",
		},
		ctx.siteId,
	);
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

/**
 * Smoke test: verify builders work by calling each once and checking row counts.
 * This test runs inline in the builders file to validate the entire set of helpers.
 */
if (import.meta.main) {
	const { Database } = await import("bun:sqlite");
	const { applySchema } = await import("@bound/core");

	console.log("Running builders smoke test...");

	const db = new Database(":memory:");
	applySchema(db);

	const ctx: BuilderContext = {
		db,
		siteId: "test-site",
		nowMs: new Date("2026-05-22T00:00:00.000Z").getTime(),
	};

	// Test makePinned
	makePinned(ctx, 5);
	let result = db
		.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE tier='pinned'")
		.get() as { count: number };
	console.log(`makePinned(5): ${result.count} pinned entries`);
	if (result.count !== 5) throw new Error("makePinned failed");

	// Test makeSummary
	const summaryKeys = makeSummary(ctx, 3);
	result = db
		.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE tier='summary'")
		.get() as { count: number };
	console.log(`makeSummary(3): ${result.count} summary entries`);
	if (result.count !== 3) throw new Error("makeSummary failed");

	// Test makeDetail
	const _detailKeys = makeDetail(ctx, 4, summaryKeys[0]);
	result = db
		.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE tier='detail'")
		.get() as { count: number };
	console.log(`makeDetail(4): ${result.count} detail entries`);
	if (result.count !== 4) throw new Error("makeDetail failed");

	// Test memory_edges created by makeDetail
	result = db.prepare("SELECT COUNT(*) as count FROM memory_edges WHERE deleted=0").get() as {
		count: number;
	};
	console.log(`  with ${result.count} edges linking to parent`);
	if (result.count !== 4) throw new Error("makeDetail edges failed");

	// Test makeStaleChild
	const staleKey = makeStaleChild(ctx, summaryKeys[1], new Date(ctx.nowMs - 5000).toISOString());
	result = db
		.prepare("SELECT COUNT(*) as count FROM memory_edges WHERE target_key=? AND deleted=0", [
			staleKey,
		])
		.get() as { count: number };
	console.log(`makeStaleChild: created with ${result.count} edge`);
	if (result.count !== 1) throw new Error("makeStaleChild failed");

	// Test makeSiblingThread
	const threadId = makeSiblingThread(ctx, "Test Thread", 3, "Optional summary");
	result = db
		.prepare("SELECT COUNT(*) as count FROM threads WHERE id=? AND deleted=0", [threadId])
		.get() as { count: number };
	console.log(`makeSiblingThread: ${result.count} thread created`);
	if (result.count !== 1) throw new Error("makeSiblingThread thread failed");

	result = db
		.prepare("SELECT COUNT(*) as count FROM messages WHERE thread_id=? AND deleted=0", [threadId])
		.get() as { count: number };
	console.log(`  with ${result.count} messages`);
	if (result.count !== 3) throw new Error("makeSiblingThread messages failed");

	// Test makeAppliedAdvisory
	makeAppliedAdvisory(ctx, "Test Advisory", 2);
	result = db
		.prepare("SELECT COUNT(*) as count FROM advisories WHERE status='applied' AND deleted=0")
		.get() as { count: number };
	console.log(`makeAppliedAdvisory: ${result.count} advisory created`);
	if (result.count !== 1) throw new Error("makeAppliedAdvisory failed");

	// Test makeFileMod
	makeFileMod(ctx, "/test/file.txt", "Test Thread");
	result = db
		.prepare("SELECT COUNT(*) as count FROM files WHERE path=? AND deleted=0", ["/test/file.txt"])
		.get() as { count: number };
	console.log(`makeFileMod: ${result.count} file entry created`);
	if (result.count !== 1) throw new Error("makeFileMod failed");

	db.close();

	console.log("All builders smoke test passed!");
	process.exit(0);
}
