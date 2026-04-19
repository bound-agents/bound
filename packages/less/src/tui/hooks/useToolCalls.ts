import type { BoundClient, ToolCallRequest, ToolCallResult, ToolCancelEvent } from "@bound/client";
import { useEffect, useState } from "react";
import { bashToolWithStreaming } from "../../tools/bash";
import type { ToolHandler } from "../../tools/types";

export interface InFlightTool {
	controller: AbortController;
	toolName: string;
	startTime: number;
	stdout?: string;
}

export interface UseToolCallsResult {
	inFlightTools: Map<string, InFlightTool>;
	abortAll: () => void;
}

/**
 * Manages in-flight tool execution.
 * - State: `Map<string, { controller: AbortController, toolName: string, startTime: number, stdout?: string }>`
 * - Uses client.onToolCall to register handler which receives tool:call events
 * - Listens to `client.on("tool:cancel", ...)`: aborts matching controller
 * - For boundless_bash: uses bashToolWithStreaming with onStdoutChunk callback
 */
export function useToolCalls(
	client: BoundClient | null,
	handlers: Map<string, ToolHandler>,
	hostname: string,
	cwd: string,
): UseToolCallsResult {
	const [inFlightTools, setInFlightTools] = useState<Map<string, InFlightTool>>(new Map());

	useEffect(() => {
		if (!client) return;

		// Register the tool call handler with the client
		const toolCallHandler = async (call: ToolCallRequest): Promise<ToolCallResult> => {
			const { call_id: callId, tool_name: toolName, arguments: args } = call;

			// Create AbortController for this tool call
			const controller = new AbortController();
			const startTime = Date.now();

			// Track in-flight tool
			setInFlightTools((prev) => {
				const updated = new Map(prev);
				updated.set(callId, {
					controller,
					toolName,
					startTime,
					stdout: undefined,
				});
				return updated;
			});

			try {
				// Get handler for this tool
				const handler = handlers.get(toolName);
				if (!handler) {
					// Tool not found
					return {
						call_id: callId,
						thread_id: call.thread_id,
						content: [
							{
								type: "text",
								text: `Error: Tool '${toolName}' not found`,
							},
						],
						is_error: true,
					};
				}

				// For bash tool, use streaming with stdout callback
				const result =
					toolName === "boundless_bash"
						? await bashToolWithStreaming(
								args,
								controller.signal,
								cwd,
								{
									onStdoutChunk: (chunk: string) => {
										setInFlightTools((prev) => {
											const updated = new Map(prev);
											const tool = updated.get(callId);
											if (tool) {
												tool.stdout = (tool.stdout || "") + chunk;
												updated.set(callId, tool);
											}
											return updated;
										});
									},
								},
								hostname,
							)
						: await handler(args, controller.signal, cwd);

				// Return result to client
				return {
					call_id: callId,
					thread_id: call.thread_id,
					content: result.content,
					is_error: result.isError,
				};
			} catch (error) {
				// Return error result
				const errorMsg = error instanceof Error ? error.message : String(error);
				return {
					call_id: callId,
					thread_id: call.thread_id,
					content: [
						{
							type: "text",
							text: `Error: ${errorMsg}`,
						},
					],
					is_error: true,
				};
			} finally {
				// Remove from in-flight
				setInFlightTools((prev) => {
					const updated = new Map(prev);
					updated.delete(callId);
					return updated;
				});
			}
		};

		const handleToolCancel = (event: ToolCancelEvent) => {
			const { callId } = event;
			setInFlightTools((prev) => {
				const tool = prev.get(callId);
				if (tool) {
					// Abort the tool
					tool.controller.abort();
					// Remove from in-flight
					const updated = new Map(prev);
					updated.delete(callId);
					return updated;
				}
				return prev;
			});
		};

		// Register event listeners
		client.onToolCall(toolCallHandler);
		client.on("tool:cancel", handleToolCancel);

		return () => {
			client.off("tool:cancel", handleToolCancel);
		};
	}, [client, handlers, hostname, cwd]);

	const abortAll = () => {
		setInFlightTools((prev) => {
			for (const tool of prev.values()) {
				tool.controller.abort();
			}
			return new Map();
		});
	};

	return {
		inFlightTools,
		abortAll,
	};
}
