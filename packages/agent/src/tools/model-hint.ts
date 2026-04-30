import { updateRow } from "@bound/core";
import type { CapabilityRequirements, ModelRouter } from "@bound/llm";
import { formatError } from "@bound/shared";
import { resolveModel } from "../model-resolution.js";
import type { RegisteredTool, ToolContext } from "../types.js";

export interface ModelHintInput {
	model?: string;
	reset?: boolean;
}

export function createModelHintTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "model_hint",
				description: "Set or clear the model hint for the current task",
				parameters: {
					type: "object",
					properties: {
						model: {
							type: "string",
							description: "Model ID or tier to switch to",
						},
						reset: {
							type: "boolean",
							description: "Clear the hint",
						},
					},
				},
			},
		},
		execute: async (input: Record<string, unknown>): Promise<string> => {
			try {
				const params = input as ModelHintInput;

				if (!ctx.taskId) {
					return "Error: taskId not available in context";
				}

				// Check if a hint already exists for this task
				const existing = ctx.db
					.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
					.get(ctx.taskId) as { id: string } | null;

				if (params.reset === true) {
					// Clear the hint by setting model_hint to null
					if (existing) {
						updateRow(ctx.db, "tasks", ctx.taskId, { model_hint: null }, ctx.siteId);
					}

					return "Model hint cleared";
				}

				if (!params.model) {
					return "Error: must specify model or reset";
				}

				if (!existing) {
					return `Error: task not found: ${ctx.taskId}`;
				}

				// Validate model against cluster-wide pool if modelRouter is available
				if (params.model && ctx.modelRouter) {
					// Derive requirements from recent thread history for model hint validation
					// Check last 5 messages for image blocks — if found, require vision capability
					let requirements: CapabilityRequirements | undefined;

					if (ctx.threadId) {
						const recentMessages = ctx.db
							.query(
								`SELECT content FROM messages
								 WHERE thread_id = ? AND deleted = 0
								 ORDER BY created_at DESC LIMIT 5`,
							)
							.all(ctx.threadId) as Array<{ content: string }>;

						const requiresVision = recentMessages.some((m) => {
							try {
								const blocks = JSON.parse(m.content);
								return (
									Array.isArray(blocks) && blocks.some((b: { type?: string }) => b.type === "image")
								);
							} catch {
								return false;
							}
						});

						requirements = requiresVision ? { vision: true } : undefined;
					}

					// Then pass requirements to resolveModel:
					const resolution = resolveModel(
						params.model,
						ctx.modelRouter as ModelRouter,
						ctx.db,
						ctx.siteId,
						requirements,
					);
					if (resolution.kind === "error") {
						if (resolution.reason === "capability-mismatch") {
							ctx.logger.warn(
								"[model-hint] Requested model lacks required capabilities for this thread's content, but hint was accepted",
								{
									modelId: params.model,
									unmetCapabilities: resolution.unmetCapabilities,
								},
							);
							// Fall through to accept the hint anyway
						} else {
							return `Error: ${resolution.error}`;
						}
					}
				}

				// Build the update payload
				const updates: Record<string, unknown> = { model_hint: params.model };

				// Store the model hint for the agent loop to read
				updateRow(ctx.db, "tasks", ctx.taskId, updates, ctx.siteId);

				return `Model hint set to: ${params.model}`;
			} catch (error) {
				const message = formatError(error);
				return `Error: ${message}`;
			}
		},
	};
}
