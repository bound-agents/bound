import type { Database } from "bun:sqlite";
import { insertRow } from "@bound/core";
import type { TaskType } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { upsertEdge } from "../../../graph-queries";

/**
 * Builder fixtures for volatile-context snapshot tests.
 *
 * Note on leading underscore key prefixes (`_pinned:`, `_summary:`,
 * `_internal.file_thread.*`): these are intentional namespacing to
 * avoid collisions with production memory keys. They are NAMES only
 * — tier is set explicitly on every insert. Tier-from-prefix
 * inference was removed from the production codebase; the names
 * survive as a human-facing convention, nothing more.
 */

export interface BuilderContext {
	db: Database;
	siteId: string;
	nowMs: number;
	userId?: string;
	_detailCounter?: { current: number };
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
	if (!ctx._detailCounter) {
		ctx._detailCounter = { current: 0 };
	}
	const keys: string[] = [];
	for (let i = 0; i < count; i++) {
		const idx = ctx._detailCounter.current++;
		const suffix = `det${idx.toString().padStart(6, "0")}`;
		const key = `curiosity:item-${idx}-${suffix}`;
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
	_deterministicSuffix = "det000000",
): string {
	const key = `detail:stale-${_deterministicSuffix}`;

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
 * The thread is created with the same user_id as ctx.userId (if provided), or a unique derived ID.
 * Returns the thread ID.
 */
export function makeSiblingThread(
	ctx: BuilderContext,
	title: string,
	messageCount: number,
	summaryText: string | null,
): string {
	const threadKey = `${title}:thread`;
	const threadId = deterministicUUID(BOUND_NAMESPACE, threadKey);
	// Use the context's userId if provided, otherwise derive one from the title
	const userId = ctx.userId || deterministicUUID(BOUND_NAMESPACE, `${title}:user`);

	const now = new Date(ctx.nowMs).toISOString();

	// Calculate last_message_at as the most recent message
	const lastMessageAt = new Date(ctx.nowMs - (messageCount > 0 ? 1000 : 0)).toISOString();

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
			last_message_at: lastMessageAt,
			modified_at: now,
			deleted: 0,
			model_hint: null,
		},
		ctx.siteId,
	);

	// Insert N messages
	for (let i = 0; i < messageCount; i++) {
		const msgKey = `${title}:msg-${i}`;
		const msgId = deterministicUUID(BOUND_NAMESPACE, msgKey);
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
 * If useCurrentTime=true, resolved_at is calculated from Date.now() instead of ctx.nowMs.
 * This is useful in snapshots where the test may run much later than the fixture time.
 */
export function makeAppliedAdvisory(
	ctx: BuilderContext,
	title: string,
	appliedHoursAgo: number,
	useCurrentTime = false,
): void {
	const advisoryKey = `${title}:advisory`;
	const baseTime = useCurrentTime ? Date.now() : ctx.nowMs;
	const resolvedAt = new Date(baseTime - appliedHoursAgo * 3600_000).toISOString();
	const now = new Date(baseTime).toISOString();

	insertRow(
		ctx.db,
		"advisories",
		{
			id: deterministicUUID(BOUND_NAMESPACE, advisoryKey),
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
			thread_id: null,
			modified_at: now,
			deleted: 0,
		},
		ctx.siteId,
	);
}

/**
 * Record a file modification for the given path.
 * Creates a _internal.file_thread.* tracking entry in semantic_memory that points to the last thread
 * that modified the file. This is the precondition for loadFileModificationsForLiveState to surface
 * the file in Live State.
 */
export function makeFileMod(ctx: BuilderContext, path: string, threadId: string): void {
	const key = `_internal.file_thread.${path}`;
	const now = new Date(ctx.nowMs).toISOString();

	insertRow(
		ctx.db,
		"semantic_memory",
		{
			id: deterministicUUID(BOUND_NAMESPACE, key),
			key,
			value: threadId,
			tier: "pinned",
			source: "fixture",
			created_at: now,
			modified_at: now,
			last_accessed_at: now,
			deleted: 0,
		},
		ctx.siteId,
	);
}

/**
 * Create a task that will surface in Live State when buildVolatileEnrichment includes it.
 * Tasks are included in the digest if: status='running' AND last_run_at within recent window.
 * Returns the task ID.
 */
export function makeTask(
	ctx: BuilderContext,
	taskType: TaskType,
	title: string,
	hoursAgo = 0,
): string {
	const taskKey = `${title}:task`;
	const taskId = deterministicUUID(BOUND_NAMESPACE, taskKey);
	const lastRunAt = new Date(ctx.nowMs - hoursAgo * 3600_000).toISOString();
	const now = new Date(ctx.nowMs).toISOString();

	insertRow(
		ctx.db,
		"tasks",
		{
			id: taskId,
			type: taskType,
			status: "running",
			trigger_spec: "fixture",
			payload: JSON.stringify({ title }),
			created_at: now,
			created_by: null,
			thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: null,
			last_run_at: lastRunAt,
			run_count: 1,
			max_runs: null,
			requires: null,
			model_hint: null,
			no_history: 0,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 3,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			modified_at: now,
			deleted: 0,
			origin_thread_id: null,
			system_prompt_addition: null,
		},
		ctx.siteId,
	);

	return taskId;
}
