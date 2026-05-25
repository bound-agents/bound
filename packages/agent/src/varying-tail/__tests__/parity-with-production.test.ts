/**
 * Parity regression test for `composeVolatileVarying`.
 *
 * `varying-tail/compose.ts` deliberately renders directly rather than
 * delegating to `renderWorkingKnowledge` / `formatMemoryEntry` /
 * `renderLiveState` so that `VolatileVaryingInputs` can be a narrow
 * input contract. This file pins the cost of that decoupling: for
 * any input set, the output of this module MUST be byte-equivalent
 * to concatenating the production renderers' varying-side channels
 * for the same inputs (with `Date.now()` mocked to a fixed value
 * matching the test's `nowMs`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type CrossThreadDigestEntry,
	type LiveStateAdvisory,
	type LiveStateFileEntry,
	type LiveStateInput,
	type LiveStateTaskEntry,
	RECENT_MEMORY_HEADER,
	type StageEntry,
	formatMemoryEntry,
	renderLiveState,
	renderWorkingKnowledge,
} from "../../summary-extraction";
import { composeVolatileVarying } from "../compose";
import type { VolatileVaryingInputs } from "../types";

const FIXED_NOW = new Date("2026-05-25T12:00:00Z").getTime();

let realDateNow: () => number;

beforeEach(() => {
	realDateNow = Date.now;
	Date.now = () => FIXED_NOW;
});
afterEach(() => {
	Date.now = realDateNow;
});

function makeStageEntry(
	overrides: Partial<StageEntry> & { key: string; value: string },
): StageEntry {
	return {
		key: overrides.key,
		value: overrides.value,
		source: overrides.source ?? null,
		modifiedAt: overrides.modifiedAt ?? "2026-05-25T11:00:00Z",
		tier: overrides.tier ?? "default",
		tag: overrides.tag ?? "[graph]",
		taskName: overrides.taskName,
		threadId: overrides.threadId,
		threadTitle: overrides.threadTitle,
		deleted: overrides.deleted,
	};
}

describe("composeVolatileVarying — parity with production renderers", () => {
	it("matches for empty inputs (no header/no body)", () => {
		const inputs: VolatileVaryingInputs = {
			nowMs: FIXED_NOW,
			workingKnowledgeUpdates: {
				pinnedDeltaKeys: [],
				summaryDeltaKeys: [],
				summariesWithStaleChildren: [],
			},
			recentMemoryEntries: [],
			liveState: {
				crossThreadEntries: [],
				taskEntries: [],
				fileEntries: [],
				advisories: [],
				synthesisBacklogCount: null,
			},
			budgetPressure: false,
		};

		const ours = composeVolatileVarying(inputs).join("\n");
		const theirs = renderProductionVaryingConcat(inputs);
		expect(ours).toBe(theirs);
	});

	it("matches with WK delta markers + stale children", () => {
		const inputs: VolatileVaryingInputs = {
			nowMs: FIXED_NOW,
			workingKnowledgeUpdates: {
				pinnedDeltaKeys: ["_pinned:tone"],
				summaryDeltaKeys: ["_summary:transit"],
				summariesWithStaleChildren: [
					{
						summaryKey: "_summary:transit",
						staleChildren: [
							{ key: "transit:bus-line-43", value: "bus 43 runs hourly", isDelta: true },
							{ key: "transit:bus-line-44", value: "bus 44 runs every 30 min", isDelta: false },
						],
					},
				],
			},
			recentMemoryEntries: [],
			liveState: {
				crossThreadEntries: [],
				taskEntries: [],
				fileEntries: [],
				advisories: [],
				synthesisBacklogCount: null,
			},
			budgetPressure: false,
		};

		const ours = composeVolatileVarying(inputs).join("\n");
		const theirs = renderProductionVaryingConcat(inputs);
		expect(ours).toBe(theirs);
	});

	it("matches with recent memory entries (graph + recency tiers)", () => {
		const inputs: VolatileVaryingInputs = {
			nowMs: FIXED_NOW,
			workingKnowledgeUpdates: {
				pinnedDeltaKeys: [],
				summaryDeltaKeys: [],
				summariesWithStaleChildren: [],
			},
			recentMemoryEntries: [
				{
					key: "graph-entry",
					value: "this entry is reachable via graph traversal",
					source: null,
					modifiedAt: "2026-05-25T11:55:00Z",
					tier: "default",
					tag: "[graph]",
				},
				{
					key: "recency-entry",
					value: "this is recent",
					source: "agent",
					modifiedAt: "2026-05-25T11:30:00Z",
					tier: "default",
					tag: "[recency]",
					threadId: "thread-id-abc",
					threadTitle: "Source Thread",
				},
			],
			liveState: {
				crossThreadEntries: [],
				taskEntries: [],
				fileEntries: [],
				advisories: [],
				synthesisBacklogCount: null,
			},
			budgetPressure: false,
		};

		const ours = composeVolatileVarying(inputs).join("\n");
		const theirs = renderProductionVaryingConcat(inputs);
		expect(ours).toBe(theirs);
	});

	it("matches under budget pressure (LS subsystems capped at 3)", () => {
		const inputs: VolatileVaryingInputs = {
			nowMs: FIXED_NOW,
			workingKnowledgeUpdates: {
				pinnedDeltaKeys: [],
				summaryDeltaKeys: [],
				summariesWithStaleChildren: [],
			},
			recentMemoryEntries: [],
			liveState: {
				crossThreadEntries: [
					{ title: "T1", messageCount: 1, lastUpdatedAt: "2026-05-25T11:00:00Z" },
					{ title: "T2", messageCount: 2, lastUpdatedAt: "2026-05-25T11:01:00Z" },
					{ title: "T3", messageCount: 3, lastUpdatedAt: "2026-05-25T11:02:00Z" },
					{ title: "T4-CAPPED", messageCount: 4, lastUpdatedAt: "2026-05-25T11:03:00Z" },
				],
				taskEntries: [],
				fileEntries: [],
				advisories: [],
				synthesisBacklogCount: null,
			},
			budgetPressure: true,
		};

		const ours = composeVolatileVarying(inputs).join("\n");
		const theirs = renderProductionVaryingConcat(inputs);
		expect(ours).toBe(theirs);
		expect(ours).not.toContain("T4-CAPPED");
	});

	it("matches with all four LS subsystems + synthesis backlog", () => {
		const inputs: VolatileVaryingInputs = {
			nowMs: FIXED_NOW,
			workingKnowledgeUpdates: {
				pinnedDeltaKeys: [],
				summaryDeltaKeys: [],
				summariesWithStaleChildren: [],
			},
			recentMemoryEntries: [],
			liveState: {
				crossThreadEntries: [
					{ title: "Sibling Thread", messageCount: 8, lastUpdatedAt: "2026-05-25T10:00:00Z" },
				],
				taskEntries: [
					{
						taskId: "task-1",
						taskType: "cron",
						runCount: 5,
						lastRunAt: "2026-05-25T11:30:00Z",
						status: "completed",
					},
				],
				fileEntries: [{ path: "src/foo.ts", threadTitle: "Editor Thread" }],
				advisories: [{ title: "Switch to opus", appliedAt: "2026-05-25T11:55:00Z" }],
				synthesisBacklogCount: 75,
			},
			budgetPressure: false,
		};

		const ours = composeVolatileVarying(inputs).join("\n");
		const theirs = renderProductionVaryingConcat(inputs);
		expect(ours).toBe(theirs);
	});
});

/**
 * Render the varying side via the production renderers and
 * concatenate them in the same order `composeVolatileVarying` does.
 *
 * The production renderers depend on `Date.now()` for relative-time
 * fragments — this test pins it via the global mock in `beforeEach`.
 */
