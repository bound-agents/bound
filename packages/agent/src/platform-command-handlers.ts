import type { Database } from "bun:sqlite";
import { findTaskById, findThreadById, listConnectorHandlesByServer, updateRow } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import type { PlatformCommandInvocation, PlatformCommandSpec } from "@bound/platforms";
import type { Logger } from "@bound/shared";
import { resolveModel } from "./model-resolution.js";

/**
 * Bound-side handlers for platform-native commands (see
 * `@bound/platforms/platform-commands.ts` for the contract and the
 * dependency-direction rationale). These know models/tasks/threads and
 * nothing about Discord; the connector knows Discord and nothing about
 * models. The wiring layer (packages/cli) marries the two.
 */
export interface PlatformCommandHandlerDeps {
	db: Database;
	siteId: string;
	modelRouter: ModelRouter;
	logger: Logger;
	/** Injectable for tests; defaults to the production resolveModel. */
	resolveModelFn?: typeof resolveModel;
}

/**
 * `/model` — show or set the model hint for the thread bound to the channel
 * the command was issued in.
 *
 * Two properties matter here:
 *
 * 1. DETERMINISTIC. This handler runs on the platform leader with zero
 *    inference — a user reaches for /model precisely when the current model
 *    cannot complete an agent turn, so a command that needed the agent loop
 *    to execute could never fix a broken model.
 *
 * 2. WRITES BOTH HINT COLUMNS. Two resolution paths read two different
 *    columns: scheduler wakeups resolve via `tasks.model_hint`, hub intake
 *    dispatch resolves via `threads.model_hint` (resolveThreadModel). A hint
 *    that lands in only one column works on one path and silently not the
 *    other — the original "/model on Discord doesn't stick" symptom. Setting
 *    both makes the hint hold regardless of which path wakes the thread.
 */
export function createModelCommandSpec(deps: PlatformCommandHandlerDeps): PlatformCommandSpec {
	const resolve = deps.resolveModelFn ?? resolveModel;

	return {
		name: "model",
		description: "Show or set the model for this channel's agent thread",
		options: [
			{
				name: "model",
				description: "Model ID or tier ('reset' to clear; omit to show current)",
				required: false,
			},
		],
		restricted: true,
		handler: async (invocation: PlatformCommandInvocation): Promise<string> => {
			const { db, siteId } = deps;

			// Channel → handle: the connector_handles row whose event_args
			// carry this channel_id. Handles are few (one per subscription),
			// so a scan over the server's handles is fine.
			const handles = listConnectorHandlesByServer(db, invocation.server_name);
			const handle = handles.find((h) => {
				try {
					const args = JSON.parse(h.event_args) as Record<string, unknown>;
					return args.channel_id === invocation.channel_id;
				} catch {
					return false;
				}
			});
			if (!handle || !handle.task_id) {
				throw new Error(
					`No event subscription is bound to this channel (${invocation.channel_id}). Attach one first, then /model applies to its thread.`,
				);
			}

			const task = findTaskById(db, handle.task_id);
			if (!task || !task.thread_id) {
				throw new Error(`No task/thread found for subscription ${handle.id}`);
			}
			const threadId = task.thread_id;

			const requested = invocation.options.model;

			// Show mode: no option supplied.
			if (requested === undefined || requested === null || requested === "") {
				const thread = findThreadById(db, threadId);
				const hint = task.model_hint ?? thread?.model_hint ?? null;
				if (hint) {
					return `Current model hint: ${hint}`;
				}
				return `No hint set — using cluster default: ${deps.modelRouter.getDefaultId()}`;
			}

			const requestedStr = String(requested);

			// Reset mode: clear both columns.
			if (requestedStr === "reset") {
				updateRow(db, "tasks", task.id, { model_hint: null }, siteId);
				updateRow(db, "threads", threadId, { model_hint: null }, siteId);
				deps.logger.info("[platform-commands] /model cleared hint", {
					taskId: task.id,
					threadId,
				});
				return `Model hint cleared — using cluster default: ${deps.modelRouter.getDefaultId()}`;
			}

			// Set mode: validate before writing. resolveModel checks the
			// cluster-wide pool (local backends + remote hosts), so a hint for
			// a model that exists only on another host is accepted — the
			// relay handles dispatch.
			const resolution = resolve(requestedStr, deps.modelRouter, db, siteId);
			if (resolution.kind === "error") {
				throw new Error(resolution.error);
			}

			updateRow(db, "tasks", task.id, { model_hint: requestedStr }, siteId);
			updateRow(db, "threads", threadId, { model_hint: requestedStr }, siteId);
			deps.logger.info("[platform-commands] /model set hint", {
				taskId: task.id,
				threadId,
				model: requestedStr,
			});
			return `Model hint set to: ${requestedStr}`;
		},
	};
}
