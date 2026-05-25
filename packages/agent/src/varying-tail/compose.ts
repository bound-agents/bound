/**
 * `composeVolatileVarying` — pure-modulo-`nowMs` renderer for the
 * R-VC24 varying-tail subsection of the volatile context.
 *
 * Unlike the stable side (which forbids wall-clock entirely), the
 * varying side is rebuilt every turn and is allowed to embed
 * relative-time fragments. The architectural promise here is the
 * dual of the stable side: instead of "byte-stable when nothing
 * relevant changed", the varying side promises:
 *
 *   - **Determinism** in `(inputs, nowMs)` — for a fixed input pair,
 *     output is byte-identical across calls and processes.
 *   - **Freshness** — when relevant state changes, the next render
 *     reflects it.
 *   - **Source-label totality** — every Live-State line carries
 *     exactly one `[…]` source label.
 *   - **Subsystem ordering** — R-VC5 fixed: thread → task → file →
 *     advisory → synthesis-backlog.
 *   - **Cap respect under pressure** — at most 3 entries per LS
 *     subsystem when `budgetPressure: true`.
 *   - **Time monotonicity** — given a later `nowMs` and otherwise
 *     identical inputs, no relative-time fragment goes backward.
 *
 * Property tests under `__tests__/compose.property.test.ts` exercise
 * V1-V6 against arbitrary inputs. Parity with the production
 * renderers (`renderWorkingKnowledge.varyingLines`, `formatMemoryEntry`,
 * `renderLiveState`) is pinned by `__tests__/parity-with-production.test.ts`
 * — the renderer here renders directly rather than delegating so the
 * input type can stay narrow.
 */

import { safeSlice } from "@bound/shared";
import {
	BUDGET_PRESSURE_SUBSYSTEM_CAP,
	DELTA_MARKER,
	LIVE_STATE_FOOTER,
	LIVE_STATE_HEADER,
	RECENT_MEMORY_HEADER,
	STALE_CHILD_GLOSS_MAX,
	WORKING_KNOWLEDGE_UPDATES_HEADER,
	relativeTimeAt,
	resolveSource,
	stalenessTagAt,
	truncateGloss,
} from "../summary-extraction";
import type {
	AdvisoryEntryView,
	CrossThreadEntryView,
	FileEntryView,
	LiveStateView,
	RecentMemoryEntryView,
	TaskEntryView,
	VolatileVaryingInputs,
	WorkingKnowledgeUpdatesView,
} from "./types";

/**
 * Render the varying tail (WK update markers + Recent memory block +
 * Live State) as an array of lines. Caller joins with `"\n"` and
 * pushes the result into the developer-role tail message.
 *
 * The function is **pure** in `inputs` alone — including `inputs.nowMs`.
 * No reads from `Date.now()` or any other ambient-time source.
 */
export function composeVolatileVarying(inputs: VolatileVaryingInputs): string[] {
	const lines: string[] = [];
	lines.push(...renderWorkingKnowledgeUpdates(inputs.workingKnowledgeUpdates));
	lines.push(...renderRecentMemoryBlock(inputs.recentMemoryEntries, inputs.nowMs));
	lines.push(...renderLiveStateBlock(inputs.liveState, inputs.budgetPressure, inputs.nowMs));
	return lines;
}

/**
 * Render the `## Working Knowledge — updates` block. Mirrors
 * `renderWorkingKnowledge`'s `varyingLines` channel byte-for-byte.
 *
 * Empty when no pinned/summary deltas exist AND no stale children
 * are present (a hasStaleChildren-equivalent check).
 */
function renderWorkingKnowledgeUpdates(updates: WorkingKnowledgeUpdatesView): string[] {
	const out: string[] = [];

	const hasStaleChildren = updates.summariesWithStaleChildren.some(
		(s) => s.staleChildren.length > 0,
	);
	const hasAnyMarker =
		updates.pinnedDeltaKeys.length > 0 || updates.summaryDeltaKeys.length > 0 || hasStaleChildren;

	if (!hasAnyMarker) return out;

	out.push(WORKING_KNOWLEDGE_UPDATES_HEADER);
	out.push("");

	// R-VC11(b): pinned delta keyed reference (body lives in stable).
	for (const key of updates.pinnedDeltaKeys) {
		out.push(`- ${key} ${DELTA_MARKER}`);
	}

	// R-VC11(a): summary delta keyed reference.
	for (const key of updates.summaryDeltaKeys) {
		out.push(`- ${key} ${DELTA_MARKER}`);
	}

	// R-VC10/R-VC11(c): stale children referenced under their parent.
	// Iteration order follows `summariesWithStaleChildren` array order
	// (which mirrors the parent summaries' WK render order upstream).
	for (const summary of updates.summariesWithStaleChildren) {
		for (const child of summary.staleChildren) {
			const childGloss = truncateGloss(child.value, STALE_CHILD_GLOSS_MAX);
			const staleMarker = `[stale child of ${summary.summaryKey}]`;
			const childDelta = child.isDelta ? ` ${DELTA_MARKER}` : "";
			out.push(`  - ${child.key}: ${childGloss} ${staleMarker}${childDelta}`);
		}
	}

	return out;
}

