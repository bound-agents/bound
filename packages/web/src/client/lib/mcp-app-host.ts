// Commit 2 of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:design-and-progress.
//
// The browser is both an MCP Apps *host* and a bound tool-provider *client*
// (the boundless pattern). This module is the host half's connection manager:
// it connects to the MCP App servers handed to the browser by
// GET /api/mcp-apps, lists their tools, maps each to a bound ToolDefinition so
// the agent can call them, and dispatches an inbound bound tool call to the
// owning MCP server. UI-bearing tools (ext-apps `_meta.ui.resourceUri`) are
// flagged here; the iframe/AppBridge rendering glue lands in a later commit.
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from "@bound/client";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** Bedrock caps tool names at 64 chars; keep generated names within that. */
const TOOL_NAME_MAX = 64;
const TOOL_NAME_PREFIX = "mcp";

const IMPLEMENTATION = { name: "bound web MCP Apps host", version: "1.0.0" };

/**
 * Minimal MCP client surface the host manager depends on. The real
 * `@modelcontextprotocol/sdk` `Client` satisfies this; tests inject a fake.
 */
export interface McpClientLike {
	callTool(params: {
		name: string;
		arguments?: Record<string, unknown>;
	}): Promise<CallToolResult>;
	getServerVersion?(): { name?: string; version?: string } | undefined;
}

/** A bound tool name resolved back to its originating MCP server + tool. */
export interface RegisteredTool {
	serverName: string;
	originalName: string;
	tool: Tool;
	client: McpClientLike;
	boundName: string;
	uiResourceUri?: string;
}

