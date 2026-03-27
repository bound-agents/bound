import type { Database } from "bun:sqlite";
import { softDelete, updateRow } from "@bound/core";
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
		// Use updateRow so a change_log entry is created and the redaction
		// propagates to other nodes via sync (Bug #7).
		updateRow(db, "messages", messageId, { content: "[redacted]" }, siteId);
		return { ok: true, value: undefined };
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
		// Get all message IDs in the thread
		const messages = db
			.prepare("SELECT id FROM messages WHERE thread_id = ?")
			.all(threadId) as Array<{ id: string }>;

		// Redact all messages via updateRow so change_log entries are created
		for (const msg of messages) {
			updateRow(db, "messages", msg.id, { content: "[redacted]" }, siteId);
		}

		// Tombstone semantic_memory entries whose source matches the thread_id
		const memoryRows = db
			.prepare("SELECT id FROM semantic_memory WHERE source = ? AND deleted = 0")
			.all(threadId) as Array<{ id: string }>;

		for (const mem of memoryRows) {
			softDelete(db, "semantic_memory", mem.id, siteId);
		}

		return {
			ok: true,
			value: {
				messagesRedacted: messages.length,
				memoriesAffected: memoryRows.length,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}
