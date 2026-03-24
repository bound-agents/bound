import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import { insertRow, recordTurn } from "@bound/core";
import { formatError } from "@bound/shared";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { assembleContext } from "./context-assembly";
import { extractSummaryAndMemories } from "./summary-extraction";
import type { AgentLoopConfig, AgentLoopResult, AgentLoopState } from "./types";

interface BashLike {
	exec?: (
		cmd: string,
		options?: Record<string, unknown>,
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	persistFs?: () => Promise<{ changes: number }>;
}

/** Parsed tool call accumulated from stream chunks */
interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	argsJson: string;
}

/** Full parse result from an LLM response stream */
interface ParsedResponse {
	textContent: string;
	toolCalls: ParsedToolCall[];
	usage: { inputTokens: number; outputTokens: number };
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

		this.ctx.eventBus.on("agent:cancel", ({ thread_id }) => {
			if (thread_id === this.config.threadId) {
				this.aborted = true;
			}
		});
	}

	async run(): Promise<AgentLoopResult> {
		try {
			this.state = "HYDRATE_FS";
			// FS hydration is handled by the caller (start.ts) before constructing
			// the AgentLoop. The sandbox's ClusterFs is already populated.

			this.state = "ASSEMBLE_CONTEXT";
			// Get context window from LLM backend capabilities
			const capabilities = this.llmBackend.capabilities();
			const contextWindow = capabilities.max_context || 8000;

			const contextMessages = assembleContext({
				db: this.ctx.db,
				threadId: this.config.threadId,
				taskId: this.config.taskId,
				userId: this.config.userId,
				currentModel: this.config.modelId,
				contextWindow: contextWindow,
				hostName: this.ctx.hostName,
				siteId: this.ctx.siteId,
			});

			// Agentic loop: keep calling the LLM until it produces a text-only
			// response with no tool calls, or until we are aborted.
			const llmMessages = [...contextMessages];
			let continueLoop = true;

			while (continueLoop) {
				if (this.aborted) break;

				this.state = "LLM_CALL";
				const chunks: StreamChunk[] = [];
				const SILENCE_TIMEOUT_MS = 120_000;

				try {
					const chatStream = this.llmBackend.chat({
						model: this.config.modelId || "default",
						messages: llmMessages,
					});

					for await (const chunk of this.withSilenceTimeout(chatStream, SILENCE_TIMEOUT_MS)) {
						if (this.aborted) break;
						chunks.push(chunk);
					}
				} catch (error) {
					this.state = "ERROR_PERSIST";
					const errorMsg = formatError(error);
					this.ctx.logger.error("LLM call failed", { error: errorMsg });

					const alertId = randomUUID();
					insertRow(
						this.ctx.db,
						"messages",
						{
							id: alertId,
							thread_id: this.config.threadId,
							role: "alert",
							content: `Error: ${errorMsg}`,
							model_id: null,
							tool_name: null,
							created_at: new Date().toISOString(),
							modified_at: new Date().toISOString(),
							host_origin: this.ctx.hostName,
						},
						this.ctx.siteId,
					);

					return {
						messagesCreated: this.messagesCreated,
						toolCallsMade: this.toolCallsMade,
						filesChanged: this.filesChanged,
						error: errorMsg,
					};
				}

				this.state = "PARSE_RESPONSE";
				const parsed = this.parseResponseChunks(chunks);

				// Record turn metrics for budget tracking
				try {
					recordTurn(this.ctx.db, {
						thread_id: this.config.threadId,
						task_id: this.config.taskId || null,
						dag_root_id: null,
						model_id: this.config.modelId || "unknown",
						tokens_in: parsed.usage.inputTokens,
						tokens_out: parsed.usage.outputTokens,
						cost_usd: 0, // Cost calculation requires model pricing config
						created_at: new Date().toISOString(),
					});
				} catch {
					// Non-fatal — don't break the loop over metrics
				}

				if (parsed.toolCalls.length > 0) {
					// --- TOOL_EXECUTE ---
					this.state = "TOOL_EXECUTE";
					const toolResults: Array<{ toolCall: ParsedToolCall; content: string }> = [];

					for (const toolCall of parsed.toolCalls) {
						this.toolCallsMade++;
						let resultContent: string;

						try {
							resultContent = await this.executeToolCall(toolCall);
						} catch (error) {
							const errorMsg = formatError(error);
							resultContent = `Error: ${errorMsg}`;
						}

						toolResults.push({ toolCall, content: resultContent });
					}

					// --- TOOL_PERSIST ---
					// Spec R-E3: persist tool_call and tool_result messages immediately
					// after each execution, before the next LLM call.
					this.state = "TOOL_PERSIST";
					const now = new Date().toISOString();

					// Persist the assistant's tool_call message (contains all tool calls from this turn)
					const toolCallContent = JSON.stringify(
						parsed.toolCalls.map((tc) => ({
							type: "tool_use",
							id: tc.id,
							name: tc.name,
							input: tc.input,
						})),
					);

					const toolCallMsgId = randomUUID();
					insertRow(
						this.ctx.db,
						"messages",
						{
							id: toolCallMsgId,
							thread_id: this.config.threadId,
							role: "tool_call",
							content: toolCallContent,
							model_id: this.config.modelId || null,
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: this.ctx.hostName,
						},
						this.ctx.siteId,
					);
					this.messagesCreated++;

					// Add tool_call to in-memory context for next LLM call
					llmMessages.push({
						role: "tool_call",
						content: toolCallContent,
					});

					// Persist each tool_result and add to context
					for (const { toolCall, content } of toolResults) {
						const resultNow = new Date().toISOString();
						const toolResultMsgId = randomUUID();
						insertRow(
							this.ctx.db,
							"messages",
							{
								id: toolResultMsgId,
								thread_id: this.config.threadId,
								role: "tool_result",
								content,
								model_id: this.config.modelId || null,
								tool_name: toolCall.id,
								created_at: resultNow,
								modified_at: resultNow,
								host_origin: this.ctx.hostName,
							},
							this.ctx.siteId,
						);
						this.messagesCreated++;

						llmMessages.push({
							role: "tool_result",
							content,
							tool_use_id: toolCall.id,
						});
					}

					// Also persist any text content the assistant emitted alongside tool calls
					if (parsed.textContent) {
						const textMsgId = randomUUID();
						insertRow(
							this.ctx.db,
							"messages",
							{
								id: textMsgId,
								thread_id: this.config.threadId,
								role: "assistant",
								content: parsed.textContent,
								model_id: this.config.modelId || null,
								tool_name: null,
								created_at: now,
								modified_at: now,
								host_origin: this.ctx.hostName,
							},
							this.ctx.siteId,
						);
						this.messagesCreated++;
					}

					// Continue the loop to feed tool results back to the LLM
					continue;
				}

				// No tool calls — persist the final assistant text response and exit
				this.state = "RESPONSE_PERSIST";
				const assistantContent = parsed.textContent || "";

				if (assistantContent) {
					const assistantMessageId = randomUUID();
					insertRow(
						this.ctx.db,
						"messages",
						{
							id: assistantMessageId,
							thread_id: this.config.threadId,
							role: "assistant",
							content: assistantContent,
							model_id: this.config.modelId || null,
							tool_name: null,
							created_at: new Date().toISOString(),
							modified_at: new Date().toISOString(),
							host_origin: this.ctx.hostName,
						},
						this.ctx.siteId,
					);
					this.messagesCreated++;
				}

				continueLoop = false;
			}

			this.state = "FS_PERSIST";
			// Persist filesystem changes if the sandbox supports it.
			// The sandbox wraps a ClusterFs whose state is persisted via
			// persistWorkspaceChanges() from @bound/sandbox.
			if (this.sandbox.persistFs) {
				const persistResult = await this.sandbox.persistFs();
				if (persistResult && typeof persistResult.changes === "number") {
					this.filesChanged += persistResult.changes;
				}
			}

			this.state = "QUEUE_CHECK";
			// Check for new messages in the queue. If a new user message arrived
			// while we were processing, the caller (event handler in start.ts)
			// will re-trigger the loop.

			this.state = "IDLE";

			// Fire-and-forget: extract summaries and memories from the thread
			extractSummaryAndMemories(
				this.ctx.db,
				this.config.threadId,
				this.llmBackend,
				this.ctx.siteId,
			).catch(() => {});

			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
			};
		} catch (error) {
			this.state = "ERROR_PERSIST";
			const errorMsg = formatError(error);
			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
				error: errorMsg,
			};
		}
	}

	/**
	 * Execute a single tool call via the sandbox.
	 *
	 * For "bash" tool calls the command string is passed directly to sandbox.exec().
	 * For built-in or MCP tools the input is serialized as a command string that
	 * the sandbox's registered custom commands can dispatch.
	 */
	private async executeToolCall(toolCall: ParsedToolCall): Promise<string> {
		if (!this.sandbox.exec) {
			return "Error: sandbox execution not available";
		}

		let commandString: string;

		if (toolCall.name === "bash" && typeof toolCall.input.command === "string") {
			// Bash tool: pass the command directly
			commandString = toolCall.input.command;
		} else {
			// Built-in or MCP command: construct "commandName arg1 arg2 ..."
			// The sandbox's custom command framework parses positional arguments
			// from argv, so we pass each input value as a positional arg.
			const args = Object.values(toolCall.input).map((v) =>
				typeof v === "string" ? v : JSON.stringify(v),
			);
			commandString = [toolCall.name, ...args].join(" ");
		}

		const result = await this.sandbox.exec(commandString);

		// Build result content from stdout/stderr
		const parts: string[] = [];
		if (result.stdout) {
			parts.push(result.stdout);
		}
		if (result.stderr) {
			parts.push(result.stderr);
		}
		if (parts.length === 0) {
			parts.push(
				result.exitCode === 0 ? "Command completed successfully" : `Exit code: ${result.exitCode}`,
			);
		}

		return parts.join("\n");
	}

	/**
	 * Parse streamed LLM chunks into text content and fully-assembled tool calls.
	 * Accumulates partial_json fragments for each tool_use into complete input objects.
	 */
	private parseResponseChunks(chunks: StreamChunk[]): ParsedResponse {
		let textContent = "";
		const toolCalls: ParsedToolCall[] = [];
		const argsAccumulator = new Map<string, string>();
		const nameMap = new Map<string, string>();
		let inputTokens = 0;
		let outputTokens = 0;

		for (const chunk of chunks) {
			if (chunk.type === "text") {
				textContent += chunk.content;
			} else if (chunk.type === "tool_use_start") {
				argsAccumulator.set(chunk.id, "");
				nameMap.set(chunk.id, chunk.name);
			} else if (chunk.type === "tool_use_args") {
				const existing = argsAccumulator.get(chunk.id) ?? "";
				argsAccumulator.set(chunk.id, existing + chunk.partial_json);
			} else if (chunk.type === "tool_use_end") {
				const fullArgsJson = argsAccumulator.get(chunk.id) ?? "{}";
				const name = nameMap.get(chunk.id) ?? chunk.id;
				let input: Record<string, unknown> = {};
				try {
					input = JSON.parse(fullArgsJson);
				} catch {
					// leave as empty object
				}
				toolCalls.push({
					id: chunk.id,
					name,
					input,
					argsJson: fullArgsJson,
				});
			} else if (chunk.type === "done") {
				inputTokens = chunk.usage.input_tokens;
				outputTokens = chunk.usage.output_tokens;
			}
		}

		return { textContent, toolCalls, usage: { inputTokens, outputTokens } };
	}

	cancel(): void {
		this.aborted = true;
		this.ctx.logger.info("Agent loop cancelled");
	}

	/**
	 * Wraps an async iterable so that if no item is yielded within `timeoutMs`,
	 * the iteration rejects with a silence-timeout error.
	 */
	private async *withSilenceTimeout<T>(
		source: AsyncIterable<T>,
		timeoutMs: number,
	): AsyncGenerator<T> {
		const iterator = source[Symbol.asyncIterator]();

		while (true) {
			const nextChunkPromise = iterator.next();
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(new Error(`LLM silence timeout: no chunk received for ${timeoutMs}ms`));
				}, timeoutMs);
			});

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([nextChunkPromise, timeoutPromise]);
			} catch (err) {
				if (typeof iterator.return === "function") {
					await iterator.return(undefined).catch(() => {});
				}
				throw err;
			}

			if (result.done) {
				return;
			}

			yield result.value;
		}
	}
}
