import { softDelete } from "@bound/core";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

function parseTimeOffset(offset: string): Date {
	const now = new Date();
	const match = offset.match(/^(\d+)(d|w|m)$/);

	if (!match) {
		throw new Error(`Invalid time offset format: ${offset}`);
	}

	const [, num, unit] = match;
	const n = Number.parseInt(num, 10);

	switch (unit) {
		case "d":
			now.setDate(now.getDate() - n);
			break;
		case "w":
			now.setDate(now.getDate() - n * 7);
			break;
		case "m":
			now.setMonth(now.getMonth() - n);
			break;
		default:
			throw new Error(`Unknown time unit: ${unit}`);
	}

	return now;
}

const archiveSchema = z.object({
	thread_id: z.string().optional().describe("Single thread ID to archive"),
	older_than: z
		.string()
		.optional()
		.describe("Archive threads older than this (e.g., '30d', '2w', '3m')"),
});

export function createArchiveTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(archiveSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "archive",
				description: "Archive a thread to long-term storage",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(archiveSchema, raw, "archive");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				const threadId = input.thread_id;
				const olderThan = input.older_than;

				// Archive a specific thread
				if (threadId) {
					const existing = ctx.db
						.prepare("SELECT id FROM threads WHERE id = ? AND deleted = 0")
						.get(threadId) as { id: string } | null;

					if (!existing) {
						return `Error: Thread not found: ${threadId}`;
					}

					// Soft-delete the thread
					softDelete(ctx.db, "threads", threadId, ctx.siteId);

					return `Thread archived: ${threadId}`;
				}

				// Archive threads with no messages in N days
				if (olderThan) {
					const cutoffDate = parseTimeOffset(olderThan);
					const cutoffTime = cutoffDate.toISOString();

					// Find threads not modified since cutoff
					const threads = ctx.db
						.prepare("SELECT id FROM threads WHERE last_message_at < ? AND deleted = 0")
						.all(cutoffTime) as Array<{ id: string }>;

					if (threads.length === 0) {
						return "No threads matched the criteria";
					}

					// Archive matching threads
					for (const thread of threads) {
						softDelete(ctx.db, "threads", thread.id, ctx.siteId);
					}

					return `Archived ${threads.length} thread(s)`;
				}

				return "Error: must specify thread_id or older_than";
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
