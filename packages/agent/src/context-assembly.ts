import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSyncedTableSchemas } from "@bound/core";
import type { BackendCapabilities, ContentBlock, LLMMessage } from "@bound/llm";
import type {
	CommandRegistryEntry,
	ContextDebugInfo,
	ContextSection,
	CrossThreadSource,
	Message,
} from "@bound/shared";
import { countContentTokens, countTokens, safeSlice } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import {
	hashStableVolatileInputs,
	hashSystemPromptString,
	projectStableVolatileInputs,
	renderSkillIndex,
} from "./stable-prefix";
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
import { TOOL_RESULT_OFFLOAD_THRESHOLD } from "./tool-result-offload";
import {
	COLD_COMPACTION_THRESHOLD,
	computeRecentWindow,
	hasStrippableThinking,
	stripThinkingFromToolCall,
} from "./warm-compaction";

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
 * 0.6%, which is exactly enough to slip past a zero-margin gate and overflow on the wire
 * (see bound_issue:context-assembly:missing-safety-margin — incident estimate was 48,902,
 * actual was 49,196 against a 49,152 window).
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
	relayInfo?: {
		remoteHost: string;
		localHost: string;
		model: string;
		provider: string;
	};
	/** When set, assembleContext() prepends a system message explaining silence semantics.
	 * toolNames lists the tools the agent should use to send messages on this platform.
	 * When omitted, a generic reference is used instead of a specific tool name.
	 */
	platformContext?: { platform: string; toolNames?: string[] };
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

/**
 * Project the inputs that fed `composeVolatileSections` into the
 * narrow `StableVolatileInputs` shape and hash them, producing the
 * `context_debug.stablePrefixInputFingerprint` value.
 *
 * Shared across the three stable-side rendering call sites (primary
 * cold path inside `buildVolatileContext`, no-history task path
 * inlined in `assembleContext`, budget-pressure rebuild path) so
 * each site records a fingerprint computed from the same canonical
 * input shape. Without this sharing, the drift detector would see
 * spurious mismatches across paths even when the same logical inputs
 * were rendered.
 *
 * The function reads only what `composeStableVolatileSubsection`
 * declares as relevant to byte output — see
 * `stable-prefix/types.ts` for the contract.
 */
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
 * Compose volatile sections using the three-section renderer pattern (R-VC1).
 * Shared helper for three of four buildVolatileEnrichment call sites: primary cold path,
 * no-history task path, and budget-pressure rebuild path. rebuildWarmSections does not
 * render and does not call this helper (warm cache rebuild only re-counts tokens).
 *
 * Returns { lines, synthesisBacklogCount } where lines are the rendered sections
 * in fixed order: Working Knowledge → Discoverable Archive → Live State.
 */
interface ComposeVolatileSectionsParams {
	db: Database;
	pinned: ReturnType<typeof loadPinnedEntries>["entries"];
	summaries: ReturnType<typeof loadSummaryEntries>["entries"];
	detailEntries: ReturnType<typeof loadDetailEntries>["entries"];
	staleChildrenMap: ReturnType<typeof buildStaleChildrenMap>;
	parentSummaryMap: ReturnType<typeof buildParentSummaryMap>;
	deltaKeys: Set<string>;
	digest: ReturnType<typeof buildCrossThreadDigest>;
	taskDigestEntries: LiveStateTaskEntry[];
	fileEntries: ReturnType<typeof loadFileModificationsForLiveState>;
	advisories: ReturnType<typeof loadAppliedAdvisoriesForLiveState>;
	/**
	 * L2 (graph-seeded) + L3 (recency) entries from
	 * `buildVolatileEnrichment.tiers`. Rendered into the varying tail
	 * via `formatMemoryEntry` so `tier='default'` memorizes that the
	 * three R-VC24 renderers (WK / DA / LS) wouldn't surface still
	 * reach the agent on the wire.
	 *
	 * Without this rendering hook, `tier='default'` entries are
	 * structurally invisible — the post-R-VC24 design folded
	 * `pinned`/`summary` into `renderWorkingKnowledge`, `detail` into
	 * `renderDiscoverableArchive`, and left `default`/orphaned-detail
	 * entries with no rendering path despite being computed by
	 * `loadRecencyEntries` and tracked in `tiers.{L2,L3}`. Live
	 * evidence: thread d0372be6's recent `bound:issue:*` and
	 * `_outcome:*` memorizes never appeared in volatile context.
	 */
	recencyEntries: StageEntry[];
	budgetPressure: boolean;
	nowMs: number;
}

/**
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

	// Compute stale child keys for dedup
	const staleChildKeysInWorkingKnowledge = new Set(
		Array.from(params.staleChildrenMap.values())
			.flat()
			.map((e) => e.key),
	);

	// Render in fixed order R-VC1: Working Knowledge → Discoverable Archive → Live State
	const wk = renderWorkingKnowledge({
		pinned: params.pinned,
		summaries: params.summaries,
		staleChildrenBySummary: params.staleChildrenMap,
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
	platformContext?: ContextParams["platformContext"];
	systemPromptAddition?: string;
	/** Last user message text for relevance-aware memory boosting */
	userMessageText?: string;
	/** Thread summary for keyword seeding */
	threadSummary?: string;
	/** Referenced inactive skill name, if any */
	inactiveSkillRef?: string;
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
	//                   line, relay/platform/model context, Live State,
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

	// --- VARYING: User/Thread ID, relay info, platform context, current model ---
	suffixLines.push(`User ID: ${params.userId}, Thread ID: ${params.threadId}`);
	varyingLines.push(`User ID: ${params.userId}, Thread ID: ${params.threadId}`);

	// AC5.4: Model location when inference is relayed
	if (params.relayInfo) {
		const relayLine = `You are: ${params.relayInfo.model} (via ${params.relayInfo.provider} on host ${params.relayInfo.remoteHost}, relayed from ${params.relayInfo.localHost})`;
		suffixLines.push(relayLine);
		varyingLines.push(relayLine);
	}

	// Platform silence semantics: user only sees what you explicitly send.
	if (params.platformContext) {
		const toolRef =
			params.platformContext.toolNames && params.platformContext.toolNames.length > 0
				? params.platformContext.toolNames.map((n) => `\`${n}\``).join(" or ")
				: "the platform send tool";
		const platformLines: string[] = [
			"",
			`## Platform Context: ${params.platformContext.platform}`,
			"The user of this conversation is on an external platform and cannot see your responses directly.",
			`To send a message to the user, call ${toolRef}. If you do not call it, the user sees nothing (silence).`,
			"Each call to the tool produces one separate message to the user. " +
				"Multiple calls are allowed and delivered in order.",
		];

		// Platform-specific formatting constraints
		if (
			params.platformContext.platform === "discord" ||
			params.platformContext.platform === "discord-interaction"
		) {
			platformLines.push(
				"Discord formatting: **bold**, *italic*, __underline__, ~~strikethrough~~, " +
					"`inline code`, ```code blocks```, > block quotes, >>> multi-line quotes, " +
					"# ## ### headers, -# subtext, [masked links](url), ||spoilers||, " +
					"- bulleted lists (2-space indent to nest). " +
					"Tables do NOT render — use lists or code blocks instead. " +
					"Messages over 2000 characters are rejected; split long content across multiple calls.",
			);
		}

		suffixLines.push(...platformLines);
		varyingLines.push(...platformLines);
	}

	// Include current model name (moved out of orientation for cache stability).
	// Stays varying because model_hint can switch turn-to-turn.
	if (params.currentModel) {
		const modelLine = `Current Model: ${params.currentModel}`;
		suffixLines.push(modelLine);
		varyingLines.push(modelLine);
	}

	// Stage 5.5: VOLATILE ENRICHMENT (replaces raw memory dump)
	// Phase 5: Wire three-renderer composition
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

	// B3: bump last_accessed_at for detail entries that are about to
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

	// Track cross-thread sources for debug
	let crossThreadSources: CrossThreadSource[] | undefined;
	if (digest.sources.length > 0) {
		crossThreadSources = digest.sources;
	}

	// --- STABLE: active skill index (AC3.1, AC3.2) ---
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
		// No logger available in this context
	}

	// --- VARYING: operator retirement notifications (24h window) (AC3.6, AC3.7) ---
	try {
		const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const retiredByOperator = params.db
			.query(
				`SELECT name, retired_reason FROM skills
				 WHERE status = 'retired'
				   AND retired_by = 'operator'
				   AND modified_at > ?
				   AND deleted = 0`,
			)
			.all(cutoff24h) as Array<{ name: string; retired_reason: string | null }>;

		for (const s of retiredByOperator) {
			const reason = s.retired_reason ? `"${s.retired_reason}"` : "no reason given";
			const line = `[Skill notification] Skill '${s.name}' was retired by operator: ${reason}.`;
			suffixLines.push("");
			suffixLines.push(line);
			varyingLines.push("");
			varyingLines.push(line);
		}
	} catch (_error) {
		// Non-fatal: retired skills query failed
		// No logger available in this context
	}

	// --- VARYING: advisory resolution notifications (24h window, capped at 5,
	// deduped by title). Closes the feedback loop so the agent knows when its
	// advisories were acted on. ---
	if (params.siteId) {
		try {
			const ADVISORY_NOTIF_CAP = 5;
			const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
			const resolvedAdvisories = params.db
				.query(
					`SELECT title, status FROM advisories
					 WHERE created_by = ?
					   AND status IN ('approved', 'applied', 'dismissed')
					   AND resolved_at > ?
					   AND deleted = 0
					 ORDER BY resolved_at DESC`,
				)
				.all(params.siteId, cutoff24h) as Array<{ title: string; status: string }>;

			// Deduplicate by title — group identical titles and emit a counted line.
			const titleGroups = new Map<string, { status: string; count: number }>();
			for (const adv of resolvedAdvisories) {
				const existing = titleGroups.get(adv.title);
				if (existing) {
					existing.count++;
				} else {
					titleGroups.set(adv.title, { status: adv.status, count: 1 });
				}
			}

			let notifCount = 0;
			for (const [title, { status, count }] of titleGroups) {
				if (notifCount >= ADVISORY_NOTIF_CAP) break;
				const countStr = count > 1 ? ` (×${count})` : "";
				const line = `[Advisory notification] Advisory '${title}' was ${status} by operator${countStr}.`;
				suffixLines.push("");
				suffixLines.push(line);
				varyingLines.push("");
				varyingLines.push(line);
				notifCount++;
			}
		} catch (_error) {
			// Non-fatal: resolved advisories query failed
			// No logger available in this context
		}
	}

	// --- VARYING: inactive skill reference note (AC3.4) ---
	if (params.inactiveSkillRef) {
		const line = `Referenced skill '${params.inactiveSkillRef}' is not active.`;
		suffixLines.push("");
		suffixLines.push(line);
		varyingLines.push("");
		varyingLines.push(line);
	}

	// --- VARYING: systemPromptAddition (AC2.2) ---
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

	// Capture full content for return
	const allVolatileLines = [...suffixLines];
	const allVaryingLines = [...varyingLines];
	const content = suffixLines.join("\n");
	const stableContent = stableLines.join("\n");
	const varyingContent = varyingLines.join("\n");

	// Calculate token estimates
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

