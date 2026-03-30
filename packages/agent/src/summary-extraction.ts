import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { LLMBackend } from "@bound/llm";
import type { Result } from "@bound/shared";

export interface ExtractionResult {
	summaryGenerated: boolean;
	memoriesExtracted: number;
}

export async function extractSummaryAndMemories(
	db: Database,
	threadId: string,
	llmBackend: LLMBackend,
	_siteId: string,
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
		const prompt =
			"Write a 2-3 sentence summary of this conversation from your own perspective:\n\n" +
			messageText;

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

		// Update thread with summary
		if (summary) {
			db.prepare(
				"UPDATE threads SET summary = ?, summary_through = ?, summary_model_id = ? WHERE id = ?",
			).run(summary, now, "default", threadId);
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
						content:
							`What are up to 3 key things you did, learned, or resolved in this conversation? ` +
							`Write each as a first-person statement on its own line starting with "- ":\n\n${summary}`,
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
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(memId, key, factLines[i], threadId, now, now);
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

export function buildCrossThreadDigest(db: Database, userId: string): string {
	try {
		// Get recent threads for user, including the summary field for continuity
		const threads = db
			.prepare(
				"SELECT id, title, last_message_at, summary FROM threads WHERE user_id = ? AND deleted = 0 ORDER BY last_message_at DESC LIMIT 5",
			)
			.all(userId) as Array<{
			id: string;
			title: string | null;
			last_message_at: string;
			summary: string | null;
		}>;

		if (threads.length === 0) {
			return "No recent activity.";
		}

		// Build digest — include summary so the agent can continue prior conversations
		const lines: string[] = [];
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
					thread.summary.length > 300
						? `${thread.summary.slice(0, 297)}...`
						: thread.summary;
				lines.push(`  Summary: ${truncated}`);
			}
		}

		return lines.join("\n");
	} catch {
		return "Error building digest.";
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
	maxMemory = 10,
	maxTasks = 5,
): VolatileEnrichment {
	// Memory delta query — fetch maxMemory+1 to detect overflow
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
	for (const row of visibleMemoryRows) {
		const sourceLabel = resolveSource(row.task_name, row.thread_id, row.thread_title, row.source);
		const relTime = relativeTime(row.modified_at);
		if (row.deleted) {
			memoryDeltaLines.push(`- ${row.key}: [forgotten] (${relTime}, via ${sourceLabel})`);
		} else {
			const value = row.value.length > 120 ? `${row.value.slice(0, 120)}...` : row.value;
			memoryDeltaLines.push(`- ${row.key}: ${value} (${relTime}, via ${sourceLabel})`);
		}
	}
	if (hasMoreMemory) {
		memoryDeltaLines.push(
			`... and ${memoryRows.length - maxMemory} more (query semantic_memory for full list)`,
		);
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

	return { memoryDeltaLines, taskDigestLines };
}
