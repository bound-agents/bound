import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import type { CrossThreadSource, MemoryTier, Result } from "@bound/shared";
import { safeSlice } from "@bound/shared";
import { graphSeededRetrieval } from "./graph-queries";

/**
 * Common English stop words for keyword filtering.
 * Used in both graph-seeded and recency-based keyword extraction.
 */
const STOP_WORDS = new Set([
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

export async function extractSummaryAndMemories(
	db: Database,
	threadId: string,
	llmBackend: LLMBackend,
	siteId: string,
): Promise<Result<ExtractionResult, Error>> {
	try {
		// Get thread state
		const thread = db.prepare("SELECT summary_through FROM threads WHERE id = ?").get(threadId) as
			| { summary_through: string | null }
			| undefined;

		if (!thread) {
			return {
				ok: false,
				error: new Error("Thread not found"),
			};
		}

		const summaryThrough = thread.summary_through || "1970-01-01T00:00:00Z";

		// Get messages after summary_through
		const messages = db
			.prepare(
				"SELECT content FROM messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at",
			)
			.all(threadId, summaryThrough) as Array<{ content: string }>;

		if (messages.length === 0) {
			return {
				ok: true,
				value: { summaryGenerated: false, memoriesExtracted: 0 },
			};
		}

		// Build prompt for summarization — framed as the agent's own first-person reflection
		// so summaries read "I helped..." rather than "The assistant was asked..."
		const messageText = messages.map((m) => m.content).join("\n\n");
		const summarizationSystem =
			"You are an AI assistant reflecting on a conversation you just had. " +
			"Write from your own first-person perspective (use 'I' or 'we'). " +
			"Do not refer to yourself as 'the assistant'.";
		const prompt = `Write a 2-3 sentence summary of this conversation from your own perspective:\n\n${messageText}`;

		// Call LLM to generate summary
		const chunks: string[] = [];
		for await (const chunk of llmBackend.chat({
			model: "",
			system: summarizationSystem,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 200,
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

		// Bug #5: previously stored the literal placeholder "Extracted from conversation".
		const factChunks: string[] = [];
		try {
			for await (const chunk of llmBackend.chat({
				model: "",
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

export function buildCrossThreadDigest(
	db: Database,
	userId: string,
	excludeThreadId?: string,
): { text: string; sources: CrossThreadSource[] } {
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
			return { text: "No recent activity.", sources: [] };
		}

		// Build digest — include summary so the agent can continue prior conversations
		const lines: string[] = [];
		const sources: CrossThreadSource[] = [];
		lines.push("Recent Activity Digest:");
		lines.push("");

		for (const thread of threads) {
			const title = thread.title || "(untitled)";
			const messageCount = db
				.prepare("SELECT COUNT(*) as count FROM messages WHERE thread_id = ?")
				.get(thread.id) as { count: number };

			lines.push(
				`- ${title}: ${messageCount.count} messages (last updated ${thread.last_message_at})`,
			);

			// Include the thread summary (truncated to 300 chars) when available,
			// so the agent has conversational context without needing to re-read history.
			if (thread.summary) {
				const truncated =
					thread.summary.length > 300 ? `${thread.summary.slice(0, 297)}...` : thread.summary;
				lines.push(`  Summary: ${truncated}`);
			}

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

		return { text: lines.join("\n"), sources };
	} catch {
		return { text: "Error building digest.", sources: [] };
	}
}

function resolveSource(
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

function relativeTime(isoString: string): string {
	const diffMs = Date.now() - new Date(isoString).getTime();
	const diffSeconds = Math.floor(diffMs / 1000);
	if (diffSeconds < 60) return "just now";
	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
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
 *   noHistory=false → thread.last_message_at ?? thread.created_at
 *   noHistory=true + taskId → task.last_run_at ?? task.created_at
 *   noHistory=true + no taskId → epoch
 */
export function computeBaseline(
	db: Database,
	threadId: string,
	taskId?: string,
	noHistory?: boolean,
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

	const row = db
		.prepare("SELECT last_message_at, created_at FROM threads WHERE id = ?")
		.get(threadId) as { last_message_at: string | null; created_at: string } | null;
	if (row === null) return EPOCH;
	return row.last_message_at ?? row.created_at;
}

export interface VolatileEnrichment {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
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
	tag: string; // e.g., "[pinned]", "[summary]", "[stale-detail]", "[seed]", "[recency]"
	taskName?: string | null; // resolved via LEFT JOIN tasks WHERE source = t.id
	threadId?: string | null; // resolved via LEFT JOIN threads WHERE source = th.id
	threadTitle?: string | null; // resolved via LEFT JOIN threads
	deleted?: number; // 0 or 1, indicates soft-deleted entries (for [forgotten] rendering)
}

export interface StageResult {
	entries: StageEntry[];
	exclusionSet: Set<string>;
}

export interface TieredEnrichment {
	L0: StageEntry[];
	L1: StageEntry[];
	L2: StageEntry[];
	L3: StageEntry[];
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
): VolatileEnrichment {
	// Helper: extract keywords from text, filtering stop words and short tokens
	const extractKeywords = (text: string): string[] =>
		text
			.toLowerCase()
			.replace(/[^a-z0-9_\s-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

	// Merge keywords from user message (high priority) and thread summary (broader context).
	// Message keywords come first; summary keywords are deduplicated against them.
	const messageKeywords = extractKeywords(userMessage ?? "");
	const messageKeywordSet = new Set(messageKeywords);
	const summaryKeywords = extractKeywords(threadSummary ?? "").filter(
		(w) => !messageKeywordSet.has(w),
	);
	// Cap keywords to prevent pathologically large SQL queries. User messages with
	// file attachments (e.g., log dumps) can produce 500+ keywords, which cascades
	// into graphSeededRetrieval's OR-chained LIKE conditions and exceeds SQLite's
	// expression tree depth limit of 1000. 30 keywords is more than sufficient for
	// semantic memory matching. The cap in graphSeededRetrieval is a safety net;
	// this is the primary cap at the source.
	const mergedKeywords = [...messageKeywords, ...summaryKeywords].slice(0, 30);

	// Run the L0→L1→L2→L3 pipeline
	const l0 = loadPinnedEntries(db);
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
			`SELECT t.trigger_spec, t.last_run_at, t.consecutive_failures, t.claimed_by,
			        h.host_name
			 FROM   tasks t
			 LEFT JOIN hosts h ON t.claimed_by = h.site_id
			 WHERE  t.last_run_at > ?
			   AND  t.last_run_at IS NOT NULL
			   AND  t.deleted = 0
			 ORDER  BY t.last_run_at DESC
			 LIMIT  ?`,
		)
		.all(baseline, maxTasks + 1) as Array<{
		trigger_spec: string;
		last_run_at: string;
		consecutive_failures: number;
		claimed_by: string | null;
		host_name: string | null;
	}>;

	const hasMoreTasks = taskRows.length > maxTasks;
	const visibleTaskRows = hasMoreTasks ? taskRows.slice(0, maxTasks) : taskRows;

	const taskDigestLines: string[] = [];
	for (const row of visibleTaskRows) {
		const status = row.consecutive_failures === 0 ? "ran" : "failed";
		const hostLabel = row.host_name ?? (row.claimed_by ? row.claimed_by.slice(0, 8) : "unknown");
		const relTime = relativeTime(row.last_run_at);
		taskDigestLines.push(`- ${row.trigger_spec} ${status} (${relTime} on ${hostLabel})`);
	}
	if (hasMoreTasks) {
		taskDigestLines.push(`... and ${taskRows.length - maxTasks} more (query tasks for full list)`);
	}

	return {
		memoryDeltaLines,
		taskDigestLines,
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
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id
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
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id
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
				 LEFT JOIN tasks   t_src  ON m.source = t_src.id
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
				 LEFT JOIN tasks   t_src  ON m.source = t_src.id
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

		const tag = r.retrievalMethod === "seed" ? "[seed]" : `[depth ${r.depth}, ${r.viaRelation}]`;

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
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE m.modified_at > ?
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
