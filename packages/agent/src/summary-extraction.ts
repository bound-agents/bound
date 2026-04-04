import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import type { CrossThreadSource, Result } from "@bound/shared";
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
	graphCount?: number; // entries retrieved via graph (seed + traversal)
	recencyCount?: number; // entries retrieved via recency fallback
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
): VolatileEnrichment {
	// Pinned/policy entries — always injected regardless of recency.
	// These are critical operational instructions that should never fall out of context.
	const pinnedRows = db
		.prepare(
			`SELECT m.key, m.value, m.modified_at, m.deleted,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title,
			        m.source
			 FROM   semantic_memory m
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE  m.deleted = 0
			   AND  (m.key LIKE '\\_policy%' ESCAPE '\\' OR m.key LIKE '\\_pinned%' ESCAPE '\\')
			 ORDER  BY m.key ASC`,
		)
		.all() as Array<{
		key: string;
		value: string;
		modified_at: string;
		deleted: number;
		task_name: string | null;
		thread_id: string | null;
		thread_title: string | null;
		source: string | null;
	}>;
	const pinnedKeys = new Set(pinnedRows.map((r) => r.key));

	// Memory delta query — fetch maxMemory+1 to detect overflow, excluding pinned entries
	const memoryRows = db
		.prepare(
			`SELECT m.key, m.value, m.modified_at, m.deleted,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title,
			        m.source
			 FROM   semantic_memory m
			 LEFT JOIN tasks   t_src  ON m.source = t_src.id
			 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
			 WHERE  m.modified_at > ?
			   AND  m.key NOT LIKE '\\_policy%' ESCAPE '\\'
			   AND  m.key NOT LIKE '\\_pinned%' ESCAPE '\\'
			 ORDER  BY m.modified_at DESC
			 LIMIT  ?`,
		)
		.all(baseline, maxMemory + 1) as Array<{
		key: string;
		value: string;
		modified_at: string;
		deleted: number;
		task_name: string | null;
		thread_id: string | null;
		thread_title: string | null;
		source: string | null;
	}>;

	const hasMoreMemory = memoryRows.length > maxMemory;
	const visibleMemoryRows = hasMoreMemory ? memoryRows.slice(0, maxMemory) : memoryRows;

	const memoryDeltaLines: string[] = [];
	const deltaKeys = new Set(visibleMemoryRows.map((r) => r.key));

	// Inject pinned entries first (always visible, no truncation — these are critical)
	for (const row of pinnedRows) {
		memoryDeltaLines.push(`- ${row.key}: ${row.value} [pinned]`);
	}

	// Check if graph edges exist — if so, use graph-seeded retrieval
	const edgeCount = db
		.prepare("SELECT COUNT(*) AS cnt FROM memory_edges WHERE deleted = 0")
		.get() as { cnt: number };
	const hasGraphEdges = edgeCount.cnt > 0;

	let graphCount: number | undefined;
	let recencyCount: number | undefined;
	const boostedKeys = new Set<string>();

	if (hasGraphEdges && userMessage) {
		// Extract keywords from user message for graph seeding
		const keywords = userMessage
			.toLowerCase()
			.replace(/[^a-z0-9_\s-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

		if (keywords.length > 0) {
			// Graph-seeded retrieval
			const graphResults = graphSeededRetrieval(db, keywords, maxMemory);

			// Track keys we've already included (pinned + graph)
			const includedKeys = new Set<string>(pinnedKeys);

			for (const r of graphResults) {
				if (includedKeys.has(r.key)) continue;
				includedKeys.add(r.key);

				const tag =
					r.retrievalMethod === "seed" ? "[seed]" : `[depth ${r.depth}, ${r.viaRelation}]`;

				const valueDisplay = r.value.length > 200 ? `${r.value.substring(0, 200)}...` : r.value;
				memoryDeltaLines.push(`- ${r.key}: ${valueDisplay} ${tag}`);
			}

			const graphResultsWithoutPinned = graphResults.filter((r) => !pinnedKeys.has(r.key));
			graphCount = graphResultsWithoutPinned.length;

			// Recency fallback: fill remaining slots
			const remaining = maxMemory - graphResultsWithoutPinned.length;
			if (remaining > 0) {
				// Use same LEFT JOIN pattern to resolve source labels
				const recencyEntries = db
					.prepare(
						`SELECT m.key, m.value, m.source, m.modified_at,
						        t_src.trigger_spec AS task_name,
						        th_src.id AS thread_id,
						        th_src.title AS thread_title
						 FROM semantic_memory m
						 LEFT JOIN tasks t_src ON m.source = t_src.id
						 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
						 WHERE m.deleted = 0
						   AND m.key NOT LIKE '\\_policy%' ESCAPE '\\'
						   AND m.key NOT LIKE '\\_pinned%' ESCAPE '\\'
						 ORDER BY m.modified_at DESC
						 LIMIT ?`,
					)
					.all(remaining + includedKeys.size) as Array<{
					key: string;
					value: string;
					source: string | null;
					modified_at: string;
					task_name: string | null;
					thread_id: string | null;
					thread_title: string | null;
				}>;

				let addedRecency = 0;
				for (const entry of recencyEntries) {
					if (includedKeys.has(entry.key)) continue;
					includedKeys.add(entry.key);

					const valueDisplay =
						entry.value.length > 200 ? `${entry.value.substring(0, 200)}...` : entry.value;
					const sourceLabel = resolveSource(
						entry.task_name,
						entry.thread_id,
						entry.thread_title,
						entry.source,
					);
					const relTime = relativeTime(entry.modified_at);
					memoryDeltaLines.push(
						`- ${entry.key}: ${valueDisplay} (${relTime}, via ${sourceLabel}) [recency]`,
					);

					addedRecency++;
					if (memoryDeltaLines.length >= maxMemory + pinnedRows.length) break;
				}

				recencyCount = addedRecency;
			}
		} else {
			// No keywords extracted — fall back to pure recency (AC4.6)
			// Skip the boost query entirely when no keywords; go straight to delta entries

			// Then delta entries (recency-based)
			for (const row of visibleMemoryRows) {
				if (pinnedKeys.has(row.key) || boostedKeys.has(row.key)) continue;
				const sourceLabel = resolveSource(
					row.task_name,
					row.thread_id,
					row.thread_title,
					row.source,
				);
				const relTime = relativeTime(row.modified_at);
				if (row.deleted) {
					memoryDeltaLines.push(`- ${row.key}: [forgotten] (${relTime}, via ${sourceLabel})`);
				} else {
					const value = row.value.length > 200 ? `${row.value.slice(0, 200)}...` : row.value;
					memoryDeltaLines.push(`- ${row.key}: ${value} (${relTime}, via ${sourceLabel})`);
				}
			}
			if (hasMoreMemory) {
				memoryDeltaLines.push(
					`... and ${memoryRows.length - maxMemory} more (query semantic_memory for full list)`,
				);
			}
		}
	} else {
		// No graph edges or no user message — existing delta+boost logic unchanged
		if (userMessage && userMessage.length > 0) {
			const keywords = userMessage
				.toLowerCase()
				.replace(/[^a-z0-9_\s-]/g, " ")
				.split(/\s+/)
				.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

			if (keywords.length > 0) {
				// Build LIKE conditions for key and value matching
				const likeConditions = keywords.map(
					() => `(LOWER(m.key) LIKE '%' || ? || '%' OR LOWER(m.value) LIKE '%' || ? || '%')`,
				);
				const params = keywords.flatMap((kw) => [kw, kw]);
				const MAX_BOOSTED = 5;

				const boostedRows = db
					.prepare(
						`SELECT m.key, m.value, m.modified_at
						 FROM   semantic_memory m
						 WHERE  m.deleted = 0
						   AND  m.key NOT LIKE '\\_policy%' ESCAPE '\\'
						   AND  m.key NOT LIKE '\\_pinned%' ESCAPE '\\'
						   AND  (${likeConditions.join(" OR ")})
						 ORDER  BY m.modified_at DESC
						 LIMIT  ?`,
					)
					.all(...params, MAX_BOOSTED) as Array<{
					key: string;
					value: string;
					modified_at: string;
				}>;

				for (const row of boostedRows) {
					if (deltaKeys.has(row.key) || pinnedKeys.has(row.key)) continue;
					boostedKeys.add(row.key);
					memoryDeltaLines.push(`- ${row.key}: ${row.value} [relevant]`);
				}
			}
		}

		// Then delta entries (recency-based)
		for (const row of visibleMemoryRows) {
			if (pinnedKeys.has(row.key) || boostedKeys.has(row.key)) continue;
			const sourceLabel = resolveSource(row.task_name, row.thread_id, row.thread_title, row.source);
			const relTime = relativeTime(row.modified_at);
			if (row.deleted) {
				memoryDeltaLines.push(`- ${row.key}: [forgotten] (${relTime}, via ${sourceLabel})`);
			} else {
				const value = row.value.length > 200 ? `${row.value.slice(0, 200)}...` : row.value;
				memoryDeltaLines.push(`- ${row.key}: ${value} (${relTime}, via ${sourceLabel})`);
			}
		}
		if (hasMoreMemory) {
			memoryDeltaLines.push(
				`... and ${memoryRows.length - maxMemory} more (query semantic_memory for full list)`,
			);
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

	return { memoryDeltaLines, taskDigestLines, graphCount, recencyCount };
}
