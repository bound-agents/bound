import { randomUUID } from "node:crypto";
import { enqueueNotification } from "@bound/core";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

interface ThreadRow {
	id: string;
}

const introspectSchema = z.object({
	thread_id: z.string().describe("Target thread ID to introspect"),
	message: z.string().describe("Question or request to send to the target thread"),
	timeout: z.number().optional().describe("Timeout in milliseconds (default 300000)"),
});

const POLL_INTERVAL_MS = 2000; // 2 seconds, matches await_event
const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes, matches await_event

export function createIntrospectTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(introspectSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "introspect",
				description:
					"Introspect on a question by consulting another one of your threads. Use when you need deeper reflection or insight informed by a different context.",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(introspectSchema, raw, "introspect");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				// Validate thread_id is not empty
				if (!input.thread_id.trim()) {
					return "Error: thread_id is required and cannot be empty";
				}

				// Self-introspect guard
				if (input.thread_id === ctx.threadId) {
					return "Error: Cannot introspect self. Use introspect to consult a different thread.";
				}

				// Check thread exists and is not deleted
				const thread = ctx.db
					.query("SELECT id FROM threads WHERE id = ? AND deleted = 0")
					.get(input.thread_id) as ThreadRow | null;

				if (!thread) {
					return `Error: Thread not found or is deleted: ${input.thread_id}`;
				}

				// Generate correlation ID
				const correlationId = randomUUID();

				// Enqueue notification with introspect payload
				enqueueNotification(ctx.db, input.thread_id, {
					type: "introspect",
					correlation_id: correlationId,
					source_thread: ctx.threadId ?? null,
					content: input.message,
				});

				// Emit event for wakeup
				ctx.eventBus.emit("notify:enqueued", { thread_id: input.thread_id });

				// Setup polling
				const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS;
				const startTime = Date.now();
				// 5-second clock-skew buffer for cross-host scenarios
				const dispatchTime = new Date(Date.now() - 5000).toISOString();

				// Polling loop
				while (true) {
					// Check for response stamp in messages metadata
					const candidates = ctx.db
						.query(
							"SELECT id, content, metadata FROM messages WHERE thread_id = ? AND role = 'assistant' AND metadata IS NOT NULL AND created_at >= ? AND deleted = 0",
						)
						.all(input.thread_id, dispatchTime) as Array<{
						id: string;
						content: string;
						metadata: string;
					}>;

					for (const row of candidates) {
						try {
							const meta = JSON.parse(row.metadata) as Record<string, unknown>;
							// Handle both single string and array format (multiple introspect requests per turn)
							if (
								meta.introspect_response_id === correlationId ||
								(Array.isArray(meta.introspect_response_id) &&
									meta.introspect_response_id.includes(correlationId))
							) {
								return row.content; // BuiltInToolResult — the target's assistant message
							}
						} catch {
							// malformed metadata, skip
						}
					}

					// Check for target turn error/abort
					const latestTurn = ctx.db
						.query(
							"SELECT status FROM turns WHERE thread_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
						)
						.get(input.thread_id, dispatchTime) as { status: string | null } | null;

					if (latestTurn?.status === "error") {
						return "Error: Target thread encountered an error during processing.";
					}
					if (latestTurn?.status === "aborted") {
						return "Error: Target thread's turn was aborted.";
					}

					// Check timeout
					if (Date.now() - startTime >= timeout) {
						return `Error: Introspect request timed out after ${timeout}ms waiting for response from thread ${input.thread_id}.`;
					}

					// Sleep before next poll
					await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