// Cache for persona content - loaded once at startup
let personaCache: string | null = null;
let personaCachePath: string | null = null;

/**
 * Load persona from config directory
 * Loads config/persona.md if it exists
 */
function loadPersona(configDir: string): string | null {
	// Check if we already have this cached
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
			// persona.md exists but cannot be read — no logger available in this context
			// This is logged elsewhere if needed
			return null;
		}
	}

	personaCachePath = configDir;
	personaCache = null;
	return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats a timestamp as an absolute short date for context annotations.
 * Cache-friendly: output is deterministic for a given input (never changes between turns).
 * Same-year: "[Apr 4, 14:30]". Different year: "[Jan 15 '25, 09:45]".
 */
export function formatTimestamp(isoTimestamp: string): string {
	const d = new Date(isoTimestamp);
	const month = MONTHS[d.getUTCMonth()];
	const day = d.getUTCDate();
	const hours = String(d.getUTCHours()).padStart(2, "0");
	const minutes = String(d.getUTCMinutes()).padStart(2, "0");

	const currentYear = new Date().getUTCFullYear();
	if (d.getUTCFullYear() !== currentYear) {
		const yearShort = String(d.getUTCFullYear()).slice(-2);
		return `[${month} ${day} '${yearShort}, ${hours}:${minutes}]`;
	}

	return `[${month} ${day}, ${hours}:${minutes}]`;
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
// Tracks per-thread+backend advisory "image stripped" notifications to avoid log noise.
// Map key: `${threadId}::${backendId}` (backendId approximated by vision flag string)
const advisoryDedup = new Set<string>();

/**
 * Substitutes content blocks that the target backend does not support.
 * Returns a new LLMMessage with substituted content, or the original if no substitution needed.
 * Never modifies the database.
 */
function substituteUnsupportedBlocks(
	msg: LLMMessage,
	targetCapabilities: BackendCapabilities,
	db: Database,
	threadId: string,
): LLMMessage {
	// Try to parse content as ContentBlock[] (may be a JSON string or already an array)
	let blocks: Array<{ type: string; [key: string]: unknown }> | null = null;
	if (Array.isArray(msg.content)) {
		blocks = msg.content as Array<{ type: string; [key: string]: unknown }>;
	} else if (typeof msg.content === "string") {
		try {
			const parsed = JSON.parse(msg.content);
			if (Array.isArray(parsed)) blocks = parsed;
		} catch {
			// Not JSON — plain text, no block substitution needed
		}
	}

	if (!blocks) return msg;

	// Check if any substitution is needed
	const hasImage = blocks.some((b) => b.type === "image");
	const hasDocument = blocks.some((b) => b.type === "document");
	if (!hasImage && !hasDocument) return msg;

	const substituted = blocks.map((block) => {
		if (block.type === "image" && !targetCapabilities.vision) {
			// Replace image block with text annotation
			const description = typeof block.description === "string" ? block.description : "image";
			return { type: "text" as const, text: `[Image: ${description}]` };
		}

		if (block.type === "document") {
			const source = block.source as
				| {
						type?: string;
						file_id?: string;
						data?: string;
						media_type?: string;
				  }
				| undefined;

			// base64 documents pass through as-is — the driver bridge routes
			// them to an AI SDK FilePart with the declared IANA mediaType.
			// Bedrock accepts pdf/csv/json/md/html/docx/xlsx/txt; openai-
			// compatible providers vary but accept text/* universally. If the
			// target can't render the media type, the provider surfaces the
			// error and the caller retries with a text-only turn.
			if (source?.type === "base64") {
				return block;
			}

			// file_ref documents: resolve from files table. If the row is
			// missing or empty, fall back to text_representation so the
			// agent at least gets the pre-extracted text form.
			if (source?.type === "file_ref" && source.file_id) {
				const fileRow = db
					.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
					.get(source.file_id) as { content: string | null; is_binary: number } | null;

				if (fileRow?.content) {
					// Resolve to base64 inline document with the declared media
					// type. If no media_type hint was stored on the file_ref
					// (legacy rows), fall back to application/octet-stream —
					// the provider may reject it but that's better than guessing.
					return {
						type: "document" as const,
						source: {
							type: "base64" as const,
							media_type: source.media_type ?? "application/octet-stream",
							data: fileRow.content,
						},
						text_representation:
							typeof block.text_representation === "string"
								? (block.text_representation as string)
								: undefined,
						title: typeof block.title === "string" ? (block.title as string) : undefined,
						filename: typeof block.filename === "string" ? (block.filename as string) : undefined,
					};
				}
			}

			// Fall back to text_representation if available, else a stub.
			const textRep =
				typeof block.text_representation === "string"
					? block.text_representation
					: "[Document: content unavailable]";
			return { type: "text" as const, text: textRep };
		}

		// Handle file_ref image sources that need DB lookup
		if (block.type === "image" && targetCapabilities.vision) {
			const source = block.source as
				| { type?: string; file_id?: string; data?: string; media_type?: string }
				| undefined;
			if (source?.type === "file_ref" && source.file_id) {
				// Attempt to resolve file content from files table
				const fileRow = db
					.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
					.get(source.file_id) as { content: string | null; is_binary: number } | null;

				if (!fileRow || !fileRow.content) {
					// File not found or binary without content — use text placeholder
					return {
						type: "text" as const,
						text: `[Image file unavailable: ${source.file_id}]`,
					};
				}
				// Resolve to base64 inline block. Use the media_type hint on
				// the file_ref if present; fall back to image/jpeg only when
				// the connector didn't stamp a type (legacy path). Hardcoding
				// image/jpeg was wrong because Discord uploads include png,
				// webp, and gif — and the provider uses mediaType to pick the
				// right tokenizer.
				const mediaType = (source.media_type ?? "image/jpeg") as
					| "image/jpeg"
					| "image/png"
					| "image/gif"
					| "image/webp";
				return {
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: mediaType,
						data: fileRow.content,
					},
					description: block.description,
				};
			}
		}

		return block;
	});

	// Only emit advisory once per thread+vision-capability combo to avoid log noise
	if (hasImage && !targetCapabilities.vision) {
		const advisoryKey = `${threadId}::vision:false`;
		if (!advisoryDedup.has(advisoryKey)) {
			advisoryDedup.add(advisoryKey);
			// Note: we don't have access to logger here — advisory is a no-op for now.
			// Agent-loop logs the substitution at the call site.
		}
	}

	return { ...msg, content: substituted as LLMMessage["content"] };
}

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
		platformContext,
		targetCapabilities,
		effectiveTruncationRatio = TRUNCATION_TARGET_RATIO,
	} = params;

	// Debug tracking for ContextAssemblyResult
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
	let enrichmentTiers: TieredEnrichment | undefined; // State variable for tracking
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
		// Anchor the compaction boundary to the index of the LAST user message,
		// with fallback to the sliding boundary when no user message exists.
		// This is critical for prefix-cache stability: without it, the boundary
		// `messages.length - recentWindow` slides forward by 2 every warm/cold
		// pass as new assistant + tool_result messages append, which mutates a
		// previously-preserved tool_result's bytes and busts the provider's
		// cached prefix.
		//
		// Anchoring to lastUserIdx keeps the boundary STABLE for every LLM round
		// inside a single user request. Tool_results between an old user message
		// and the most recent one get stubbed once and stay stubbed; tool_results
		// after the most recent user message are in-flight and stay intact.
		// The boundary only moves when the user sends a new message — at which
		// point a one-time cache invalidation is the natural break point.
		//
		// Cold and warm paths must use the SAME anchor logic; otherwise warm-
		// after-cold misses cache because the two produce different stub sets.
		// See packages/agent/src/warm-compaction.ts for the warm-path twin.
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		const compactionBoundary =
			lastUserIdx >= 0 ? lastUserIdx : Math.max(0, messages.length - recentWindow);

		// Inject thread summary if available
		const thread = db.query("SELECT summary FROM threads WHERE id = ?").get(threadId) as {
			summary: string | null;
		} | null;
		if (thread?.summary) {
			// Prepend a synthetic developer-role summary message.
			// It will be picked up naturally by later stages.
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

		// Compact old tool results (everything before the recent window)
		// The boundary shifts by 1 if we prepended the summary message.
		// - tool_result: replace with pointer + short preview (always, for space)
		// - tool_call thinking: budget-driven — only strip when context exceeds
		//   TRUNCATION_TARGET_RATIO of the window. Preserves the model's reasoning
		//   chain on cold assembly when there's room, preventing reorientation.
		// - assistant: NOT compacted — the LLM mimics the compaction format
		// - user: kept intact (ground truth)
		const adjustedBoundary = thread?.summary ? compactionBoundary + 1 : compactionBoundary;
		for (let i = 0; i < adjustedBoundary; i++) {
			const msg = messages[i];
			if (msg.role === "tool_result" && msg.content.length > COLD_COMPACTION_THRESHOLD) {
				const originalLength = msg.content.length;
				const preview = safeSlice(msg.content, 0, 200).trimEnd();
				msg.content = `[Tool result truncated for inline display — ${originalLength} chars stored. Full content: query SELECT content FROM messages WHERE id='${msg.id}']\n${preview}`;
			}
		}

		// Budget-driven thinking compaction: only strip thinking blocks from
		// tool_call messages when post-tool_result-compaction size exceeds the
		// TRUNCATION_TARGET_RATIO threshold. Preserves the model's reasoning
		// chain on cold assembly when there's headroom.
		const thinkingThreshold = Math.floor(contextWindow * effectiveTruncationRatio);
		let coldEstimate = 0;
		for (const msg of messages) {
			coldEstimate += countTokens(msg.content);
		}
		if (coldEstimate > thinkingThreshold) {
			for (let i = 0; i < adjustedBoundary; i++) {
				if (coldEstimate <= thinkingThreshold) break;
				const msg = messages[i];
				if (msg.role === "tool_call" && hasStrippableThinking(msg.content)) {
					const before = countTokens(msg.content);
					msg.content = stripThinkingFromToolCall(msg.content);
					const after = countTokens(msg.content);
					coldEstimate -= before - after;
				}
			}
		}
	}
	stage1_7Span.end();

	// Stage 2: PURGE_SUBSTITUTION
	// Find any purge messages and replace targeted IDs with summaries
	const stage2Span = getTracer().startSpan("context.stage-2-purge-substitution");
	const purgeMessages = messages.filter((m) => m.role === "purge");
	const purgeIdToSummary = new Map<string, string>();
	const purgeGroups: Array<{ ids: Set<string>; summary: string }> = [];

	for (const purgeMsg of purgeMessages) {
		try {
			const purgeData = JSON.parse(purgeMsg.content);
			const targetIds: string[] = purgeData.target_ids || [];
			const summary: string = purgeData.summary || "Messages purged from conversation";

			if (targetIds.length > 0) {
				const group = { ids: new Set(targetIds), summary };
				purgeGroups.push(group);

				for (const id of targetIds) {
					purgeIdToSummary.set(id, summary);
				}
			}
		} catch (_error) {
			// Ignore purge metadata parse errors — no logger available in this context
			// Malformed purge messages are silently skipped
		}
	}

	// Build a map of tool_call IDs to their paired tool_result IDs
	const toolCallToPair = new Map<string, string>();
	const toolResultToPair = new Map<string, string>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "tool_call") {
			// Find the next tool_result
			for (let j = i + 1; j < messages.length; j++) {
				if (messages[j].role === "tool_result") {
					toolCallToPair.set(msg.id, messages[j].id);
					toolResultToPair.set(messages[j].id, msg.id);
					break;
				}
			}
		}
	}

	// Expand purge groups to include paired tool messages
	for (const group of purgeGroups) {
		const additionalIds = new Set<string>();
		for (const id of Array.from(group.ids)) {
			// If this is a tool_call, include its paired tool_result
			const pairedResult = toolCallToPair.get(id);
			if (pairedResult && !group.ids.has(pairedResult)) {
				additionalIds.add(pairedResult);
			}
			// If this is a tool_result, include its paired tool_call
			const pairedCall = toolResultToPair.get(id);
			if (pairedCall && !group.ids.has(pairedCall)) {
				additionalIds.add(pairedCall);
			}
		}
		// Add the additional IDs to the group
		for (const id of Array.from(additionalIds)) {
			group.ids.add(id);
			purgeIdToSummary.set(id, group.summary);
		}
	}

	// Build the list of messages to process, replacing purge groups with summaries
	const messagesAfterPurge: Message[] = [];
	const processedPurgeGroups = new Set<number>();
	const purgeMessageIds = new Set(purgeMessages.map((m) => m.id));

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Skip purge messages themselves
		if (purgeMessageIds.has(msg.id)) {
			continue;
		}

		// Check if this message is part of a purge group
		const purgedSummary = purgeIdToSummary.get(msg.id);
		if (purgedSummary) {
			// Find which purge group this belongs to
			const groupIndex = purgeGroups.findIndex((g) => g.ids.has(msg.id));
			if (groupIndex !== -1 && !processedPurgeGroups.has(groupIndex)) {
				// This is the first message in this purge group - replace it with a summary
				const group = purgeGroups[groupIndex];
				processedPurgeGroups.add(groupIndex);

				// Create a developer message with the purge summary, flagged
				// as an agent-authored claim. The summary text comes from
				// the agent's own input to the `purge` tool — there's no
				// system verification of its truthfulness at write time.
				// On read, the bridge wraps developer messages in
				// <system-context>...</system-context>; without an explicit
				// provenance marker the agent re-reads its own past summary
				// as authoritative system state and gate-dismisses real
				// events that contradict it (live evidence: thread d0372be6
				// 2026-05-24, where the agent's confabulated "Issues #20-36
				// captured" claim drove ~50 turns of "stand down" decisions
				// against actual fresh webhook deliveries). The provenance
				// prefix asks the agent to verify against ground truth
				// (messages / semantic_memory / files tables) before
				// relying on the summary's claims.
				messagesAfterPurge.push({
					id: `purge-summary-${groupIndex}`,
					thread_id: threadId,
					role: "developer",
					content: `(purged ${group.ids.size} messages — agent-authored summary, unverified; verify against source tables before relying) ${group.summary}`,
					model_id: null,
					tool_name: null,
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: "local",
					deleted: 0,
					exit_code: null,
					metadata: null,
				});
			}
			// Skip this message (and all subsequent messages in the same purge group)
			continue;
		}

		// Not purged - include it
		messagesAfterPurge.push(msg);
	}
	stage2Span.end();

	// Stage 2.5: NON-LLM ROLE FILTERING
	// Drop non-LLM-compatible roles before Stage 3 sanitizer runs. Per
	// Invariant #19, role='system' must never be persisted into the messages
	// table — insertRow() enforces this at the write boundary. Any row
	// reaching this filter with role='system' is legacy/corrupt data; drop it.
	// The prior prefix allowlist for "purge-summary-" / "__compaction_" was
	// dead code — those synthetic messages (inserted earlier in this function
	// at lines 783 and 930) are role='developer', not 'system'.
	const stage2_5Span = getTracer().startSpan("context.stage-2.5-role-filtering");
	const NON_LLM_ROLES = new Set(["alert", "purge", "system"]);
	const messagesFiltered = messagesAfterPurge.filter((m) => !NON_LLM_ROLES.has(m.role));
	stage2_5Span.end();

	// Stage 3: TOOL_PAIR_SANITIZATION
	// Ensure tool_call/tool_result pairs are adjacent (no messages between them).
	//
	// Pass 1: For each tool_call, look ahead for its matching tool_result.
	// If there are non-tool messages between them, move those messages before the tool_call.
	// This preserves the real tool_call -> tool_result adjacency that Bedrock requires.
	const stage3Span = getTracer().startSpan("context.stage-3-tool-pair-sanitization");
	const reordered: Message[] = [];
	const consumed = new Set<number>();

	for (let i = 0; i < messagesFiltered.length; i++) {
		if (consumed.has(i)) continue;

		const msg = messagesFiltered[i];
		if (msg.role === "tool_call") {
			// Collect ALL tool_results that belong to this tool_call, looking past any
			// interleaved non-tool messages. The co-emitted assistant text is persisted
			// with the same `now` timestamp as the tool_call; if some tool_results land
			// in the next millisecond, ORDER BY (created_at, rowid) places the assistant
			// between the fast and slow results. We detect this by tracking which
			// tool_use_ids are still unmatched — if more are pending we continue past
			// the non-tool message; if all are matched we stop (legitimate post-pair msg).
			const matchIndices: number[] = [];
			const nonToolMessages: Message[] = [];
			const nonToolIndices: number[] = [];

			// Build set of expected tool_use_ids from this tool_call's content
			const pendingToolUseIds = new Set<string>();
			try {
				const tcBlocks = JSON.parse(msg.content);
				if (Array.isArray(tcBlocks)) {
					for (const block of tcBlocks) {
						if (block.type === "tool_use" && block.id) {
							pendingToolUseIds.add(block.id);
						}
					}
				}
			} catch (_error) {
				// Non-parseable tool_call content — fall back to unlimited scan
				// No logger available in this context
			}

			// Flag flips true once we scan past the next tool_call boundary while
			// still chasing straggler results for this tool_call's pending ids.
			let crossedToolCallBoundary = false;
			for (let j = i + 1; j < messagesFiltered.length; j++) {
				if (consumed.has(j)) continue;
				const jMsg = messagesFiltered[j];
				if (jMsg.role === "tool_call") {
					// Hit the next tool_call. Normally this closes our scan, BUT if
					// we still have unmatched tool_use_ids, a real tool_result for
					// one of them may be a "straggler" that landed AFTER the next
					// turn's tool_call (parallel tool racing: the agent loop
					// re-entered inference before the slow result came back). Keep
					// scanning past this next tool_call, but only to claim results
					// whose tool_name is in OUR pending set — we never steal results
					// that belong to the next tool_call.
					if (pendingToolUseIds.size === 0) {
						break;
					}
					crossedToolCallBoundary = true;
					continue;
				}
				if (jMsg.role === "tool_result") {
					if (crossedToolCallBoundary) {
						// After crossing a later tool_call, only claim results whose
						// tool_name is one of OUR outstanding pending ids.
						if (!jMsg.tool_name || !pendingToolUseIds.has(jMsg.tool_name)) {
							continue;
						}
					}
					matchIndices.push(j);
					// Remove matched tool_use_id from pending set
					if (jMsg.tool_name) pendingToolUseIds.delete(jMsg.tool_name);
				} else {
					// Non-tool message encountered after finding at least one result.
					// Continue scanning past it only if there are still unmatched
					// tool_use_ids — those results are displaced by the timestamp
					// collision and we need to keep looking for them.
					// If all tool_use_ids are matched (or the set was never populated),
					// stop: this message legitimately follows the completed pair.
					if (matchIndices.length > 0 && pendingToolUseIds.size === 0) {
						break;
					}
					// Don't reorder messages from past the next tool_call boundary —
					// they belong to a different turn. Only reorder system messages
					// between us and our results (the original adjacent-reorder case).
					if (crossedToolCallBoundary) {
						continue;
					}
					// Only reorder system messages, NOT assistant messages.
					// Assistant messages between tool_call and tool_result should stay
					// in place — Pass 2 will handle the structural repair. Moving
					// assistants before tool_calls corrupts conversation ordering.
					if (jMsg.role !== "assistant") {
						nonToolMessages.push(jMsg);
						nonToolIndices.push(j);
					}
					// If it IS an assistant, leave it in place — don't add to nonToolMessages
				}
			}

			if (matchIndices.length > 0) {
				// Move non-tool messages before the tool_call
				for (const m of nonToolMessages) {
					reordered.push(m);
				}
				for (const idx of nonToolIndices) {
					consumed.add(idx);
				}
				for (const idx of matchIndices) {
					consumed.add(idx);
				}
				// Push tool_call followed by ALL its tool_results in order
				reordered.push(msg);
				for (const idx of matchIndices) {
					reordered.push(messagesFiltered[idx]);
				}
			} else {
				// No tool_results found — push non-tool messages and tool_call as-is
				for (const m of nonToolMessages) {
					reordered.push(m);
				}
				for (const idx of nonToolIndices) {
					consumed.add(idx);
				}
				reordered.push(msg);
			}
		} else {
			reordered.push(msg);
		}
	}

	// Pass 2: Handle any remaining structural issues (orphaned tool_results, unclosed tool_calls)
	const sanitized: Message[] = [];
	// Track remaining expected tool_use_ids from the active tool_call.
	// Non-empty = tool pair is open and waiting for results.
	const activePendingIds = new Set<string>();
	// Boolean fallback for tool_calls whose content can't be parsed for IDs.
	// When true and activePendingIds is empty, the next tool_result still belongs
	// to this tool_call (legacy single-tool or malformed content).
	let inActiveToolCall = false;
	let lastToolId = "";
	let lastToolUseIds: string[] = []; // track IDs from the last tool_call for synthetic results
	let prevSanitizedRole: string | null = null;
	// Track the last synthetic tool_call injected for orphaned tool_results, so we
	// can extend it when consecutive orphans from the same multi-tool call appear.
	let lastSyntheticToolCall: Message | null = null;

	/** Extract tool_use IDs from a tool_call message's content */
	const extractToolUseIds = (content: string): string[] => {
		try {
			const blocks = JSON.parse(content);
			if (Array.isArray(blocks)) {
				return blocks
					.filter((b: { type?: string; id?: string }) => b.type === "tool_use" && b.id)
					.map((b: { id: string }) => b.id);
			}
		} catch {
			// Non-parseable content
		}
		return [];
	};

	/** Generate synthetic tool_result messages for each tool_use ID */
	const makeSyntheticResults = (
		prefix: string,
		toolUseIds: string[],
		errContent: string,
	): Message[] => {
		if (toolUseIds.length === 0) {
			// Fallback: single result with no tool_name (legacy behavior)
			return [
				{
					id: `${prefix}-${lastToolId}`,
					thread_id: threadId,
					role: "tool_result",
					content: errContent,
					model_id: null,
					tool_name: null,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					host_origin: "local",
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
			];
		}
		return toolUseIds.map((tuId, idx) => ({
			id: `${prefix}-${lastToolId}-${idx}`,
			thread_id: threadId,
			role: "tool_result",
			content: errContent,
			model_id: null,
			tool_name: tuId,
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			host_origin: "local",
			deleted: 0,
			exit_code: null,
			metadata: null,
		}));
	};

	/** Flush synthetic results for any remaining pending tool_use_ids */
	const flushPendingIds = (prefix: string, errContent: string): void => {
		if (activePendingIds.size > 0) {
			const remaining = [...activePendingIds];
			const results = makeSyntheticResults(prefix, remaining, errContent);
			for (const r of results) {
				sanitized.push(r);
			}
			activePendingIds.clear();
		}
	};

	for (const msg of reordered) {
		if (msg.role === "tool_call") {
			// Close any prior incomplete tool pair
			flushPendingIds("synthetic", "Tool execution was interrupted");
			inActiveToolCall = true;
			lastToolId = msg.id;
			lastToolUseIds = extractToolUseIds(msg.content);
			// Populate pending set — tool pair stays open until all IDs are matched
			activePendingIds.clear();
			for (const id of lastToolUseIds) activePendingIds.add(id);
			lastSyntheticToolCall = null;
			sanitized.push(msg);
			prevSanitizedRole = "tool_call";
		} else if (msg.role === "tool_result") {
			if (activePendingIds.size > 0 || inActiveToolCall) {
				// Part of active tool pair — remove matched ID from pending set
				if (msg.tool_name) activePendingIds.delete(msg.tool_name);
				inActiveToolCall = false; // first result received
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			} else if (prevSanitizedRole === "tool_result") {
				if (lastSyntheticToolCall) {
					// Consecutive orphaned tool_result — extend the synthetic tool_call
					// with this result's tool_use_id so the Bedrock driver sees matching IDs.
					const toolUseId = msg.tool_name || `synthetic-tc-${msg.id}`;
					try {
						const blocks = JSON.parse(lastSyntheticToolCall.content);
						if (Array.isArray(blocks) && !blocks.some((b: { id?: string }) => b.id === toolUseId)) {
							blocks.push({ type: "tool_use", id: toolUseId, name: "unknown", input: {} });
							lastSyntheticToolCall.content = JSON.stringify(blocks);
						}
					} catch {
						// Non-parseable synthetic content — shouldn't happen
					}
				}
				// Additional tool_result in a multi-tool response — push directly,
				// no synthetic tool_call needed. The driver merges these into one
				// user message per the Bedrock/Anthropic multi-tool requirement.
				sanitized.push(msg);
				// prevSanitizedRole stays "tool_result"
			} else {
				// Truly orphaned tool_result (no preceding tool_call at all) — inject synthetic.
				// Use the tool_result's own tool_use_id (stored in tool_name) so the Bedrock
				// driver emits a proper toolUse block instead of falling back to [{ text: "" }]
				// which Bedrock rejects with "text field is blank".
				const toolUseId = msg.tool_name || `synthetic-tc-${msg.id}`;
				const syntheticMsg: Message = {
					id: `synthetic-${msg.id}`,
					thread_id: threadId,
					role: "tool_call",
					content: JSON.stringify([
						{ type: "tool_use", id: toolUseId, name: "unknown", input: {} },
					]),
					model_id: null,
					tool_name: toolUseId,
					created_at: msg.created_at,
					modified_at: msg.modified_at,
					host_origin: msg.host_origin,
					deleted: 0,
					exit_code: null,
					metadata: null,
				};
				lastSyntheticToolCall = syntheticMsg;
				sanitized.push(syntheticMsg);
				sanitized.push(msg);
				prevSanitizedRole = "tool_result";
			}
		} else {
			// Non-tool message — flush any remaining pending IDs first
			if (inActiveToolCall) {
				// Tool_call with no results at all — generate synthetics for ALL IDs
				const results = makeSyntheticResults(
					"synthetic",
					lastToolUseIds,
					"Tool execution was interrupted",
				);
				for (const r of results) {
					sanitized.push(r);
				}
				activePendingIds.clear();
				inActiveToolCall = false;
			} else {
				flushPendingIds("synthetic", "Tool execution was interrupted");
			}
			lastSyntheticToolCall = null;
			sanitized.push(msg);
			prevSanitizedRole = msg.role;
		}
	}

	// Close any unclosed tool pair (pending IDs remain)
	if (inActiveToolCall) {
		const results = makeSyntheticResults(
			"synthetic-close",
			lastToolUseIds,
			"Tool execution completed",
		);
		for (const r of results) {
			sanitized.push(r);
		}
	} else {
		flushPendingIds("synthetic-close", "Tool execution completed");
	}
	stage3Span.end();

	// Stage 4: MESSAGE_QUEUEING
	// Already handled by filtering - skip messages that were persisted during active tool-use
	const stage4Span = getTracer().startSpan("context.stage-4-message-queueing");
	stage4Span.setAttribute("stage.implicit", true);
	stage4Span.end();

	// Stage 5: ANNOTATION
	// Convert Message to LLMMessage format with annotations
	// Also detect model switches between consecutive assistant messages per spec R-U11
	// Defense-in-depth: filter non-LLM roles in case any survived Stage 2.5
	const stage5Span = getTracer().startSpan("context.stage-5-annotation");
	const LLM_COMPATIBLE_ROLES = new Set([
		"user",
		"assistant",
		"system",
		"developer",
		"tool_call",
		"tool_result",
	]);

	// Build a map from tool_call message ID to the tool_use IDs contained within,
	// so we can propagate tool_use_id to the subsequent tool_result messages.
	// Also collect all known tool_use IDs so we can validate tool_result.tool_name
	// against actual IDs (tool_name may contain a tool name instead of an ID due
	// to historical data from before the toolCallId fix).
	const toolCallIdToToolUseId = new Map<string, string>();
	const knownToolUseIds = new Set<string>();
	for (const m of sanitized) {
		if (m.role === "tool_call") {
			try {
				const blocks = JSON.parse(m.content);
				if (Array.isArray(blocks)) {
					for (const block of blocks) {
						if (block.id) {
							knownToolUseIds.add(block.id);
						}
					}
					if (blocks.length > 0 && blocks[0].id) {
						toolCallIdToToolUseId.set(m.id, blocks[0].id);
					}
				}
			} catch (_error) {
				// Content may not be JSON (e.g. synthetic tool_call)
				// No logger available in this context
			}
		}
	}

	const annotated: LLMMessage[] = [];
	let lastAssistantModel: string | null = null;
	let lastToolCallMsgId: string | null = null;
	let modelSwitchCount = 0;
	const MODEL_SWITCH_CAP = 3;

	for (let i = 0; i < sanitized.length; i++) {
		const m = sanitized[i];

		// Skip non-LLM roles (alert, purge, etc.)
		if (!LLM_COMPATIBLE_ROLES.has(m.role)) {
			continue;
		}

		// Track the last tool_call message ID for tool_use_id propagation
		if (m.role === "tool_call") {
			lastToolCallMsgId = m.id;
		}

		// Check for model switch on assistant messages; cap at MODEL_SWITCH_CAP
		// to prevent long threads with many switches from flooding the context.
		if (m.role === "assistant" && m.model_id) {
			if (lastAssistantModel && lastAssistantModel !== m.model_id) {
				if (modelSwitchCount < MODEL_SWITCH_CAP) {
					annotated.push({
						role: "developer",
						content: `Model switched from ${lastAssistantModel} to ${m.model_id}`,
					});
					modelSwitchCount++;
				}
			}
			lastAssistantModel = m.model_id;
		}

		// Parse JSON ContentBlock[] strings back into arrays.
		// The DB stores image/document messages as JSON-serialized ContentBlock[].
		// Parse them here so Stage 5b substitution and drivers receive proper arrays.
		let annotatedContent: string | ContentBlock[] = m.content;
		if (
			typeof m.content === "string" &&
			(m.role === "user" || m.role === "assistant" || m.role === "tool_result")
		) {
			try {
				const parsed = JSON.parse(m.content);
				if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
					annotatedContent = parsed as ContentBlock[];
				}
			} catch (_error) {
				// Not JSON — keep as plain text string
				// No logger available in this context
			}
		}

		// Annotate user messages with absolute timestamps so the agent can
		// detect session boundaries and temporal gaps. Only user messages are
		// annotated — annotating assistant messages caused the LLM to echo
		// the timestamp format as its entire response (producing noise like
		// "[Apr 5, 07:25]" persisted as real assistant messages).
		// Uses absolute format (e.g. "[Apr 4, 14:30]") instead of relative
		// (e.g. "[5m ago]") to avoid busting the LLM prompt cache prefix.
		// Only annotate when the message is >= 1 minute old (no value for very recent).
		if (m.role === "user" && m.created_at) {
			const ageMs = Date.now() - new Date(m.created_at).getTime();
			if (ageMs >= 60_000 && typeof annotatedContent === "string") {
				const ts = formatTimestamp(m.created_at);
				annotatedContent = `${ts} ${annotatedContent}`;
			}
		}

		const msg: LLMMessage = {
			role: m.role as LLMMessage["role"],
			content: annotatedContent,
			model_id: m.model_id || undefined,
			host_origin: m.host_origin,
		};

		// Propagate tool_use_id for tool_result messages
		// In the DB, tool_name stores the tool_use_id for tool_result messages.
		// Validate that tool_name is an actual tool_use ID (not a tool name like
		// "retrieve_task" from historical data before the toolCallId fix).
		if (m.role === "tool_result") {
			const toolUseId =
				(m.tool_name && knownToolUseIds.has(m.tool_name) ? m.tool_name : null) ||
				(lastToolCallMsgId ? toolCallIdToToolUseId.get(lastToolCallMsgId) : null) ||
				`synthetic-${m.id}`;
			msg.tool_use_id = toolUseId;
		}

		annotated.push(msg);
	}
	stage5Span.end();

	// Stage 5b: CONTENT_SUBSTITUTION
	// Replace image/document blocks in assembled messages when the target backend lacks vision support.
	// This modifies the LLMMessage[] only — the persisted messages.content is never changed.
	const stage5bSpan = getTracer().startSpan("context.stage-5b-content-substitution");
	const finalAnnotated = targetCapabilities
		? annotated.map((msg) => substituteUnsupportedBlocks(msg, targetCapabilities, db, threadId))
		: annotated;
	stage5bSpan.end();

	// Stage 6: ASSEMBLY
	const stage6Span = getTracer().startSpan("context.stage-6-assembly");
	// Build stable system prompt as a string (returned separately, not in messages array).
	// Drivers receive this via the `system` param, keeping it out of the message prefix.
	const systemParts: string[] = [];

	// Environment paragraph: explains what bound and boundless are so the
	// agent has a grounded mental model of its runtime, its memory, and the
	// user-facing surfaces it can be invoked from. Static / cache-friendly.
	const environmentParagraph =
		"**Environment.** You run inside **bound**, a persistent, model-agnostic personal agent " +
		"daemon. Bound owns a local SQLite database that is the source of truth for your memory — " +
		"semantic memory entries, thread summaries, activated skills, and advisories all persist " +
		"across conversations, hosts, and user-facing surfaces, which is what lets you stay " +
		"coherent with the user between sessions. You read and write that memory through commands " +
		"like `memorize`, `memory`, and `query` (read-only SQL and read-only PRAGMAs). Users can " +
		"reach you through several surfaces: the bound web UI, Discord (via a platform " +
		"connector), or **boundless** — a terminal coding client that connects to a bound daemon " +
		"over WebSocket and renders your responses in an Ink-based TUI. Boundless provides its " +
		"own filesystem tools (`boundless_read`, `boundless_write`, `boundless_edit`, " +
		"`boundless_bash`) scoped to the user's local working directory; those tools are only " +
		"present when the current thread is a boundless thread. You may also be invoked " +
		"indirectly through `bound-mcp`, a stdio MCP proxy that forwards a single `bound_chat` " +
		"tool call into a bound thread. Which surface originated the current turn is noted in " +
		"the volatile context that follows this prompt.";
	const concurrencyParagraph =
		"**Concurrency model.** Each conversation is a *thread*, and bound can run many threads " +
		"in parallel — including threads you spawn for yourself. Use `schedule` to fan work out " +
		"into sibling threads (deferred `--in`, recurring `--every`, or event-driven `--on`); " +
		"each scheduled task runs in its own thread with its own context window, so they don't " +
		"consume this conversation's budget. Use `--after` to chain dependencies, `--inject " +
		"results|all|file` to feed a child thread's output back into this one, and `await` to " +
		"block on specific task IDs when you need their results before proceeding. Treat " +
		"parallel threads as a primary tool for long-running research, exploration, and " +
		"multi-step plans: fan out first, synthesize later. This is an implementation detail of " +
		"how you operate — don't narrate it to the user unless they ask how the work is being " +
		"done.";
	systemParts.push(environmentParagraph);
	systemParts.push(concurrencyParagraph);

	// Load and inject persona if it exists
	const persona = loadPersona(configDir);
	if (persona) {
		systemParts.push(persona);
	}

	// Stable orientation section: available commands, current model, host identity
	const registry = params.commandRegistry ?? [];
	const orientationLines: string[] = ["## Orientation", ""];

	// MCP bridge commands are the only commands still in the registry.
	// Native agent tools are self-describing through their ToolDefinition schemas.
	if (registry.length > 0) {
		const commandList = [...registry]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((c) => `  ${c.name} — ${c.description}`)
			.join("\n");
		orientationLines.push(
			"### Additional MCP Commands",
			commandList,
			"",
			"These are MCP server commands dispatched through the bash tool. Run `<server-name> --help` for details.",
			"",
		);
	}

	orientationLines.push(
		`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
	);

	systemParts.push(orientationLines.join("\n"));

	// Live schema block: lists every synced table and its columns by
	// introspecting the DB with PRAGMA table_info. Read-only; part of the
	// stable prefix (cached once per cold assembly).
	try {
		const schemaInfos = getSyncedTableSchemas(db);
		const schemaLines: string[] = [
			"## Database Schema",
			"",
			"Synced tables available via the `query` command:",
			"",
		];
		for (const info of schemaInfos) {
			// Skip tables that aren't materialized in this DB yet (e.g.,
			// partial test setup that skipped applyMetricsSchema). Emitting
			// a table header with zero columns is noise.
			if (info.columns.length === 0) continue;
			schemaLines.push(`### ${info.table}`);
			for (const col of info.columns) {
				const parts: string[] = [col.name, col.type || "TEXT"];
				if (col.pk) parts.push("PK");
				if (col.notnull) parts.push("NOT NULL");
				schemaLines.push(`- ${parts.join(" ")}`);
			}
			schemaLines.push("");
		}
		systemParts.push(schemaLines.join("\n").trimEnd());
	} catch (_error) {
		// Non-fatal: if introspection fails (e.g., synthetic test DB missing
		// a table), skip the schema block rather than blocking assembly.
	}

	const assembled: LLMMessage[] = [];

	// Track part count before skill injection (for token tracking)
	const systemPartCountBeforeSkill = systemParts.length;

	// Track inactive skill reference for volatile context note (AC3.4)
	let inactiveSkillRef: string | undefined;

	// Inject task-referenced skill body into system prompt (AC3.3, AC3.5)
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
					// No logger available in this context
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
			// No logger available in this context
		}
	}

	// Track system section tokens (parts before skill injection).
	// Build the system prompt string AFTER the volatile-context build so the
	// stable prefix (Working Knowledge bodies + Discoverable Archive titles +
	// skill index) can be folded into systemParts. That gets it onto the
	// `system` provider param where the existing system-level cache breakpoint
	// covers it cross-thread (the cron-task cache reuse goal called out in the
	// historical line-1774 comment). The bridge would otherwise merge a
	// pre-history developer message into the first user message and lose
	// cross-thread byte stability.
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

	// Add message history
	assembled.push(...finalAnnotated);

	// Track history section with role children
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
			platformContext,
			systemPromptAddition: params.systemPromptAddition,
			userMessageText,
			threadSummary,
			inactiveSkillRef,
		});

		// STABLE PREFIX: fold WK bodies + DA titles + skill index into systemParts.
		// Sits behind the system-level cache breakpoint, so steady-state runs reuse
		// the prefix across turns and across threads.
		if (volatileCtx.stableContent.length > 0) {
			systemParts.push(volatileCtx.stableContent);
			sections[volatilePrefixSectionIndex] = {
				name: "volatile-prefix",
				tokens: volatileCtx.stableTokenEstimate,
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

	// Track tools section (from ContextParams)
	const toolTokens = params.toolTokenEstimate ?? 0;
	if (toolTokens > 0) sections.push({ name: "tools", tokens: toolTokens });
	stage6Span.end();

	// Stage 5.5: VOLATILE_ENRICHMENT
	const stage5_5Span = getTracer().startSpan("context.stage-5.5-volatile-enrichment");

	// Stage 5.5 (noHistory path): Inject enrichment as standalone system message for autonomous tasks
	if (noHistory) {
		enrichmentBaseline = computeBaseline(db, threadId, params.taskId, true);
		const nowMs = Date.now();

		// Load inputs for renderers with smaller caps (maxMemory=10, maxTasks=5)
		const pinnedNH = loadPinnedEntries(db);
		const summariesNH = loadSummaryEntries(db, pinnedNH.exclusionSet);
		const detailEntriesNH = loadDetailEntries(db);
		const staleChildrenMapNH = buildStaleChildrenMap(db, summariesNH.entries);
		const parentSummaryMapNH = buildParentSummaryMap(
			db,
			detailEntriesNH.entries.map((e) => e.key),
		);
		const digestNH = buildCrossThreadDigest(db, userId, threadId);
		const advisoriesNH = loadAppliedAdvisoriesForLiveState(db, nowMs);

		// Compute task and file entries
		const {
			taskDigestEntries: taskEntriesNH,
			taskDigestLines: noHistTasks,
			tiers: enrichmentTiersL2,
		} = buildVolatileEnrichment(db, enrichmentBaseline, 10, 5, undefined, undefined, 10);
		const fileEntriesNH = loadFileModificationsForLiveState(db, threadId);

		// Compute delta-key set
		const allDeltaKeysNH = db
			.prepare(
				`SELECT DISTINCT key FROM semantic_memory
				 WHERE modified_at > ?
				   AND deleted = 0
				   AND key NOT LIKE '_internal.%'`,
			)
			.all(enrichmentBaseline) as Array<{ key: string }>;
		const deltaKeysNH = new Set(allDeltaKeysNH.map((r) => r.key));

		enrichmentTiers = enrichmentTiersL2;
		taskDigestLinesSnapshot = noHistTasks;

		// Compose the three sections using the shared helper. The noHistory
		// path mirrors the primary path's split: stable subsections fold into
		// systemParts (cacheable cross-thread), varying tail rides as a
		// developer message at the assembled tail.
		const { stableLines: nhStable, varyingLines: nhVarying } = composeVolatileSections({
			db,
			pinned: pinnedNH.entries,
			summaries: summariesNH.entries,
			detailEntries: detailEntriesNH.entries,
			staleChildrenMap: staleChildrenMapNH,
			parentSummaryMap: parentSummaryMapNH,
			deltaKeys: deltaKeysNH,
			digest: digestNH,
			taskDigestEntries: taskEntriesNH,
			fileEntries: fileEntriesNH,
			advisories: advisoriesNH,
			recencyEntries: flattenRecencyEntries(enrichmentTiersL2),
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
			pinned: pinnedNH.entries,
			summaries: summariesNH.entries,
			detailEntries: detailEntriesNH.entries,
			parentSummaryMap: parentSummaryMapNH,
			staleChildrenMap: staleChildrenMapNH,
			budgetPressure: false,
			activeSkills: [],
		});

		if (renderedEnrichmentLines.length > 0) {
			totalMemCount = (
				db.prepare("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as {
					c: number;
				}
			).c;

			if (nhStable.length > 0) {
				systemParts.push(nhStable.join("\n"));
			}

			const varyingTailLines: string[] = [...nhVarying];
			// In noHistory the varying tail begins with nhVarying (no
			// User/Thread ID prefix lines), so the enrichment section sits
			// at indices [0, nhVarying.length).
			varyingEnrichmentStartIdx = 0;
			varyingEnrichmentEndIdx = nhVarying.length;

			// Append systemPromptAddition if present (AC2.2 for noHistory path).
			// Operator-supplied per-task instruction stays varying (re-runnable).
			if (params.systemPromptAddition) {
				varyingTailLines.push("");
				varyingTailLines.push(params.systemPromptAddition);
			}

			if (varyingTailLines.length > 0) {
				enrichmentMessageIndex = assembled.length;
				assembled.push({ role: "developer", content: varyingTailLines.join("\n") });
				allVaryingLines = varyingTailLines;
			}

			// Track noHistory volatile section tokens (combined for debug parity)
			const noHistVolatileTokens = countTokens(renderedEnrichmentLines.join("\n"));
			sections.push({ name: "volatile-enrichment", tokens: noHistVolatileTokens });
		}
	}
	stage5_5Span.end();

	// Build the final system prompt string. Deferred until after both Stage 6
	// (history path) and Stage 5.5 (noHistory path) have appended any stable
	// volatile content (Working Knowledge bodies + Discoverable Archive titles
	// + skill index). Folding these into the `system` provider param keeps
	// them inside the system-level cache breakpoint, so steady-state turns
	// reuse the prefix across turns AND across threads (cron-task cache reuse
	// goal called out in the historical line-1774 comment).
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

		// Re-load inputs for renderers with reduced caps (3 task entries, 3 live-state caps per subsystem)
		const pinnedBP = loadPinnedEntries(db);
		const summariesBP = loadSummaryEntries(db, pinnedBP.exclusionSet);
		const detailEntriesBP = loadDetailEntries(db);

		const staleChildrenMapBP = buildStaleChildrenMap(db, summariesBP.entries);
		const parentSummaryMapBP = buildParentSummaryMap(
			db,
			detailEntriesBP.entries.map((e) => e.key),
		);
		const digestBP = buildCrossThreadDigest(db, userId, threadId);
		const advisoriesBP = loadAppliedAdvisoriesForLiveState(db, Date.now());

		// Compute task and file entries with reduced caps (3 tasks, 3 files for Live State)
		const { taskDigestEntries: taskEntriesBP, tiers: tiersBP } = buildVolatileEnrichment(
			db,
			baseline,
			3,
			3,
		);
		const fileEntriesBP = loadFileModificationsForLiveState(db, threadId);

		// Compute delta-key set
		const allDeltaKeysBP = db
			.prepare(
				`SELECT DISTINCT key FROM semantic_memory
				 WHERE modified_at > ?
				   AND deleted = 0
				   AND key NOT LIKE '_internal.%'`,
			)
			.all(baseline) as Array<{ key: string }>;
		const deltaKeysBP = new Set(allDeltaKeysBP.map((r) => r.key));

		// Compose three sections with budgetPressure:true
		// R-VC14 §3.3: Pass full memory entries (no pre-cap); renderers handle section-specific capping
		// - Working Knowledge: full fidelity (no cap)
		// - Discoverable Archive: all titles preserved (R-VC21), fragment dropped via budgetPressure flag
		// - Live State: BUDGET_PRESSURE_SUBSYSTEM_CAP (3) applied per subsystem inside renderLiveState
		// Cap recency entries under budget pressure to mirror the
		// per-subsystem-cap-3 convention applied inside renderLiveState.
		// Even under pressure the agent needs to see fresh memory
		// activity, so don't drop the section entirely — just trim.
		const recencyBP = flattenRecencyEntries(tiersBP).slice(0, 3);
		const { stableLines: bpStable, varyingLines: bpVarying } = composeVolatileSections({
			db,
			pinned: pinnedBP.entries,
			summaries: summariesBP.entries,
			detailEntries: detailEntriesBP.entries,
			staleChildrenMap: staleChildrenMapBP,
			parentSummaryMap: parentSummaryMapBP,
			deltaKeys: deltaKeysBP,
			digest: digestBP,
			taskDigestEntries: taskEntriesBP,
			fileEntries: fileEntriesBP,
			advisories: advisoriesBP,
			recencyEntries: recencyBP,
			budgetPressure: true,
			nowMs: Date.now(),
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
				// edited under budget pressure: it is bounded by R-VC14 §3.3
				// (WK full-fidelity / presence invariant) and VC15 tunables
				// (DA titles), so leaving it stable is acceptable. The
				// shedding effect lives on the varying tail (Live State
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
				// Replace with reduced varying lines + trailing
				// systemPromptAddition (preserved verbatim from the unreduced
				// path's tail).
				const noHistVaryingLines: string[] = [...bpVarying];
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

		// Re-count volatile section tokens after budget pressure rebuild
		const reducedEnrichmentTokens = countTokens(reducedEnrichmentLines.join("\n"));

		// Update sections array to reflect new token counts
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

			// Walk backwards from end, accumulating tokens until we exceed budget
			let accumulatedTokens = 0;
			let sliceStart = historyMessages.length; // start at end (include nothing)
			for (let i = historyMessages.length - 1; i >= 0; i--) {
				const msgTokens = countContentTokens(historyMessages[i].content);
				if (accumulatedTokens + msgTokens > historyBudget) break;
				accumulatedTokens += msgTokens;
				sliceStart = i;
			}

			// Floor: keep at least 2 messages so the agent has something to work with
			sliceStart = Math.min(sliceStart, Math.max(0, historyMessages.length - 2));

			// Advance past orphaned tool_result/tool_call/assistant at the boundary
			// to start at a clean user message when possible.
			const preAdvanceStart = sliceStart;
			while (sliceStart < historyMessages.length && historyMessages[sliceStart].role !== "user") {
				sliceStart++;
			}

			// Fallback: if no user found in forward scan (e.g. scheduled task threads
			// with only system wakeup + tool_call/tool_result/assistant cycles, or
			// long bursts of tool_call/tool_result pairs that pushed every user
			// message out of the kept slice), try the last user message, or
			// fall back to the original budget-based start. The Bedrock driver
			// prepends a `<system-notification />` placeholder user message when
			// the conversation doesn't start with `user`, but that placeholder
			// does NOT satisfy a leading orphan tool_result whose tool_call was
			// sliced off — Bedrock's pair validator rejects with "Expected
			// toolResult blocks at messages.0.content for the following Ids: …".
			// So even on the budget-based fallback, advance past leading
			// `tool_result` rows whose `tool_call` partner is no longer in the
			// kept slice. We deliberately do NOT skip leading `tool_call` rows:
			// a tool_call followed by its tool_result is a well-formed pair, and
			// the placeholder user satisfies Bedrock's "first message must be
			// user" constraint.
			if (sliceStart >= historyMessages.length) {
				let foundUser = false;
				for (let i = historyMessages.length - 1; i >= 0; i--) {
					if (historyMessages[i].role === "user") {
						sliceStart = i;
						foundUser = true;
						break;
					}
				}
				if (!foundUser) {
					sliceStart = preAdvanceStart;
					while (
						sliceStart < historyMessages.length &&
						historyMessages[sliceStart].role === "tool_result"
					) {
						sliceStart++;
					}
				}
			}

			const remaining = historyMessages.slice(sliceStart);
			truncatedCount = historyMessages.length - remaining.length;

			// Inject truncation marker so the agent knows context was lost
			const truncationMarker: LLMMessage[] = [];
			if (truncatedCount > 0) {
				// Count total messages in the thread for the marker
				const totalRow = params.db
					.prepare(
						"SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND role IN ('user','assistant','tool_call','tool_result')",
					)
					.get(params.threadId) as { count: number } | null;
				const totalInThread = totalRow?.count ?? historyMessages.length;

				// Include thread summary if available — preserves gist of truncated history
				const threadRow = params.db
					.prepare("SELECT summary FROM threads WHERE id = ?")
					.get(params.threadId) as { summary: string | null } | null;
				const summarySection = threadRow?.summary
					? `\n\nSummary of earlier conversation:\n${threadRow.summary}`
					: "";

				truncationMarker.push({
					role: "developer",
					content: `[Context note: ${truncatedCount} earlier messages in this conversation were truncated to fit the context window. This thread has ${totalInThread} total messages. You are seeing only the most recent portion. If you need to reference earlier context, you can use the query command to search the messages table, e.g.: query "SELECT role, substr(content, 1, 200), created_at FROM messages WHERE thread_id = '${params.threadId}' ORDER BY created_at DESC LIMIT 50"]${summarySection}`,
				});
			}

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

					sections[histIdx] = {
						name: "history",
						tokens: postTruncUserTokens + postTruncAssistantTokens + postTruncToolResultTokens,
						children: postTruncChildren.length > 0 ? postTruncChildren : undefined,
					};
				}
			}

			const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

			// Stage 7 must record its attributes and end on every return
			// path. Pre-fix this branch returned without calling .end(),
			// orphaning the span: BatchSpanProcessor never flushed it,
			// so Jaeger had zero visibility into truncation events even
			// though they were the most operationally significant turns
			// (largest cache invalidations, biggest message drops).
			stage7Span.setAttribute("context.total_tokens", totalEstimated);
			stage7Span.setAttribute("context.headroom", effectiveBudget - totalEstimated);
			stage7Span.setAttribute("context.truncated_messages", truncatedCount);
			stage7Span.end();

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
				},
			};
		}
	}

	// Stage 8: METRIC_RECORDING
	// Deferred to Phase 8 when metrics.db is created
	const stage8Span = getTracer().startSpan("context.stage-8-metric-recording");

	const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0);

	// Add attributes to stage 7 before ending it (no-truncation path)
	stage7Span.setAttribute("context.total_tokens", totalEstimated);
	stage7Span.setAttribute("context.headroom", effectiveBudget - totalEstimated);
	stage7Span.setAttribute("context.truncated_messages", truncatedCount);
	stage7Span.end();
	stage8Span.end();

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

	return sections;
}

