import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendCapabilities, ContentBlock, LLMMessage } from "@bound/llm";
import type {
	CommandRegistryEntry,
	ContextDebugInfo,
	ContextSection,
	CrossThreadSource,
	Message,
} from "@bound/shared";
import { countContentTokens, countTokens } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import { annotateMessages } from "./annotation";
import { substituteUnsupportedBlocks } from "./content-substitution";
import {
	compactToolResultsBeforeBoundary,
	computeCompactionBoundary,
	stripThinkingBeforeBoundary,
} from "./history-compaction";
import { loadNotificationInputs, renderNotifications } from "./notifications";
import {
	ANCIENT_RATIO,
	MIDDLE_RATIO,
	RECENT_RATIO,
	tieredHistoryTruncation,
} from "./progressive-fidelity";
import { substitutePurgedMessages } from "./purge-substitution";
import {
	hashStableVolatileInputs,
	hashSystemPromptString,
	projectStableVolatileInputs,
	renderSkillIndex,
} from "./stable-prefix";
import type { StableSubsectionCache } from "./stable-prefix/cache";
import {
	type LiveStateTaskEntry,
	RECENT_MEMORY_HEADER,
	type StageEntry,
	type TieredEnrichment,
	buildCrossThreadDigest,
	buildParentSummaryMap,
	buildStaleChildrenMap,
	buildVolatileEnrichment,
	bumpRenderedDetailEntries,
	computeBaseline,
	flattenRecencyEntries,
	formatMemoryEntry,
	loadAppliedAdvisoriesForLiveState,
	loadDetailEntries,
	loadFileModificationsForLiveState,
	loadPinnedEntries,
	loadSummaryEntries,
	renderDiscoverableArchive,
	renderLiveState,
	renderWorkingKnowledge,
	resolveVc15Tunables,
} from "./summary-extraction.js";
import { buildStaticSystemParts } from "./system-parts";
import { sanitizeToolPairs } from "./tool-pair-sanitize";
import { TOOL_RESULT_OFFLOAD_THRESHOLD } from "./tool-result-offload";
import { buildVaryingPrefix } from "./varying-prefix";
import { computeRecentWindow } from "./warm-compaction";

/** Lazily get the tracer to ensure tests can register their provider first */
function getTracer() {
	return trace.getTracer("bound.context-assembly");
}

/**
 * The cold path targets this fraction of contextWindow, leaving headroom for warm-path growth.
 * At 200k contextWindow, this leaves ~30k tokens (15%) for warm-path turns before triggering
 * high-water mark reassembly. With 10-15% underestimation by tiktoken, this also protects
 * against exceeding the model's true context limit.
 */
export const TRUNCATION_TARGET_RATIO = 0.85;

/**
 * Safety margin between the estimated token count and the backend's true context window.
 *
 * tiktoken's cl100k_base is an APPROXIMATION of the actual tokenizers used by Claude, GLM,
 * qwen, etc. — variance is typically 5-10%, but for short payloads it can be as small as
 * 0.6%, which is exactly enough to slip past a zero-margin gate and overflow on the wire.
 *
 * The gate in assembleContext compares the estimate against
 *   effectiveBudget = contextWindow - safetyMargin(contextWindow)
 * rather than contextWindow directly, so any undercount up to the margin is absorbed before
 * the backend sees the payload. The ratio is conservative (2%) with a floor (512 tokens) so
 * small contexts still get meaningful headroom.
 *
 * Note: TRUNCATION_TARGET_RATIO (0.85) is a separate concept — it controls how aggressively
 * truncation cuts once it fires. The safety margin controls WHEN truncation fires.
 */
export const CONTEXT_SAFETY_MARGIN_RATIO = 0.02;
export const CONTEXT_SAFETY_MARGIN_FLOOR = 512;

export function computeSafetyMargin(contextWindow: number): number {
	return Math.max(
		CONTEXT_SAFETY_MARGIN_FLOOR,
		Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN_RATIO),
	);
}

export interface ContextParams {
	db: Database;
	threadId: string;
	taskId?: string;
	userId: string;
	currentModel?: string;
	contextWindow?: number;
	noHistory?: boolean;
	configDir?: string;
	hostName?: string;
	siteId?: string;
	/** Cluster topology role ("hub" | "spoke"), rendered on the orientation Host line. See #68. */
	topologyRole?: "hub" | "spoke";
	/**
	 * Originating task type (`"heartbeat"`, `"cron"`, `"event"`, `"deferred"`),
	 * when this assembly is driven by a scheduled task. Drives surface-specific
	 * volatile rendering — currently the resolved-advisory operator-ack
	 * notifications, which are restricted to the heartbeat surface (#70).
	 * Undefined for user-facing (web/discord/boundless) assemblies.
	 */
	taskType?: string;
	relayInfo?: {
		remoteHost: string;
		localHost: string;
		model: string;
		provider: string;
	};
	/**
	 * When set, context assembly performs in-place substitution of content blocks
	 * that the target backend does not support. Image blocks are replaced with text
	 * annotations when vision is not supported. Document blocks are always replaced
	 * with their text_representation.
	 */
	targetCapabilities?: BackendCapabilities;
	/** Estimated token count for tool definitions (counted by caller since tools are at ChatParams level) */
	toolTokenEstimate?: number;
	/** When true, replaces old tool_result content (outside the recent window) with DB
	 *  retrieval pointers and injects the thread summary. Reduces context size while
	 *  keeping the compacted prefix deterministic and cache-friendly. */
	compactToolResults?: boolean;
	/** Number of recent messages to keep intact during compaction. Defaults to 20. */
	compactRecentWindow?: number;
	/** Optional system prompt addition from client connection. Appended to system suffix. */
	systemPromptAddition?: string;
	/**
	 * Server-level instructions authored by the connector this thread is bound
	 * to, resolved via PlatformMcpRegistry.getInstructionsForThread(). Surfaced
	 * verbatim on the varying side. bound core does not interpret it — the
	 * connector owns the prose. Undefined for threads not bound to a connector.
	 */
	platformInstructions?: string;
	/** MCP commands to display in orientation block. Passed explicitly from AppContext. */
	commandRegistry?: readonly CommandRegistryEntry[];
	/**
	 * Override for the truncation/headroom ratio applied to contextWindow.
	 * Defaults to TRUNCATION_TARGET_RATIO (0.85) when omitted. The agent loop
	 * supplies a per-thread adaptive value derived from the historical
	 * tiktoken-vs-actual inflation ratio so threads with thinking-heavy
	 * content (cl100k_base under-counts by 2x+) don't blow the configured
	 * context window. Honored at both Stage 1.7 thinking-strip threshold
	 * and Stage 7 truncation target.
	 */
	effectiveTruncationRatio?: number;
	/**
	 * Per-process cache for the rendered R-VC25 stable volatile subsection.
	 * When supplied, the cold-path stable bytes pushed onto `systemParts`
	 * come from `cache.get(...)` rather than from a freshly-rendered
	 * `volatileCtx.stableContent`. Insulates the on-wire bytes from
	 * `last_accessed_at` bumps and other within-TTL collect-side
	 * mutations that the change-log doesn't track (CONTRIBUTING.md narrow
	 * exception #1) — pinning K1 of `stable-prefix/cache.ts`.
	 *
	 * Optional. When omitted, the renderer falls back to the freshly-
	 * rendered bytes. Tests omit this; the agent loop passes a singleton
	 * instance per process.
	 */
	stableSubsectionCache?: StableSubsectionCache;
}

export interface ContextAssemblyResult {
	messages: LLMMessage[];
	/** Stable system prompt (persona + orientation + skill body). Passed as the `system` param to drivers. */
	systemPrompt: string;
	debug: ContextDebugInfo;
	/** Volatile context token estimate for warm-path reuse */
	volatileTokenEstimate?: number;
}

export interface VolatileContext {
	/**
	 * Joined content string of all volatile context lines (stable + varying
	 * concatenated). Retained for snapshot tests and any consumer that only
	 * needs a single rendered string.
	 */
	content: string;
	/**
	 * Stable lines: thread-agnostic content that does not change turn-to-turn
	 * under steady state. Working Knowledge bodies, Discoverable Archive
	 * titles, and the skill index. Joined and emitted as a developer message
	 * BEFORE history so prompt caching can reuse the prefix across turns and
	 * across threads (cross-thread cache reuse for cron tasks in the same TTL
	 * window).
	 */
	stableContent: string;
	/**
	 * Varying lines: per-thread / per-turn content. Working Knowledge update
	 * markers, Live State (cross-thread digest, task digest, file
	 * modifications, applied advisories), retired-skill notifications,
	 * advisory feedback notifications, inactive-skill references, the
	 * User/Thread ID line, relay/platform/model context, and any
	 * systemPromptAddition. Emitted as a developer message AFTER history;
	 * uncached.
	 */
	varyingContent: string;
	/** Token estimate for the combined volatile context (stable + varying). */
	tokenEstimate: number;
	/** Token estimate for the stable portion only (for cache accounting). */
	stableTokenEstimate: number;
	/** Token estimate for the varying portion only (driver suffix budgeting). */
	varyingTokenEstimate: number;
	/**
	 * Enrichment section start index in `allVolatileLines` (combined buffer)
	 * for budget-pressure rebuild splicing.
	 */
	enrichmentStartIdx: number;
	/** Enrichment section end index in `allVolatileLines` (combined buffer). */
	enrichmentEndIdx: number;
	/**
	 * Enrichment section start/end indices into the varying buffer alone.
	 * Used by budget-pressure rebuild to splice ONLY the varying tail.
	 */
	varyingEnrichmentStartIdx: number;
	varyingEnrichmentEndIdx: number;
	/** Snapshot of combined volatile lines (stable then varying) for splicing */
	allVolatileLines: string[];
	/** Snapshot of varying-only volatile lines (mirror of `varyingContent`). */
	allVaryingLines: string[];
	/** Memory delta lines for tier-aware shedding */
	memoryDeltaLines: string[];
	/** Task digest lines for tier-aware shedding */
	taskDigestLines: string[];
	/** Tiered enrichment structure for shedding */
	tiers?: TieredEnrichment;
	/** Cross-thread sources for debug */
	crossThreadSources?: CrossThreadSource[];
	/** Total memory count for header reconstruction */
	totalMemCount: number;
	/**
	 * SHA-256/16-hex of the `StableVolatileInputs` snapshot that fed
	 * the R-VC24 stable subsection rendering on this assembly. The
	 * hash covers Working Knowledge inputs (pinned + summary), the
	 * Discoverable Archive inputs (detail entries + parent-summary
	 * map + stale-child exclusions + tunables + budgetPressure), and
	 * the skill-index inputs.
	 *
	 * Propagated up to `ContextDebugInfo.stablePrefixInputFingerprint`
	 * by `assembleContext`. Used by the drift detector at
	 * `validation/run-stable-prefix-drift-validation.ts` to localize
	 * leaks: matching fingerprint with diverging output hash means
	 * the drift is in the renderer (not in input collection).
	 */
	stablePrefixInputFingerprint: string;
}

