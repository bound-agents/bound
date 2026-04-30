import { insertRow } from "@bound/core";
import { randomUUID } from "@bound/shared";
import type { RegisteredTool, ToolContext } from "../types";

export function createPurgeTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "purge",
				description: "Create a purge record targeting message IDs",
				parameters: {
					type: "object",
					properties: {
						message_ids: {
							type: "string",
							description: "Comma-separated message IDs to purge",
						},
						last_n: {
							type: "integer",
							description: "Purge the last N messages from the thread",
						},
						thread_id: {
							type: "string",
							description: "Thread ID (defaults to current thread)",
						},
						summary: {
							type: "string",
							description: "Optional summary text for the purge",
						},
					},
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			try {
				const now = new Date().toISOString();
				let targetIds: string[] = [];

				const messageIds = input.message_ids as string | undefined;
				const lastN = input.last_n as number | undefined;
				const threadIdParam = input.thread_id as string | undefined;
				const summaryText = input.summary as string | undefined;

				if (messageIds) {
					// Parse comma-separated IDs
					targetIds = messageIds.split(",").map((id) => id.trim());
				} else if (lastN && (threadIdParam || ctx.threadId)) {
					// Get last N messages from thread
					const n = lastN;

					if (n <= 0) {
						return "Error: last_n must be a positive integer";
					}

					const threadId = threadIdParam || ctx.threadId || "";

					if (!threadId) {
						return "Error: thread_id is required when using last_n";
					}

					const messages = ctx.db
						.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?")
						.all(threadId, n) as Array<{ id: string }>;

					targetIds = messages.map((m) => m.id);
				} else {
					return "Error: must specify message_ids or (last_n and thread_id)";
				}

				// Tool-pair integrity: when a tool_call is targeted, auto-include its paired tool_result
				if (targetIds.length > 0) {
					const targetSet = new Set(targetIds);
					const placeholders = targetIds.map(() => "?").join(", ");
					const targeted = ctx.db
						.prepare(`SELECT id, role FROM messages WHERE id IN (${placeholders})`)
						.all(...targetIds) as Array<{ id: string; role: string }>;

					const additionalIds: string[] = [];
					for (const msg of targeted) {
						if (msg.role === "tool_call") {
							// Find the paired tool_result that immediately follows this tool_call
							const paired = ctx.db
								.prepare(
									`SELECT id FROM messages
									 WHERE thread_id = (SELECT thread_id FROM messages WHERE id = ?)
									   AND role = 'tool_result'
									   AND created_at > (SELECT created_at FROM messages WHERE id = ?)
									 ORDER BY created_at ASC LIMIT 1`,
								)
								.get(msg.id, msg.id) as { id: string } | null;

							if (paired && !targetSet.has(paired.id)) {
								additionalIds.push(paired.id);
								targetSet.add(paired.id);
							}
						}
					}

					if (additionalIds.length > 0) {
						targetIds = [...targetIds, ...additionalIds];
					}
				}

				// Create a purge message referencing the target IDs
				const purgeMessageId = randomUUID();
				const summary = summaryText ?? "Messages purged from conversation";
				const threadId = threadIdParam || ctx.threadId || "";

				// Store content as JSON with target_ids for context-assembly.ts to parse
				const content = JSON.stringify({
					target_ids: targetIds,
					summary,
				});

				insertRow(
					ctx.db,
					"messages",
					{
						id: purgeMessageId,
						thread_id: threadId,
						role: "purge",
						content,
						model_id: null,
						tool_name: null,
						created_at: now,
						modified_at: now,
						host_origin: ctx.siteId,
					},
					ctx.siteId,
				);

				return `Purge message created: ${purgeMessageId}\nTargeted ${targetIds.length} messages`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