/**
 * Apply actual LLM-reported token counts to a previously-built ContextDebugInfo,
 * returning a fully deep-cloned new snapshot.
 *
 * The agent loop builds contextDebug once per user submission (cold or warm
 * assembly), then iterates calling the LLM multiple times for extended-tool-use.
 * After each LLM response, the actual input-token count is known and may differ
 * from the pre-call estimate; this helper updates `totalEstimated` and bumps
 * `history.tokens` by the positive delta so the recorded per-turn debug
 * reflects what actually went on the wire.
 *
 * The deep-clone (via structuredClone) is essential: the agent loop holds a
 * reference to lastContextDebug across iterations, and recordContextDebug
 * synchronously serializes it via JSON.stringify. Without the clone, mutating
 * sections in place would leave a window where a later iteration's delta
 * could retroactively alter an earlier iteration's section breakdown if the
 * synchronous-serialization invariant ever broke (e.g. async DB writes,
 * future refactors holding the reference longer, callers reading
 * lastContextDebug directly). The clone removes that latent dependency.
 */
/**
 * Records the LLM-reported actual input token count alongside the existing
 * tiktoken-derived `totalEstimated`, returning a deep-cloned snapshot so
 * concurrent loop iterations can't share section references.
 *
 * Pre-2026-05-22 this function overwrote `totalEstimated` with `actualTokens`
 * and bumped `sections.history.tokens` by the positive delta to keep the
 * section sum consistent with the new total. That destroyed the original
 * tiktoken estimate, making per-thread inflation-ratio analysis impossible
 * without ad-hoc trace correlation.
 *
 * Now both numbers live independently: `totalEstimated` stays as the
 * pre-LLM tiktoken estimate (per-section breakdown sums to it), and
 * `actualTotalTokens` carries the LLM-reported number. Visualizers wanting
 * to surface the gap can render `actualTotalTokens / totalEstimated` as
 * the inflation ratio.
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