function renderProductionVaryingConcat(inputs: VolatileVaryingInputs): string {
	const out: string[] = [];

	// Working Knowledge updates — production wants the full pinned+summary
	// arrays plus a delta key set. We reconstruct those from the narrow
	// inputs by synthesizing the entries the renderer needs to read.
	const allPinnedKeys = inputs.workingKnowledgeUpdates.pinnedDeltaKeys;
	const allSummaryKeys = new Set<string>();
	for (const k of inputs.workingKnowledgeUpdates.summaryDeltaKeys) allSummaryKeys.add(k);
	for (const s of inputs.workingKnowledgeUpdates.summariesWithStaleChildren) {
		allSummaryKeys.add(s.summaryKey);
	}
	const summariesArr = [...allSummaryKeys].map((k) =>
		makeStageEntry({ key: k, value: `body of ${k}` }),
	);
	// Order summaries to match summariesWithStaleChildren order so stale
	// children render in the same order as ours.
	summariesArr.sort((a, b) => {
		const aIdx = inputs.workingKnowledgeUpdates.summariesWithStaleChildren.findIndex(
			(s) => s.summaryKey === a.key,
		);
		const bIdx = inputs.workingKnowledgeUpdates.summariesWithStaleChildren.findIndex(
			(s) => s.summaryKey === b.key,
		);
		return (
			(aIdx === -1 ? Number.MAX_SAFE_INTEGER : aIdx) -
			(bIdx === -1 ? Number.MAX_SAFE_INTEGER : bIdx)
		);
	});
	const pinnedArr = allPinnedKeys.map((k) => makeStageEntry({ key: k, value: `body of ${k}` }));

	const deltaKeys = new Set<string>();
	for (const k of inputs.workingKnowledgeUpdates.pinnedDeltaKeys) deltaKeys.add(k);
	for (const k of inputs.workingKnowledgeUpdates.summaryDeltaKeys) deltaKeys.add(k);
	for (const s of inputs.workingKnowledgeUpdates.summariesWithStaleChildren) {
		for (const c of s.staleChildren) {
			if (c.isDelta) deltaKeys.add(c.key);
		}
	}

	const staleChildrenBySummary = new Map<string, StageEntry[]>();
	for (const s of inputs.workingKnowledgeUpdates.summariesWithStaleChildren) {
		staleChildrenBySummary.set(
			s.summaryKey,
			s.staleChildren.map((c) => makeStageEntry({ key: c.key, value: c.value })),
		);
	}

	const wk = renderWorkingKnowledge({
		pinned: pinnedArr,
		summaries: summariesArr,
		staleChildrenBySummary,
		deltaKeys,
	});
	out.push(...wk.varyingLines);

	// Recent memory block.
	if (inputs.recentMemoryEntries.length > 0) {
		out.push("");
		out.push(RECENT_MEMORY_HEADER);
		out.push("");
		for (const e of inputs.recentMemoryEntries) {
			const stage: StageEntry = {
				key: e.key,
				value: e.value,
				source: e.source,
				modifiedAt: e.modifiedAt,
				tier: e.tier,
				tag: e.tag,
				taskName: e.taskName ?? null,
				threadId: e.threadId ?? null,
				threadTitle: e.threadTitle ?? null,
				deleted: e.deleted ? 1 : 0,
			};
			out.push(formatMemoryEntry(stage));
		}
	}

	// Live State.
	const liveInput: LiveStateInput = {
		crossThreadEntries: inputs.liveState.crossThreadEntries.map(
			(e): CrossThreadDigestEntry => ({
				title: e.title,
				messageCount: e.messageCount,
				lastUpdatedAt: e.lastUpdatedAt,
			}),
		),
		taskEntries: inputs.liveState.taskEntries.map(
			(t): LiveStateTaskEntry => ({
				taskId: t.taskId,
				taskType: t.taskType,
				runCount: t.runCount,
				lastRunAt: t.lastRunAt,
				status: t.status,
			}),
		),
		fileEntries: inputs.liveState.fileEntries.map(
			(f): LiveStateFileEntry => ({
				path: f.path,
				threadTitle: f.threadTitle,
			}),
		),
		advisories: inputs.liveState.advisories.map(
			(a): LiveStateAdvisory => ({
				title: a.title,
				appliedAt: a.appliedAt,
			}),
		),
		synthesisBacklogCount: inputs.liveState.synthesisBacklogCount,
		budgetPressure: inputs.budgetPressure,
		nowMs: inputs.nowMs,
	};
	const ls = renderLiveState(liveInput);
	out.push(...ls.lines);

	return out.join("\n");
}
