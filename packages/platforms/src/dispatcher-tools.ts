import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { ToolDefinition } from "@bound/llm";
import { connectorHandleId } from "./connector-handle-id.js";
import {
	createConnectorHandle,
	getConnectorHandle,
	getConnectorHandlesByServer,
} from "./connector-handle.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

/**
 * Tool factory return type (subset of RegisteredTool needed for dispatcher tools).
 */
export interface DispatcherTool {
	kind: "builtin";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<string>;
}

export interface DispatcherToolContext {
	registry: PlatformMcpRegistry;
	db: Database;
	siteId: string;
}

/**
 * Creates the connector_list tool — returns names of all connected platform MCP servers.
 */
export function createConnectorListTool(ctx: DispatcherToolContext): DispatcherTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "connector_list",
				description: "List all connected platform MCP servers.",
				parameters: { type: "object", properties: {}, required: [] },
			},
		},
		execute: async () => {
			const servers = ctx.registry.getServerNames();
			return servers.length > 0
				? `Connected platform servers: ${servers.join(", ")}`
				: "No platform servers connected.";
		},
	};
}

/**
 * Creates the connector_channels tool — returns available event channels from a platform server,
 * annotated with binding status.
 *
 * Verifies: mcp-platform-connectors.AC4.2
 */
export function createConnectorChannelsTool(ctx: DispatcherToolContext): DispatcherTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "connector_channels",
				description:
					"List available event channels from a platform server, annotated with binding status.",
				parameters: {
					type: "object",
					properties: {
						server_name: { type: "string", description: "Name of the platform server to query" },
					},
					required: ["server_name"],
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			const serverName = input.server_name as string;
			const client = ctx.registry.getClient(serverName);
			if (!client) return `Error: server '${serverName}' not found`;

			// Call events/list on the MCP server
			const result = (await client.request({ method: "events/list", params: {} }, {} as never)) as {
				events: Array<{
					name: string;
					description?: string;
					inputSchema?: Record<string, unknown>;
				}>;
			};

			// Annotate with existing bindings
			const existingHandles = getConnectorHandlesByServer(ctx.db, serverName);
			const boundKeys = new Set(existingHandles.map((h) => `${h.event_name}:${h.event_args}`));

			const annotated = result.events.map((evt) => ({
				...evt,
				bound: boundKeys.has(`${evt.name}:${JSON.stringify(evt.inputSchema?.properties ?? {})}`),
			}));

			return JSON.stringify(annotated, null, 2);
		},
	};
}

/**
 * Creates the connector_attach tool — binds to a platform event stream, creating a connector handle,
 * event task, and thread with history retention.
 *
 * Verifies: mcp-platform-connectors.AC4.3, mcp-platform-connectors.AC4.4, mcp-platform-connectors.AC4.5
 */
export function createConnectorAttachTool(ctx: DispatcherToolContext): DispatcherTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "connector_attach",
				description:
					"Bind to a platform event stream, creating a connector handle, event task, and thread.",
				parameters: {
					type: "object",
					properties: {
						server_name: { type: "string", description: "Platform server name" },
						event_name: {
							type: "string",
							description: "Event type to subscribe to (e.g., 'message.received')",
						},
						event_args: {
							type: "object",
							description: "Subscription filter parameters (e.g., { channel_id: '123' })",
						},
					},
					required: ["server_name", "event_name", "event_args"],
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			const serverName = input.server_name as string;
			const eventName = input.event_name as string;
			const eventArgs = (input.event_args ?? {}) as Record<string, unknown>;

			// Check if handle already exists (AC4.4)
			const handleId = connectorHandleId(serverName, eventName, eventArgs);
			const existing = getConnectorHandle(ctx.db, handleId);
			if (existing) {
				return `Error: subscription already exists for (${serverName}, ${eventName}, ${JSON.stringify(eventArgs)}). Handle ID: ${handleId}`;
			}

			// 1. Create thread for the event task (history retention enabled)
			const threadId = randomUUID();
			const now = new Date().toISOString();
			insertRow(
				ctx.db,
				"threads",
				{
					id: threadId,
					user_id: "system",
					interface: "platform",
					host_origin: ctx.siteId,
					color: 0,
					title: `${serverName}:${eventName}`,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
					model_hint: null,
				},
				ctx.siteId,
			);

			// 2. Create event task linked to thread
			// Use per-handle trigger_spec so only THIS task wakes when THIS handle delivers
			const taskId = randomUUID();
			insertRow(
				ctx.db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `connector:event:${handleId}`,
					payload: JSON.stringify({ handle_id: handleId, server_name: serverName }),
					created_at: now,
					created_by: "system",
					thread_id: threadId,
					origin_thread_id: null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: null,
					last_run_at: null,
					run_count: 0,
					max_runs: null,
					requires: null,
					model_hint: null,
					no_history: 0, // retain conversation history
					inject_mode: "results",
					depends_on: null,
					require_success: 0,
					alert_threshold: 5,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			// 3. Create connector handle with task link
			createConnectorHandle(ctx.db, ctx.siteId, {
				serverName,
				eventName,
				eventArgs,
				deliveryMode: "push", // default to push mode
				taskId,
			});

			// 4. Activate the subscription (starts stream, replays from cursor) (AC4.5)
			const handle = getConnectorHandle(ctx.db, handleId);
			if (handle) {
				await ctx.registry.activateSubscription(handle);
			}

			return `Attached: created handle ${handleId}, task ${taskId}, thread ${threadId} for ${serverName}:${eventName}`;
		},
	};
}