/**
 * Render the `## Recent memory — graph + recency` block. Empty when
 * the input array is empty (the production code path elides the
 * header in that case).
 */
function renderRecentMemoryBlock(
	entries: ReadonlyArray<RecentMemoryEntryView>,
	nowMs: number,
): string[] {
	if (entries.length === 0) return [];

	const out: string[] = [];
	out.push("");
	out.push(RECENT_MEMORY_HEADER);
	out.push("");
	for (const entry of entries) {
		out.push(formatRecentMemoryLine(entry, nowMs));
	}
	return out;
}

/**
 * Render a single `tier='default'` L2/L3 entry. Mirrors the body of
 * `formatMemoryEntry` in `summary-extraction.ts` — the renderer here
 * must stay byte-equivalent or the parity regression test fails.
 */
function formatRecentMemoryLine(entry: RecentMemoryEntryView, nowMs: number): string {
	const valueDisplay =
		entry.value.length > 200 ? `${safeSlice(entry.value, 0, 200)}...` : entry.value;

	if (entry.deleted) {
		const sourceLabel = resolveSource(
			entry.taskName ?? null,
			entry.threadId ?? null,
			entry.threadTitle ?? null,
			entry.source,
		);
		const relTime = relativeTimeAt(entry.modifiedAt, nowMs);
		return `- ${entry.key}: [forgotten] (${relTime}, via ${sourceLabel})`;
	}

	if (entry.tag === "[pinned]") {
		return `- ${entry.key}: ${valueDisplay} ${entry.tag}`;
	}
	if (entry.tag === "[summary]" || entry.tag === "[stale-detail]") {
		return `- ${entry.key}: ${valueDisplay} ${entry.tag}`;
	}

	const stale = stalenessTagAt(entry.modifiedAt, nowMs);
	const sourceLabel = resolveSource(
		entry.taskName ?? null,
		entry.threadId ?? null,
		entry.threadTitle ?? null,
		entry.source,
	);
	const relTime = relativeTimeAt(entry.modifiedAt, nowMs);
	return `- ${entry.key}: ${valueDisplay} (${relTime}, via ${sourceLabel}) ${entry.tag}${stale}`;
}

/**
 * Render the Live State section in fixed R-VC5 order.
 *
 * The cap helper enforces the `budgetPressure` invariant inline so
 * removing or shuffling subsystem branches preserves the cap on each.
 */
function renderLiveStateBlock(
	live: LiveStateView,
	budgetPressure: boolean,
	nowMs: number,
): string[] {
	const out: string[] = [];
	out.push(LIVE_STATE_HEADER);
	out.push("");

	const cap = <T>(arr: ReadonlyArray<T>): ReadonlyArray<T> =>
		budgetPressure ? arr.slice(0, BUDGET_PRESSURE_SUBSYSTEM_CAP) : arr;

	for (const e of cap(live.crossThreadEntries)) {
		out.push(renderCrossThreadLine(e));
	}
	for (const t of cap(live.taskEntries)) {
		out.push(renderTaskLine(t));
	}
	for (const f of cap(live.fileEntries)) {
		out.push(renderFileLine(f));
	}
	for (const a of cap(live.advisories)) {
		out.push(renderAdvisoryLine(a, nowMs));
	}
	if (live.synthesisBacklogCount !== null) {
		out.push(`- [synthesis-backlog] ${live.synthesisBacklogCount} uncategorized detail entries`);
	}

	out.push("");
	out.push(LIVE_STATE_FOOTER);
	return out;
}

function renderCrossThreadLine(e: CrossThreadEntryView): string {
	return `- [thread] ${e.title}: ${e.messageCount} messages (last updated ${e.lastUpdatedAt})`;
}

function renderTaskLine(t: TaskEntryView): string {
	return `- [task] ${t.taskId} (${t.taskType}): run_count=${t.runCount}, last_run_at=${t.lastRunAt}, status=${t.status}`;
}

function renderFileLine(f: FileEntryView): string {
	// em-dash separator U+2014 — must match production byte-for-byte.
	return `- [file] ${f.path} — last modified by thread "${f.threadTitle}"`;
}

function renderAdvisoryLine(a: AdvisoryEntryView, nowMs: number): string {
	return `- [advisory] ${a.title} — applied ${relativeTimeAt(a.appliedAt, nowMs)}`;
}