/** Replace wire-illegal characters so a name part is safe in a tool id. */
export function sanitizeNamePart(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Namespaced bound tool name for an MCP (server, tool) pair. */
export function mcpToolName(serverName: string, toolName: string): string {
	return `${TOOL_NAME_PREFIX}__${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`;
}

/** Map an MCP tool descriptor to a bound function ToolDefinition. */
export function mcpToolToDefinition(boundName: string, tool: Tool): ToolDefinition {
	return {
		type: "function",
		function: {
			name: boundName,
			description: tool.description ?? "",
			parameters: tool.inputSchema ?? { type: "object", properties: {} },
		},
	};
}

/**
 * Flatten an MCP `CallToolResult` into the textual content the bound agent
 * consumes. Rich content (the full result) is forwarded separately to the
 * rendered app via the AppBridge in a later commit; the agent only needs a
 * readable summary of what the tool produced.
 */
export function callToolResultToContent(result: CallToolResult): string {
	const parts: string[] = [];
	for (const block of result.content ?? []) {
		switch (block.type) {
			case "text":
				parts.push(block.text);
				break;
			case "resource_link":
				parts.push(String(block.uri));
				break;
			case "resource": {
				const res = block.resource as { uri?: string; mimeType?: string };
				parts.push(`[embedded resource: ${res.uri ?? res.mimeType ?? "resource"}]`);
				break;
			}
			default:
				parts.push(`[${block.type}]`);
				break;
		}
	}
	if (parts.length === 0 && result.structuredContent) {
		parts.push(JSON.stringify(result.structuredContent));
	}
	return parts.join("\n");
}

/**
 * Holds the browser's connected MCP App servers and bridges them to the bound
 * tool-provider protocol: `getToolDefinitions()` feeds `client.configureTools`,
 * `dispatch()` is wired to `client.onToolCall`.
 */
export class McpAppHost {
	private readonly byBoundName = new Map<string, RegisteredTool>();

	/**
	 * Register a connected server's tools, returning the bound ToolDefinitions
	 * added. Bound names are namespaced per server and de-duplicated so two
	 * servers exposing the same tool name don't collide.
	 */
	registerServer(serverName: string, client: McpClientLike, tools: Tool[]): ToolDefinition[] {
		const defs: ToolDefinition[] = [];
		for (const tool of tools) {
			const boundName = this.uniqueBoundName(serverName, tool.name);
			const uiResourceUri = getToolUiResourceUri(tool) ?? undefined;
			this.byBoundName.set(boundName, {
				serverName,
				originalName: tool.name,
				tool,
				client,
				boundName,
				uiResourceUri,
			});
			defs.push(mcpToolToDefinition(boundName, tool));
		}
		return defs;
	}

	/** All registered tools as bound ToolDefinitions, in registration order. */
	getToolDefinitions(): ToolDefinition[] {
		return Array.from(this.byBoundName.values(), (reg) =>
			mcpToolToDefinition(reg.boundName, reg.tool),
		);
	}

	/** Resolve a bound tool name back to its server + original tool. */
	resolve(boundName: string): RegisteredTool | undefined {
		return this.byBoundName.get(boundName);
	}

	/** True if the bound tool carries an MCP App UI (ext-apps resource binding). */
	isUiBearing(boundName: string): boolean {
		return this.byBoundName.get(boundName)?.uiResourceUri != null;
	}

	/** The `ui://` resource URI bound to a tool, if any. */
	uiResourceUri(boundName: string): string | undefined {
		return this.byBoundName.get(boundName)?.uiResourceUri;
	}

	/**
	 * Dispatch a bound tool call to the owning MCP server and map the result
	 * back. Errors (unknown tool, transport/tool failure) are returned as
	 * `is_error` results rather than thrown, so the bound agent loop can resume.
	 */
	async dispatch(call: ToolCallRequest): Promise<ToolCallResult> {
		const reg = this.byBoundName.get(call.tool_name);
		if (!reg) {
			return {
				call_id: call.call_id,
				thread_id: call.thread_id,
				content: `Unknown MCP tool: ${call.tool_name}`,
				is_error: true,
			};
		}
		try {
			const result = await reg.client.callTool({
				name: reg.originalName,
				arguments: call.arguments ?? {},
			});
			return {
				call_id: call.call_id,
				thread_id: call.thread_id,
				content: callToolResultToContent(result),
				is_error: result.isError === true,
			};
		} catch (err) {
			return {
				call_id: call.call_id,
				thread_id: call.thread_id,
				content: err instanceof Error ? err.message : String(err),
				is_error: true,
			};
		}
	}

	private uniqueBoundName(serverName: string, toolName: string): string {
		const base = mcpToolName(serverName, toolName).slice(0, TOOL_NAME_MAX);
		if (!this.byBoundName.has(base)) return base;
		for (let i = 2; ; i++) {
			const suffix = `_${i}`;
			const candidate = base.slice(0, TOOL_NAME_MAX - suffix.length) + suffix;
			if (!this.byBoundName.has(candidate)) return candidate;
		}
	}
}

/**
 * Connect to an MCP server over Streamable HTTP, falling back to SSE for older
 * servers (the basic-host reference order). Returns the connected SDK client.
 * Optional `headers` are attached to every transport request (e.g. an auth
 * token from `mcp_apps.json`); note these are client-visible by construction.
 */
export async function connectToMcpServer(
	serverUrl: URL,
	headers?: Record<string, string>,
): Promise<Client> {
	const requestInit = headers ? { headers } : undefined;
	try {
		const client = new Client(IMPLEMENTATION);
		await client.connect(new StreamableHTTPClientTransport(serverUrl, { requestInit }));
		return client;
	} catch (streamableError) {
		try {
			const client = new Client(IMPLEMENTATION);
			await client.connect(new SSEClientTransport(serverUrl, { requestInit }));
			return client;
		} catch (sseError) {
			throw new Error(
				`Could not connect to MCP server ${serverUrl.href}. ` +
					`Streamable HTTP error: ${streamableError instanceof Error ? streamableError.message : String(streamableError)}; ` +
					`SSE error: ${sseError instanceof Error ? sseError.message : String(sseError)}`,
			);
		}
	}
}
