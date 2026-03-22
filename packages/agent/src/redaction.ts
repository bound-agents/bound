import type { Database } from "bun:sqlite";
import type { Result } from "@bound/shared";

export interface RedactionResult {
	messagesRedacted: number;
	memoriesAffected: number;
}

export function redactMessage(
	db: Database,
	messageId: string,
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		db.prepare("UPDATE messages SET content = ?, modified_at = ? WHERE id = ?").run(
			"[redacted]",
			now,
			messageId,
		);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export function redactThread(
	db: Database,
	threadId: string,
	siteId: string,
): Result<RedactionResult, Error> {
	try {
		const now = new Date().toISOString();

		// Get all message IDs in the thread
		const messages = db
			.prepare("SELECT id FROM messages WHERE thread_id = ?")
			.all(threadId) as Array<{ id: string }>;

		// Redact all messages
		for (const msg of messages) {
			db.prepare("UPDATE messages SET content = ?, modified_at = ? WHERE id = ?").run(
				"[redacted]",
				now,
				msg.id,
			);
		}

		// Tombstone semantic_memory entries whose source matches the thread_id
		const memoryResult = db
			.prepare(`SELECT COUNT(*) as count FROM semantic_memory WHERE source = ? AND deleted = 0`)
			.get(threadId) as { count: number };

		const memoryCount = memoryResult.count;

		db.prepare(
			"UPDATE semantic_memory SET deleted = 1, modified_at = ? WHERE source = ? AND deleted = 0",
		).run(now, threadId);

		return {
			ok: true,
			value: {
				messagesRedacted: messages.length,
				memoriesAffected: memoryCount,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}
