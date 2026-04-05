import type { Database } from "bun:sqlite";
import { updateRow } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import type { Result } from "@bound/shared";
import type { Message, Thread } from "@bound/shared";

/**
 * Extract a human-readable title from a JSON task payload.
 * Returns null if the content isn't a recognized JSON payload.
 */
function titleFromPayload(content: string): string | null {
	if (!content.startsWith("{")) return null;
	try {
		const payload = JSON.parse(content) as Record<string, unknown>;
		// Try common fields in priority order
		const description =
			(typeof payload.topic === "string" && payload.topic) ||
			(typeof payload.instructions === "string" && payload.instructions) ||
			(typeof payload.prompt === "string" && payload.prompt) ||
			(typeof payload.task === "string" && payload.task);
		if (!description) return null;

		const type = typeof payload.type === "string" ? payload.type : "task";
		const label = type.replace(/_/g, " ");

		// Take the first sentence or clause, cap at 70 chars to leave room for label
		let desc = description.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
		if (desc.length > 70) {
			desc = `${desc.substring(0, 67).trimEnd()}...`;
		}
		return `[${label}] ${desc}`;
	} catch {
		return null;
	}
}

export async function generateThreadTitle(
	db: Database,
	threadId: string,
	llmBackend: LLMBackend,
	siteId: string,
): Promise<Result<string, Error>> {
	try {
		// Check if thread already has a title (at-most-once guarantee)
		const thread = db.prepare("SELECT title FROM threads WHERE id = ?").get(threadId) as
			| Pick<Thread, "title">
			| undefined;

		if (thread?.title) {
			// Title already exists, return early
			return { ok: true, value: thread.title };
		}

		// Get the first user message
		const firstUserMessage = db
			.prepare(
				"SELECT content FROM messages WHERE thread_id = ? AND role IN ('user') ORDER BY created_at LIMIT 1",
			)
			.get(threadId) as Pick<Message, "content"> | undefined;

		// Get the first assistant response
		const firstAssistantMessage = db
			.prepare(
				"SELECT content FROM messages WHERE thread_id = ? AND role IN ('assistant') ORDER BY created_at LIMIT 1",
			)
			.get(threadId) as Pick<Message, "content"> | undefined;

		if (!firstUserMessage) {
			return {
				ok: false,
				error: new Error("No user message found to generate title from"),
			};
		}

		// Build a prompt for title generation
		const prompt = `Generate a short, single-line title (5-10 words) for this conversation. No markdown, no quotes, no punctuation at the start. Return ONLY the title text on one line.

User: ${firstUserMessage.content}
${firstAssistantMessage ? `Assistant: ${firstAssistantMessage.content}` : ""}`;

		// Call the LLM to generate title
		const chunks: string[] = [];
		for await (const chunk of llmBackend.chat({
			model: "", // Will use default
			messages: [
				{
					role: "user",
					content: prompt,
				},
			],
			max_tokens: 100,
		})) {
			if (chunk.type === "text") {
				chunks.push(chunk.content);
			}
		}

		let title = chunks.join("").trim();

		// Sanitize: collapse to single line, strip markdown headers and leading punctuation
		title = title
			.replace(/\r?\n/g, " ") // newlines → spaces
			.replace(/\s+/g, " ") // collapse whitespace
			.replace(/^[#*_>\-]+\s*/, "") // strip leading markdown syntax
			.replace(/^["']+|["']+$/g, "") // strip wrapping quotes
			.trim();

		// Cap title length — LLMs sometimes return verbose multi-sentence "titles"
		if (title.length > 80) {
			title = `${title.substring(0, 77).trimEnd()}...`;
		}

		// Fallback per spec R-E17: use first 50 chars of user message if LLM returned empty
		if (!title) {
			title =
				titleFromPayload(firstUserMessage.content) ??
				firstUserMessage.content.substring(0, 50).trim();
		}

		// Store the generated title
		updateRow(db, "threads", threadId, { title }, siteId);

		return { ok: true, value: title };
	} catch (error) {
		// Fallback per spec R-E17: on failure, use first 50 chars of user's first message
		try {
			const fallbackMsg = db
				.prepare(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at LIMIT 1",
				)
				.get(threadId) as Pick<Message, "content"> | null;

			if (fallbackMsg) {
				const fallbackTitle =
					titleFromPayload(fallbackMsg.content) ?? fallbackMsg.content.substring(0, 50).trim();
				updateRow(db, "threads", threadId, { title: fallbackTitle }, siteId);
				return { ok: true, value: fallbackTitle };
			}
		} catch {
			// If even the fallback fails, just return the original error
		}

		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}