interface VolatileSectionInputs {
	pinned: ReturnType<typeof loadPinnedEntries>;
	summaries: ReturnType<typeof loadSummaryEntries>;
	detailEntries: ReturnType<typeof loadDetailEntries>;
	staleChildrenMap: ReturnType<typeof buildStaleChildrenMap>;
	parentSummaryMap: ReturnType<typeof buildParentSummaryMap>;
	digest: ReturnType<typeof buildCrossThreadDigest>;
	advisories: ReturnType<typeof loadAppliedAdvisoriesForLiveState>;
	taskDigestEntries: LiveStateTaskEntry[];
	taskDigestLines: string[];
	tiers: TieredEnrichment;
	fileEntries: ReturnType<typeof loadFileModificationsForLiveState>;
	deltaKeys: Set<string>;
}

/**
 * Load every input `composeVolatileSections` needs in a single
 * pass. Pure-modulo-DB: no clock reads beyond what `buildVolatileEnrichment`
 * already does internally for digest cutoffs.
 *
 * Caps follow the existing two-call-site convention:
 *   - no-history task path: `(maxMemory: 10, maxTasks: 5, maxPinned: 10)`
 *   - budget-pressure rebuild: `(maxMemory: 3, maxTasks: 3)` (no pinned cap)
 *
 * Property-tested at
 * `__tests__/load-volatile-section-inputs.property.test.ts`.
 */
function loadVolatileSectionInputs(args: {
	db: Database;
	threadId: string;
	userId: string;
	baseline: string;
	nowMs: number;
	maxMemory?: number;
	maxTasks?: number;
	maxPinned?: number;
}): VolatileSectionInputs {
	const { db, threadId, userId, baseline, nowMs, maxMemory, maxTasks, maxPinned } = args;

	const pinned = loadPinnedEntries(db);
	const summaries = loadSummaryEntries(db, pinned.exclusionSet);
	const detailEntries = loadDetailEntries(db);
	const staleChildrenMap = buildStaleChildrenMap(db, summaries.entries);
	const parentSummaryMap = buildParentSummaryMap(
		db,
		detailEntries.entries.map((e) => e.key),
	);
	const digest = buildCrossThreadDigest(db, userId, threadId);
	const advisories = loadAppliedAdvisoriesForLiveState(db, nowMs);
	const fileEntries = loadFileModificationsForLiveState(db, threadId);

	const { taskDigestEntries, taskDigestLines, tiers } = buildVolatileEnrichment(
		db,
		baseline,
		maxMemory,
		maxTasks,
		undefined,
		undefined,
		maxPinned,
	);

	const allDeltaKeys = db
		.prepare(
			`SELECT DISTINCT key FROM semantic_memory
			 WHERE modified_at > ?
			   AND deleted = 0
			   AND key NOT LIKE '_internal.%'`,
		)
		.all(baseline) as Array<{ key: string }>;
	const deltaKeys = new Set(allDeltaKeys.map((r) => r.key));

	return {
		pinned,
		summaries,
		detailEntries,
		staleChildrenMap,
		parentSummaryMap,
		digest,
		advisories,
		taskDigestEntries,
		taskDigestLines,
		tiers,
		fileEntries,
		deltaKeys,
	};
}

function computeStablePrefixInputFingerprint(args: {
	pinned: ReadonlyArray<StageEntry>;
	summaries: ReadonlyArray<StageEntry>;
	detailEntries: ReadonlyArray<{ key: string; last_accessed_at: string | null }>;
	parentSummaryMap: ReadonlyMap<string, string>;
	staleChildrenMap: ReadonlyMap<string, ReadonlyArray<{ key: string }>>;
	budgetPressure: boolean;
	activeSkills: ReadonlyArray<{ name: string; description: string }>;
}): string {
	// Route every fingerprint computation through the same pure
	// projector (`projectStableVolatileInputs` in `stable-prefix/`).
	// Without this seam, each call site reimplemented the projection
	// inline and silently diverged — the drift detector's "leak in
	// compose" classification would then false-positive when paths
	// disagreed.
	return hashStableVolatileInputs(
		projectStableVolatileInputs({
			pinned: args.pinned,
			summaries: args.summaries,
			detailEntries: args.detailEntries,
			parentSummaryMap: args.parentSummaryMap,
			staleChildrenMap: args.staleChildrenMap,
			budgetPressure: args.budgetPressure,
			activeSkills: args.activeSkills,
			tunables: resolveVc15Tunables(),
		}),
	);
}

/**
 * Shared empty stale-children map for the active-conversation render path
 * (#69). `composeVolatileSections` passes this to `renderWorkingKnowledge`
 * when `includeStaleChildren` is false, suppressing the off-topic
 * `[stale child of _summary:X]` bullets while leaving the surface-independent
 * Discoverable-Archive drop intact.
 */
const NO_STALE_CHILDREN: ReturnType<typeof buildStaleChildrenMap> = new Map();

interface ComposeVolatileSectionsParams {
	db: Database;
	pinned: ReturnType<typeof loadPinnedEntries>["entries"];
	summaries: ReturnType<typeof loadSummaryEntries>["entries"];
	detailEntries: ReturnType<typeof loadDetailEntries>["entries"];
	staleChildrenMap: ReturnType<typeof buildStaleChildrenMap>;
	/**
	 * When false, the "Working Knowledge — updates" (varying) block omits the
	 * `[stale child of _summary:X]` re-summarization bullets (#69). Stale-child
	 * entries are an off-topic memory-consolidation signal; they belong on the
	 * heartbeat surface where consolidation runs, not in active-conversation
	 * contexts where they crowd out relevant attention. This is the ~5K-token /
	 * ~50-entry block the issue measured.
	 *
	 * SCOPE — this flag gates exactly two surfaces, both of which read the FULL
	 * `staleChildrenMap`:
	 *   1. the varying `[stale child of _summary:X]` bullets (gated here, omitted
	 *      on active);
	 *   2. the Discoverable-Archive drop of the same keys, which is deliberately
	 *      NOT gated (see `staleChildKeysInWorkingKnowledge` below) so a stripped
	 *      child is not re-surfaced as a DA title and the stable channel stays
	 *      byte-identical across surfaces.
	 *
	 * It does NOT gate the stable "Working Knowledge — operational and durable"
	 * body: `loadSummaryEntries` independently promotes each stale child into
	 * `summaries` as a `[stale-detail]`-tagged entry, and `renderWorkingKnowledge`
	 * renders every summary entry as an unlabeled `- key: gloss` line on the
	 * stable channel. That line rides the summary list identically on both
	 * surfaces, so it is intentionally left in place — narrowing it would diverge
	 * the stable channel and pull the stable-prefix purity subsystem (parity test
	 * + drift fingerprint) into scope. In practice the residual is a handful of
	 * recent children (the bulk of the measured ~5K lived in the varying bullets).
	 */
	includeStaleChildren: boolean;
	parentSummaryMap: ReturnType<typeof buildParentSummaryMap>;
	deltaKeys: Set<string>;
	digest: ReturnType<typeof buildCrossThreadDigest>;
	taskDigestEntries: LiveStateTaskEntry[];
	fileEntries: ReturnType<typeof loadFileModificationsForLiveState>;
	advisories: ReturnType<typeof loadAppliedAdvisoriesForLiveState>;
	/**
	 * L2 (graph-seeded) + L3 (recency) entries. Filter to `tier='default'`
	 * before rendering to avoid double-rendering entries already handled by
	 * renderWorkingKnowledge (pinned/summary) or renderDiscoverableArchive (detail).
	 */
	recencyEntries: StageEntry[];
	budgetPressure: boolean;
	nowMs: number;
}

/**
 * Shared helper for three of the four `buildVolatileEnrichment` call sites:
 * primary cold path, no-history task path, and budget-pressure rebuild path.
 * `rebuildWarmSections` does not render and does not call this helper.
 *
 * Composes the three volatile renderers (Working Knowledge, Discoverable
 * Archive, Live State) into stable and varying line buffers per the
 * suffix-prefix split (RFC 2026-05-22-volatile-context).
 *
 *   stableLines  — content that does not change turn-to-turn under steady
 *                  state. Working Knowledge bodies (pinned + summary, no
 *                  markers) and Discoverable Archive titles. Sits before
 *                  history as a cacheable developer prefix.
 *   varyingLines — content that does change turn-to-turn: Working Knowledge
 *                  delta markers and stale-child references, plus the entire
 *                  Live State section (cross-thread digest, task digest, file
 *                  modifications, applied advisories, synthesis backlog).
 *                  Sits after history; uncached.
 *
 * Section ordering inside each buffer mirrors R-VC1 (WK → DA → LS), so
 * concatenating stableLines + varyingLines produces the same logical
 * sequence the agent saw before the split.
 */
function composeVolatileSections(params: ComposeVolatileSectionsParams): {
	stableLines: string[];
	varyingLines: string[];
	synthesisBacklogCount: number | null;
} {
	const stableLines: string[] = [];
	const varyingLines: string[] = [];

	// Surface-independent: computed from the FULL stale map regardless of
	// `includeStaleChildren`. This set drives the Discoverable-Archive drop
	// (`renderDiscoverableArchive` below), which lands in `stableLines`. Gating
	// it on the surface would diverge the stable channel between heartbeat and
	// active turns and break cross-thread cache reuse. Keeping it full means a
	// stale-child key dropped here is NOT re-surfaced as a DA title on the active
	// turn — so on active the only `[stale child of …]`-flagged surfacing (the
	// varying "Working Knowledge — updates" bullets, gated below) disappears, and
	// the child does not leak back in via a DA title. Note this does NOT remove
	// the child's `[stale-detail]` summary-body line from the stable Working
	// Knowledge block: that line rides `summaries` (see `includeStaleChildren`
	// docs) and is intentionally identical on both surfaces.
	const staleChildKeysInWorkingKnowledge = new Set(
		Array.from(params.staleChildrenMap.values())
			.flat()
			.map((e) => e.key),
	);

	// Render in fixed order: Working Knowledge → Discoverable Archive → Live State
	const wk = renderWorkingKnowledge({
		pinned: params.pinned,
		summaries: params.summaries,
		// #69: stale-child bullets render only on the heartbeat surface.
		staleChildrenBySummary: params.includeStaleChildren
			? params.staleChildrenMap
			: NO_STALE_CHILDREN,
		deltaKeys: params.deltaKeys,
	});
	stableLines.push("");
	stableLines.push(...wk.stableLines);

	const da = renderDiscoverableArchive({
		entries: params.detailEntries,
		parentSummaryByKey: params.parentSummaryMap,
		staleChildKeysInWorkingKnowledge,
		budgetPressure: params.budgetPressure,
		tunables: resolveVc15Tunables(),
	});
	stableLines.push(...da.section.lines);

	if (wk.varyingLines.length > 0) {
		varyingLines.push(...wk.varyingLines);
	}

	// Recency block: L2 (graph-seeded) + L3 (recency) entries with
	// `tier='default'` that loadRecencyEntries / loadGraphEntries
	// surfaced. These are the entries the post-R-VC24 pipeline
	// otherwise has no rendering path for: WK owns pinned + summary,
	// DA owns detail, LS doesn't read semantic_memory. We filter to
	// `tier='default'` rather than rendering everything in tiers.L2 +
	// tiers.L3 because:
	//   - pinned/summary entries from L2's graph traversal would
	//     double-render against renderWorkingKnowledge
	//   - detail entries (including orphaned) from L3's
	//     `OR (tier='detail' AND NOT EXISTS summarizes-edge)` clause
	//     would double-render against renderDiscoverableArchive
	const recentDefaults = params.recencyEntries.filter((e) => e.tier === "default");
	if (recentDefaults.length > 0) {
		varyingLines.push("");
		varyingLines.push(RECENT_MEMORY_HEADER);
		varyingLines.push("");
		for (const entry of recentDefaults) {
			varyingLines.push(formatMemoryEntry(entry));
		}
	}

	const ls = renderLiveState({
		crossThreadEntries: params.digest.entries,
		taskEntries: params.taskDigestEntries,
		fileEntries: params.fileEntries,
		advisories: params.advisories,
		synthesisBacklogCount: da.synthesisBacklogCount,
		budgetPressure: params.budgetPressure,
		nowMs: params.nowMs,
	});
	varyingLines.push(...ls.lines);

	return {
		stableLines,
		varyingLines,
		synthesisBacklogCount: da.synthesisBacklogCount,
	};
}

