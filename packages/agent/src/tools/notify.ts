import { enqueueNotification } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

interface UserRow {
	id: string;
	display_name: string;
	platform_ids: string | null;
}

interface ThreadRow {
	id: string;
}

/**
 * Resolve a bound username to a user ID and validate platform access.
 */
function resolveUser(db: import("bun:sqlite").Database, username: string): UserRow | null {
	const userId = deterministicUUID(BOUND_NAMESPACE, username);
	return db
		.query("SELECT id, display_name, platform_ids FROM users WHERE id = ? AND deleted = 0")
		.get(userId) as UserRow | null;
}

/**
 * Find the most recent DM thread for a user on a given platform.
 */
function findDmThread(
	db: import("bun:sqlite").Database,
	userId: string,
	platform: string,
): ThreadRow | null {
	return db
		.query(
			"SELECT id FROM threads WHERE user_id = ? AND interface = ? AND deleted = 0 ORDER BY last_message_at DESC LIMIT 1",
		)
		.get(userId, platform) as ThreadRow | null;
}

/**
 * Get all non-deleted users from the database.
 */
function getAllUsers(db: import("bun:sqlite").Database): UserRow[] {
	return db
		.query("SELECT id, display_name, platform_ids FROM users WHERE deleted = 0")
		.all() as UserRow[];
}

/**
 * Enqueue a proactive notification and signal the server to run inference.
 */
function enqueueAndSignal(
	ctx: ToolContext,
	threadId: string,
	sourceThreadId: string | undefined,
	message: string,
): void {
	enqueueNotification(ctx.db, threadId, {
		type: "proactive",
		source_thread: sourceThreadId ?? null,
		content: message,
	});

	ctx.eventBus.emit("notify:enqueued", { thread_id: threadId });
}

const notifySchema = z.object({
	user: z.string().optional().describe("Target bound username"),
	all: z.boolean().optional().describe("Broadcast to all users"),
	platform: z.string().describe("Platform name (e.g., 'discord')"),
	message: z.string().describe("Notification message content"),
});

export function createNotifyTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(notifySchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "notify",
				description: "Send a notification to users on configured platforms",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(notifySchema, raw, "notify");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				const platform = input.platform;
				const user = input.user;
				const all = input.all;
				const message = input.message;

				// Validate --user / --all mutual exclusivity
				if (user && all) {
					return "Error: user and all are mutually exclusive";
				}
				if (!user && !all) {
					return "Error: One of user or all is required";
				}

				// Validate message
				if (!message.trim()) {
					return "Error: Missing notification message";
				}

				const sourceThreadId = ctx.threadId;

				if (all) {
					const users = getAllUsers(ctx.db);
					let delivered = 0;
					let skipped = 0;

					for (const userRow of users) {
						// Check if user has the target platform
						const platformIds = userRow.platform_ids
							? (JSON.parse(userRow.platform_ids) as Record<string, unknown>)
							: {};
						if (!platformIds[platform]) {
							skipped++;
							continue;
						}

						const thread = findDmThread(ctx.db, userRow.id, platform);
						if (!thread) {
							skipped++;
							continue;
						}

						enqueueAndSignal(ctx, thread.id, sourceThreadId, message.trim());
						delivered++;
					}

					if (delivered === 0) {
						return `Error: No ${platform} threads found for any users`;
					}

					const skipNote = skipped > 0 ? ` (${skipped} skipped — no thread)` : "";
					return `Notification enqueued for ${delivered} user(s) on ${platform}${skipNote}.`;
				}

				// Single user
				if (!user) {
					return "Error: User is required when all is not specified";
				}
				const userRow = resolveUser(ctx.db, user);
				if (!userRow) {
					return `Error: User not found: ${user}`;
				}

				const thread = findDmThread(ctx.db, userRow.id, platform);
				if (!thread) {
					return `Error: No ${platform} thread found for user ${user}`;
				}

				if (sourceThreadId && thread.id === sourceThreadId) {
					return "Error: Cannot notify the current thread. Run notify from a background task to deliver to this thread.";
				}

				enqueueAndSignal(ctx, thread.id, sourceThreadId, message.trim());
				return `Notification enqueued for ${user} on ${platform}.`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
