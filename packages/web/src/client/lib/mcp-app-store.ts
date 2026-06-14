// Commit 4 of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:design-and-progress.
//
// The browser dispatches the agent's MCP tool calls (the boundless pattern). For
// UI-bearing tools (ext-apps `_meta.ui.resourceUri`) the call ALSO renders an
// app iframe. This module owns the bridge between the tool-call dispatch path
// and the Svelte render layer:
//
//  - `McpAppInstance` captures everything a panel needs to mount one app render:
//    the resolved UI resource URI, the tool input, the in-flight CallToolResult
//    promise, and the SDK client to read the resource / drive the AppBridge.
//  - The pure reducer helpers (`upsertInstance` / `removeInstance` /
//    `instancesForThread`) keep the keyed store logic testable without a DOM.
//  - `createToolCallHandler` wraps an `McpAppHost` into a `client.onToolCall`
//    handler: it kicks off the underlying MCP call once, registers a render
//    instance for UI-bearing tools (sharing the same in-flight promise the app
//    consumes), and returns the flattened textual result the agent loop needs.
import type { ToolCallRequest, ToolCallResult } from "@bound/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { writable } from "svelte/store";
import type { UiResourceClient } from "./mcp-app-bridge";
import { type McpAppHost, callToolResultToContent } from "./mcp-app-host";

/** A single UI-bearing tool call rendered as an MCP App in the conversation. */
export interface McpAppInstance {
	/** Bound tool call id — the stable key for the instance and its panel. */
	callId: string;
	threadId: string;
	/** Namespaced bound tool name that triggered the render. */
	boundName: string;
	/** Originating MCP server name (for labelling). */
	serverName: string;
	/** `ui://…` resource URI to read the app HTML from. */
	uiResourceUri: string;
	/** Arguments the agent invoked the tool with, forwarded to the app. */
	input: Record<string, unknown>;
	/** Client used to read the UI resource and drive the AppBridge. */
	client: UiResourceClient;
	/** In-flight tool-call result; the app receives it via `sendToolResult`. */
	resultPromise: Promise<CallToolResult>;
	/** Epoch ms the instance was registered (render ordering / debugging). */
	createdAt: number;
}

/** Immutable map of instances keyed by `callId`. */
export type McpAppInstanceMap = Readonly<Record<string, McpAppInstance>>;

/** Add or replace an instance, returning a new map (does not mutate input). */
export function upsertInstance(
	map: McpAppInstanceMap,
	instance: McpAppInstance,
): McpAppInstanceMap {
	return { ...map, [instance.callId]: instance };
}

/** Remove an instance by call id, returning a new map (does not mutate input). */
export function removeInstance(map: McpAppInstanceMap, callId: string): McpAppInstanceMap {
	if (!(callId in map)) return map;
	const next = { ...map };
	delete next[callId];
	return next;
}