export function buildVolatileContext(params: {
	db: Database;
	threadId: string;
	taskId?: string;
	userId: string;
	siteId?: string;
	hostName?: string;
	currentModel?: string;
	relayInfo?: ContextParams["relayInfo"];
	systemPromptAddition?: string;
	/** Connector-authored server instructions for connector-bound threads. */
	platformInstructions?: string;
	/** Last user message text for relevance-aware memory boosting */
	userMessageText?: string;
	/** Thread summary for keyword seeding */
	threadSummary?: string;
	/** Referenced inactive skill name, if any */
	inactiveSkillRef?: string;
	/**
	 * Originating task type, when driven by a scheduled task. Gates the
	 * resolved-advisory operator-ack notifications to the heartbeat surface
	 * (#70); active-conversation assemblies leave this undefined and therefore
	 * never surface those acks.
	 */
	taskType?: string;
	/**
	 * Wall-clock anchor for relative-time formatting (`Nd ago`, applied-advisory
	 * recency cutoffs, etc.). Defaults to `Date.now()` for production callers;
	 * tests inject a fixed timestamp so snapshot fixtures stay deterministic
	 * across days. Without this, relative-time strings drift relative to when
	 * the snapshot was last regenerated.
	 */
	nowMs?: number;
}): VolatileContext {
	// Suffix-prefix split (RFC 2026-05-22-volatile-context):
	//   varyingLines  — per-thread / per-turn content. Driver places these
	//                   AFTER history; uncached. Includes the User/Thread ID
	//                   line, relay/model context, Live State,
	//                   Working Knowledge update markers, advisory and skill
	//                   notifications, inactive-skill references, and any
	//                   systemPromptAddition.
	//   stableLines   — content that does not change turn-to-turn under
	//                   steady state. Driver places these BEFORE history so
	//                   prompt caching reuses the prefix across turns and
	//                   across threads (cron-task cache reuse in the same
	//                   TTL window). Includes Working Knowledge bodies,
	//                   Discoverable Archive titles, and the skill index.
	//
	// During this build we accumulate into both arrays plus a combined
	// `suffixLines` array so existing single-message consumers (snapshot
	// fixtures, debug accounting, budget-pressure splice) keep working.
	const stableLines: string[] = [];
	const varyingLines: string[] = [];
	const suffixLines: string[] = [];

	// --- VARYING: User/Thread ID, relay info, current model.
	// Pure projection in `varying-prefix/build.ts`; pinned by V1-V8 props. ---
	const prefixLines = buildVaryingPrefix({
		userId: params.userId,
		threadId: params.threadId,
		relayInfo: params.relayInfo,
		currentModel: params.currentModel,
	});
	suffixLines.push(...prefixLines);
	varyingLines.push(...prefixLines);

	// Stage 5.5: VOLATILE ENRICHMENT
	const nowMs = params.nowMs ?? Date.now();
	const enrichmentBaseline = computeBaseline(
		params.db,
		params.threadId,
		params.taskId,
		false,
		nowMs,
	);

	// Compute delta-key set from R-MV1 baseline + delta query
	const allDeltaKeys = params.db
		.prepare(
			`SELECT DISTINCT key FROM semantic_memory
			 WHERE modified_at > ?
			   AND deleted = 0
			   AND key NOT LIKE '_internal.%'`,
		)
		.all(enrichmentBaseline) as Array<{ key: string }>;
	const deltaKeys = new Set(allDeltaKeys.map((r) => r.key));

	// Load inputs for renderers
	const pinned = loadPinnedEntries(params.db);
	const summaries = loadSummaryEntries(params.db, pinned.exclusionSet);
	const detailEntries = loadDetailEntries(params.db);

	// Bump last_accessed_at for detail entries that are about to
	// be rendered into Discoverable Archive. The DA sort key and
	// per-entry `(last accessed Nd ago)` fragment depend on this
	// column; without a render-time bump the agent reads its own
	// actively-used memory as "26d ago" and concludes everything is
	// stale (live evidence: thread d0372be6). Debounced to one bump
	// per entry per hour. Direct SQL write (not via the outbox) —
	// see bumpRenderedDetailEntries for the documented exception
	// to invariant #1.
	bumpRenderedDetailEntries(params.db, detailEntries.entries, nowMs);

	const staleChildrenMap = buildStaleChildrenMap(params.db, summaries.entries);
	const parentSummaryMap = buildParentSummaryMap(
		params.db,
		detailEntries.entries.map((e) => e.key),
	);
	const digest = buildCrossThreadDigest(params.db, params.userId, params.threadId);
	const advisories = loadAppliedAdvisoriesForLiveState(params.db, nowMs);

	// Compute task and file entries
	const {
		taskDigestEntries,
		taskDigestLines,
		memoryDeltaLines,
		tiers: enrichmentTiers,
	} = buildVolatileEnrichment(
		params.db,
		enrichmentBaseline,
		undefined,
		undefined,
		params.userMessageText,
		params.threadSummary,
	);
	const fileEntries = loadFileModificationsForLiveState(params.db, params.threadId);

	// Query total memory count for VolatileContext return
	const totalMemCount = (
		params.db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
			c: number;
		}
	).c;

	// Render the three sections using the shared composer.
	// Stable side: WK bodies + DA titles. Varying side: WK update markers +
	// Live State.
	const enrichmentStartIdx = suffixLines.length;
	const varyingEnrichmentStartIdx = varyingLines.length;
	const { stableLines: enrichmentStableLines, varyingLines: enrichmentVaryingLines } =
		composeVolatileSections({
			db: params.db,
			pinned: pinned.entries,
			summaries: summaries.entries,
			detailEntries: detailEntries.entries,
			staleChildrenMap,
			// #69: gate stale-child bullets to the heartbeat surface.
			includeStaleChildren: params.taskType === "heartbeat",
			parentSummaryMap,
			deltaKeys,
			digest,
			taskDigestEntries,
			fileEntries,
			advisories,
			recencyEntries: flattenRecencyEntries(enrichmentTiers),
			budgetPressure: false,
			nowMs,
		});
	const enrichmentLines: string[] = [...enrichmentStableLines, ...enrichmentVaryingLines];
	stableLines.push(...enrichmentStableLines);
	varyingLines.push(...enrichmentVaryingLines);
	suffixLines.push(...enrichmentLines);
	const enrichmentEndIdx = suffixLines.length;
	const varyingEnrichmentEndIdx = varyingLines.length;

	let crossThreadSources: CrossThreadSource[] | undefined;
	if (digest.sources.length > 0) {
		crossThreadSources = digest.sources;
	}

	// --- STABLE: active skill index ---
	// Skill index is keyed off the active skill set; a skill flipping
	// active/retired or being newly imported invalidates the prefix, but
	// steady state (no skill churn) keeps it cacheable across turns.
	//
	// `activeSkills` is hoisted out of the try block so the
	// stable-prefix fingerprint computation below can also see it. On
	// error, falls through to `[]` — same outcome the rendering branch
	// has (empty skill index produces no lines).
	let activeSkills: Array<{ name: string; description: string }> = [];
	try {
		activeSkills = params.db
			.query(
				"SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC",
			)
			.all() as Array<{ name: string; description: string }>;

		if (activeSkills.length > 0) {
			const skillIndexLines = renderSkillIndex(activeSkills).split("\n");
			stableLines.push(...skillIndexLines);
			suffixLines.push(...skillIndexLines);
		}
	} catch (_error) {
		// Non-fatal: active skills query failed
	}

	// --- VARYING: operator-feedback notifications (24h window). Surfaces
	// recent operator actions on this site's skills so the agent learns when
	// its skill proposals were acted on. See `notifications/`.
	//
	// Resolved-advisory operator-acks are deliberately NOT loaded here (#70):
	// they are post-resolution maintenance signals with no attached decision,
	// and surfacing them in this privileged-attention position primes a false
	// "advisories are happening right now" framing that competes with the live
	// `tasks.error` column. They are preserved only on the heartbeat surface
	// (rendered in the no-history branch of `assembleContext`), where
	// advisory-hygiene tracking is part of the role. `buildVolatileContext`
	// only ever runs on the !noHistory active-conversation path, so the
	// `taskType === "heartbeat"` gate evaluates false here in practice and is
	// kept for defensive generality. ---
	const notifInputs = loadNotificationInputs({
		db: params.db,
		siteId: params.siteId,
		includeResolvedAdvisories: params.taskType === "heartbeat",
		nowMs,
	});
	const notifLines = renderNotifications({ ...notifInputs, nowMs });
	for (const line of notifLines) {
		suffixLines.push("");
		suffixLines.push(line);
		varyingLines.push("");
		varyingLines.push(line);
	}

	// --- VARYING: inactive skill reference note ---
	if (params.inactiveSkillRef) {
		const line = `Referenced skill '${params.inactiveSkillRef}' is not active.`;
		suffixLines.push("");
		suffixLines.push(line);
		varyingLines.push("");
		varyingLines.push(line);
	}

	// --- VARYING: platform (connector) instructions ---
	// Connector-authored orientation for connector-bound threads. Varying
	// because the bound connector can change between runs and the connector
	// may revise its own instructions; placing it in the cached prefix would
	// silently freeze old text. Ordered before systemPromptAddition so an
	// operator's per-task instruction remains the last word.
	if (params.platformInstructions) {
		suffixLines.push("");
		suffixLines.push(params.platformInstructions);
		varyingLines.push("");
		varyingLines.push(params.platformInstructions);
	}

	// --- VARYING: systemPromptAddition ---
	// Operator-supplied per-task instruction. Treated as varying because a
	// task can be reconfigured between runs; placing it in the cached prefix
	// would silently freeze old text. Keeps it as the trailing element of the
	// varying tail (user intent, not internal state).
	if (params.systemPromptAddition) {
		suffixLines.push("");
		suffixLines.push(params.systemPromptAddition);
		varyingLines.push("");
		varyingLines.push(params.systemPromptAddition);
	}

	const allVolatileLines = [...suffixLines];
	const allVaryingLines = [...varyingLines];
	const content = suffixLines.join("\n");
	const stableContent = stableLines.join("\n");
	const varyingContent = varyingLines.join("\n");

	const tokenEstimate = countTokens(content);
	const stableTokenEstimate = stableContent.length > 0 ? countTokens(stableContent) : 0;
	const varyingTokenEstimate = varyingContent.length > 0 ? countTokens(varyingContent) : 0;

	// Stable-prefix input fingerprint — see ContextDebugInfo for
	// rationale. Hashed at the same level as the renderer so the
	// captured snapshot is byte-equivalent to what the renderer
	// actually consumed (R-VC24 stable-side inputs only).
	const stablePrefixInputFingerprint = computeStablePrefixInputFingerprint({
		pinned: pinned.entries,
		summaries: summaries.entries,
		detailEntries: detailEntries.entries,
		parentSummaryMap,
		staleChildrenMap,
		budgetPressure: false,
		activeSkills,
	});

	return {
		content,
		stableContent,
		varyingContent,
		tokenEstimate,
		stableTokenEstimate,
		varyingTokenEstimate,
		enrichmentStartIdx,
		enrichmentEndIdx,
		varyingEnrichmentStartIdx,
		varyingEnrichmentEndIdx,
		allVolatileLines,
		allVaryingLines,
		memoryDeltaLines,
		taskDigestLines,
		tiers: enrichmentTiers,
		crossThreadSources,
		totalMemCount,
		stablePrefixInputFingerprint,
	};
}

