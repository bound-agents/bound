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

/** Sink the handler reports UI-bearing renders to (the store, or a test fake). */
export interface UiInstanceSink {
	register(instance: McpAppInstance): void;
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