/** Instances belonging to one thread, oldest-registered first. */
export function instancesForThread(map: McpAppInstanceMap, threadId: string): McpAppInstance[] {
	return Object.values(map)
		.filter((inst) => inst.threadId === threadId)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** Svelte store of live MCP App instances, keyed by tool call id. */
function createAppInstanceStore() {
	const { subscribe, update, set } = writable<McpAppInstanceMap>({});
	return {
		subscribe,
		register(instance: McpAppInstance): void {
			update((map) => upsertInstance(map, instance));
		},
		remove(callId: string): void {
			update((map) => removeInstance(map, callId));
		},
		clear(): void {
			set({});
		},
	};
}

/** Shared singleton store; the panel layer subscribes, the handler registers. */
export const mcpAppInstances = createAppInstanceStore();

/**
 * The connected MCP App host (set once bootstrap finishes), exposed so the
 * per-thread view can resolve persisted tool names back to UI-bearing
 * registrations and rebuild app panels on reload. `null` until init completes
 * (or if no servers are configured).
 */
export const mcpAppHost = writable<McpAppHost | null>(null);

/** Sink the handler reports UI-bearing renders to (the store, or a test fake). */
export interface UiInstanceSink {
	register(instance: McpAppInstance): void;
}

/** A persisted message as seen on reload, minimally typed for reconstruction. */
export interface PersistedToolMessage {
	role: string;
	/** Raw `messages.content` — a JSON string from the API, or already-parsed. */
	content: string | unknown[];
	/** On a tool_result row this holds the originating tool_use id (the linkage). */
	tool_name?: string | null;
	exit_code?: number | null;
	/**
	 * Raw `messages.metadata` — the opaque JSON property bag (invariant #19). On a
	 * tool_result row for a UI-bearing MCP call it carries `mcp_app`, the binding
	 * stamped at dispatch. A JSON string from the API, or already-parsed.
	 */
	metadata?: string | Record<string, unknown> | null;
}

/** The MCP App binding stamped onto a tool_result's `metadata.mcp_app` at dispatch. */
interface McpAppBinding {
	server: string;
	tool: string;
	uiResourceUri: string;
}

/**
 * Read the `mcp_app` binding off a persisted message's `metadata`, tolerating the
 * raw JSON-string form (the API/WS shape) and an already-parsed object. Returns
 * undefined for absent, malformed, or incomplete bindings — the renderer simply
 * doesn't mount a panel for those.
 */
function readMcpAppBinding(metadata: PersistedToolMessage["metadata"]): McpAppBinding | undefined {
	if (metadata == null) return undefined;
	let bag: unknown = metadata;
	if (typeof metadata === "string") {
		try {
			bag = JSON.parse(metadata);
		} catch {
			return undefined;
		}
	}
	if (typeof bag !== "object" || bag === null) return undefined;
	const mcpApp = (bag as Record<string, unknown>).mcp_app;
	if (typeof mcpApp !== "object" || mcpApp === null) return undefined;
	const { server, tool, uiResourceUri } = mcpApp as Record<string, unknown>;
	if (typeof server !== "string" || typeof tool !== "string" || typeof uiResourceUri !== "string") {
		return undefined;
	}
	return { server, tool, uiResourceUri };
}

/** Parse a message's content into a content-block array, tolerating both forms. */
function parseContentBlocks(content: string | unknown[]): Array<Record<string, unknown>> {
	let blocks: unknown = content;
	if (typeof content === "string") {
		try {
			blocks = JSON.parse(content);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(blocks)) return [];
	return blocks.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
}

/**
 * Rebuild the UI-bearing app instances for a thread from its persisted message
 * history, so a page reload re-renders the panels that were live before. The
 * agent's tool-call rows survive a refresh; the in-memory instance store does
 * not — this bridges that gap. New results streaming in live re-run this scan,
 * so it doubles as the live render trigger.
 *
 * The render signal is the `mcp_app` binding stamped onto the tool_result row at
 * dispatch (`messages.metadata.mcp_app`): the authoritative {server, tool,
 * uiResourceUri} for the call. Keying off that — rather than reverse-parsing the
 * tool_use call shape — means a UI-bearing call mounts identically no matter
 * which surface dispatched it (web omnibus `<server>`/subcommand, boundless bash,
 * a direct bound name). The binding lives on the RESULT, so a call only mounts
 * once its result has landed; the call's own input (for the args the app renders
 * from) is paired back from the matching tool_use block.
 *
 * Fidelity note: the app re-renders at full fidelity from the tool INPUT (which
 * is what drives the render — e.g. the whole diagram for an Excalidraw call).
 * The tool RESULT is reconstructed as the persisted text ack, not the original
 * rich `CallToolResult` — that raw object is not persisted, and capturing it
 * would require a storage change outside the web-router scope. The result is a
 * completion ack, so text fidelity is sufficient for the render.
 */
export function reconstructInstancesFromMessages(
	messages: PersistedToolMessage[],
	host: Pick<McpAppHost, "resolveByServerTool">,
	threadId: string,
	now: () => number = Date.now,
): McpAppInstance[] {
	// First pass: index by tool_use id — the result content + the MCP App binding
	// (both off tool_result rows), and the call's input (off the tool_use block).
	const resultsByToolUseId = new Map<string, { content: unknown[]; isError: boolean }>();
	const bindingByToolUseId = new Map<string, McpAppBinding>();
	const inputByCallId = new Map<string, Record<string, unknown>>();
	for (const msg of messages) {
		if (msg.role === "tool_result" && msg.tool_name) {
			resultsByToolUseId.set(msg.tool_name, {
				content: parseContentBlocks(msg.content),
				isError: msg.exit_code != null && msg.exit_code !== 0,
			});
			const binding = readMcpAppBinding(msg.metadata);
			if (binding) bindingByToolUseId.set(msg.tool_name, binding);
		}
		for (const block of parseContentBlocks(msg.content)) {
			if (block.type !== "tool_use") continue;
			const callId = typeof block.id === "string" ? block.id : undefined;
			if (!callId) continue;
			inputByCallId.set(callId, (block.input as Record<string, unknown>) ?? {});
		}
	}

	// Second pass: each bound tool_result becomes a reconstructed instance. The
	// binding names the (server, tool); the connected host resolves it to the live
	// client that reads the `ui://` resource. A binding whose server the browser
	// never connected to has no client, so it can't render and is skipped.
	const instances: McpAppInstance[] = [];
	for (const [callId, binding] of bindingByToolUseId) {
		const reg = host.resolveByServerTool(binding.server, binding.tool);
		if (!reg) continue;
		// Strip the omnibus `subcommand` wrapper when present; the app wants only
		// the tool's own arguments.
		const { subcommand: _omit, ...toolArgs } = inputByCallId.get(callId) ?? {};
		const persisted = resultsByToolUseId.get(callId);
		instances.push({
			callId,
			threadId,
			boundName: reg.boundName,
			serverName: binding.server,
			uiResourceUri: binding.uiResourceUri,
			input: toolArgs,
			client: reg.client as unknown as UiResourceClient,
			resultPromise: Promise.resolve({
				content: persisted?.content ?? [],
				isError: persisted?.isError ?? false,
			} as CallToolResult),
			createdAt: now(),
		});
	}
	return instances;
}

/**
 * Build a `client.onToolCall` handler from an `McpAppHost`. Behaviourally
 * identical to `host.dispatch` for non-UI tools, but for UI-bearing tools it
 * starts the MCP call once and shares the in-flight promise with both the agent
 * (flattened text result) and the render instance (raw CallToolResult for the
 * app). Unknown tools and call failures resolve to `is_error` results so the
 * agent loop resumes rather than hanging.
 */
export function createToolCallHandler(
	host: McpAppHost,
	sink: UiInstanceSink = mcpAppInstances,
	now: () => number = Date.now,
): (call: ToolCallRequest) => Promise<ToolCallResult> {
	return async (call: ToolCallRequest): Promise<ToolCallResult> => {
		const reg = host.resolve(call.tool_name);
		if (!reg) {
			return {
				call_id: call.call_id,
				thread_id: call.thread_id,
				content: `Unknown MCP tool: ${call.tool_name}`,
				is_error: true,
			};
		}

		const input = call.arguments ?? {};
		// Single in-flight call shared by the agent result and the app render.
		const resultPromise = reg.client.callTool({ name: reg.originalName, arguments: input });

		if (reg.uiResourceUri) {
			sink.register({
				callId: call.call_id,
				threadId: call.thread_id,
				boundName: reg.boundName,
				serverName: reg.serverName,
				uiResourceUri: reg.uiResourceUri,
				input,
				// The McpClientLike used for dispatch is the same SDK Client used to
				// read the UI resource; it structurally satisfies UiResourceClient.
				client: reg.client as unknown as UiResourceClient,
				resultPromise,
				createdAt: now(),
			});
		}

		try {
			const result = await resultPromise;
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
	};
}
