/**
 * Attach flow: connects to an existing thread with ordered initialization.
 * Implements AC7.1 (ordered attach sequence) and AC7.2 (pending tool calls).
 */

import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import { buildSystemPromptAddition, buildToolSet } from "../tools/registry";
import type { ResolvedShell } from "../tools/shell";
import { collectToolCallPairing } from "./tool-call-pairing";

export interface AttachParams {
	client: BoundClient;
	threadId: string;
	mcpManager: McpServerManager;
	mcpConfigs: McpServerConfig[];
	cwd: string;
	hostname: string;
	logger: AppLogger;
	confirmFn?: (toolName: string) => Promise<boolean>;
	injectContextFiles?: string[];
	/** Resolved shell for the bash-family tool (name + invocation). */
	shell: ResolvedShell;
}

export interface AttachResult {
	messages: Message[];
	pendingToolCallIds: string[];
	mcpFailures: Array<{ serverName: string; error: string }>;
}

/**
 * Perform attach flow in strict order (AC7.1):
 * 1. listMessages
 * 2. subscribe
 * 3. ensure MCP servers
 * 4. build tools
 * 5. configure
 *
 * Returns messages, pending tool call IDs, and MCP failures (non-fatal).
 */
export async function performAttach(params: AttachParams): Promise<AttachResult> {
	const { client, threadId, mcpManager, mcpConfigs, cwd, hostname, logger, confirmFn, shell } =
		params;

	// Step 1: List recent messages and scan for pending tool calls (AC7.2)
	// Cap to 200 messages to avoid OOM on large threads (17k+ messages)
	const MESSAGE_LIMIT = 200;
	logger.info("attach_flow_start", { threadId, step: "listMessages" });
	const messages = await client.listMessages(threadId, { limit: MESSAGE_LIMIT });

	// Scan for unpaired tool calls: a tool_use dispatched without a matching
	// tool_result. The id lives in the tool_use block of a tool_call row's
	// content (the row's tool_name column is empty); results carry it in their
	// tool_name column. See collectToolCallPairing for the full pairing rules.
	const { unpairedIds: pendingToolCallIds } = collectToolCallPairing(messages);

	logger.info("attach_flow_messages_scanned", {
		threadId,
		messageCount: messages.length,
		pendingToolCalls: pendingToolCallIds.length,
	});

	// Step 2: Subscribe to thread
	logger.info("attach_flow_subscribe", { threadId });
	client.subscribe(threadId);

	// Step 3: Ensure MCP servers
	logger.info("attach_flow_ensure_mcp", { serverCount: mcpConfigs.length });
	const mcpFailures: Array<{ serverName: string; error: string }> = [];

	await mcpManager.ensureAllEnabled(mcpConfigs);

	// Collect failures from server states
	const allStates = mcpManager.getServerStates();
	for (const config of mcpConfigs) {
		const state = allStates.get(config.name);
		if (state && state.status === "failed" && state.error) {
			mcpFailures.push({
				serverName: config.name,
				error: state.error,
			});
		}
	}

	logger.info("attach_flow_mcp_ensured", {
		threadId,
		failureCount: mcpFailures.length,
	});

	// Step 4: Build tool set
	logger.info("attach_flow_build_tools", { threadId });
	const mcpTools = mcpManager.getRunningTools();
	const toolSet = buildToolSet(cwd, hostname, mcpTools, confirmFn, client.getBaseUrl(), shell);

	logger.info("attach_flow_tools_built", {
		threadId,
		toolCount: toolSet.tools.length,
	});

	// Step 5: Configure tools on client
	logger.info("attach_flow_configure", { threadId });
	const mcpServerNames = Array.from(mcpTools.keys());
	const systemPromptAddition = await buildSystemPromptAddition(cwd, hostname, mcpServerNames, {
		injectContextFiles: params.injectContextFiles,
		shellToolName: shell.toolName,
	});

	client.configureTools(toolSet.tools, {
		systemPromptAddition,
	});

	logger.info("attach_flow_complete", {
		threadId,
		messageCount: messages.length,
		pendingToolCalls: pendingToolCallIds.length,
		mcpFailures: mcpFailures.length,
	});

	return {
		messages,
		pendingToolCallIds,
		mcpFailures,
	};
}
