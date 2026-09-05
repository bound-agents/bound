import type { Database } from "bun:sqlite";
import { insertRow } from "@bound/core";
import type { SyncedTableName, SyncedTableRowMap, TaskType } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { upsertEdge } from "../../../graph-queries";

/** Builder fixtures for volatile-context snapshot tests. */

export interface BuilderContext {
	db: Database;
	siteId: string;
	nowMs: number;
	userId?: string;
	_detailCounter?: { current: number };
}

function insertFixtureRow<T extends SyncedTableName>(
	ctx: BuilderContext,
	table: T,
	row: SyncedTableRowMap[T],
): void {
	insertRow(ctx.db, table, row, ctx.siteId);
}

function timestamp(ctx: BuilderContext, offsetMs = 0): string {
	return new Date(ctx.nowMs - offsetMs).toISOString();
}

function insertMemory(
	ctx: BuilderContext,
	{
		key,
		value,
		tier,
		at = timestamp(ctx),
	}: Pick<SyncedTableRowMap["semantic_memory"], "key" | "value" | "tier"> & {
		at?: string;
	},
): void {
	insertFixtureRow(ctx, "semantic_memory", {
		id: deterministicUUID(BOUND_NAMESPACE, key),
		key,
		value,
		tier,
		source: "fixture",
		created_at: at,
		modified_at: at,
		last_accessed_at: at,
		deleted: 0,
	});
}

/** Insert N pinned memory entries with deterministic UUIDs and timestamps. */
export function makePinned(ctx: BuilderContext, count: number, prefix = "_pinned:"): void {
	for (let i = 0; i < count; i++) {
		const key = `${prefix}${i}`;
		insertMemory(ctx, {
			key,
			value: `pinned body ${i}`,
			tier: "pinned",
			at: timestamp(ctx, i * 1000),
		});
	}
}

/** Insert N summary memory entries and return their keys. */
export function makeSummary(ctx: BuilderContext, count: number): string[] {
	return Array.from({ length: count }, (_, i) => {
		const key = `_summary:topic-${i}`;
		insertMemory(ctx, {
			key,
			value: `Summary for topic ${i}: this is a brief overview.`,
			tier: "summary",
			at: timestamp(ctx, (i + 1) * 1000),
		});
		return key;
	});
}

/** Insert N detail memory entries, optionally as children of a parent summary. */
export function makeDetail(
	ctx: BuilderContext,
	count: number,
	parentKey: string | null = null,
): string[] {
	if (!ctx._detailCounter) ctx._detailCounter = { current: 0 };
	const detailCounter = ctx._detailCounter;
	return Array.from({ length: count }, (_, i) => {
		const idx = detailCounter.current++;
		const key = `curiosity:item-${idx}-det${idx.toString().padStart(6, "0")}`;
		insertMemory(ctx, {
			key,
			value: `Detail entry ${i}: specific observation or fact.`,
			tier: "detail",
			at: timestamp(ctx, (i + 100) * 1000),
		});
		if (parentKey) upsertEdge(ctx.db, parentKey, key, "summarizes", 1.0, ctx.siteId);
		return key;
	});
}

/** Create a stale-child detail entry (modified after its parent summary). */
export function makeStaleChild(
	ctx: BuilderContext,
	parentSummaryKey: string,
	parentModifiedAt: string,
	deterministicSuffix = "det000000",
): string {
	const key = `detail:stale-${deterministicSuffix}`;
	const at = new Date(new Date(parentModifiedAt).getTime() + 2000).toISOString();
	insertMemory(ctx, {
		key,
		value: "Stale child detail: added after parent was finalized.",
		tier: "detail",
		at,
	});
	upsertEdge(ctx.db, parentSummaryKey, key, "summarizes", 1.0, ctx.siteId);
	return key;
}

/** Create a sibling thread (not the current agent thread) with optional summary. */
export function makeSiblingThread(
	ctx: BuilderContext,
	title: string,
	messageCount: number,
	summaryText: string | null,
): string {
	const threadId = deterministicUUID(BOUND_NAMESPACE, `${title}:thread`);
	const now = timestamp(ctx);
	insertFixtureRow(ctx, "threads", {
		id: threadId,
		user_id: ctx.userId || deterministicUUID(BOUND_NAMESPACE, `${title}:user`),
		interface: "web",
		host_origin: "fixture-host",
		color: 0,
		title,
		summary: summaryText,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: now,
		last_message_at: timestamp(ctx, messageCount > 0 ? 1000 : 0),
		modified_at: now,
		deleted: 0,
		model_hint: null,
	});
	for (let i = 0; i < messageCount; i++) {
		insertFixtureRow(ctx, "messages", {
			id: deterministicUUID(BOUND_NAMESPACE, `${title}:msg-${i}`),
			thread_id: threadId,
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Message ${i} in thread ${title}`,
			created_at: timestamp(ctx, (messageCount - i) * 1000),
			host_origin: "fixture-host",
			deleted: 0,
			model_id: null,
			tool_name: null,
			modified_at: null,
			exit_code: null,
			metadata: null,
		});
	}
	return threadId;
}

/** Create an applied advisory resolved N hours ago. */
export function makeAppliedAdvisory(
	ctx: BuilderContext,
	title: string,
	appliedHoursAgo: number,
	useCurrentTime = false,
): void {
	const baseTime = useCurrentTime ? Date.now() : ctx.nowMs;
	insertFixtureRow(ctx, "advisories", {
		id: deterministicUUID(BOUND_NAMESPACE, `${title}:advisory`),
		type: "general",
		status: "applied",
		title,
		detail: `Advisory detail for: ${title}`,
		action: null,
		impact: null,
		evidence: null,
		proposed_at: new Date(ctx.nowMs - (appliedHoursAgo + 1) * 3600_000).toISOString(),
		defer_until: null,
		resolved_at: new Date(baseTime - appliedHoursAgo * 3600_000).toISOString(),
		created_by: null,
		thread_id: null,
		resolved_by: null,
		resolution_note: null,
		modified_at: new Date(baseTime).toISOString(),
		deleted: 0,
	});
}

/** Record the file-thread tracking entry required for Live State file modifications. */
export function makeFileMod(ctx: BuilderContext, path: string, threadId: string): void {
	insertMemory(ctx, {
		key: `_internal.file_thread.${path}`,
		value: threadId,
		tier: "pinned",
	});
}

/** Create a recently-running task that surfaces in Live State. */
export function makeTask(
	ctx: BuilderContext,
	taskType: TaskType,
	title: string,
	hoursAgo = 0,
): string {
	const taskId = deterministicUUID(BOUND_NAMESPACE, `${title}:task`);
	const now = timestamp(ctx);
	insertFixtureRow(ctx, "tasks", {
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
		last_run_at: timestamp(ctx, hoursAgo * 3600_000),
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
	});
	return taskId;
}