/**
 * Estimates the character length of message content for token-budget purposes.
 * Handles both string content and ContentBlock[] content (produced by
 * substituteUnsupportedBlocks when the backend lacks vision/document support).
 * Text blocks contribute their text length; all other blocks contribute their
 * JSON-serialised length as a conservative approximation.
 * @deprecated Use countContentTokens() from @bound/shared for token counting.
 * This function returns character counts, not token counts.
 */
export function estimateContentLength(content: string | ContentBlock[]): number {
	if (typeof content === "string") return content.length;
	return content.reduce((sum: number, block: ContentBlock) => {
		if (block.type === "text") return sum + block.text.length;
		return sum + JSON.stringify(block).length;
	}, 0);
}

let personaCache: string | null = null;
let personaCachePath: string | null = null;

/**
 * Load persona from config directory
 * Loads config/persona.md if it exists
 */
function loadPersona(configDir: string): string | null {
	if (personaCachePath === configDir && personaCache !== undefined) {
		return personaCache;
	}

	const personaPath = join(configDir, "persona.md");
	if (existsSync(personaPath)) {
		try {
			const content = readFileSync(personaPath, "utf-8");
			personaCachePath = configDir;
			personaCache = content;
			return content;
		} catch (_error) {
			// persona.md exists but cannot be read
			return null;
		}
	}

	personaCachePath = configDir;
	personaCache = null;
	return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Renders a standard UTC offset (east-of-UTC positive, in minutes) as
 * `UTC±HH:MM`. E.g. -240 → "UTC-04:00", +540 → "UTC+09:00", +330 → "UTC+05:30".
 */
function formatUtcOffset(offsetMinutes: number): string {
	const sign = offsetMinutes < 0 ? "-" : "+";
	const abs = Math.abs(offsetMinutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	return `UTC${sign}${hh}:${mm}`;
}

/**
 * Formats a timestamp as an absolute short date for context annotations.
 * Cache-friendly: output is deterministic for a given (isoTimestamp, offsetMinutes)
 * pair (never changes between turns), which preserves the byte-stable user-message
 * annotation rule (see annotation/annotate.ts).
 *
 * Without an offset, components are read in UTC:
 *   same-year "[Apr 4, 14:30]", different year "[Jan 15 '25, 09:45]".
 *
 * With `offsetMinutes` (the standard UTC offset, east-of-UTC positive — EDT=-240,
 * JST=+540, IST=+330), the instant is shifted into the sender's local wall-clock
 * and a `UTC±HH:MM` suffix is appended so the local time is unambiguous:
 *   "[Jun 5, 18:38 UTC-04:00]". The year-variant check uses the shifted (local) year.
 */
export function formatTimestamp(isoTimestamp: string, offsetMinutes?: number): string {
	const utc = new Date(isoTimestamp);
	const hasOffset = typeof offsetMinutes === "number" && Number.isFinite(offsetMinutes);
	// Shift to the sender's local wall-clock, then read UTC components off the
	// shifted instant so the calendar fields reflect local time.
	const d = hasOffset ? new Date(utc.getTime() + (offsetMinutes as number) * 60_000) : utc;
	const month = MONTHS[d.getUTCMonth()];
	const day = d.getUTCDate();
	const hours = String(d.getUTCHours()).padStart(2, "0");
	const minutes = String(d.getUTCMinutes()).padStart(2, "0");
	const suffix = hasOffset ? ` ${formatUtcOffset(offsetMinutes as number)}` : "";

	const currentYear = new Date().getUTCFullYear();
	if (d.getUTCFullYear() !== currentYear) {
		const yearShort = String(d.getUTCFullYear()).slice(-2);
		return `[${month} ${day} '${yearShort}, ${hours}:${minutes}${suffix}]`;
	}

	return `[${month} ${day}, ${hours}:${minutes}${suffix}]`;
}

/**
 * Assembles the context for an LLM call using the 8-stage pipeline from spec §13.1:
 * 1. MESSAGE_RETRIEVAL - Fetch messages by thread_id
 * 2. PURGE_SUBSTITUTION - Replace targeted IDs with summaries
 * 3. TOOL_PAIR_SANITIZATION - Ensure tool_call/tool_result pairs are correct
 * 4. MESSAGE_QUEUEING - Exclude non-tool messages during active tool-use
 * 5. ANNOTATION - Add model/host/timestamp annotations
 * 6. ASSEMBLY - Compose system prompt + persona + orientation + history + volatile
 * 7. BUDGET_VALIDATION - Check token count, truncate if needed
 * 8. METRIC_RECORDING - Record tokens (deferred to Phase 8)
 */
export function assembleContext(params: ContextParams): ContextAssemblyResult {
	const {
		db,
		threadId,
		userId,
		noHistory = false,
		configDir = "config",
		currentModel,
		contextWindow = 8000,
		hostName,
		siteId,
		relayInfo,
		targetCapabilities,
		effectiveTruncationRatio = TRUNCATION_TARGET_RATIO,
	} = params;

	const sections: ContextSection[] = [];
	let budgetPressure = false;
	let truncatedCount = 0;

	// Enrichment state — shared between Stage 6 volatile context and Stage 7 budget check
	let enrichmentBaseline: string | undefined;
	let enrichmentMessageIndex = -1;
	// Indices into the varying-only buffer (used by budget-pressure splice
	// after the suffix-prefix split, because the developer tail message now
	// holds varying content only).
	let varyingEnrichmentStartIdx = -1;
	let varyingEnrichmentEndIdx = -1;
	// biome-ignore lint/correctness/noUnusedVariables: Used in return statement
	let enrichmentTiers: TieredEnrichment | undefined;
	let allVaryingLines: string[] = []; // Varying-only volatile content for tail rebuild
	// biome-ignore lint/correctness/noUnusedVariables: Used in return statement
	let totalMemCount = 0;
	// biome-ignore lint/correctness/noUnusedVariables: Used in return statement
	let taskDigestLinesSnapshot: string[] = []; // Captured from initial enrichment

	// Stage 1: MESSAGE_RETRIEVAL
	// Load the entire thread. Stage 7's backward-fill truncation is the
	// authoritative budget gate and emits a user-visible truncation marker
	// telling the agent to use `query` for older content; an upstream cap
	// here would silently amputate messages and bypass that signal,
	// producing the sliding-context-loss sawtooth on threads larger than
	// the cap.
	//
	// The hard ceiling below is a defensive belt against catastrophic
	// scenarios (e.g. a restored thread with millions of rows) — set well
	// above any realistic working thread so it never fires under normal
	// operation. Real DB cost on `(thread_id, created_at)` for tens of
	// thousands of rows in `bun:sqlite` is in the low-hundreds of ms; the
	// downstream tiktoken cost is bounded by Stage 7's post-truncation set,
	// not the raw load.
	const stage1Span = getTracer().startSpan("context.stage-1-message-retrieval");
	const MESSAGE_LOAD_HARD_CEILING = 100_000;
	const messages: Message[] = [];
	if (!noHistory) {
		const query = db.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?",
		);
		const rows = query.all(threadId, MESSAGE_LOAD_HARD_CEILING) as Message[];
		rows.reverse();
		messages.push(...rows);
	} else if (params.taskId) {
		// noHistory tasks still need the current run's injected messages (wakeup +
		// synthetic tool_call/tool_result). Load messages created at or after the
		// task's claimed_at timestamp to capture exactly this run's setup.
		const task = db.query("SELECT claimed_at FROM tasks WHERE id = ?").get(params.taskId) as {
			claimed_at: string | null;
		} | null;
		if (task?.claimed_at) {
			const rows = db
				.query(
					"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 AND created_at >= ? ORDER BY created_at ASC, rowid ASC",
				)
				.all(threadId, task.claimed_at) as Message[];
			messages.push(...rows);
		}
	}
	stage1Span.setAttribute("message_count", messages.length);
	stage1Span.end();

	// Stage 1.5: RETROACTIVE_RESULT_TRUNCATION
	// Truncate oversized tool_result content in-memory (does not modify DB).
	// This is a second guard behind the agent-loop offloading: historical results
	// persisted before offloading was introduced still get capped here.
	const stage1_5Span = getTracer().startSpan("context.stage-1.5-retroactive-result-truncation");
	for (const msg of messages) {
		if (msg.role === "tool_result" && msg.content.length > TOOL_RESULT_OFFLOAD_THRESHOLD) {
			const originalLength = msg.content.length;
			msg.content = `[Tool result truncated: ${originalLength} characters exceeded the ${TOOL_RESULT_OFFLOAD_THRESHOLD} char limit]
Original output was too large for the context window. If you need the full content, use: query "SELECT substr(content, 1, 2000) FROM messages WHERE id = '${msg.id}'"`;
		}
	}
	stage1_5Span.end();

	// Stage 1.7: HISTORY_COMPACTION
	// Replace old message content (outside the recent window) with DB retrieval
	// pointers. The agent can re-fetch full content via "query" if needed. Compaction
	// is deterministic (same message → same replacement), so the compacted prefix is
	// cache-friendly: assembleContext runs once per loop invocation, and the compacted
	// messages produce identical content across turns. This reduces context size
	// dramatically (e.g., 190k → 40k) while preserving conversational structure.
	// User messages and tool_call messages are kept intact; assistant and tool_result
	// messages are replaced with compact stubs.
	// Also injects the thread summary as a context anchor for compacted history.
	// The recent window preserves the last N messages intact (no tool_result
	// compaction, no thinking-block stripping). It's the agent's working memory
	// for the current turn.
	//
	// A fixed default of 20 is too large for small-context backends: on a 49K
	// window with dense tool-using threads, 20 uncompacted messages can easily
	// consume 15-20K tokens (tool_result payloads are often multi-KB each).
	// That leaves too little budget for system prompt + tools + compacted
	// history + enrichment.
	//
	// Scale with contextWindow: allot roughly one message per 2.5K tokens of
	// window, clamped to [4, 20]. So 49K → 19, 32K → 12, 16K → 6, 200K → 20
	// (still capped at the historical default — larger windows don't need
	// more recent working memory, they just tolerate it).
	const stage1_7Span = getTracer().startSpan("context.stage-1.7-history-compaction");
	if (params.compactToolResults && messages.length > 0) {
		const recentWindow = params.compactRecentWindow ?? computeRecentWindow(contextWindow);

		// Anchor the compaction boundary to the index of the LAST user
		// message — see `history-compaction/index.ts` for the cache-
		// stability rationale. The boundary stays put across LLM round-
		// trips within a single user request so the prefix bytes don't
		// mutate underneath the provider's cache.
		const compactionBoundary = computeCompactionBoundary(messages, recentWindow);

		const thread = db.query("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		} | null;
		if (thread?.summary) {
			messages.unshift({
				id: "__compaction_summary__",
				thread_id: threadId,
				role: "developer",
				content: `[Conversation context — ${compactionBoundary} earlier messages are compacted below as stubs. Use "query SELECT content FROM messages WHERE id='...'" to retrieve any specific message.]\n\n${thread.summary}`,
				model_id: null,
				tool_name: null,
				created_at: messages[0]?.created_at ?? new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: params.hostName ?? "localhost",
				deleted: 0,
			} as Message);
		}

		// The boundary shifts by 1 if we prepended the summary message
		// (it was computed against the pre-prepend indices).
		const adjustedBoundary = thread?.summary ? compactionBoundary + 1 : compactionBoundary;

		// Compaction primitives — see `history-compaction/`:
		//   - tool_result: stub if content > COLD_COMPACTION_THRESHOLD
		//   - tool_call thinking: budget-driven strip when over threshold
		//   - assistant / user: untouched
		compactToolResultsBeforeBoundary(messages, adjustedBoundary);
		const thinkingThreshold = Math.floor(contextWindow * effectiveTruncationRatio);
		stripThinkingBeforeBoundary(messages, adjustedBoundary, thinkingThreshold);
	}
	stage1_7Span.end();

	// Stage 2: PURGE_SUBSTITUTION
	// Replace purge-targeted messages with summary developer stubs.
	// Tool-pair symmetric expansion + provenance prefix on the
	// summary live in `purge-substitution/`. Property-tested for
	// purge-message dropout, symmetric expansion, single-summary-
	// per-group, provenance prefix, non-purged survival,
	// determinism, malformed-metadata graceful skip, and empty
	// input — see purge-substitution/__tests__/purge.property.test.ts.
	const stage2Span = getTracer().startSpan("context.stage-2-purge-substitution");
	const messagesAfterPurge = substitutePurgedMessages({ messages, threadId });
	stage2Span.end();

	// Stage 2.5: NON-LLM ROLE FILTERING
	// Drop non-LLM-compatible roles before Stage 3 sanitizer runs. Per
	// Invariant #19, role='system' must never be persisted into the messages
	// table — insertRow() enforces this at the write boundary. Any row
	// reaching this filter with role='system' is legacy/corrupt data; drop it.
	const stage2_5Span = getTracer().startSpan("context.stage-2.5-role-filtering");
	const NON_LLM_ROLES = new Set(["alert", "purge", "system"]);
	const messagesFiltered = messagesAfterPurge.filter((m) => !NON_LLM_ROLES.has(m.role));
	stage2_5Span.end();

	// Stage 3: TOOL_PAIR_SANITIZATION
	// Two-pass tool-pair sanitization. See `tool-pair-sanitize/index.ts`
	// for the full architectural rationale and post-condition contract.
	//
	// Pass 1 (reorder) hoists non-tool messages out from between a
	// tool_call and its tool_results so the pair is wire-adjacent.
	// Pass 2 (structural repair) synthesizes stubs for unclosed
	// tool_calls and orphaned tool_results.
	//
	// Property-tested at
	// `tool-pair-sanitize/__tests__/sanitize.property.test.ts`;
	// parity with the historical inline implementation pinned by
	// `__tests__/parity-with-production.test.ts`.
	const stage3Span = getTracer().startSpan("context.stage-3-tool-pair-sanitization");
	const sanitized = sanitizeToolPairs({
		messages: messagesFiltered,
		threadId,
	});

	stage3Span.end();

	// Stage 4: MESSAGE_QUEUEING
	// Already handled by filtering - skip messages that were persisted during active tool-use
	const stage4Span = getTracer().startSpan("context.stage-4-message-queueing");
	stage4Span.setAttribute("stage.implicit", true);
	stage4Span.end();

	// Stage 5: ANNOTATION — model-switch markers, tool_use_id
	// propagation, content-block parsing, user-message timestamp
	// annotation. See `annotation/` for the full contract;
	// property-tested at annotation/__tests__/annotate.property.test.ts.
	const stage5Span = getTracer().startSpan("context.stage-5-annotation");
	const annotated = annotateMessages({ messages: sanitized });
	stage5Span.end();

	// Stage 5b: CONTENT_SUBSTITUTION
	// Replace image/document blocks in assembled messages when the target backend lacks vision support.
	// This modifies the LLMMessage[] only — the persisted messages.content is never changed.
	const stage5bSpan = getTracer().startSpan("context.stage-5b-content-substitution");
	const finalAnnotated = targetCapabilities
		? annotated.map((msg) => substituteUnsupportedBlocks({ msg, targetCapabilities, db }))
		: annotated;
	stage5bSpan.end();

	// Stage 6: ASSEMBLY
	const stage6Span = getTracer().startSpan("context.stage-6-assembly");
	// Build stable system prompt as a string (returned separately, not in messages array).
	// Drivers receive this via the `system` param, keeping it out of the message prefix.
	//
	// Static parts (env paragraph + concurrency paragraph + persona +
	// orientation + database schema) live in `system-parts/`. Property-
	// tested for byte-stability — see `system-parts/__tests__/static-parts.property.test.ts`.
	const systemParts: string[] = buildStaticSystemParts({
		db,
		persona: loadPersona(configDir),
		commandRegistry: params.commandRegistry ?? [],
		hostName,
		siteId,
		topologyRole: params.topologyRole,
	});

	const assembled: LLMMessage[] = [];

	const systemPartCountBeforeSkill = systemParts.length;

	let inactiveSkillRef: string | undefined;

	// Inject task-referenced skill body into system prompt
	// Must be outside the !noHistory guard so it works when noHistory = true
	if (params.taskId) {
		try {
			const taskRow = db
				.query("SELECT payload FROM tasks WHERE id = ? AND deleted = 0")
				.get(params.taskId) as { payload: string | null } | null;

			if (taskRow?.payload) {
				let taskPayload: unknown;
				try {
					taskPayload = JSON.parse(taskRow.payload);
				} catch (_error) {
					// Malformed task payload — skip skill injection
				}

				if (
					typeof taskPayload === "object" &&
					taskPayload !== null &&
					"skill" in taskPayload &&
					typeof (taskPayload as Record<string, unknown>).skill === "string"
				) {
					const skillName = (taskPayload as Record<string, unknown>).skill as string;

					const skillRow = db
						.query(
							"SELECT id, skill_root FROM skills WHERE name = ? AND status = 'active' AND deleted = 0",
						)
						.get(skillName) as { id: string; skill_root: string | null } | null;

					if (skillRow) {
						const skillMdPath = skillRow.skill_root
							? `${skillRow.skill_root}/SKILL.md`
							: `skills/${skillName}/SKILL.md`;
						const skillMdRow = db
							.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
							.get(skillMdPath) as {
							content: string;
						} | null;

						if (skillMdRow?.content) {
							systemParts.push(skillMdRow.content);
						}
					} else {
						// Skill referenced but not active — note will appear in volatile context
						inactiveSkillRef = skillName;
					}
				}
			}
		} catch (_error) {
			// Non-fatal: skip skill body injection on any error
		}
	}

	// Track system section tokens (parts before skill injection).
	// Build the system prompt string AFTER the volatile-context build so the
	// stable prefix (Working Knowledge bodies + Discoverable Archive titles +
	// skill index) can be folded into systemParts. That gets it onto the
	// `system` provider param where the existing system-level cache breakpoint
	// covers it cross-thread (the cron-task cache reuse goal). The bridge
	// would otherwise merge a pre-history developer message into the first
	// user message and lose cross-thread byte stability.
	const systemTokens = systemParts
		.slice(0, systemPartCountBeforeSkill)
		.reduce((sum, part) => sum + countTokens(part), 0);
	sections.push({ name: "system", tokens: systemTokens });

	// Track skill section if a skill part was added
	if (systemParts.length > systemPartCountBeforeSkill) {
		const skillTokens = countTokens(systemParts[systemParts.length - 1]);
		if (skillTokens > 0) {
			sections.push({ name: "skill-context", tokens: skillTokens });
		}
	}

	// Reserve a placeholder index for the stable volatile prefix (folded into
	// systemParts below in Stage 6). Pushed pre-history per R-VC24 so the
	// debugger renders stable subsections in the same physical position the
	// LLM driver receives them.
	const volatilePrefixSectionIndex = sections.length;
	sections.push({ name: "volatile-prefix", tokens: 0 });

	assembled.push(...finalAnnotated);

	const historyChildren: ContextSection[] = [];
	let userTokens = 0;
	let assistantTokens = 0;
	let toolResultTokens = 0;

	for (const msg of finalAnnotated) {
		const tokens = countContentTokens(msg.content);
		if (msg.role === "user") userTokens += tokens;
		else if (msg.role === "assistant" || msg.role === "tool_call") assistantTokens += tokens;
		else if (msg.role === "tool_result") toolResultTokens += tokens;
	}

	if (userTokens > 0) historyChildren.push({ name: "user", tokens: userTokens });
	if (assistantTokens > 0) historyChildren.push({ name: "assistant", tokens: assistantTokens });
	if (toolResultTokens > 0) historyChildren.push({ name: "tool_result", tokens: toolResultTokens });

	sections.push({
		name: "history",
		tokens: userTokens + assistantTokens + toolResultTokens,
		children: historyChildren.length > 0 ? historyChildren : undefined,
	});

	// Add volatile context. Per R-VC24 (suffix-prefix split):
	//   - Stable lines (Working Knowledge bodies + Discoverable Archive titles
	//     + skill index) fold into systemParts and ride the system-level cache
	//     breakpoint. This is what enables cross-thread cache reuse for cron
	//     tasks in the same TTL window — the prefix is byte-identical across
	//     threads.
	//   - Varying lines (WK update markers, Live State, advisory and skill
	//     notifications, User/Thread ID, relay/platform/model context, and
	//     systemPromptAddition) ride as a developer-role message after history.
	//     The bridge merges them into the next adjacent user message wrapped
	//     in <system-context>; uncached.
	// `suffixContent` below tracks the varying tail's content for budget
	// accounting and warm-path token reuse.
	let crossThreadSources: CrossThreadSource[] | undefined;
	let suffixContent: string | undefined;
	// Stable-prefix fingerprints for the drift detector.
	// Populated by the primary cold path (via `buildVolatileContext`)
	// and the no-history task path (inline below); left undefined on
	// other paths where the stable subsection isn't built.
	let stablePrefixInputFingerprint: string | undefined;
	if (!noHistory) {
		// --- VARYING SUFFIX: per-thread content that busts the cache ---
		// Extract latest user message for relevance-aware memory boosting
		const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
		const userMessageText = lastUserMsg?.content ?? undefined;
		// Query thread summary for broader keyword seeding
		const threadRow = db.prepare("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		} | null;
		const threadSummary = threadRow?.summary ?? undefined;

		const volatileCtx = buildVolatileContext({
			db,
			threadId,
			taskId: params.taskId,
			userId,
			siteId,
			hostName,
			currentModel,
			relayInfo,
			systemPromptAddition: params.systemPromptAddition,
			platformInstructions: params.platformInstructions,
			userMessageText,
			threadSummary,
			inactiveSkillRef,
			taskType: params.taskType,
		});

		// STABLE PREFIX: fold WK bodies + DA titles + skill index into systemParts.
		// Sits behind the system-level cache breakpoint, so steady-state runs reuse
		// the prefix across turns and across threads.
		//
		// When `stableSubsectionCache` is supplied (production path), pull the
		// rendered bytes from the per-thread memoization layer instead of using
		// the fresh `volatileCtx.stableContent`. This insulates the on-wire bytes
		// from within-TTL `last_accessed_at` bumps and other collect-side
		// mutations the change_log doesn't track — the K1 invariant of
		// `stable-prefix/cache.ts`. Tests omit the cache and fall back to the
		// freshly-rendered content (preserving existing test semantics).
		const stableContentForWire = params.stableSubsectionCache
			? params.stableSubsectionCache
					.get({
						db,
						threadId,
						budgetPressure: false,
					})
					.join("\n")
			: volatileCtx.stableContent;
		if (stableContentForWire.length > 0) {
			systemParts.push(stableContentForWire);
			sections[volatilePrefixSectionIndex] = {
				name: "volatile-prefix",
				tokens: params.stableSubsectionCache
					? countTokens(stableContentForWire)
					: volatileCtx.stableTokenEstimate,
			};
		}
		stablePrefixInputFingerprint = volatileCtx.stablePrefixInputFingerprint;

		// VARYING TAIL: developer message after history. Bridge merges it into
		// an adjacent user message wrapped in <system-context>; uncached.
		assembled.push({ role: "developer", content: volatileCtx.varyingContent });

		suffixContent = volatileCtx.varyingContent;
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, false);
		enrichmentTiers = volatileCtx.tiers;
		crossThreadSources = volatileCtx.crossThreadSources;
		varyingEnrichmentStartIdx = volatileCtx.varyingEnrichmentStartIdx;
		varyingEnrichmentEndIdx = volatileCtx.varyingEnrichmentEndIdx;
		allVaryingLines = volatileCtx.allVaryingLines;
		totalMemCount = volatileCtx.totalMemCount;
		taskDigestLinesSnapshot = volatileCtx.taskDigestLines;

		// Track volatile-tail tokens (the trailing developer message that
		// follows history, uncached). See computeVolatileTailSection for
		// the shape and accounting rules — shared with rebuildWarmSections
		// and agent-loop's per-inner-loop refresh.
		const tailSection = computeVolatileTailSection(volatileCtx);
		if (tailSection) sections.push(tailSection);
	}

	const toolTokens = params.toolTokenEstimate ?? 0;
	if (toolTokens > 0) sections.push({ name: "tools", tokens: toolTokens });
	stage6Span.end();

	// Stage 5.5: VOLATILE_ENRICHMENT
	const stage5_5Span = getTracer().startSpan("context.stage-5.5-volatile-enrichment");

	// Stage 5.5 (noHistory path): Inject enrichment
	if (noHistory) {
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, true);
		const nowMs = Date.now();

		const inputs = loadVolatileSectionInputs({
			db,
			threadId,
			userId,
			baseline: enrichmentBaseline,
			nowMs,
			maxMemory: 10,
			maxTasks: 5,
			maxPinned: 10,
		});

		enrichmentTiers = inputs.tiers;
		taskDigestLinesSnapshot = inputs.taskDigestLines;

		// Compose the three sections using the shared helper. The noHistory
		// path mirrors the primary path's split: stable subsections fold into
		// systemParts (cacheable cross-thread), varying tail rides as a
		// developer message at the assembled tail.
		const { stableLines: nhStable, varyingLines: nhVarying } = composeVolatileSections({
			db,
			pinned: inputs.pinned.entries,
			summaries: inputs.summaries.entries,
			detailEntries: inputs.detailEntries.entries,
			staleChildrenMap: inputs.staleChildrenMap,
			// #69: gate stale-child bullets to the heartbeat surface.
			includeStaleChildren: params.taskType === "heartbeat",
			parentSummaryMap: inputs.parentSummaryMap,
			deltaKeys: inputs.deltaKeys,
			digest: inputs.digest,
			taskDigestEntries: inputs.taskDigestEntries,
			fileEntries: inputs.fileEntries,
			advisories: inputs.advisories,
			recencyEntries: flattenRecencyEntries(inputs.tiers),
			budgetPressure: false,
			nowMs,
		});
		const renderedEnrichmentLines: string[] = [...nhStable, ...nhVarying];

		// Stable-prefix input fingerprint for the noHistory path.
		// Mirrors the primary path's computation in
		// `buildVolatileContext` so the drift detector sees a uniform
		// fingerprint shape across path types. The noHistory path
		// loads no skills (the skill index is stamped only on
		// non-noHistory threads), so `skillIndex: []`.
		stablePrefixInputFingerprint = computeStablePrefixInputFingerprint({
			pinned: inputs.pinned.entries,
			summaries: inputs.summaries.entries,
			detailEntries: inputs.detailEntries.entries,
			parentSummaryMap: inputs.parentSummaryMap,
			staleChildrenMap: inputs.staleChildrenMap,
			budgetPressure: false,
			activeSkills: [],
		});

		const varyingTailLines: string[] = [];

		if (renderedEnrichmentLines.length > 0) {
			totalMemCount = (
				db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
					c: number;
				}
			).c;

			if (nhStable.length > 0) {
				systemParts.push(nhStable.join("\n"));
			}

			varyingTailLines.push(...nhVarying);
			// In noHistory the varying tail begins with nhVarying (no
			// User/Thread ID prefix lines), so the enrichment section sits
			// at indices [0, nhVarying.length).
			varyingEnrichmentStartIdx = 0;
			varyingEnrichmentEndIdx = nhVarying.length;

			// Track noHistory volatile section tokens (combined for debug parity)
			const noHistVolatileTokens = countTokens(renderedEnrichmentLines.join("\n"));
			sections.push({ name: "volatile-enrichment", tokens: noHistVolatileTokens });
		}

		// --- VARYING: heartbeat-only resolved-advisory operator-acks (#70).
		// The maintenance surface keeps advisory-hygiene tracking; active
		// conversations strip these (see buildVolatileContext). Skill-retirement
		// notes stay active-only and are not loaded here. Computed independent of
		// enrichment presence so a heartbeat with no memory enrichment still
		// surfaces its acks. These lines sit after the enrichment window
		// [start, end), so they do not perturb any indices (and the
		// budget-pressure splice is gated off for noHistory anyway). ---
		if (params.taskType === "heartbeat") {
			const advisoryNotifLines = renderNotifications({
				...loadNotificationInputs({
					db,
					siteId,
					includeRetiredSkills: false,
					includeResolvedAdvisories: true,
					nowMs,
				}),
				nowMs,
			});
			for (const line of advisoryNotifLines) {
				varyingTailLines.push("");
				varyingTailLines.push(line);
			}
		}

		// Append connector instructions then systemPromptAddition for the
		// noHistory path, preserving the same order as the primary tail.
		if (params.platformInstructions) {
			varyingTailLines.push("");
			varyingTailLines.push(params.platformInstructions);
		}
		if (params.systemPromptAddition) {
			varyingTailLines.push("");
			varyingTailLines.push(params.systemPromptAddition);
		}

		if (varyingTailLines.length > 0) {
			enrichmentMessageIndex = assembled.length;
			assembled.push({ role: "developer", content: varyingTailLines.join("\n") });
			allVaryingLines = varyingTailLines;
		}
	}
	stage5_5Span.end();

	// Build the final system prompt string. Deferred until after both Stage 6
	// (history path) and Stage 5.5 (noHistory path) have appended any stable
	// volatile content (Working Knowledge bodies + Discoverable Archive titles
	// + skill index). Folding these into the `system` provider param keeps
	// them inside the system-level cache breakpoint, so steady-state turns
	// reuse the prefix across turns AND across threads (cron-task cache reuse).
	const systemPrompt = systemParts.join("\n\n");

	// Stage 7: BUDGET_VALIDATION
	// Budget pressure check: reduce enrichment caps if headroom < 2,000 tokens.
	// Use non-history token count (system msgs + tools) so that long threads
	// with truncation don't permanently trigger budget pressure. History overflow
	// is handled by truncation — budget pressure should only fire when the
	// fixed-size context (system prompt, volatile enrichment, tools) genuinely
	// crowds the window.
	const stage7Span = getTracer().startSpan("context.stage-7-budget-validation");

	// Helper to apply reduced enrichment to the assembled context or developer message.
	// Under budget pressure, re-compose the three sections with reduced (3,3) caps and budgetPressure:true.
	// This ensures R-VC1 compliance: sections are never merged or conditionally rendered.
	const applyReducedEnrichment = (): void => {
		// At this point, enrichmentBaseline is guaranteed to be non-undefined (caller checks it).
		// biome-ignore lint/style/noNonNullAssertion: Caller checked the condition above
		const baseline = enrichmentBaseline!;
		const nowMs = Date.now();

		const inputs = loadVolatileSectionInputs({
			db,
			threadId,
			userId,
			baseline,
			nowMs,
			maxMemory: 3,
			maxTasks: 3,
		});

		// Cap recency entries under budget pressure to mirror the
		// per-subsystem-cap-3 convention applied inside renderLiveState.
		// Even under pressure the agent needs to see fresh memory
		// activity, so don't drop the section entirely — just trim.
		const recencyBP = flattenRecencyEntries(inputs.tiers).slice(0, 3);
		const { stableLines: bpStable, varyingLines: bpVarying } = composeVolatileSections({
			db,
			pinned: inputs.pinned.entries,
			summaries: inputs.summaries.entries,
			detailEntries: inputs.detailEntries.entries,
			staleChildrenMap: inputs.staleChildrenMap,
			// #69: gate stale-child bullets to the heartbeat surface.
			includeStaleChildren: params.taskType === "heartbeat",
			parentSummaryMap: inputs.parentSummaryMap,
			deltaKeys: inputs.deltaKeys,
			digest: inputs.digest,
			taskDigestEntries: inputs.taskDigestEntries,
			fileEntries: inputs.fileEntries,
			advisories: inputs.advisories,
			recencyEntries: recencyBP,
			budgetPressure: true,
			nowMs,
		});
		const reducedEnrichmentLines: string[] = [...bpStable, ...bpVarying];

		// Find and update the developer message at the tail
		let devIdx = -1;
		for (let i = assembled.length - 1; i >= 0; i--) {
			if (assembled[i].role === "developer") {
				devIdx = i;
				break;
			}
		}

		if (devIdx >= 0) {
			if (!params.noHistory && varyingEnrichmentStartIdx >= 0 && varyingEnrichmentEndIdx >= 0) {
				// Splice the reduced VARYING enrichment into the developer
				// tail message. The stable prefix (WK bodies + DA titles +
				// skill index) is already folded into systemPrompt and is not
				// edited under budget pressure — leaving it stable is acceptable.
				// The shedding effect lives on the varying tail (Live State
				// subsystem caps + the WK update markers), which is exactly
				// what bpVarying re-renders.
				const rebuiltVarying = [
					...allVaryingLines.slice(0, varyingEnrichmentStartIdx),
					...bpVarying,
					...allVaryingLines.slice(varyingEnrichmentEndIdx),
				];
				assembled[devIdx] = { role: "developer", content: rebuiltVarying.join("\n") };
			} else if (params.noHistory) {
				// noHistory: developer tail is varying-only by construction.
				// Replace with reduced varying lines + trailing connector
				// instructions and systemPromptAddition (preserved verbatim
				// from the unreduced path's tail, same order).
				const noHistVaryingLines: string[] = [...bpVarying];
				if (params.platformInstructions) {
					noHistVaryingLines.push("");
					noHistVaryingLines.push(params.platformInstructions);
				}
				if (params.systemPromptAddition) {
					noHistVaryingLines.push("");
					noHistVaryingLines.push(params.systemPromptAddition);
				}
				assembled[devIdx] = {
					role: "developer",
					content: noHistVaryingLines.join("\n"),
				};
			}
		}

		const reducedEnrichmentTokens = countTokens(reducedEnrichmentLines.join("\n"));

		for (let i = 0; i < sections.length; i++) {
			if (sections[i].name === "volatile-enrichment") {
				sections[i] = { ...sections[i], tokens: reducedEnrichmentTokens };
			}
		}
	};

	if (
		enrichmentBaseline !== undefined &&
		(suffixContent !== undefined || enrichmentMessageIndex >= 0)
	) {
		const systemTokens = assembled
			.filter((m) => m.role === "system")
			.reduce((sum, m) => sum + countContentTokens(m.content), 0);
		const suffixTokens = suffixContent ? countTokens(suffixContent) : 0;
		const nonHistoryTokens = systemTokens + suffixTokens + toolTokens;
		const headroom = contextWindow - nonHistoryTokens;

		if (headroom < 2000) {
			budgetPressure = true;
			// Budget-pressure rebuild: re-compose three sections with reduced (3,3) caps and budgetPressure:true
			// to comply with R-VC1 (sections shall not be merged or conditionally rendered)
			applyReducedEnrichment();
		}
	}

	// Token count estimate via tiktoken cl100k_base encoding.
	// IMPORTANT: include every component the server will bill against the
	// context window — messages, system suffix, AND tool schemas. Omitting
	// tools here was the root cause of multi-K overshoots on small-context
	// backends: the gate saw ~content-only~ tokens, decided "fits", and
	// shipped a payload that exceeded the real limit by exactly the tool
	// schema size.
	const suffixTokensForBudget = suffixContent ? countTokens(suffixContent) : 0;
	const toolTokensForBudget = params.toolTokenEstimate ?? 0;
	// The stable system prompt is sent to the LLM separately from
	// `assembled` but still counts against the context window on the
	// backend. Including it here keeps the budget gate honest regardless of
	// stable-prefix size.
	const stablePrefixTokensForBudget = countTokens(systemPrompt);
	const totalTokens =
		assembled.reduce((sum, msg) => {
			return sum + countContentTokens(msg.content);
		}, 0) +
		stablePrefixTokensForBudget +
		suffixTokensForBudget +
		toolTokensForBudget;

	// Compute the safety-margined gate. The estimator (tiktoken cl100k_base) is an
	// approximation of each backend's real tokenizer; a zero-margin gate would allow
	// undercounts of even 1% to overflow the backend's true window. Subtracting
	// safetyMargin before comparing gives the estimator room to be wrong.
	const safetyMargin = computeSafetyMargin(contextWindow);
	const effectiveBudget = Math.max(0, contextWindow - safetyMargin);

	if (totalTokens > effectiveBudget) {
		// Truncate history from front — token-aware backward fill.
		// Instead of keeping a hardcoded last-N messages, we fill from the end
		// until we hit the remaining token budget. This ensures recent conversations
		// survive even when bulky tool exchanges sit between them.
		//
		// CACHE-FRIENDLY HEADROOM: target effectiveTruncationRatio of contextWindow
		// (default 0.85) so that truncation fires infrequently. Each truncation
		// shifts the message prefix, breaking Bedrock/Anthropic's automatic prefix
		// caching. By leaving ~15% headroom, the prefix stays stable for ~10-20
		// turns between truncations, enabling 90%+ cache hit rates on long threads.
		// Additionally, tiktoken cl100k_base underestimates Claude's actual token
		// count — typically by 10-15%, but for thinking-heavy threads we've measured
		// 2x+ inflation. The agent loop supplies a per-thread adaptive ratio
		// (tightened by the historical actual/estimated mean) so the post-truncation
		// payload genuinely fits the configured window even when the estimator runs
		// far below reality.
		//
		// The truncation target is clamped to effectiveBudget so that even if the
		// supplied ratio is unusually permissive, the post-truncation payload still
		// respects the safety margin.
		const truncationTarget = Math.min(
			Math.floor(contextWindow * effectiveTruncationRatio),
			effectiveBudget,
		);

		const systemMessages = assembled.filter((m) => m.role === "system");
		const historyMessages = assembled.filter((m) => m.role !== "system");

		if (historyMessages.length > 0) {
			const systemMsgTokens = systemMessages.reduce(
				(sum, m) => sum + countContentTokens(m.content),
				0,
			);
			// The stable system prompt (environment + concurrency + persona +
			// orientation + schema + skill) is returned separately from
			// `assembled` but still consumes window budget for the LLM call.
			// Fold its token cost into the truncation calculation so the 15%
			// headroom invariant holds regardless of stable-prefix size.
			const stablePrefixTokens = countTokens(systemPrompt);
			const toolTokens = params.toolTokenEstimate ?? 0;
			const historyBudget = Math.max(
				0,
				truncationTarget - systemMsgTokens - stablePrefixTokens - toolTokens,
			);

			// Physical-window headroom for the recent tier — the HARD ceiling,
			// distinct from the soft `historyBudget`. `historyBudget` derives from
			// `truncationTarget` (≤ contextWindow * truncationRatio) and sizes the
			// tiers; `recentHardCeiling` derives from `effectiveBudget`
			// (contextWindow − safetyMargin) and is the absolute limit the recent
			// tier may never cross. The gap between them is the headroom that lets
			// the recent tier stay anchored to the latest user message (cache
			// stability) when an inner-loop run modestly overshoots the soft
			// target, while still folding the tail into the middle tier when a
			// single user turn genuinely overflows the window. The volatile tail
			// also consumes window on the wire, so subtract it here (it is part of
			// the physical fixed cost) even though the soft `historyBudget` above
			// does not — the ceiling must reflect true history-only headroom.
			//
			// INFLATION CONSISTENCY. The tier function bounds the recent tier using
			// `countContentTokens` (tiktoken cl100k_base) estimates, but the real
			// wire prompt inflates above that — typically 10-15%, but 1.5-2x on
			// thinking-heavy threads. If the ceiling were the raw tiktoken
			// `effectiveBudget`, a recent tier "fitting" the ceiling in estimator
			// units could occupy far more real tokens and breach the window. The
			// agent loop already measures this as an EMA and folds it into
			// `effectiveTruncationRatio = TRUNCATION_TARGET_RATIO / inflationEMA`,
			// so `effectiveTruncationRatio / TRUNCATION_TARGET_RATIO == 1 /
			// inflationEMA`. Scaling the physical budget by that factor expresses
			// the ceiling in the SAME estimator units the tier function compares
			// against, so "recent fits the ceiling (estimated)" implies "recent
			// fits the window (real)". The factor is clamped to ≤ 1 so an
			// estimator that over-counts (inflation < 1) never loosens the ceiling.
			const volatileTokens = suffixContent ? countTokens(suffixContent) : 0;
			const inflationDeflator = Math.min(1, effectiveTruncationRatio / TRUNCATION_TARGET_RATIO);
			const physicalHistoryHeadroom =
				effectiveBudget - systemMsgTokens - stablePrefixTokens - toolTokens - volatileTokens;
			const recentHardCeiling = Math.max(
				0,
				Math.floor(physicalHistoryHeadroom * inflationDeflator),
			);

			// Progressive fidelity: three-tier truncation replaces the binary cliff.
			// Property-tested for budget compliance, coverage, wire-legal openers,
			// recency preservation, monotonicity, determinism, graceful degradation,
			// and chronological ordering — see
			// `progressive-fidelity/__tests__/tier-allocation.property.test.ts`.
			const threadRow = params.db
				.prepare("SELECT summary FROM threads WHERE id = ?")
				.get(params.threadId) as { summary: string | null } | null;

			const tieredResult = tieredHistoryTruncation({
				historyMessages,
				historyBudget,
				threadId: params.threadId,
				threadSummary: threadRow?.summary ?? undefined,
				recentHardCeiling,
			});

			const remaining = tieredResult.recentMessages;
			truncatedCount = tieredResult.ancientDropped + tieredResult.middleFolded;

			// Byte-stability requirement. The marker messages ride the cached
			// prefix of every message-level cachePoint. The ancient marker's
			// byte content is stable between truncation events (ancientDropped
			// count + thread summary are both byte-stable per the same reasoning
			// documented in the original truncation marker). The middle-tier
			// digest is a pure function of immutable historical messages and
			// is also byte-stable between cold-path rebuilds.
			const truncationMarker: LLMMessage[] = [];
			if (tieredResult.ancientMarker) truncationMarker.push(tieredResult.ancientMarker);
			if (tieredResult.middleDigestMsg) truncationMarker.push(tieredResult.middleDigestMsg);

			const truncatedMessages = [...systemMessages, ...truncationMarker, ...remaining];

			// Recalculate history section tokens from the KEPT messages, not the
			// pre-truncation total. Without this, context_debug reports wildly inflated
			// token counts (e.g. 3M instead of 5k when thousands of messages were dropped).
			if (truncatedCount > 0) {
				let postTruncUserTokens = 0;
				let postTruncAssistantTokens = 0;
				let postTruncToolResultTokens = 0;
				for (const msg of remaining) {
					const tokens = countContentTokens(msg.content);
					if (msg.role === "user") postTruncUserTokens += tokens;
					else if (msg.role === "assistant" || msg.role === "tool_call")
						postTruncAssistantTokens += tokens;
					else if (msg.role === "tool_result") postTruncToolResultTokens += tokens;
				}

				const histIdx = sections.findIndex((s) => s.name === "history");
				if (histIdx >= 0) {
					const postTruncChildren: Array<{ name: string; tokens: number }> = [];
					if (postTruncUserTokens > 0)
						postTruncChildren.push({ name: "user", tokens: postTruncUserTokens });
					if (postTruncAssistantTokens > 0)
						postTruncChildren.push({ name: "assistant", tokens: postTruncAssistantTokens });
					if (postTruncToolResultTokens > 0)
						postTruncChildren.push({ name: "tool_result", tokens: postTruncToolResultTokens });

					// Replace the pre-truncation history section with post-truncation
					// values. When the middle tier is active, also insert sections for
					// the ancient marker and middle digest ahead of the history section.
					const newSections: ContextSection[] = [];
					if (tieredResult.tierTokens.ancient > 0) {
						newSections.push({ name: "ancient-marker", tokens: tieredResult.tierTokens.ancient });
					}
					if (tieredResult.tierTokens.middle > 0) {
						newSections.push({ name: "middle-digest", tokens: tieredResult.tierTokens.middle });
					}
					newSections.push({
						name: "history",
						tokens: postTruncUserTokens + postTruncAssistantTokens + postTruncToolResultTokens,
						children: postTruncChildren.length > 0 ? postTruncChildren : undefined,
					});

					sections.splice(histIdx, 1, ...newSections);
				}
			}

			const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

			// Must end on all return paths — span is used for truncation event visibility.
			stage7Span.setAttribute("context.total_tokens", totalEstimated);
			stage7Span.setAttribute("context.headroom", effectiveBudget - totalEstimated);
			stage7Span.setAttribute("context.truncated_messages", truncatedCount);
			stage7Span.end();

			// Progressive fidelity debug info — present when the middle tier fired.
			const progressiveFidelity =
				tieredResult.middleFolded > 0
					? {
							ancientDropped: tieredResult.ancientDropped,
							middleFolded: tieredResult.middleFolded,
							recentKept: tieredResult.recentKept,
							tierBudgets: {
								ancient: Math.floor(historyBudget * ANCIENT_RATIO),
								middle: Math.floor(historyBudget * MIDDLE_RATIO),
								recent: Math.floor(historyBudget * RECENT_RATIO),
							},
							tierTokens: tieredResult.tierTokens,
						}
					: undefined;

			// #97: tools ride in the cached prefix — render the slice after system.
			placeToolsAfterSystem(sections);

			return {
				messages: truncatedMessages,
				systemPrompt,
				...(suffixContent !== undefined
					? { volatileTokenEstimate: countTokens(suffixContent) }
					: {}),
				debug: {
					contextWindow: contextWindow,
					safetyMargin,
					effectiveBudget,
					totalEstimated,
					model: params.currentModel ?? "unknown",
					sections,
					budgetPressure,
					truncated: truncatedCount,
					...(crossThreadSources ? { crossThreadSources } : {}),
					stablePrefixHash: hashSystemPromptString(systemPrompt),
					...(stablePrefixInputFingerprint !== undefined ? { stablePrefixInputFingerprint } : {}),
					...(progressiveFidelity ? { progressiveFidelity } : {}),
				},
			};
		}
	}

	// Stage 8: METRIC_RECORDING
	// No-op — metrics recorded by caller after LLM response
	const stage8Span = getTracer().startSpan("context.stage-8-metric-recording");

	const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

	// Add attributes to stage 7 before ending it (no-truncation path)
	stage7Span.setAttribute("context.total_tokens", totalEstimated);
	stage7Span.setAttribute("context.headroom", effectiveBudget - totalEstimated);
	stage7Span.setAttribute("context.truncated_messages", truncatedCount);
	stage7Span.end();
	stage8Span.end();

	// #97: tools ride in the cached prefix — render the slice after system.
	placeToolsAfterSystem(sections);

	return {
		messages: assembled,
		systemPrompt,
		...(suffixContent !== undefined ? { volatileTokenEstimate: countTokens(suffixContent) } : {}),
		debug: {
			contextWindow: contextWindow,
			safetyMargin,
			effectiveBudget,
			totalEstimated,
			model: params.currentModel ?? "unknown",
			sections,
			budgetPressure,
			truncated: truncatedCount,
			...(crossThreadSources ? { crossThreadSources } : {}),
		},
	};
}

