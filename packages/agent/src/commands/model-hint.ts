import type { CapabilityRequirements, ModelRouter } from "@bound/llm";
import { formatError } from "@bound/shared";

import { updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { resolveModel } from "../model-resolution";

export const modelHint: CommandDefinition = {
	name: "model-hint",
	args: [
		{ name: "model", required: false, description: "Model ID or tier to switch to" },
		{ name: "reset", required: false, description: "Clear the hint" },
		{ name: "for-turns", required: false, description: "Turn count limit for the hint" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			if (!ctx.taskId) {
				return {
					stdout: "",
					stderr: "Error: taskId not available in context\n",
					exitCode: 1,
				};
			}

			// Check if a hint already exists for this task
			const existing = ctx.db
				.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
				.get(ctx.taskId) as { id: string } | undefined;

			if (args.reset === "true") {
				// Clear the hint by setting model_hint to null
				if (existing) {
					updateRow(ctx.db, "tasks", ctx.taskId, { model_hint: null }, ctx.siteId);
				}

				return {
					stdout: "Model hint cleared\n",
					stderr: "",
					exitCode: 0,
				};
			}

			if (!args.model) {
				return {
					stdout: "",
					stderr: "Error: must specify --model or --reset\n",
					exitCode: 1,
				};
			}

			if (!existing) {
				return {
					stdout: "",
					stderr: `Error: task not found: ${ctx.taskId}\n`,
					exitCode: 1,
				};
			}

			// Validate model against cluster-wide pool if modelRouter is available
			if (args.model && ctx.modelRouter) {
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
					args.model,
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
								modelId: args.model,
								unmetCapabilities: resolution.unmetCapabilities,
							},
						);
						// Fall through to accept the hint anyway
					} else {
						return {
							stdout: "",
							stderr: `Error: ${resolution.error}\n`,
							exitCode: 1,
						};
					}
				}
			}

			// Build the update payload
			const updates: Record<string, unknown> = { model_hint: args.model };

			// Store the model hint for the agent loop to read
			updateRow(ctx.db, "tasks", ctx.taskId, updates, ctx.siteId);

			return {
				stdout: `Model hint set to: ${args.model}\n`,
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = formatError(error);
			return {
				stdout: "",
				stderr: `Error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
