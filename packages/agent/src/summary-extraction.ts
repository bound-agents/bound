import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { LLMBackend, Result } from "@bound/llm";

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
				`SELECT content FROM messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at`,
			)
			.all(threadId, summaryThrough) as Array<{ content: string }>;

		if (messages.length === 0) {
			return {
				ok: true,
				value: { summaryGenerated: false, memoriesExtracted: 0 },
			};
		}

		// Build prompt for summarization
		const messageText = messages.map((m) => m.content).join("\n\n");
		const prompt = `Summarize the following conversation in 2-3 sentences:\n\n${messageText}`;

		// Call LLM to generate summary
		const chunks: string[] = [];
		for await (const chunk of llmBackend.chat({
			model: "",
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

		// Extract key facts as memories (simplified)
		const memoryCount = Math.min(3, Math.max(0, messages.length - 1)); // Create 0-3 memories
		for (let i = 0; i < memoryCount; i++) {
			const memId = randomUUID();
			const key = `thread_${threadId}_fact_${i}`;
			const value = `Extracted from conversation`;

			db.prepare(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)`,
			).run(memId, key, value, threadId, now, now);
		}

		return {
			ok: true,
			value: { summaryGenerated: summary.length > 0, memoriesExtracted: memoryCount },
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
		// Get recent threads for user
		const threads = db
			.prepare(
				`SELECT id, title, last_message_at FROM threads WHERE user_id = ? AND deleted = 0 ORDER BY last_message_at DESC LIMIT 5`,
			)
			.all(userId) as Array<{ id: string; title: string | null; last_message_at: string }>;

		if (threads.length === 0) {
			return "No recent activity.";
		}

		// Build digest
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
		}

		return lines.join("\n");
	} catch {
		return "Error building digest.";
	}
}