/**
 * Build the `volatile-tail` ContextSection from a freshly-rendered
 * VolatileContext. Returns null when the varying half is empty (no tail
 * section should be emitted).
 *
 * The varying tail is rendered as a parent `volatile-tail` section with
 * memory/task-digest/volatile-other children that drill down into the
 * three subsystem token totals. The web debugger sums TOP-LEVEL section
 * tokens only — children render expandable but don't contribute to the
 * total — so this nesting avoids the double-count that flat peers would
 * produce.
 *
 * Notes that protect against off-by-one accounting:
 *  - Slices `allVaryingLines` (not `allVolatileLines`) using the varying-
 *    relative indices (`varyingEnrichmentStartIdx/EndIdx`). The
 *    union-relative indices would over-count stable Working Knowledge
 *    bodies that have been promoted into the prefix.
 *  - `volatile-other = varyingTokenEstimate - memory - task-digest`. Using
 *    `tokenEstimate` (the union including the stable prefix) would leak
 *    the stable Working Knowledge slab into volatile-other.
 *
 * Used by cold-path assembleContext, rebuildWarmSections, and the
 * per-inner-loop refresh in agent-loop's refreshVolatileTailForNextTurn.
 */
/**
 * Reorder `sections` in place so the `tools` section renders immediately after
 * `system` (#97).
 *
 * Tool definitions ride in the cacheable prefix on the wire (Anthropic/Bedrock
 * order: tools → system → messages), so a system-level cache breakpoint caches
 * them. The context-debug visualization previously pushed `tools` last, drawing
 * it at the far right after BOTH cachePoints and implying tools were uncached.
 * Moving the slice next to `system` places it inside the cached region; the
 * complementary offset fix in `buildCacheMarkers` folds tool tokens into the
 * system-prefix offset so the cachePoint ticks land to the right of the slice.
 *
 * No-op when there is no `tools` section. When there is no `system` section
 * (defensive — assembly always emits one), the slice is inserted at the front.
 */
