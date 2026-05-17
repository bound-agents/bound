import { createHash } from "node:crypto";
import { enqueueNotification } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

interface UserRow {
	id: string;
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
		.query("SELECT id FROM users WHERE id = ? AND deleted = 0")
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
 * Compute a stable dedup_key for a notify call. Slots one in-flight notify per
 * (source_thread, target_thread, content_hash) — byte-identical retries while
 * the target is busy collapse onto the same dispatch_queue entry instead of
 * piling redundant notifications.
 *
 * Different content from the same source produces a different key and queues
 * normally; introspect uses a separate type prefix so introspect+notify with
 * matching content do NOT dedup against each other (intentional — falling
 * back from introspect to notify is a legitimate dual-channel pattern).
 */
function computeNotifyDedupKey(
	sourceThread: string | undefined,
	targetThread: string,
	content: string,
): string {
	const hash = createHash("sha256")
		.update(`${sourceThread ?? "anon"}:${targetThread}:${content}`)
		.digest("hex")
		.slice(0, 32);
	return `notify:${hash}`;
}

/**
 * Enqueue a proactive notification and signal the server to run inference.
 * Returns true when a fresh row was inserted, false when the call collided
 * with an in-flight equivalent (caller should report dedup status).
 */
function enqueueAndSignal(
	ctx: ToolContext,
	threadId: string,
	sourceThreadId: string | undefined,
	message: string,
): { deduped: boolean } {
	const dedupKey = computeNotifyDedupKey(sourceThreadId, threadId, message);
	const result = enqueueNotification(
		ctx.db,
		threadId,
		{
			type: "proactive",
			source_thread: sourceThreadId ?? null,
			content: message,
		},
		{ dedupKey },
	);

	ctx.eventBus.emit("notify:enqueued", { thread_id: threadId });
	return { deduped: result.deduped };
}

const notifySchema = z.object({
	action: z.enum(["thread", "user"]).describe("Notification target mode"),
	thread_id: z.string().optional().describe("Target thread ID (for thread action)"),
	user: z.string().optional().describe("Target bound username (for user action)"),
	platform: z.string().optional().describe("Platform name, e.g. 'discord' (for user action)"),
	message: z.string().describe("Notification message content"),
});

type NotifyInput = z.infer<typeof notifySchema>;

function handleThread(input: NotifyInput, ctx: ToolContext): string {
	// Validate thread_id is present
	if (!input.thread_id) {
		return "Error: thread_id is required for thread action";
	}

	// Validate message non-empty
	if (!input.message.trim()) {
		return "Error: Missing notification message";
	}

	// Self-notify guard
	if (input.thread_id === ctx.threadId) {
		return "Error: Cannot notify the current thread. Run notify from a background task to deliver to this thread.";
	}

	// Thread existence query
	const thread = ctx.db
		.query("SELECT id FROM threads WHERE id = ? AND deleted = 0")
		.get(input.thread_id) as ThreadRow | null;

	if (!thread) {
		return `Error: Thread not found or is deleted: ${input.thread_id}`;
	}

	const { deduped } = enqueueAndSignal(ctx, thread.id, ctx.threadId, input.message.trim());
	if (deduped) {
		return `Notification deduped against in-flight equivalent for thread ${input.thread_id} (same source, target, and content already pending). Wait for it to be processed before retrying.`;
	}
	return `Notification enqueued for thread ${input.thread_id}.`;
}

function handleUser(input: NotifyInput, ctx: ToolContext): string {
	// Validate user and platform are present
	if (!input.user) {
		return "Error: user is required for user action";
	}
	if (!input.platform) {
		return "Error: platform is required for user action";
	}

	// Validate message non-empty
	if (!input.message.trim()) {
		return "Error: Missing notification message";
	}

	// Resolve user
	const userRow = resolveUser(ctx.db, input.user);
	if (!userRow) {
		return `Error: User not found: ${input.user}`;
	}

	// Find DM thread
	const thread = findDmThread(ctx.db, userRow.id, input.platform);
	if (!thread) {
		return `Error: No ${input.platform} thread found for user ${input.user}`;
	}

	// Self-notify guard on resolved thread
	if (thread.id === ctx.threadId) {
		return "Error: Cannot notify the current thread. Run notify from a background task to deliver to this thread.";
	}

	const { deduped } = enqueueAndSignal(ctx, thread.id, ctx.threadId, input.message.trim());
	if (deduped) {
		return `Notification deduped against in-flight equivalent for ${input.user} on ${input.platform} (same source, target, and content already pending). Wait for it to be processed before retrying.`;
	}
	return `Notification enqueued for ${input.user} on ${input.platform}.`;
}

export function createNotifyTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(notifySchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "notify",
				description: "Send a proactive notification to a thread or user on a configured platform",
				parameters: jsonSchema,
			},
		},
		// Non-idempotent: each call sends another message to the target.
		idempotent: false,
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(notifySchema, raw, "notify");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				switch (input.action) {
					case "thread":
						return handleThread(input, ctx);
					case "user":
						return handleUser(input, ctx);
					default: {
						const _exhaustive: never = input.action;
						return `Error: Unknown action "${_exhaustive}"`;
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
