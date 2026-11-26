/**
 * Attach flow: connects to an existing thread with ordered initialization.
 */

import type { Implementation } from "@agentclientprotocol/sdk";
import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import { withLessTelemetry } from "../telemetry";
import { buildSystemPromptAddition, buildToolSet } from "../tools/registry";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import type { ResolvedShell } from "../tools/shell";
import { collectToolCallPairing } from "./tool-call-pairing";

/** Recent-message window fetched on attach/replay; bounds memory on very long threads. */
export const HISTORY_WINDOW_MESSAGES = 200;

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
	/** Resolved filesystem sandbox policy for the bash-family tool. */
	sandbox: ResolvedSandboxConfig;
	/**
	 * Which surface is driving this session. Selects the opening line of the
	 * system-prompt addition: `"terminal"` (default) for the boundless TUI,
	 * `"acp"` when an ACP editor (Zed et al.) is the front-end.
	 */
	surface?: { type: "terminal" } | { type: "acp"; clientInfo: Implementation };
}

export interface AttachResult {
	messages: Message[];
	pendingToolCallIds: string[];
	mcpFailures: Array<{ serverName: string; error: string }>;
	/**
	 * The model that most recently produced a message in this thread, or null
	 * when no fetched message carries one (new/empty thread, or a thread whose
	 * model-bearing rows fell outside the fetch window). Callers use this to
	 * seed the session's selected model so an attach resumes the thread on
	 * the model it was last using rather than the client-config default.
	 */
	lastUsedModelId: string | null;
}

/**
 * Perform attach flow in strict order:
 * 1. listMessages
 * 2. subscribe
 * 3. ensure MCP servers
 * 4. build tools
 * 5. configure
 *
 * Returns messages, pending tool call IDs, and MCP failures (non-fatal).
 */
export async function performAttach(params: AttachParams): Promise<AttachResult> {
	return withLessTelemetry(
		"boundless.transport.attach",
		{ "transport.kind": params.surface?.type === "acp" ? "acp" : "terminal" },
		(span) => performAttachInner(params, span),
	);
}

async function performAttachInner(
	params: AttachParams,
	span: { addEvent(name: string, attributes?: Record<string, string | number>): void },
): Promise<AttachResult> {
	const {
		client,
		threadId,
		mcpManager,
		mcpConfigs,
		cwd,
		hostname,
		logger,
		confirmFn,
		shell,
		sandbox,
		injectContextFiles,
	} = params;

	logger.info("attach_flow_start", { threadId, step: "listMessages" });
	span.addEvent("boundless.attach.messages.fetch");
	let messages = await client.listMessages(threadId, { limit: HISTORY_WINDOW_MESSAGES });
	const turns =
		typeof client.getContextDebug === "function"
			? await client
					.getContextDebug(threadId)
					.catch(() => [] as Awaited<ReturnType<typeof client.getContextDebug>>)
			: [];
	if (turns.length > 0) {
		messages = messages.map((message) => {
			if (message.role !== "assistant") return message;
			const messageTime = Date.parse(message.created_at);
			const turn = [...turns]
				.reverse()
				.find((candidate) => Date.parse(candidate.created_at) <= messageTime);
			if (!turn || ((turn.tokens_cache_read ?? 0) === 0 && (turn.tokens_cache_write ?? 0) === 0)) {
				return message;
			}
			let metadata: Record<string, unknown> = {};
			try {
				const parsed = JSON.parse(message.metadata ?? "null");
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
			} catch {
				// Cache usage still renders when unrelated metadata is malformed.
			}
			return {
				...message,
				metadata: JSON.stringify({
					...metadata,
					cache_usage: {
						read: turn.tokens_cache_read ?? 0,
						write: turn.tokens_cache_write ?? 0,
					},
				}),
			};
		});
	}

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

	// Subscribe to thread
	logger.info("attach_flow_subscribe", { threadId });
	client.subscribe(threadId);
	span.addEvent("boundless.attach.transport.subscribed");

	// Ensure MCP servers
	logger.info("attach_flow_ensure_mcp", { serverCount: mcpConfigs.length });
	const mcpFailures: Array<{ serverName: string; error: string }> = [];

	await mcpManager.ensureAllEnabled(mcpConfigs);
	span.addEvent("boundless.attach.mcp.ready", { server_count: mcpConfigs.length });

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

	// Build tool set
	logger.info("attach_flow_build_tools", { threadId });
	const mcpTools = mcpManager.getRunningTools();
	const toolSet = buildToolSet({
		hostname,
		mcpTools,
		confirmFn,
		boundUrl: client.getBaseUrl(),
		shell,
		mcpManager,
		sandbox,
		logger,
		contextFiles: injectContextFiles,
	});

	logger.info("attach_flow_tools_built", {
		threadId,
		toolCount: toolSet.tools.length,
	});

	// Configure tools on client
	logger.info("attach_flow_configure", { threadId });
	const systemPromptAddition = await buildSystemPromptAddition(cwd, hostname, {
		injectContextFiles: params.injectContextFiles,
		surface: params.surface,
	});

	span.addEvent("boundless.attach.tools.configured", { tool_count: toolSet.tools.length });
	client.configureTools(toolSet.tools, {
		systemPromptAddition,
	});

	logger.info("attach_flow_complete", {
		threadId,
		messageCount: messages.length,
		pendingToolCalls: pendingToolCallIds.length,
		mcpFailures: mcpFailures.length,
	});

	// Most recent model to have produced a message in this thread. Messages
	// arrive in chronological order (newest-N window, ASC), so scan backwards
	// for the first non-null model_id.
	let lastUsedModelId: string | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].model_id) {
			lastUsedModelId = messages[i].model_id;
			break;
		}
	}

	return {
		messages,
		pendingToolCallIds,
		mcpFailures,
		lastUsedModelId,
	};
}