export function placeToolsAfterSystem(sections: ContextSection[]): void {
	const toolsIdx = sections.findIndex((s) => s.name === "tools");
	if (toolsIdx < 0) return;
	const [toolsSection] = sections.splice(toolsIdx, 1);
	const sysIdx = sections.findIndex((s) => s.name === "system");
	sections.splice(sysIdx + 1, 0, toolsSection);
}

export function computeVolatileTailSection(volatileCtx: VolatileContext): ContextSection | null {
	if (volatileCtx.varyingTokenEstimate <= 0) return null;
	const memoryLines = volatileCtx.allVaryingLines.slice(
		volatileCtx.varyingEnrichmentStartIdx,
		volatileCtx.varyingEnrichmentEndIdx,
	);
	const memoryTokens = memoryLines.length > 0 ? countTokens(memoryLines.join("\n")) : 0;
	const taskDigestTokens =
		volatileCtx.taskDigestLines.length > 0
			? countTokens(volatileCtx.taskDigestLines.join("\n"))
			: 0;
	const volatileOtherTokens = volatileCtx.varyingTokenEstimate - memoryTokens - taskDigestTokens;
	const tailChildren: ContextSection[] = [];
	if (memoryTokens > 0) tailChildren.push({ name: "memory", tokens: memoryTokens });
	if (taskDigestTokens > 0) tailChildren.push({ name: "task-digest", tokens: taskDigestTokens });
	if (volatileOtherTokens > 0)
		tailChildren.push({ name: "volatile-other", tokens: volatileOtherTokens });
	return {
		name: "volatile-tail",
		tokens: volatileCtx.varyingTokenEstimate,
		children: tailChildren.length > 0 ? tailChildren : undefined,
	};
}

