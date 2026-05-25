import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getPkColumn, insertRow, updateRow } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import type { CrossThreadSource, MemoryTier, Result } from "@bound/shared";
import { safeSlice } from "@bound/shared";
import { getLastThreadForFile } from "./file-thread-tracker";
import { graphSeededRetrieval } from "./graph-queries";

/**
 * High-frequency English function words filtered BEFORE passing to FTS5.
 * This prevents noisy OR queries where common words match nearly everything.
 * FTS5 handles stemming/tokenization; this set only filters query noise.
 * Deliberately excludes short content words (AI, Go, JS) — no length gate.
 */
const FTS5_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"about",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"they",
	"what",
	"how",
	"when",
	"where",
	"why",
	"which",
	"who",
	"not",
	"no",
	"and",
	"or",
	"but",
	"if",
]);

export interface ExtractionResult {
	summaryGenerated: boolean;
	memoriesExtracted: number;
}

/** Maximum character length for formatted delta messages sent to the summarization LLM. */
const DELTA_MESSAGE_CAP = 15_000;

/** Maximum character length for a single tool result in the formatted delta. */
const TOOL_RESULT_TRUNCATE = 200;

/**
 * Formats delta messages for the summarization prompt. Compresses tool
 * interactions and filters out internal plumbing (system/developer messages)
 * to give the summarization LLM a concise view of what happened.
 */
export function formatDeltaMessages(messages: Array<{ role: string; content: string }>): string {
	const lines: string[] = [];

	for (const msg of messages) {
		switch (msg.role) {
			case "user":
			case "assistant":
				// Include full content — these carry intent and reasoning
				lines.push(`[${msg.role}] ${msg.content}`);
				break;
			case "tool_call": {
				// Compress to one-liner with tool name
				try {
					const parsed = JSON.parse(msg.content);
					const calls = Array.isArray(parsed) ? parsed : [parsed];
					for (const call of calls) {
						const name = call.name ?? call.function?.name ?? "unknown";
						lines.push(`[tool_call: ${name}]`);
					}
				} catch {
					lines.push("[tool_call]");
				}
				break;
			}
			case "tool_result": {
				// Truncate aggressively — full content is in the DB
				const preview =
					msg.content.length > TOOL_RESULT_TRUNCATE
						? `${msg.content.slice(0, TOOL_RESULT_TRUNCATE)}...`
						: msg.content;
				lines.push(`[Tool result: ${preview}]`);
				break;
			}
			// system, developer — skip (internal plumbing)
			default:
				break;
		}
	}

	let result = lines.join("\n");

	// Cap total length, truncating from the front (oldest messages) since
	// recency matters more for the progress section of the summary.
	if (result.length > DELTA_MESSAGE_CAP) {
		const truncated = result.slice(result.length - DELTA_MESSAGE_CAP);
		// Find a clean line break to avoid cutting mid-message
		const firstNewline = truncated.indexOf("\n");
		const cleanStart = firstNewline >= 0 ? firstNewline + 1 : 0;
		const omittedApprox = messages.length - truncated.split("\n").length;
		result = `[${omittedApprox} earlier messages omitted]\n${truncated.slice(cleanStart)}`;
	}

	return result;
}

