import type { Database } from "bun:sqlite";
import type { LLMBackend, Result } from "@bound/llm";
import type { Message, Thread } from "@bound/shared";

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
		const prompt = `Based on the initial exchange below, generate a short title (5-10 words) for this conversation thread. Return ONLY the title, nothing else.

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

		// Fallback per spec R-E17: use first 50 chars of user message if LLM returned empty
		if (!title) {
			title = firstUserMessage.content.substring(0, 50).trim();
		}

		// Store the generated title
		db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, threadId);

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
				const fallbackTitle = fallbackMsg.content.substring(0, 50).trim();
				db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(fallbackTitle, threadId);
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
