import { escapeXmlAttr } from "@bound/shared";
import {
	BUDGET_PRESSURE_SUBSYSTEM_CAP,
	DELTA_MARKER,
	LIVE_STATE_FOOTER,
	RELEVANT_MEMORY_HEADER,
	STALE_CHILD_GLOSS_MAX,
	WORKING_KNOWLEDGE_UPDATES_HEADER,
	relativeTimeAt,
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
 * Render the R-VC27 `## Relevant memory — matched to this turn` block. Empty
 * when the input array is empty (the production code path elides the header in
 * that case). Entries arrive PRE-SELECTED (dedup against the full-body stable
 * prefix + BOUND_VC27_K cap happen upstream in `selectRelevantMemory`); this
 * renderer only title-only formats them.
 */
function renderRecentMemoryBlock(
	entries: ReadonlyArray<RecentMemoryEntryView>,
	nowMs: number,
): string[] {
	if (entries.length === 0) return [];

	const out: string[] = [];
	out.push("");
	out.push(RELEVANT_MEMORY_HEADER);
	out.push("");
	for (const entry of entries) {
		out.push(formatRecentMemoryLine(entry, nowMs));
	}
	return out;
}

/**
 * Title-only line mirroring `formatRelevantMemoryTitleLine` in
 * `summary-extraction.ts`: `- {key} [{tier}] ({relTime})`. Renders the entry's
 * actual tier (`forgotten` if soft-deleted), NOT its retrieval-stage tag. Must
 * stay byte-equivalent or the parity regression test fails — uses the
 * `nowMs`-injected relative-time variant; production uses wall-clock
 * `relativeTime`, and the parity test mocks the clock so the two agree.
 */
function formatRecentMemoryLine(entry: RecentMemoryEntryView, nowMs: number): string {
	const tierTag = entry.deleted ? "forgotten" : entry.tier;
	return `- ${entry.key} [${tierTag}] (${relativeTimeAt(entry.modifiedAt, nowMs)})`;
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
	// Mirror of production `renderLiveState` (summary-extraction.ts): emits the
	// `<live-state>` XML element, NOT the legacy `## Live State` markdown. This
	// seam carries no client-session data (CrossThreadEntryView has no
	// `sessions`) and no `currentHost`, so every `<thread>` self-closes with
	// `local="false"` — which is exactly what production renders when fed the
	// same sessionless, host-less input (the parity test maps this view onto
	// the production renderer). Byte-equivalence is enforced by
	// parity-with-production.test.ts.
	out.push(`<live-state sources="${escapeXmlAttr(LIVE_STATE_FOOTER)}">`);

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
		out.push(`<synthesis-backlog count="${live.synthesisBacklogCount}"/>`);
	}

	out.push("</live-state>");
	return out;
}

function renderCrossThreadLine(e: CrossThreadEntryView): string {
	return (
		`<thread title="${escapeXmlAttr(e.title)}" messages="${e.messageCount}"` +
		` updated="${escapeXmlAttr(e.lastUpdatedAt)}" local="false"/>`
	);
}

function renderTaskLine(t: TaskEntryView): string {
	return (
		`<task id="${escapeXmlAttr(t.taskId)}" type="${escapeXmlAttr(t.taskType)}"` +
		` runs="${t.runCount}" last-run="${escapeXmlAttr(t.lastRunAt)}"` +
		` status="${escapeXmlAttr(t.status)}"/>`
	);
}

function renderFileLine(f: FileEntryView): string {
	// Host attribution rides as an attribute (R-VC28); `local` reflects whether
	// the modifying thread ran on this host. Must match production byte-for-byte.
	const hostAttr = f.host ? ` host="${escapeXmlAttr(f.host)}"` : "";
	return (
		`<file path="${escapeXmlAttr(f.path)}" thread="${escapeXmlAttr(f.threadTitle)}"` +
		`${hostAttr} local="${f.isLocal}"/>`
	);
}

function renderAdvisoryLine(a: AdvisoryEntryView, nowMs: number): string {
	return `<advisory title="${escapeXmlAttr(a.title)}" applied="${escapeXmlAttr(relativeTimeAt(a.appliedAt, nowMs))}"/>`;
}