export async function extractSummaryAndMemories(
	db: Database,
	threadId: string,
	llmBackend: LLMBackend,
	siteId: string,
): Promise<Result<ExtractionResult, Error>> {
	try {
		// Get thread state — read existing summary for rolling synthesis
		const thread = db
			.prepare("SELECT summary, summary_through FROM threads WHERE id = ?")
			.get(threadId) as { summary: string | null; summary_through: string | null } | undefined;

		if (!thread) {
			return {
				ok: false,
				error: new Error("Thread not found"),
			};
		}

		const summaryThrough = thread.summary_through || "1970-01-01T00:00:00Z";
		const previousSummary = thread.summary;

		// Get messages after summary_through with role for delta formatting
		const messages = db
			.prepare(
				"SELECT role, content FROM messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at",
			)
			.all(threadId, summaryThrough) as Array<{ role: string; content: string }>;

		if (messages.length === 0) {
			return {
				ok: true,
				value: { summaryGenerated: false, memoriesExtracted: 0 },
			};
		}

		// Format delta messages for the summarization prompt.
		// User and assistant messages carry semantic intent and are included in full.
		// Tool calls are compressed to one-liners. Tool results are truncated.
		// System and developer messages are internal plumbing and are skipped.
		const deltaText = formatDeltaMessages(messages);

		// Resolve the user's display name so the summary references them by name
		// instead of "you" (which is meaningless in cross-thread digests or when
		// a different agent instance reads the summary).
		const threadMeta = db
			.prepare(
				"SELECT u.display_name FROM threads t JOIN users u ON t.user_id = u.id WHERE t.id = ?",
			)
			.get(threadId) as { display_name: string } | null;
		const userName = threadMeta?.display_name;
		const userClause = userName ? ` The user in this conversation is named ${userName}.` : "";

		// Rolling synthesis: two prompt variants depending on whether a previous
		// summary exists. The system message is shared — first-person orientation
		// anchor framing, not a recap.
		const summarizationSystem = `You are maintaining a running summary of a conversation thread. Your summary serves as an orientation anchor — it will be shown alongside recent messages to help you understand the broader context of the conversation. You can always query the message database for specific details, so your job is to capture the WHY and WHERE-ARE-WE, not the exact WHAT. Write in first person ('I investigated...', 'We decided...').${userClause} Refer to the user by name when possible, never as "you" (the summary is read by other systems, not the user).`;

		let prompt: string;
		if (previousSummary) {
			// Update variant: build on the previous summary
			prompt = `Here is the current summary of this conversation:

${previousSummary}

Here are the new messages since the last summary update:

${deltaText}

Write an UPDATED summary that:
- PRESERVES the goal and key decisions from the previous summary unless the user has explicitly changed direction
- INCORPORATES important new developments from the new messages
- DROPS details that are no longer relevant
- Stays under ~500 tokens

Do not start from scratch. Build on the previous summary. If nothing materially changed, return the previous summary with minor updates.`;
		} else {
			// First-run variant: generate from scratch
			prompt = `Here is the beginning of a conversation thread:

${deltaText}

Write an initial summary covering:
- GOAL: What is the user trying to accomplish?
- KEY CONTEXT: Important decisions, constraints, or discoveries
- CURRENT STATE: What has been done, what is in progress

Keep the summary under 500 tokens. Focus on information that helps continue the conversation — not a recap of what was said, but what matters going forward.`;
		}

		// Call LLM to generate summary — 800 token budget gives room for ~500 token
		// summaries without cutting the LLM off mid-thought.
		const chunks: string[] = [];
		for await (const chunk of llmBackend.chat({
			system: summarizationSystem,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 800,
		})) {
			if (chunk.type === "text") {
				chunks.push(chunk.content);
			}
		}

		const summary = chunks.join("").trim();
		const now = new Date().toISOString();

		// Update thread with summary (via outbox for sync)
		if (summary) {
			updateRow(
				db,
				"threads",
				threadId,
				{
					summary,
					summary_through: now,
					summary_model_id: "default",
				},
				siteId,
			);
		}

		// Extract key facts as memories by asking the LLM for a bullet-point list.
		// Skip if seed facts already exist — regenerating them wastes LLM calls and
		// produces ~1260 redundant updateRow operations per day across active threads.
		const existingFacts = db
			.prepare("SELECT COUNT(*) as count FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
			.get(`thread_${threadId}_fact_%`) as { count: number };
		if (existingFacts.count > 0) {
			return {
				ok: true,
				value: { summaryGenerated: summary.length > 0, memoriesExtracted: 0 },
			};
		}

		// Confabulation guard (Class D / F2a): when the thread has no
		// `role='assistant'` message, the summarizer LLM is reasoning
		// from prompt + tool_results alone and produces plausible but
		// fabricated first-person reasoning attributions ("I recognized
		// this as ...", "I resolved that ..."). Live evidence: the
		// 2026-04-26 model trial battery, where 5 threads with EOF
		// after the initial tool_result surfaced "I recognized this
		// as a model characterization trial" facts even though the
		// model never reasoned about anything — inference errored
		// before producing any real assistant turn. Skip extraction
		// rather than persist confabulation as memory.
		const assistantTurnCount = (
			db
				.prepare(
					"SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0",
				)
				.get(threadId) as { count: number }
		).count;
		if (assistantTurnCount === 0) {
			return {
				ok: true,
				value: { summaryGenerated: summary.length > 0, memoriesExtracted: 0 },
			};
		}

		// Bug #5: previously stored the literal placeholder "Extracted from conversation".
		const factChunks: string[] = [];
		try {
			for await (const chunk of llmBackend.chat({
				system: summarizationSystem,
				messages: [
					{
						role: "user",
						content: `What are up to 3 key things you did, learned, or resolved in this conversation? Write each as a first-person statement on its own line starting with "- ":\n\n${summary}`,
					},
				],
				max_tokens: 200,
			})) {
				if (chunk.type === "text") {
					factChunks.push(chunk.content);
				}
			}
		} catch {
			// Non-fatal — skip memory extraction if the LLM call fails
		}

		const factsText = factChunks.join("").trim();
		const factLines = factsText
			.split("\n")
			.map((l) => l.replace(/^[-*\d.]+\s*/, "").trim())
			.filter((l) => l.length > 0)
			.slice(0, 3);

		for (let i = 0; i < factLines.length; i++) {
			const memId = randomUUID();
			const key = `thread_${threadId}_fact_${i}`;
			// Check for existing entry (including soft-deleted) to avoid UNIQUE violations
			const existing = db.prepare("SELECT id FROM semantic_memory WHERE key = ?").get(key) as
				| { id: string }
				| undefined;
			if (existing) {
				updateRow(
					db,
					"semantic_memory",
					existing.id,
					{ value: factLines[i], source: threadId, deleted: 0 },
					siteId,
				);
			} else {
				insertRow(
					db,
					"semantic_memory",
					{
						id: memId,
						key,
						value: factLines[i],
						source: threadId,
						created_at: now,
						modified_at: now,
						last_accessed_at: now,
						tier: "default",
						deleted: 0,
					},
					siteId,
				);
			}
		}

		return {
			ok: true,
			value: { summaryGenerated: summary.length > 0, memoriesExtracted: factLines.length },
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export interface CrossThreadDigestEntry {
	title: string;
	messageCount: number;
	lastUpdatedAt: string; // ISO-8601 from threads table
}

export interface CrossThreadDigestResult {
	/** Existing field preserved for backward compatibility with any non-Live-State caller. */
	text: string;
	/** Existing field preserved. */
	sources: CrossThreadSource[];
	/** New: structured per-thread rows for Live State composition. */
	entries: CrossThreadDigestEntry[];
}

export function buildCrossThreadDigest(
	db: Database,
	userId: string,
	excludeThreadId?: string,
): CrossThreadDigestResult {
	try {
		// Get recent threads for user, including the summary field for continuity
		const hasMessages = "AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)";
		const sql = excludeThreadId
			? `SELECT id, title, color, last_message_at, summary FROM threads WHERE user_id = ? AND id != ? AND deleted = 0 ${hasMessages} ORDER BY last_message_at DESC LIMIT 5`
			: `SELECT id, title, color, last_message_at, summary FROM threads WHERE user_id = ? AND deleted = 0 ${hasMessages} ORDER BY last_message_at DESC LIMIT 5`;
		const params = excludeThreadId ? [userId, excludeThreadId] : [userId];
		const threads = db.prepare(sql).all(...params) as Array<{
			id: string;
			title: string | null;
			color: number;
			last_message_at: string;
			summary: string | null;
		}>;

		if (threads.length === 0) {
			return { text: "No recent activity.", sources: [], entries: [] };
		}

		// Build digest — populate structured entries for Live State
		const lines: string[] = [];
		const sources: CrossThreadSource[] = [];
		const entries: CrossThreadDigestEntry[] = [];

		for (const thread of threads) {
			const title = thread.title || "(untitled)";
			const messageCount = db
				.prepare("SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND deleted = 0")
				.get(thread.id) as { count: number };

			lines.push(
				`- ${title}: ${messageCount.count} messages (last updated ${thread.last_message_at})`,
			);

			// Populate structured entry for Live State
			entries.push({
				title,
				messageCount: messageCount.count,
				lastUpdatedAt: thread.last_message_at,
			});

			// Only mark threads with summaries as cross-thread sources —
			// they're the ones whose content was actually injected into context.
			// Threads without summaries only contribute a metadata line (title + count)
			// which can't meaningfully influence the agent's response.
			if (thread.summary) {
				sources.push({
					threadId: thread.id,
					title,
					color: thread.color,
					messageCount: messageCount.count,
					lastMessageAt: thread.last_message_at,
				});
			}
		}

		return { text: lines.join("\n"), sources, entries };
	} catch {
		return { text: "Error building digest.", sources: [], entries: [] };
	}
}

/**
 * Resolve a memory entry's `source` field into a human-readable
 * label. Pure in inputs alone — no DB, no clock. Exposed so the
 * varying-tail module can render `formatMemoryEntry`-equivalent
 * output without re-deriving the labelling logic.
 */
export function resolveSource(
	taskName: string | null,
	threadId: string | null,
	threadTitle: string | null,
	source: string | null,
): string {
	if (taskName !== null) return `task "${taskName}"`;
	if (threadId !== null) {
		// source matched a non-deleted thread (may or may not have a title)
		return `thread "${threadTitle ?? threadId.slice(0, 8)}"`;
	}
	if (source === null) return "unknown";
	return source.slice(0, 8);
}

/**
 * Parameterized relative-time fragment generator. Used for the
 * varying-side renderer where `nowMs` is plumbed through as the
 * single allowed wall-clock ingress. Production callers that want
 * the implicit-now behavior call `relativeTime` (which delegates).
 */
export function relativeTimeAt(isoString: string, nowMs: number): string {
	const diffMs = nowMs - new Date(isoString).getTime();
	const diffSeconds = Math.floor(diffMs / 1000);
	if (diffSeconds < 60) return "just now";
	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}

function relativeTime(isoString: string): string {
	return relativeTimeAt(isoString, Date.now());
}

/**
 * Parameterized staleness-tag generator. Same `nowMs` plumbing
 * rationale as `relativeTimeAt`.
 */
export function stalenessTagAt(isoString: string, nowMs: number): string {
	const diffMs = nowMs - new Date(isoString).getTime();
	const diffDays = diffMs / (1000 * 60 * 60 * 24);
	if (diffDays > 7) return " ⚠️ may be outdated (>7d old)";
	if (diffDays > 1) return " (may have changed)";
	return "";
}

/** Staleness caveat for memory entries older than 24h. */
function stalenessTag(isoString: string): string {
	const diffMs = Date.now() - new Date(isoString).getTime();
	const diffDays = diffMs / (1000 * 60 * 60 * 24);
	if (diffDays > 7) return " ⚠️ may be outdated (>7d old)";
	if (diffDays > 1) return " (may have changed)";
	return "";
}

/**
 * Computes the baseline timestamp (ISO string) for delta queries.
 * Implements the R-MV4 fallback chain:
 *   noHistory=false → MAX(last user-role message OR thread.created_at, NOW - 24h)
 *   noHistory=true + taskId → task.last_run_at ?? task.created_at
 *   noHistory=true + no taskId → epoch
 *
 * The non-noHistory branch anchors to the most-recent **user-role**
 * message — not `thread.last_message_at` — and applies a 24-hour
 * wallclock floor. This handles two cases that the prior
 * `thread.last_message_at` implementation collapsed:
 *
 *  1. **Self-driving threads.** Webhook-bound event tasks and
 *     scheduler-spawned threads emit `developer`-role `[Task wakeup]`
 *     messages into the same thread on every tick, advancing
 *     `last_message_at` continuously. The recency baseline therefore
 *     advanced past every memorize that landed *between* wakeups,
 *     structurally excluding those entries from L3 recency rendering.
 *     Live evidence: thread d0372be6 with 558 wakeups had recent
 *     `bound:issue:*` and `_outcome:*` memorizes that never surfaced
 *     in volatile context, leading the agent to repeatedly report
 *     "Working knowledge is months stale" while in fact the entries
 *     were 0.9–1.9 days old.
 *
 *  2. **User threads where the agent persists assistant messages
 *     between user turns.** Each agent turn that persists an
 *     assistant or tool_result row advances `last_message_at` past
 *     any memorize that ran during the same turn, excluding it from
 *     the next turn's L3 recency. The user-message anchor avoids
 *     this by tracking the real conversational boundary.
 *
 * The 24h wallclock floor ensures autonomous threads (no user
 * message ever) and dormant user threads still surface roughly the
 * last 24 hours of memory activity rather than collapsing on
 * `thread.created_at` (which can be days or weeks old).
 *
 * `nowMs` is parameterized so tests can pin floor calculation to a
 * fixed timestamp; defaults to `Date.now()` for production callers.
 */
const RECENCY_FLOOR_MS = 24 * 60 * 60 * 1000;

export function computeBaseline(
	db: Database,
	threadId: string,
	taskId?: string,
	noHistory?: boolean,
	nowMs: number = Date.now(),
): string {
	const EPOCH = "1970-01-01T00:00:00.000Z";

	if (noHistory) {
		if (taskId) {
			const row = db
				.prepare("SELECT last_run_at, created_at FROM tasks WHERE id = ?")
				.get(taskId) as { last_run_at: string | null; created_at: string } | null;
			if (row === null) return EPOCH;
			return row.last_run_at ?? row.created_at;
		}
		return EPOCH;
	}

	const threadRow = db.prepare("SELECT created_at FROM threads WHERE id = ?").get(threadId) as {
		created_at: string;
	} | null;
	if (threadRow === null) return EPOCH;

	// Anchor to the most-recent user-role message; fall back to
	// thread.created_at when the thread has never had a user turn
	// (autonomous webhook/scheduler threads).
	const userRow = db
		.prepare(
			"SELECT created_at FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId) as { created_at: string } | null;
	const anchor = userRow?.created_at ?? threadRow.created_at;

	// MAX(anchor, floor): pick the LATER of the two so dormant threads
	// don't surface stale entries (cap at 24h of recency) but
	// continuously-active autonomous threads still see fresh activity.
	const floor = new Date(nowMs - RECENCY_FLOOR_MS).toISOString();
	return anchor > floor ? anchor : floor;
}

export interface VolatileEnrichment {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
	taskDigestEntries: LiveStateTaskEntry[]; // Structured task entries for Live State renderer
	tiers: TieredEnrichment; // L0→L1→L2→L3 tiered entries (now required after Task 2 rewrite)
	graphCount?: number; // entries retrieved via graph (seed + traversal)
	recencyCount?: number; // entries retrieved via recency fallback
}

export interface StageEntry {
	key: string;
	value: string;
	source: string | null;
	modifiedAt: string;
	tier: MemoryTier;
	tag: string; // e.g., "[pinned]", "[summary]", "[stale-detail]", "[graph]", "[recency]"
	taskName?: string | null; // resolved via LEFT JOIN tasks WHERE source = t.id
	threadId?: string | null; // resolved via LEFT JOIN threads WHERE source = th.id
	threadTitle?: string | null; // resolved via LEFT JOIN threads
	deleted?: number; // 0 or 1, indicates soft-deleted entries (for [forgotten] rendering)
}

export interface StageResult {
	entries: StageEntry[];
	exclusionSet: Set<string>;
}

export interface DetailEntry {
	id: string;
	key: string;
	last_accessed_at: string | null;
}

export interface DetailRetrievalResult {
	entries: DetailEntry[];
}

export interface TieredEnrichment {
	L0: StageEntry[];
	L1: StageEntry[];
	L2: StageEntry[];
	L3: StageEntry[];
}

export interface WorkingKnowledgeInput {
	/** From loadPinnedEntries — rendered in full text. */
	pinned: StageEntry[];
	/** From loadSummaryEntries — rendered with 200-char gloss. */
	summaries: StageEntry[];
	/**
	 * Per-summary stale children, keyed by summary key.
	 * Populated by Phase 5 wiring via memory_edges 'summarizes' traversal.
	 * Empty array (or missing key) means no stale children for that summary.
	 */
	staleChildrenBySummary: Map<string, StageEntry[]>;
	/**
	 * Set of memory keys with modified_at > baseline (R-MV1 delta semantics).
	 * Computed upstream by the existing R-MV1 baseline logic; passed in here
	 * so the renderer is pure (no DB access for delta detection).
	 */
	deltaKeys: Set<string>;
}

export interface RenderedSection {
	/** Section line array, one element per output line. Joined with "\n" by callers. */
	lines: string[];
}

export interface DiscoverableArchiveInput {
	/** From loadDetailEntries — already sorted by last_accessed_at DESC. */
	entries: DetailEntry[];
	/**
	 * Map from a detail-tier entry key to its parent summary key (e.g.
	 * "_summary:transit-systems"). Built by Phase 5 wiring from memory_edges
	 * 'summarizes' edges. Entries without a parent are absent from the map.
	 */
	parentSummaryByKey: Map<string, string>;
	/**
	 * Set of detail-tier keys already routed to Working Knowledge as R-HM7
	 * stale children. These are dropped from Discoverable Archive output to
	 * prevent duplicate rendering (§6.4 dedup rule).
	 */
	staleChildKeysInWorkingKnowledge: Set<string>;
	/** True when the upstream budget gate (R-VC14) signals critical pressure. */
	budgetPressure: boolean;
	/** Resolved at assembly time from BOUND_VC15_N / BOUND_VC15_M (see resolveVc15Tunables). */
	tunables: Vc15Tunables;
}

export interface Vc15Tunables {
	/** BOUND_VC15_N — Tier 2/3 boundary. Default 1000. */
	n: number;
	/** BOUND_VC15_M — Tier 3 per-cluster cap. Default 20. */
	m: number;
}

export const VC15_DEFAULT_N = 1000;
export const VC15_DEFAULT_M = 20;
export const VC15_TIER1_THRESHOLD = 200;
export const VC15_UNCATEGORIZED_BACKLOG_THRESHOLD = 50;
export const UNCATEGORIZED_CLUSTER_NAME = "Uncategorized";

export function resolveVc15Tunables(env: NodeJS.ProcessEnv = process.env): Vc15Tunables {
	const n = parsePositiveInt(env.BOUND_VC15_N, VC15_DEFAULT_N);
	const m = parsePositiveInt(env.BOUND_VC15_M, VC15_DEFAULT_M);
	return { n, m };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

export interface DiscoverableArchiveOutput {
	section: RenderedSection;
	/**
	 * When Tier 3 is active and the Uncategorized cluster exceeds the backlog
	 * threshold, this carries the count for Phase 4 / Phase 5 to fold into
	 * Live State as `- [synthesis-backlog] {N} uncategorized detail entries`.
	 * `null` otherwise.
	 */
	synthesisBacklogCount: number | null;
}

/**
 * For a set of detail-tier keys, look up each key's parent _summary:<topic> via
 * incoming `summarizes` edges. Used by Phase 3 to compute Discoverable Archive
 * cluster names.
 */
export function buildParentSummaryMap(
	db: Database,
	detailKeys: Iterable<string>,
): Map<string, string> {
	const result = new Map<string, string>();
	const keys = Array.from(detailKeys);
	if (keys.length === 0) return result;
	const placeholders = keys.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT e.target_key AS child, e.source_key AS parent
			 FROM memory_edges e
			 WHERE e.relation = 'summarizes'
			   AND e.deleted = 0
			   AND e.target_key IN (${placeholders})`,
		)
		.all(...keys) as Array<{ child: string; parent: string }>;
	for (const r of rows) {
		// If multiple summaries claim the same child, the first-seen wins. The spec is
		// silent on multi-parent semantics; the data model conventionally has one summary
		// per detail entry.
		if (!result.has(r.child)) result.set(r.child, r.parent);
	}
	return result;
}

/**
 * For a set of summary keys, return each summary's outgoing `summarizes` children
 * whose `modified_at` is later than the summary's own — i.e. R-HM7 stale children.
 */
export function buildStaleChildrenMap(
	db: Database,
	summaries: StageEntry[],
): Map<string, StageEntry[]> {
	const result = new Map<string, StageEntry[]>();
	if (summaries.length === 0) return result;
	const summaryKeyToModifiedAt = new Map(summaries.map((s) => [s.key, s.modifiedAt ?? ""]));
	const placeholders = summaries.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT e.source_key AS parent, e.target_key AS child_key,
					m.value AS child_value, m.modified_at AS child_modified_at, m.tier AS tier
			 FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 WHERE e.relation = 'summarizes'
			   AND e.deleted = 0
			   AND e.source_key IN (${placeholders})`,
		)
		.all(...summaries.map((s) => s.key)) as Array<{
		parent: string;
		child_key: string;
		child_value: string;
		child_modified_at: string;
		tier: string;
	}>;
	for (const r of rows) {
		const parentModifiedAt = summaryKeyToModifiedAt.get(r.parent) ?? "";
		// R-HM7 staleness: child.modified_at > summary.modified_at.
		if (r.child_modified_at <= parentModifiedAt) continue;
		const bucket = result.get(r.parent) ?? [];
		bucket.push({
			key: r.child_key,
			value: r.child_value,
			source: null,
			modifiedAt: r.child_modified_at,
			tier: r.tier as MemoryTier,
			tag: "[stale-detail]",
		});
		result.set(r.parent, bucket);
	}
	return result;
}

export const DISCOVERABLE_HEADER = "## Discoverable Archive — title-only; bodies via memory search";
export const DISCOVERABLE_FOOTER =
	"Bodies are accessed via memory search or query against semantic_memory.";

/**
 * Render a Discoverable-Archive entry line. Pure in `(entry,
 * budgetPressure)` — no `nowMs` parameter, no `Date.now()` call —
 * which is the wall-clock-purity contract that
 * `composeStableVolatileSubsection` relies on. Delegates to
 * `formatDetailLine`; exported here so the stable-prefix module can
 * render byte-equivalently without importing internal helpers.
 */
export function formatStableDetailLine(
	entry: { key: string; last_accessed_at: string | null },
	budgetPressure: boolean,
): string {
	return formatDetailLine(
		// Production callers pass full `DetailEntry` rows; the
		// renderer reads only `key` and `last_accessed_at`. The narrow
		// shape from `stable-prefix/types.ts` is structurally
		// compatible with the subset actually read.
		entry as DetailEntry,
		budgetPressure,
	);
}

/**
 * Section header for `tier='default'` L2 (graph-seeded) + L3 (recency)
 * entries that the three R-VC24 renderers (WK / DA / LS) don't surface.
 * Rendered into the varying tail by `composeVolatileSections`.
 */
export const RECENT_MEMORY_HEADER = "## Recent memory — graph + recency";

/**
 * Flatten a `TieredEnrichment` into the L2 + L3 tail used by
 * `composeVolatileSections` for the recency rendering block. Three
 * call sites (primary, no-history task, budget-pressure rebuild)
 * compose this same shape; centralized here so the spread pattern
 * doesn't drift across paths.
 */
export function flattenRecencyEntries(tiers: TieredEnrichment): StageEntry[] {
	return [...tiers.L2, ...tiers.L3];
}

export function renderDiscoverableArchive(
	input: DiscoverableArchiveInput,
): DiscoverableArchiveOutput {
	const lines: string[] = [];
	lines.push(DISCOVERABLE_HEADER);
	lines.push("");

	// §5.2 step 2 — drop entries also rendered as stale children in Working Knowledge.
	const visible = input.entries.filter((e) => !input.staleChildKeysInWorkingKnowledge.has(e.key));

	const total = visible.length;

	if (total === 0) {
		lines.push("");
		lines.push(DISCOVERABLE_FOOTER);
		return { section: { lines }, synthesisBacklogCount: null };
	}

	if (total <= VC15_TIER1_THRESHOLD) {
		// Tier 1: flat list, last_accessed_at DESC (already sorted upstream by R-VC4 SELECT).
		for (const entry of visible) {
			lines.push(formatDetailLine(entry, input.budgetPressure));
		}
		lines.push("");
		lines.push(DISCOVERABLE_FOOTER);
		return { section: { lines }, synthesisBacklogCount: null };
	}

	if (total <= input.tunables.n) {
		// Tier 2: cluster compression.
		const clusters = groupByCluster(visible, input.parentSummaryByKey);
		const sorted = sortClusters(clusters);
		for (const cluster of sorted) {
			lines.push(`### ${cluster.name} (${cluster.entries.length} entries)`);
			for (const entry of cluster.entries) {
				lines.push(formatDetailLine(entry, input.budgetPressure));
			}
			lines.push(""); // blank line between clusters for readability
		}
		// Drop trailing blank if any cluster was rendered.
		if (lines[lines.length - 1] === "") lines.pop();
		lines.push("");
		lines.push(DISCOVERABLE_FOOTER);
		return { section: { lines }, synthesisBacklogCount: null };
	}

	// Tier 3: heading-only compression with M most-recent per cluster.
	const clusters = groupByCluster(visible, input.parentSummaryByKey);
	const sorted = sortClusters(clusters);
	let synthesisBacklogCount: number | null = null;
	for (const cluster of sorted) {
		const totalCount = cluster.entries.length;
		const tail = cluster.entries.slice(0, input.tunables.m);
		lines.push(
			`### ${cluster.name} (${totalCount} entries, showing ${input.tunables.m} most recent)`,
		);
		for (const entry of tail) {
			lines.push(formatDetailLine(entry, input.budgetPressure));
		}
		lines.push("");
		if (
			cluster.name === UNCATEGORIZED_CLUSTER_NAME &&
			totalCount > VC15_UNCATEGORIZED_BACKLOG_THRESHOLD
		) {
			synthesisBacklogCount = totalCount;
		}
	}
	if (lines[lines.length - 1] === "") lines.pop();
	lines.push("");
	lines.push(DISCOVERABLE_FOOTER);
	return { section: { lines }, synthesisBacklogCount };
}

interface Cluster {
	name: string;
	entries: DetailEntry[];
}

function clusterNameForEntry(entry: DetailEntry, parentSummaryByKey: Map<string, string>): string {
	const parent = parentSummaryByKey.get(entry.key);
	if (!parent) return UNCATEGORIZED_CLUSTER_NAME;
	// Parent key shape is "_summary:<topic>" per R-HM1 / R-HM3. Strip the prefix.
	const colonIdx = parent.indexOf(":");
	if (colonIdx < 0) return UNCATEGORIZED_CLUSTER_NAME; // defensive
	return parent.slice(colonIdx + 1) || UNCATEGORIZED_CLUSTER_NAME;
}

function groupByCluster(
	entries: DetailEntry[],
	parentSummaryByKey: Map<string, string>,
): Cluster[] {
	const map = new Map<string, DetailEntry[]>();
	for (const entry of entries) {
		const name = clusterNameForEntry(entry, parentSummaryByKey);
		const bucket = map.get(name) ?? [];
		bucket.push(entry);
		map.set(name, bucket);
	}
	// Within-cluster ordering is preserved from `entries`, which is already
	// last_accessed_at DESC from the R-VC4 SELECT. R-VC15 Tier 2 step (d).
	return Array.from(map.entries()).map(([name, entries]) => ({ name, entries }));
}

function sortClusters(clusters: Cluster[]): Cluster[] {
	return clusters.slice().sort((a, b) => {
		// Primary: entry count descending.
		if (a.entries.length !== b.entries.length) {
			return b.entries.length - a.entries.length;
		}
		// Tiebreak: cluster name ascending.
		return a.name.localeCompare(b.name);
	});
}

function formatDetailLine(entry: DetailEntry, budgetPressure: boolean): string {
	if (budgetPressure) {
		return `- ${entry.key}`;
	}
	const dateFragment = formatAbsoluteDate(entry.last_accessed_at);
	return `- ${entry.key} (accessed ${dateFragment})`;
}

/**
 * Render a `last_accessed_at` ISO timestamp as the literal calendar date
 * prefix (`YYYY-MM-DD`), or `"never"` when the input is null or malformed.
 *
 * Pure in `iso` alone — no `Date.now()`, no `Date.parse()` round-trip, no
 * timezone math. The output is byte-stable across renders for the same
 * input string. This is the key property that lets `composeStablePrefix`
 * be byte-stable across cold rebuilds within the cache TTL window: the
 * displayed date only changes when the underlying `last_accessed_at`
 * column changes, and `bumpRenderedDetailEntries` debounces those writes
 * to ≥ cache TTL.
 *
 * The prior `Nm/h/d/mo/y ago` formatter was the documented direct cause
 * of the 554-token volatile-prefix wobble observed on thread
 * `2d055bbe-...` (see `docs/design/specs/2026-05-22-volatile-context.md`,
 * "Stable-prefix purity invariant"): the relative-time string ticked
 * with wall-clock between renders, breaking byte-stability and driving
 * the prompt cache hit rate to ~12%.
 */
function formatAbsoluteDate(iso: string | null): string {
	if (!iso) return "never";
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
	return match ? match[1] : "never";
}

/**
 * Render an ISO timestamp as a humanized relative-age fragment
 * (`"just now"`, `"5m ago"`, `"3d ago"`, etc.). Used ONLY by the
 * **varying** side of the volatile context (Live State applied-advisory
 * line). Stable-side renderers must not call this — they have no
 * `nowMs` parameter to pass in (see `formatAbsoluteDate` for the
 * stable-side equivalent and the byte-stability rationale).
 */
function relativeTimeFragment(iso: string | null, nowMs: number): string {
	if (!iso) return "never";
	const ts = Date.parse(iso);
	if (!Number.isFinite(ts)) return "never";
	const deltaMs = nowMs - ts;
	if (deltaMs < 60_000) return "just now";
	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(months / 12);
	return `${years}y ago`;
}

/**
 * Formats a single StageEntry for display in memory delta output.
 * Handles tier-aware formatting: L0 is minimal, L1 includes tier tag,
 * L2/L3 include source attribution and relative time.
 *
 * Exported for use in budget pressure shedding (memory-shedding.ts).
 */
export function formatMemoryEntry(entry: StageEntry): string {
	const valueDisplay =
		entry.value.length > 200 ? `${safeSlice(entry.value, 0, 200)}...` : entry.value;
	const stale = stalenessTag(entry.modifiedAt);

	// Handle soft-deleted entries specially (rendered as [forgotten])
	if (entry.deleted) {
		const sourceLabel = resolveSource(
			entry.taskName ?? null,
			entry.threadId ?? null,
			entry.threadTitle ?? null,
			entry.source,
		);
		const relTime = relativeTime(entry.modifiedAt);
		return `- ${entry.key}: [forgotten] (${relTime}, via ${sourceLabel})`;
	}

	// Different formatting for each tier
	if (entry.tag === "[pinned]") {
		// L0: pinned entries - minimal format
		return `- ${entry.key}: ${valueDisplay} ${entry.tag}`;
	}
	if (entry.tag === "[summary]" || entry.tag === "[stale-detail]") {
		// L1: summary and stale-detail entries
		return `- ${entry.key}: ${valueDisplay} ${entry.tag}`;
	}
	// L2 and L3 entries include source and relative time
	// Resolve source using taskName/threadId/threadTitle if available, else use source id
	const sourceLabel = resolveSource(
		entry.taskName ?? null,
		entry.threadId ?? null,
		entry.threadTitle ?? null,
		entry.source,
	);
	const relTime = relativeTime(entry.modifiedAt);
	return `- ${entry.key}: ${valueDisplay} (${relTime}, via ${sourceLabel}) ${entry.tag}${stale}`;
}

/**
 * Queries the database for memory entries and tasks that changed since
 * the given baseline timestamp. Returns formatted line arrays for
 * injection into the volatile context block.
 *
 * Delta reads do NOT update last_accessed_at (queries are SELECT-only).
 */
export function buildVolatileEnrichment(
	db: Database,
	baseline: string,
	maxMemory = 25,
	maxTasks = 5,
	userMessage?: string,
	threadSummary?: string,
	maxPinned?: number,
): VolatileEnrichment {
	// Extract meaningful tokens from text for FTS5 seed matching.
	// We still filter high-frequency English function words to prevent noisy OR
	// queries (e.g., "is" matching every entry containing "is"). FTS5 handles
	// stemming and tokenization, but feeding it pure stop words produces false
	// positives. No minimum length filter — short content words like "AI", "Go"
	// are valid query terms.
	const extractKeywords = (text: string): string[] =>
		text
			.toLowerCase()
			.replace(/[^a-z0-9_\s-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 0 && !FTS5_STOP_WORDS.has(w));

	// Merge keywords from user message (high priority) and thread summary (broader context).
	// Message keywords come first; summary keywords are deduplicated against them.
	const messageKeywords = extractKeywords(userMessage ?? "");
	const messageKeywordSet = new Set(messageKeywords);
	const summaryKeywords = extractKeywords(threadSummary ?? "").filter(
		(w) => !messageKeywordSet.has(w),
	);
	// Cap keywords to prevent overly broad FTS5 OR queries. 30 terms is more than
	// sufficient for semantic memory matching. The cap in graphSeededRetrieval is
	// a safety net; this is the primary cap at the source.
	const mergedKeywords = [...messageKeywords, ...summaryKeywords].slice(0, 30);

	// Run the L0→L1→L2→L3 pipeline
	const l0Raw = loadPinnedEntries(db);
	// Cap pinned entries when maxPinned is specified (e.g., noHistory tasks where
	// 172 pinned entries would overwhelm a 3-message context)
	const l0 =
		maxPinned !== undefined && l0Raw.entries.length > maxPinned
			? { entries: l0Raw.entries.slice(0, maxPinned), exclusionSet: l0Raw.exclusionSet }
			: l0Raw;
	const l1 = loadSummaryEntries(db, l0.exclusionSet);
	const l2 = loadGraphEntries(db, l1.exclusionSet, mergedKeywords, maxMemory);
	const remainingSlots = Math.max(0, maxMemory - l2.entries.length);
	const l3 = loadRecencyEntries(db, l2.exclusionSet, baseline, remainingSlots);

	// Build tiers structure
	const tiers: TieredEnrichment = {
		L0: l0.entries,
		L1: l1.entries,
		L2: l2.entries,
		L3: l3.entries,
	};

	// Format memoryDeltaLines in L0→L1→L2→L3 order
	const memoryDeltaLines: string[] = [];

	// Inject L0 entries (pinned)
	for (const entry of l0.entries) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Inject L1 entries (summary + stale-detail)
	for (const entry of l1.entries) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Inject L2 entries (graph-seeded)
	for (const entry of l2.entries) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Inject L3 entries (recency)
	for (const entry of l3.entries) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Detect overflow: if L2+L3 was capped by maxMemory, check if more entries exist
	const totalL23Entries = l2.entries.length + l3.entries.length;
	if (totalL23Entries >= maxMemory) {
		// More entries may exist beyond maxMemory cap — add overflow indicator
		// Query to check if there are more default entries after L0+L1+L2+L3
		const allExcluded = new Set<string>([
			...l0.entries.map((e) => e.key),
			...l1.entries.map((e) => e.key),
			...l2.entries.map((e) => e.key),
			...l3.entries.map((e) => e.key),
		]);

		const countMore = db
			.prepare(
				`SELECT COUNT(*) AS cnt FROM semantic_memory m
				 WHERE m.deleted = 0
				   AND m.modified_at > ?
				   AND m.key NOT LIKE '_internal.%'
				   AND (
				     m.tier NOT IN ('detail', 'pinned', 'summary')
				     OR (m.tier = 'detail' AND NOT EXISTS (
				       SELECT 1 FROM memory_edges e
				       WHERE e.target_key = m.key AND e.relation = 'summarizes' AND e.deleted = 0
				     ))
				   )`,
			)
			.get(baseline) as { cnt: number };

		if (countMore.cnt > allExcluded.size) {
			const moreCount = countMore.cnt - allExcluded.size;
			memoryDeltaLines.push(`... and ${moreCount} more (query semantic_memory for full list)`);
		}
	}

	// Task digest query — fetch maxTasks+1 to detect overflow
	const taskRows = db
		.prepare(
			`SELECT t.id, t.type, t.trigger_spec, t.last_run_at, t.run_count, t.consecutive_failures, t.claimed_by,
			        h.host_name
			 FROM   tasks t
			 LEFT JOIN hosts h ON t.claimed_by = h.site_id AND h.deleted = 0
			 WHERE  t.last_run_at > ?
			   AND  t.last_run_at IS NOT NULL
			   AND  t.deleted = 0
			 ORDER  BY t.last_run_at DESC
			 LIMIT  ?`,
		)
		.all(baseline, maxTasks + 1) as Array<{
		id: string;
		type: string;
		trigger_spec: string;
		last_run_at: string;
		run_count: number;
		consecutive_failures: number;
		claimed_by: string | null;
		host_name: string | null;
	}>;

	const hasMoreTasks = taskRows.length > maxTasks;
	const visibleTaskRows = hasMoreTasks ? taskRows.slice(0, maxTasks) : taskRows;

	const taskDigestLines: string[] = [];
	const taskDigestEntries: LiveStateTaskEntry[] = [];
	for (const row of visibleTaskRows) {
		const status = row.consecutive_failures === 0 ? "ran" : "failed";
		const hostLabel = row.host_name ?? (row.claimed_by ? row.claimed_by.slice(0, 8) : "unknown");
		const relTime = relativeTime(row.last_run_at);
		taskDigestLines.push(`- ${row.trigger_spec} ${status} (${relTime} on ${hostLabel})`);
		taskDigestEntries.push({
			taskId: row.id,
			taskType: row.type,
			runCount: row.run_count,
			lastRunAt: row.last_run_at,
			status,
		});
	}
	if (hasMoreTasks) {
		taskDigestLines.push(`... and ${taskRows.length - maxTasks} more (query tasks for full list)`);
	}

	return {
		memoryDeltaLines,
		taskDigestLines,
		taskDigestEntries,
		tiers,
		graphCount: l2.entries.length,
		recencyCount: l3.entries.length,
	};
}

/**
 * Stage L0: Load pinned entries using dual detection (tier='pinned' OR prefix match)
 * Returns loaded entries plus an exclusion set for downstream stages.
 */
export function loadPinnedEntries(db: Database): StageResult {
	// IMPORTANT: ESCAPE syntax must match summary-extraction.ts lines 467-470 exactly.
	// Copy the escape sequence from the existing codebase, do NOT derive from scratch.
	const rows = db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id AND t_src.deleted = 0
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE m.deleted = 0
			   AND (m.tier = 'pinned'
			     OR m.key LIKE '\\_standing%' ESCAPE '\\'
			     OR m.key LIKE '\\_feedback%' ESCAPE '\\'
			     OR m.key LIKE '\\_policy%' ESCAPE '\\'
			     OR m.key LIKE '\\_pinned%' ESCAPE '\\')
			 ORDER BY m.key ASC`,
		)
		.all() as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
		tier: string;
		task_name: string | null;
		thread_id: string | null;
		thread_title: string | null;
	}>;

	const entries: StageEntry[] = rows.map((r) => ({
		key: r.key,
		value: r.value,
		source: r.source,
		modifiedAt: r.modified_at,
		tier: (r.tier || "pinned") as MemoryTier,
		tag: "[pinned]",
		taskName: r.task_name,
		threadId: r.thread_id,
		threadTitle: r.thread_title,
	}));

	const exclusionSet = new Set(entries.map((e) => e.key));

	return { entries, exclusionSet };
}

/**
 * Stage L1: Load summary entries and their children, detecting staleness.
 * All children are added to the exclusion set regardless of staleness.
 * Stale children (modified after the summary) are loaded with [stale-detail] tag.
 */
export function loadSummaryEntries(db: Database, excludeKeys: Set<string>): StageResult {
	// Load all summary entries not already in exclusion set
	const summaries = db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id AND t_src.deleted = 0
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE m.tier = 'summary' AND m.deleted = 0
			 ORDER BY m.key ASC`,
		)
		.all() as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
		tier: string;
		task_name: string | null;
		thread_id: string | null;
		thread_title: string | null;
	}>;

	const entries: StageEntry[] = [];
	const newExclusion = new Set(excludeKeys);

	for (const summary of summaries) {
		if (excludeKeys.has(summary.key)) continue;

		entries.push({
			key: summary.key,
			value: summary.value,
			source: summary.source,
			modifiedAt: summary.modified_at,
			tier: "summary",
			tag: "[summary]",
			taskName: summary.task_name,
			threadId: summary.thread_id,
			threadTitle: summary.thread_title,
		});
		newExclusion.add(summary.key);

		// Find all children via outgoing summarizes edges
		const children = db
			.prepare(
				`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
				        t_src.trigger_spec AS task_name,
				        th_src.id          AS thread_id,
				        th_src.title       AS thread_title
				 FROM memory_edges e
				 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
				 LEFT JOIN tasks   t_src  ON m.source = t_src.id AND t_src.deleted = 0
				 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
				 WHERE e.source_key = ? AND e.relation = 'summarizes' AND e.deleted = 0
				 ORDER BY m.key ASC`,
			)
			.all(summary.key) as Array<{
			key: string;
			value: string;
			source: string | null;
			modified_at: string;
			tier: string;
			task_name: string | null;
			thread_id: string | null;
			thread_title: string | null;
		}>;

		for (const child of children) {
			// ALL children go into exclusion set — stale or not
			newExclusion.add(child.key);

			// Stale children: modified after the summary
			if (child.modified_at > summary.modified_at) {
				entries.push({
					key: child.key,
					value: child.value,
					source: child.source,
					modifiedAt: child.modified_at,
					tier: child.tier as MemoryTier,
					tag: "[stale-detail]",
					taskName: child.task_name,
					threadId: child.thread_id,
					threadTitle: child.thread_title,
				});
			}
		}
	}

	return { entries, exclusionSet: newExclusion };
}

/**
 * Stage L2: Load graph-seeded entries, applying tier and exclusion filters.
 * Returns only `default` tier entries (plus orphaned detail entries).
 * Respects excludeKeys from L0+L1 and expands the exclusion set.
 */
export function loadGraphEntries(
	db: Database,
	excludeKeys: Set<string>,
	keywords: string[],
	maxSlots: number,
): StageResult {
	if (keywords.length === 0 || maxSlots <= 0) {
		return { entries: [], exclusionSet: new Set(excludeKeys) };
	}

	const graphResults = graphSeededRetrieval(
		db,
		keywords,
		maxSlots + excludeKeys.size,
		3,
		excludeKeys,
	);

	const entries: StageEntry[] = [];
	const newExclusion = new Set(excludeKeys);

	// Build a map of key -> source resolution info from a single query
	const sourceInfoMap = new Map<
		string,
		{ taskName: string | null; threadId: string | null; threadTitle: string | null }
	>();

	if (graphResults.length > 0) {
		const keys = graphResults.map((r) => r.key);
		const placeholders = keys.map(() => "?").join(",");
		const sourceInfoRows = db
			.prepare(
				`SELECT m.key,
				        t_src.trigger_spec AS task_name,
				        th_src.id          AS thread_id,
				        th_src.title       AS thread_title
				 FROM semantic_memory m
				 LEFT JOIN tasks   t_src  ON m.source = t_src.id AND t_src.deleted = 0
				 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
				 WHERE m.key IN (${placeholders})`,
			)
			.all(...keys) as Array<{
			key: string;
			task_name: string | null;
			thread_id: string | null;
			thread_title: string | null;
		}>;

		for (const row of sourceInfoRows) {
			sourceInfoMap.set(row.key, {
				taskName: row.task_name,
				threadId: row.thread_id,
				threadTitle: row.thread_title,
			});
		}
	}

	for (const r of graphResults) {
		if (newExclusion.has(r.key)) continue;
		if (entries.length >= maxSlots) break;

		const tag = "[graph]";

		// Preserve the original tier (default or orphaned detail)
		const tier = r.tier ? (r.tier as MemoryTier) : "default";

		const sourceInfo = sourceInfoMap.get(r.key) || {
			taskName: null,
			threadId: null,
			threadTitle: null,
		};

		entries.push({
			key: r.key,
			value: r.value,
			source: r.source,
			modifiedAt: r.modifiedAt,
			tier,
			tag,
			taskName: sourceInfo.taskName,
			threadId: sourceInfo.threadId,
			threadTitle: sourceInfo.threadTitle,
		});
		newExclusion.add(r.key);
	}

	return { entries, exclusionSet: newExclusion };
}

/**
 * Stage L3: Load recency-based entries, applying same tier/exclusion filters as L2.
 * Returns entries ordered by recency, limited to maxSlots.
 * Respects excludeKeys from L0+L1+L2 and expands the exclusion set.
 */
export function loadRecencyEntries(
	db: Database,
	excludeKeys: Set<string>,
	baseline: string,
	maxSlots: number,
): StageResult {
	if (maxSlots <= 0) {
		return { entries: [], exclusionSet: new Set(excludeKeys) };
	}

	// Query recent entries, excluding pinned/summary/detail tiers
	// (same filter as L2 — orphaned details also pass through)
	// Include deleted entries (deleted=1) so they can be rendered with [forgotten] tag
	const rows = db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier, m.deleted,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id AND t_src.deleted = 0
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE m.modified_at > ?
			   AND m.key NOT LIKE '_internal.%'
			   AND (
			     m.tier NOT IN ('detail', 'pinned', 'summary')
			     OR (m.tier = 'detail' AND NOT EXISTS (
			       SELECT 1 FROM memory_edges e
			       WHERE e.target_key = m.key AND e.relation = 'summarizes' AND e.deleted = 0
			     ))
			   )
			 ORDER BY m.modified_at DESC
			 LIMIT ?`,
		)
		.all(baseline, maxSlots + excludeKeys.size) as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
		tier: string;
		deleted: number;
		task_name: string | null;
		thread_id: string | null;
		thread_title: string | null;
	}>;

	const entries: StageEntry[] = [];
	const newExclusion = new Set(excludeKeys);

	for (const row of rows) {
		if (newExclusion.has(row.key)) continue;
		if (entries.length >= maxSlots) break;

		entries.push({
			key: row.key,
			value: row.value,
			source: row.source,
			modifiedAt: row.modified_at,
			tier: (row.tier || "default") as MemoryTier,
			tag: "[recency]",
			taskName: row.task_name,
			threadId: row.thread_id,
			threadTitle: row.thread_title,
			deleted: row.deleted,
		});
		newExclusion.add(row.key);
	}

	return { entries, exclusionSet: newExclusion };
}

/**
 * Retrieval stage for R-VC4: Discoverable Archive.
 * Enumerates every non-deleted detail-tier entry in last_accessed_at DESC order.
 * Independent of R-HM6's slot accounting and tag dispatch.
 *
 * The query is intentionally unbounded: R-VC15's three-tier compression (Phase 3)
 * bounds the rendered output, not the underlying retrieval.
 *
 * Verifies R-MV5 (delta reads must not update last_accessed_at) by being a pure SELECT.
 */
export function loadDetailEntries(db: Database): DetailRetrievalResult {
	const rows = db
		.prepare(
			"SELECT id, key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted = 0 ORDER BY last_accessed_at DESC",
		)
		.all() as Array<{ id: string; key: string; last_accessed_at: string | null }>;

	return {
		entries: rows.map((r) => ({
			id: r.id,
			key: r.key,
			last_accessed_at: r.last_accessed_at,
		})),
	};
}

/**
 * Default debounce window for `bumpRenderedDetailEntries`. The render
 * path runs on every cold assembly, so without a debounce each cold
 * pass would generate one change_log entry per loaded detail entry —
 * a few hundred sync rows per cold turn on busy threads. One hour
 * caps the rate to at most one bump per entry per hour.
 */
const RENDER_BUMP_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * Bump `last_accessed_at` to `nowMs` for each rendered detail entry
 * whose existing access timestamp is older than the debounce window.
 *
 * R-MV5 (no-bump on `query` / `memory --action search`) is preserved:
 * this fires from the render pipeline, not the agent's deliberate
 * read tools. Without it, Discoverable Archive sorts and displays
 * rendered detail entries by their last WRITE time rather than their
 * actual usage. Live evidence: thread d0372be6's
 * `curiosity:smolagents-codeact-paradigm:2026-04-28` entry was
 * rendered on every cold assembly for weeks but still showed
 * `(last accessed 26d ago)` because nothing on the read path
 * advanced the column.
 *
 * **Documented exception to the change-log outbox invariant
 * (CONTRIBUTING.md #1).** This helper writes `last_accessed_at`
 * via direct SQL — NOT via `updateRow` — because:
 *
 *  1. `last_accessed_at` is a per-host relevance hint, not a
 *     content field. It does not need LWW resolution across hosts:
 *     each host's render activity informs only that host's local
 *     sort order. There is no cross-host correctness invariant
 *     keyed on this column.
 *  2. Routing through `updateRow` advances `modified_at` along
 *     with `last_accessed_at` because LWW requires it. That cascades
 *     into stale-child detection (`buildStaleChildrenMap` compares
 *     child.modified_at vs parent summary.modified_at) and would
 *     misclassify every actively-rendered detail entry as stale —
 *     defeating the rendering invariant we're trying to fix.
 *  3. The change-log volume from per-cold-assembly bumps on busy
 *     threads (~200 entries × multiple cold passes) would also be
 *     wasteful sync traffic for a signal other hosts ignore.
 *
 * The narrow column allowed here is `last_accessed_at` only.
 * Failures are non-fatal: a missed bump is a hint, not a
 * correctness gate, and the render must not break the agent loop.
 *
 * **LWW overwrite is acceptable.** A remote `memorize` from another
 * host arrives via the change-log reducer and overwrites every
 * column in the row, including `last_accessed_at`. The local bump
 * we just performed gets clobbered by the remote write's timestamp.
 * This is fine: a remote write IS a genuine content mutation, and
 * resetting the access time to that write's `now` is semantically
 * correct ("the entry was last touched then"). The local-render
 * bumps and remote-write bumps are not in tension — they're two
 * legitimate sources of access-time updates.
 */
export function bumpRenderedDetailEntries(
	db: Database,
	entries: DetailEntry[],
	nowMs: number,
	debounceMs: number = RENDER_BUMP_DEBOUNCE_MS,
): void {
	const nowIso = new Date(nowMs).toISOString();
	const cutoff = new Date(nowMs - debounceMs).toISOString();
	const pk = getPkColumn("semantic_memory");
	// Compile the prepared statement ONCE outside the loop. SQLite
	// re-binds parameters cheaply but compilation per-iteration would
	// turn a ~200-row bump into ~200× the work it needs to do.
	const sql = `UPDATE semantic_memory SET last_accessed_at = ? WHERE ${pk} = ? AND deleted = 0`; // outbox-exempt: per-host relevance hint, see JSDoc on bumpRenderedDetailEntries
	const stmt = db.prepare(sql);
	for (const entry of entries) {
		if (entry.last_accessed_at !== null && entry.last_accessed_at >= cutoff) {
			continue;
		}
		try {
			stmt.run(nowIso, entry.id);
		} catch {
			// Non-fatal — bumping is a relevance hint, not a correctness gate.
		}
	}
}

export const WORKING_KNOWLEDGE_HEADER = "## Working Knowledge — operational and durable";
export const WORKING_KNOWLEDGE_FOOTER =
	"Bodies of summary entries are accessed via memory search using terms from the entry key.";
export const SUMMARY_GLOSS_MAX = 200;

/**
 * Truncate a summary value to `SUMMARY_GLOSS_MAX` chars with `…`
 * suffix when over budget. Exposed so `stable-prefix/compose.ts`
 * can render summary bodies byte-equivalently to
 * `renderWorkingKnowledge`'s stable channel without re-importing
 * the dual-purpose renderer.
 */
export function truncateGlossForSummary(value: string): string {
	return truncateGloss(value, SUMMARY_GLOSS_MAX);
}
export const STALE_CHILD_GLOSS_MAX = 200;
export const DELTA_MARKER = "[changed since last turn]";

/**
 * Truncates a string to maximum length and appends "..." if truncated.
 * Matches the existing convention in formatMemoryEntry (line 577).
 */
export function truncateGloss(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${safeSlice(s, 0, max)}...`;
}

/**
 * Header line emitted on the varying side when there are any updates to
 * report (deltas, stale children). Distinct from WORKING_KNOWLEDGE_HEADER so
 * the agent can visually pair updates with the stable bodies above without
 * re-parsing the section title.
 */
export const WORKING_KNOWLEDGE_UPDATES_HEADER = "## Working Knowledge — updates";

/**
 * Renders the Working Knowledge section from pinned and summary entries.
 * A pure function that takes already-loaded data and produces output lines.
 * No I/O; no DB access; R-VC11(d) structurally guaranteed by signature.
 *
 * Output is split into two channels (stable / varying) so the stable bodies
 * can sit before history as a cacheable developer prefix and the varying
 * markers ride in the uncached tail (RFC 2026-05-22-volatile-context §
 * suffix-prefix split).
 *
 *   stableLines  — header + plain pinned + summary bodies + footer.
 *                  Cacheable across turns until a body itself is rewritten.
 *   varyingLines — per-key [changed since last turn] markers and stale-child
 *                  sub-bullets ([stale child of <parent>], optionally with
 *                  the delta marker). Empty when no deltas / no stale children.
 *
 * R-VC2: Produces header line with exact em-dash character (U+2014).
 * R-VC3: Pinned entries rendered in full text; summary entries with 200-char gloss.
 * R-VC6: Produces exact footer text.
 * R-VC10: Stale children referenced via [stale child of <parent>] in the
 *         varying channel; the parent's body remains stable.
 * R-VC11(a-c): Delta markers emitted into the varying channel, keyed back to
 *         the entry by name. Ordering for stale + delta on the same child is
 *         preserved: [stale child of …] [changed since last turn].
 * R-VC22: Header uses ## (top-level, uniform across sections).
 */
export function renderWorkingKnowledge(input: WorkingKnowledgeInput): {
	stableLines: string[];
	varyingLines: string[];
} {
	const stableLines: string[] = [];
	stableLines.push(WORKING_KNOWLEDGE_HEADER);
	stableLines.push("");

	// R-VC3: pinned bodies in full text, no inline markers.
	for (const entry of input.pinned) {
		stableLines.push(`- ${entry.key}: ${entry.value}`);
	}

	// R-VC3: summary bodies with 200-char gloss, no inline markers.
	for (const summary of input.summaries) {
		const gloss = truncateGloss(summary.value, SUMMARY_GLOSS_MAX);
		stableLines.push(`- ${summary.key}: ${gloss}`);
	}

	stableLines.push("");
	stableLines.push(WORKING_KNOWLEDGE_FOOTER);

	const varyingLines: string[] = [];

	// Collect all per-key annotations (deltas + stale children) on the varying side.
	const pinnedDeltas = input.pinned.filter((e) => input.deltaKeys.has(e.key));
	const summaryDeltas = input.summaries.filter((s) => input.deltaKeys.has(s.key));
	let hasStaleChildren = false;
	for (const summary of input.summaries) {
		const children = input.staleChildrenBySummary.get(summary.key);
		if (children && children.length > 0) {
			hasStaleChildren = true;
			break;
		}
	}

	if (pinnedDeltas.length > 0 || summaryDeltas.length > 0 || hasStaleChildren) {
		varyingLines.push(WORKING_KNOWLEDGE_UPDATES_HEADER);
		varyingLines.push("");

		// R-VC11(b): pinned delta — keyed reference (body lives in stable).
		for (const entry of pinnedDeltas) {
			varyingLines.push(`- ${entry.key} ${DELTA_MARKER}`);
		}

		// R-VC11(a): summary delta — keyed reference (body lives in stable).
		for (const summary of summaryDeltas) {
			varyingLines.push(`- ${summary.key} ${DELTA_MARKER}`);
		}

		// R-VC10/R-VC11(c): stale children referenced under their parent. The
		// child gloss travels with the marker because the staleness signal is
		// what makes it relevant — it would not appear otherwise.
		for (const summary of input.summaries) {
			const staleChildren = input.staleChildrenBySummary.get(summary.key) ?? [];
			for (const child of staleChildren) {
				const childGloss = truncateGloss(child.value, STALE_CHILD_GLOSS_MAX);
				const staleMarker = `[stale child of ${summary.key}]`;
				const childDelta = input.deltaKeys.has(child.key) ? ` ${DELTA_MARKER}` : "";
				varyingLines.push(`  - ${child.key}: ${childGloss} ${staleMarker}${childDelta}`);
			}
		}
	}

	return { stableLines, varyingLines };
}

/**
 * Live State data type for applied advisories (R-VC12).
 * Advisories where status = 'applied' within the prior 24 hours.
 */
export interface LiveStateAdvisory {
	title: string;
	/** ISO-8601 timestamp of the apply-status transition. */
	appliedAt: string;
}

/**
 * Loads applied advisories within the 24-hour window for Live State rendering (R-VC12).
 *
 * This query is distinct from the advisory feedback-loop in context-assembly.ts:362–:389,
 * which serves operator-feedback notifications. Here, we surface all applied advisories
 * (not authored-site-gated) and do not de-dupe by title (each application is independently
 * relevant as a pointer).
 *
 * CONTRIBUTING.md gotcha: never use SQLite datetime('now', '-N hours') against ISO-8601;
 * compute the cutoff in JS and pass as a parameter.
 */
export function loadAppliedAdvisoriesForLiveState(
	db: Database,
	nowMs: number,
): LiveStateAdvisory[] {
	const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
	const rows = db
		.prepare(
			"SELECT title, resolved_at FROM advisories WHERE status = 'applied' AND deleted = 0 AND resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY resolved_at DESC",
		)
		.all(cutoff) as Array<{ title: string; resolved_at: string }>;
	return rows.map((r) => ({ title: r.title, appliedAt: r.resolved_at }));
}

/**
 * Loads file modification notices for Live State rendering (R-VC13, R-E20).
 * Queries _internal.file_thread.* entries and returns structured file entries
 * pointing to the last thread that modified each file, capped at 10 total.
 *
 * Non-fatal: query errors are swallowed; empty array returned on failure.
 */
export function loadFileModificationsForLiveState(
	db: Database,
	currentThreadId: string,
): LiveStateFileEntry[] {
	try {
		const FILE_NOTIF_CAP = 10;
		const threadFiles = db
			.query(
				"SELECT DISTINCT key FROM semantic_memory WHERE key LIKE '_internal.file_thread.%' AND deleted = 0",
			)
			.all() as Array<{ key: string }>;

		const entries: LiveStateFileEntry[] = [];
		for (const { key } of threadFiles) {
			if (entries.length >= FILE_NOTIF_CAP) break;
			const filePath = key.replace("_internal.file_thread.", "");
			const lastThread = getLastThreadForFile(db, filePath);
			if (lastThread && lastThread !== currentThreadId) {
				const threadRow = db.query("SELECT title FROM threads WHERE id = ?").get(lastThread) as {
					title: string | null;
				} | null;
				const threadTitle = threadRow?.title || lastThread;
				entries.push({ path: filePath, threadTitle });
			}
		}
		return entries;
	} catch (error) {
		// Non-fatal: file thread notification query failed. Log for visibility.
		console.warn("loadFileModificationsForLiveState query failed:", error);
		return [];
	}
}

/**
 * Live State data type for task digest entries (R-VC5, R-MV6/R-MV7/R-MV8/R-MV9).
 * Represents a task run from the volatile digest.
 */
export interface LiveStateTaskEntry {
	taskId: string;
	taskType: string;
	runCount: number;
	lastRunAt: string;
	status: string;
}

/**
 * Live State data type for file modification notices (R-VC13, R-E20).
 * Represents a file modified from a sibling thread.
 */
export interface LiveStateFileEntry {
	path: string;
	threadTitle: string;
}

/**
 * Input to renderLiveState — composed from four subsystems by Phase 5 wiring.
 * Each field is pre-loaded by the caller; the renderer is a pure function.
 */
export interface LiveStateInput {
	/** Structured per-thread rows from buildCrossThreadDigest.entries */
	crossThreadEntries: CrossThreadDigestEntry[];
	/** Task digest rows from buildVolatileEnrichment */
	taskEntries: LiveStateTaskEntry[];
	/** File modification notices from context-assembly.ts */
	fileEntries: LiveStateFileEntry[];
	/** Applied advisories from loadAppliedAdvisoriesForLiveState */
	advisories: LiveStateAdvisory[];
	/** From renderDiscoverableArchive output. Null when Tier 3 inactive or Uncategorized ≤ 50. */
	synthesisBacklogCount: number | null;
	/** True when budget pressure is active (R-VC14). */
	budgetPressure: boolean;
	/** Wall-clock anchor for relative-time formatting. Pass Date.now() at assembly time. */
	nowMs: number;
}

export const LIVE_STATE_HEADER = "## Live State — pointers to canonical sources";
export const LIVE_STATE_FOOTER =
	"Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.";
export const BUDGET_PRESSURE_SUBSYSTEM_CAP = 3;

/**
 * Renders the Live State section — the third top-level section.
 * Composes four subsystems (cross-thread, task, file, advisory) in fixed order,
 * each with an explicit source label, plus the conditional synthesis-backlog line.
 *
 * R-VC2: Produces header with exact em-dash character (U+2014).
 * R-VC5: Each entry renders with explicit source label naming the kind of pointer.
 * R-VC6: Produces exact footer text.
 * R-VC7: Cross-thread digest renders title, message count, last-updated timestamp.
 * R-VC12: Applied advisories render with relative time.
 * R-VC13: File modification notices render with em-dash separator (U+2014).
 * R-VC14: Under budget pressure, each subsystem is capped to most-recent-3.
 * R-VC15: synthesis-backlog line rendered conditionally, not affected by budget cap.
 * R-VC22: Header uses ## (top-level, uniform across sections).
 */
export function renderLiveState(input: LiveStateInput): RenderedSection {
	const lines: string[] = [];
	lines.push(LIVE_STATE_HEADER);
	lines.push("");

	const cap = (arr: unknown[]) =>
		input.budgetPressure ? arr.slice(0, BUDGET_PRESSURE_SUBSYSTEM_CAP) : arr;

	// §5.3 step 1 — cross-thread entries (R-VC7).
	for (const e of cap(input.crossThreadEntries) as CrossThreadDigestEntry[]) {
		lines.push(
			`- [thread] ${e.title}: ${e.messageCount} messages (last updated ${e.lastUpdatedAt})`,
		);
	}

	// §5.3 step 2 — task digest entries (R-MV6/R-MV7/R-MV8/R-MV9).
	for (const t of cap(input.taskEntries) as LiveStateTaskEntry[]) {
		lines.push(
			`- [task] ${t.taskId} (${t.taskType}): run_count=${t.runCount}, last_run_at=${t.lastRunAt}, status=${t.status}`,
		);
	}

	// §5.3 step 3 — file modification notices (R-VC13, R-E20).
	for (const f of cap(input.fileEntries) as LiveStateFileEntry[]) {
		// em-dash separator U+2014
		lines.push(`- [file] ${f.path} — last modified by thread "${f.threadTitle}"`);
	}

	// §5.3 step 4 — applied advisories (R-VC12).
	for (const a of cap(input.advisories) as LiveStateAdvisory[]) {
		lines.push(
			`- [advisory] ${a.title} — applied ${relativeTimeFragment(a.appliedAt, input.nowMs)}`,
		);
	}

	// §5.3 trailing rule — synthesis-backlog line (R-VC15).
	// Not subject to budget cap; singleton line when active.
	if (input.synthesisBacklogCount !== null) {
		lines.push(`- [synthesis-backlog] ${input.synthesisBacklogCount} uncategorized detail entries`);
	}

	lines.push("");
	lines.push(LIVE_STATE_FOOTER);

	return { lines };
}
