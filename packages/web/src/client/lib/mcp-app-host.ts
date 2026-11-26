// Connection manager for the browser's MCP App servers. The browser renders
// MCP App UIs; it does not execute agent tool calls. This module connects to
// the servers GET /api/mcp-apps hands out, records each tool and its
// `_meta.ui.resourceUri` binding, and resolves a stamped (server, tool) pair
// back to its connected client. The iframe/AppBridge glue lives in
// mcp-app-bridge.ts.
import type { ToolDefinition } from "@bound/client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, ClientCapabilities, Tool } from "@modelcontextprotocol/client";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
/** Bedrock caps tool names at 64 chars; keep generated names within that. */
const TOOL_NAME_MAX = 64;
const TOOL_NAME_PREFIX = "mcp";

export const IMPLEMENTATION = { name: "bound web MCP Apps host", version: "1.0.0" };

/**
 * The MCP Apps UI capability extension id. Kept as a browser-safe literal so
 * importing it doesn't drag the ext-apps *server* entry into the web bundle;
 * `mcp-app-host.test.ts` pins it against the package's own `EXTENSION_ID`
 * (from `@modelcontextprotocol/ext-apps/server`) so a rename breaks loudly.
 */
export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * Client capabilities the browser MCP-Apps host advertises at `initialize`.
 * Declaring the `io.modelcontextprotocol/ui` extension is how a UI-capable
 * client negotiates MCP Apps support: a server that gates its tool→UI resource
 * bindings on this extension (e.g. github-mcp-server's `clientSupportsUI`, which
 * reads `capabilities.extensions["io.modelcontextprotocol/ui"]`) only emits them
 * when the connecting client declares it here.
 *
 * Only the *browser* advertises this — it's the surface that can host an iframe.
 * The agent-side MCP bridge (`packages/agent`) deliberately does NOT, because it
 * can't render UI; advertising there would only coax a server into emitting a
 * `ui://` resource the agent would flatten to placeholder text.
 *
 * `extensions` is not in the SDK 1.28 `ClientCapabilities` type, but the Client
 * sends `_capabilities` verbatim into the initialize request (no schema strip),
 * so the field reaches the wire as-is; the cast at the call site is for typing.
 */
export const MCP_APPS_HOST_CAPABILITIES = {
	extensions: {
		[MCP_UI_EXTENSION_ID]: {},
	},
};

/**
 * Minimal MCP client surface the host manager depends on. The real
 * `@modelcontextprotocol/client` `Client` satisfies this; tests inject a fake.
 */
export interface McpClientLike {
	callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
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

/** The browser's connected MCP App servers, indexed by namespaced bound tool name. */
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

	/** Resolve a bound tool name back to its server + original tool. */
	resolve(boundName: string): RegisteredTool | undefined {
		return this.byBoundName.get(boundName);
	}

	/**
	 * Resolve a registration by its originating (server, tool) pair — the shape
	 * carried by the `mcp_app` binding stamped onto a tool_result row at dispatch
	 * (messages.metadata.mcp_app). The renderer reads that authoritative stamp
	 * rather than reverse-parsing the call shape, so a UI-bearing call mounts the
	 * same way no matter which surface dispatched it (web omnibus, boundless bash,
	 * a direct bound name). Returns undefined when the browser hasn't connected to
	 * that server — there's then no client to read the `ui://` resource with.
	 */
	resolveByServerTool(serverName: string, toolName: string): RegisteredTool | undefined {
		for (const reg of this.byBoundName.values()) {
			if (reg.serverName === serverName && reg.originalName === toolName) return reg;
		}
		return undefined;
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

/** A transport the SDK `Client` can connect over. Injected in tests. */
export interface McpClientTransport {
	start(): Promise<void>;
	send(message: unknown, options?: unknown): Promise<void>;
	close(): Promise<void>;
}

/**
 * Factory for the transport `connectToMcpServer` connects over. The default
 * opens a Streamable HTTP transport to `serverUrl` with `headers` attached to
 * every request; tests inject an in-memory transport to exercise the connect
 * path without a network listener. `requestInit` is undefined when no headers
 * are supplied so the SDK keeps its own defaults.
 */
export type McpTransportFactory = (
	serverUrl: URL,
	headers?: Record<string, string>,
) => McpClientTransport;

const defaultTransportFactory: McpTransportFactory = (serverUrl, headers) => {
	const requestInit = headers ? { headers } : undefined;
	return new StreamableHTTPClientTransport(serverUrl, {
		requestInit,
	}) as unknown as McpClientTransport;
};

/**
 * Connect to an MCP server over Streamable HTTP. Returns the connected SDK
 * client. Optional `headers` are attached to every transport request. In the
 * web UI's renderer path these are injected server-side by the same-origin
 * proxy, so the browser never sees upstream auth tokens. `makeTransport` is
 * injectable for tests; production uses the default Streamable HTTP factory.
 */
export async function connectToMcpServer(
	serverUrl: URL,
	headers?: Record<string, string>,
	makeTransport: McpTransportFactory = defaultTransportFactory,
): Promise<Client> {
	const clientOptions = { capabilities: MCP_APPS_HOST_CAPABILITIES as ClientCapabilities };
	const client = new Client(IMPLEMENTATION, clientOptions);
	await client.connect(makeTransport(serverUrl, headers) as Parameters<Client["connect"]>[0]);
	return client;
}
