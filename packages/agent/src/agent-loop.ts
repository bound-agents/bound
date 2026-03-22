import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import { insertRow } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { assembleContext } from "./context-assembly";
import type { AgentLoopConfig, AgentLoopResult, AgentLoopState } from "./types";

// Bash type - see comment in phase_04.md: just-bash may not be available on npm
// This interface allows for a stubbed implementation
interface BashLike {
	exec?: (cmd: string, options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class AgentLoop {
	private state: AgentLoopState = "IDLE";
	private messagesCreated = 0;
	private toolCallsMade = 0;
	private filesChanged = 0;
	private aborted = false;

	constructor(
		private ctx: AppContext,
		private sandbox: BashLike,
		private llmBackend: LLMBackend,
		private config: AgentLoopConfig,
	) {
		if (config.abortSignal) {
			config.abortSignal.addEventListener("abort", () => {
				this.aborted = true;
			});
		}
	}

	async run(): Promise<AgentLoopResult> {
		try {
			this.state = "HYDRATE_FS";

			// For Phase 4, we skip FS hydration as it requires sandbox
			// In production, this would call hydrateWorkspace()

			this.state = "ASSEMBLE_CONTEXT";
			const context = assembleContext({
				db: this.ctx.db,
				threadId: this.config.threadId,
				taskId: this.config.taskId,
				userId: this.config.userId,
				currentModel: this.config.modelId,
			});

			this.state = "LLM_CALL";
			const chunks: StreamChunk[] = [];
			// const silenceTimeout = 120000; // 120 seconds - silence timeout to be implemented in Phase 5
			// TODO: Implement 120s silence timeout tracking

			try {
				for await (const chunk of this.llmBackend.chat({
					model: this.config.modelId || "default",
					messages: context,
				})) {
					if (this.aborted) {
						break;
					}

					chunks.push(chunk);
				}
			} catch (error) {
				this.state = "ERROR_PERSIST";
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.ctx.logger.error("LLM call failed", { error: errorMsg });

				// Persist error as alert message
				const alertId = randomUUID();
				insertRow(this.ctx.db, "messages", {
					id: alertId,
					thread_id: this.config.threadId,
					role: "alert",
					content: `Error: ${errorMsg}`,
					model_id: null,
					tool_name: null,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					host_origin: this.ctx.hostName,
				}, this.ctx.siteId);

				return {
					messagesCreated: this.messagesCreated,
					toolCallsMade: this.toolCallsMade,
					filesChanged: this.filesChanged,
					error: errorMsg,
				};
			}

			this.state = "PARSE_RESPONSE";
			const parsedChunks = this.parseResponseChunks(chunks);

			if (parsedChunks.hasToolUse) {
				this.state = "TOOL_EXECUTE";
				// For Phase 4, tool execution is simulated
				// In production, this would execute via sandbox.exec()
			}

			this.state = "RESPONSE_PERSIST";
			// Persist assistant message
			const assistantMessageId = randomUUID();
			const assistantContent = parsedChunks.textContent || "";

			if (assistantContent) {
				insertRow(this.ctx.db, "messages", {
					id: assistantMessageId,
					thread_id: this.config.threadId,
					role: "assistant",
					content: assistantContent,
					model_id: this.config.modelId || null,
					tool_name: null,
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					host_origin: this.ctx.hostName,
				}, this.ctx.siteId);
				this.messagesCreated++;
			}

			this.state = "FS_PERSIST";
			// For Phase 4, we skip actual FS persistence
			// In production, this would call persistWorkspaceChanges()

			this.state = "QUEUE_CHECK";
			// Check for new messages in the queue
			// For now, just return results

			this.state = "IDLE";

			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
			};
		} catch (error) {
			this.state = "ERROR_PERSIST";
			const errorMsg = error instanceof Error ? error.message : String(error);
			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
				error: errorMsg,
			};
		}
	}

	private parseResponseChunks(chunks: StreamChunk[]): {
		textContent: string;
		hasToolUse: boolean;
	} {
		let textContent = "";
		let hasToolUse = false;

		for (const chunk of chunks) {
			if (chunk.type === "text") {
				textContent += chunk.content;
			} else if (chunk.type === "tool_use_start") {
				hasToolUse = true;
				this.toolCallsMade++;
			}
		}

		return { textContent, hasToolUse };
	}

	cancel(): void {
		this.aborted = true;
		this.ctx.logger.info("Agent loop cancelled");
	}
}