/**
 * Rebuild context_debug.sections for a warm-path turn. Reuses stable-prefix
 * sections from the cold-path snapshot (system, skill-context, tools) and
 * recomputes the dynamic ones (history, memory, task-digest, volatile-other)
 * from the freshly-built volatile context and current stored messages.
 *
 * Mirrors the per-section computation in assembleContext so warm hits report
 * the same shape as cold builds, just with current-turn token counts.
 */
export function rebuildWarmSections(params: {
	cachedSections: ContextSection[];
	storedMessages: LLMMessage[];
	volatileCtx: VolatileContext;
}): ContextSection[] {
	const sections: ContextSection[] = [];

	// Stable-prefix sections from the cold-path snapshot. These are baked
	// into systemPrompt and never change between turns while warm.
	for (const s of params.cachedSections) {
		if (s.name === "system" || s.name === "skill-context") {
			sections.push(s);
		}
	}

	// History: recompute from storedMessages, excluding the trailing volatile
	// dev message at length-1 and any cache-role markers (zero-token splice
	// markers placed by maybePlaceCacheMarker).
	const historyChildren: ContextSection[] = [];
	let userTokens = 0;
	let assistantTokens = 0;
	let toolResultTokens = 0;
	const historyEnd = params.storedMessages.length - 1; // exclude trailing volatile dev
	for (let i = 0; i < historyEnd; i++) {
		const msg = params.storedMessages[i];
		if (msg.role === "cache") continue;
		const tokens = countContentTokens(msg.content);
		if (msg.role === "user") userTokens += tokens;
		else if (msg.role === "assistant" || msg.role === "tool_call") assistantTokens += tokens;
		else if (msg.role === "tool_result") toolResultTokens += tokens;
	}
	if (userTokens > 0) historyChildren.push({ name: "user", tokens: userTokens });
	if (assistantTokens > 0) historyChildren.push({ name: "assistant", tokens: assistantTokens });
	if (toolResultTokens > 0) historyChildren.push({ name: "tool_result", tokens: toolResultTokens });

	sections.push({
		name: "history",
		tokens: userTokens + assistantTokens + toolResultTokens,
		children: historyChildren.length > 0 ? historyChildren : undefined,
	});

	// Volatile sections: recompute from the freshly-built volatile context.
	const tailSection = computeVolatileTailSection(params.volatileCtx);
	if (tailSection) sections.push(tailSection);

	// Tools: copy from cached snapshot — toolFingerprint match in the warm
	// gate guarantees the tool set is unchanged from the cold build.
	for (const s of params.cachedSections) {
		if (s.name === "tools") {
			sections.push(s);
		}
	}

	// #97: tools ride in the cached prefix — render the slice after system.
	placeToolsAfterSystem(sections);

	return sections;
}

/**
 * Applies actual LLM-reported token counts to a previously-built ContextDebugInfo,
 * returning a deep-cloned snapshot.
 *
 * `totalEstimated` stays as the pre-LLM tiktoken estimate; `actualTotalTokens`
 * carries the LLM-reported number. Both live independently so visualizers can
 * compute `actualTotalTokens / totalEstimated` as the inflation ratio.
 *
 * The deep-clone (via structuredClone) is essential: the agent loop holds a
 * reference to lastContextDebug across concurrent iterations, and without the
 * clone, a later iteration's delta could retroactively alter an earlier
 * iteration's section breakdown.
 */
export function applyActualUsageToContextDebug(
	debug: ContextDebugInfo,
	actualTokens: number,
): ContextDebugInfo {
	return {
		...debug,
		actualTotalTokens: actualTokens,
		sections: structuredClone(debug.sections),
	};
}
