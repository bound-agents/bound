import { stripToolDuration } from "@bound/shared/strings";
// Render-side state for MCP App panels. The browser renders MCP App UIs; it
// does not execute agent tool calls. Instances are rebuilt from persisted
// tool_result rows carrying the `metadata.mcp_app` binding stamped at dispatch,
// and kept in a keyed store the panel layer subscribes to.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { writable } from "svelte/store";
import type { UiResourceClient } from "./mcp-app-bridge";
import type { McpAppHost } from "./mcp-app-host";
import { parseContentBlocks } from "./message-grouping";
import { readMetadataBag } from "./metadata-bag";

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

/** Instances belonging to one thread, oldest-registered first. */
export function instancesForThread(map: McpAppInstanceMap, threadId: string): McpAppInstance[] {
	return Object.values(map)
		.filter((inst) => inst.threadId === threadId)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** Svelte store of live MCP App instances, keyed by tool call id. */
function createAppInstanceStore() {
	const { subscribe, update } = writable<McpAppInstanceMap>({});
	return {
		subscribe,
		register(instance: McpAppInstance): void {
			update((map) => upsertInstance(map, instance));
		},
	};
}

/** Shared singleton store; the panel layer subscribes, reload reconstruction registers. */
export const mcpAppInstances = createAppInstanceStore();

/**
 * The connected MCP App host (set once bootstrap finishes), exposed so the
 * per-thread view can resolve persisted tool names back to UI-bearing
 * registrations and rebuild app panels on reload. `null` until init completes
 * (or if no servers are configured).
 */
export const mcpAppHost = writable<McpAppHost | null>(null);

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
	input?: Record<string, unknown>;
}

/**
 * Read the `mcp_app` binding off a persisted message's `metadata`, tolerating the
 * raw JSON-string form (the API/WS shape) and an already-parsed object. Returns
 * undefined for absent, malformed, or incomplete bindings — the renderer simply
 * doesn't mount a panel for those.
 */
function readMcpAppBinding(metadata: PersistedToolMessage["metadata"]): McpAppBinding | undefined {
	const mcpApp = readMetadataBag(metadata)?.mcp_app;
	if (typeof mcpApp !== "object" || mcpApp === null) return undefined;
	const { server, tool, uiResourceUri, input } = mcpApp as Record<string, unknown>;
	if (typeof server !== "string" || typeof tool !== "string" || typeof uiResourceUri !== "string") {
		return undefined;
	}
	return {
		server,
		tool,
		uiResourceUri,
		input:
			typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined,
	};
}

/**
 * Build the content-block array for a reconstructed tool RESULT. A sandbox /
 * MCP-bridge dispatch persists the result as the flattened text the agent loop
 * consumes (agent-loop.ts pushes a string), not a content-block array — github
 * `get_me` lands as the bare JSON object `{"login":...}`. An app that reads
 * `result.content[].text` (github's get-me app JSON.parses it) sees no content
 * and renders "No user data" unless that text is handed back inside a text
 * block. So: a real content-block array passes through; flattened text (a JSON
 * value that isn't an array, or non-JSON) is wrapped as a single text block.
 */
function resultContentBlocks(content: string | unknown[]): Array<Record<string, unknown>> {
	if (typeof content !== "string") {
		// Already a parsed value (a content-block array, normally).
		return Array.isArray(content)
			? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
			: [];
	}
	// Persisted tool-result text. The dispatch layer appends a `[duration: N.NNNs]`
	// footer (appendToolDuration) to every result before persistence — strip it so
	// an app that JSON.parses its content (github get-me reads `content[].text`)
	// sees the original payload rather than payload-plus-footer, which would throw.
	const text = stripToolDuration(content);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Not JSON at all — a plain-text result. Wrap it (or drop an empty one).
		return text.length > 0 ? [{ type: "text", text }] : [];
	}
	if (Array.isArray(parsed)) {
		return parsed.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
	}
	// Parsed to a non-array JSON value (the flattened structured result) — hand the
	// text back inside a text block so a content-reading app can parse it.
	return text.length > 0 ? [{ type: "text", text }] : [];
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
				content: resultContentBlocks(msg.content),
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
		// Prefer the native MCP arguments captured at dispatch. The persisted
		// tool_use may describe an outer bash wrapper (`{ command: ... }`), which is
		// not meaningful to the app. Older direct calls fall back to their tool_use.
		const persistedInput = inputByCallId.get(callId) ?? {};
		const bindingInput = binding.input;
		// Before native arguments were persisted, bash-wrapped calls could only be
		// reconstructed as `{command: ...}`. Feeding that wrapper to the app produces
		// an empty canvas, so leave the ordinary tool card visible instead.
		if (!bindingInput && "command" in persistedInput) continue;
		const { subcommand: _omit, ...toolArgs } = bindingInput ?? persistedInput;
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
