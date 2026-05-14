import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, softDelete } from "@bound/core";
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
	/** Proxies an MCP protocol request to a remote platform host via relay. */
	remotePlatformRequest?: (
		serverName: string,
		method: string,
		params: Record<string, unknown>,
	) => Promise<unknown>;
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
			// Cluster-wide discovery: local registry + synced hosts.platforms column
			const clusterServers = new Set<string>(ctx.registry.getServerNames());
			const rows = ctx.db
				.query("SELECT platforms FROM hosts WHERE deleted = 0 AND platforms IS NOT NULL")
				.all() as Array<{ platforms: string }>;
			for (const row of rows) {
				try {
					const platforms = JSON.parse(row.platforms) as string[];
					if (Array.isArray(platforms)) {
						for (const p of platforms) clusterServers.add(p);
					}
				} catch {
					// Skip corrupted platforms JSON
				}
			}
			const servers = Array.from(clusterServers);
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

			// Try local registry first, then relay to remote platform host
			let eventsResult: {
				events: Array<{
					name: string;
					description?: string;
					inputSchema?: Record<string, unknown>;
				}>;
			};

			const client = ctx.registry.getClient(serverName);
			if (client) {
				eventsResult = (await client.request(
					{ method: "events/list", params: {} },
					{} as never,
				)) as typeof eventsResult;
			} else if (ctx.remotePlatformRequest) {
				eventsResult = (await ctx.remotePlatformRequest(
					serverName,
					"events/list",
					{},
				)) as typeof eventsResult;
			} else {
				return `Error: server '${serverName}' not found locally and no remote relay configured`;
			}

			// Annotate with existing bindings using event_name-based matching
			// (connector_handles is synced, so this works on any host)
			const existingHandles = getConnectorHandlesByServer(ctx.db, serverName);
			const boundEventNames = new Set(existingHandles.map((h) => h.event_name));

			const annotated = eventsResult.events.map((evt) => ({
				...evt,
				bound: boundEventNames.has(evt.name),
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

			// 4. Activate the subscription on the platform leader.
			// If we ARE the leader (local client exists for this server), activate immediately.
			// Otherwise, the handle syncs to the leader via changelog and the
			// connector:handle_synced event triggers activation there.
			if (ctx.registry.getClient(serverName)) {
				const handle = getConnectorHandle(ctx.db, handleId);
				if (handle) {
					await ctx.registry.activateSubscription(handle);
				}
			}

			return `Attached: created handle ${handleId}, task ${taskId}, thread ${threadId} for ${serverName}:${eventName}`;
		},
	};
}

/**
 * Creates the connector_detach tool — unbinds from a platform event stream by soft-deleting
 * the connector handle and its associated task.
 */
export function createConnectorDetachTool(ctx: DispatcherToolContext): DispatcherTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "connector_detach",
				description:
					"Unbind from a platform event stream. Soft-deletes the connector handle and its event task.",
				parameters: {
					type: "object",
					properties: {
						handle_id: {
							type: "string",
							description:
								"The connector handle ID to detach (from connector_channels bound status)",
						},
					},
					required: ["handle_id"],
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			const handleId = input.handle_id as string;

			const handle = getConnectorHandle(ctx.db, handleId);
			if (!handle) {
				return `Error: handle '${handleId}' not found`;
			}

			// 1. Soft-delete the connector handle
			softDelete(ctx.db, "connector_handles", handleId, ctx.siteId);

			// 2. Soft-delete the associated event task (if any)
			if (handle.task_id) {
				softDelete(ctx.db, "tasks", handle.task_id, ctx.siteId);
			}

			// 3. Stop the local subscription if we're the platform leader
			if (ctx.registry.getClient(handle.server_name)) {
				// stopSubscription is private, but deactivating via shutdown+reconnect
				// would be heavy. Instead, the leader's next reconnectAll() will skip
				// this handle since it's now deleted. For immediate effect, we can
				// trigger a reconnect cycle.
				// For now, the subscription will naturally stop on next leader restart
				// or when the registry notices the handle is deleted during delivery.
			}

			return `Detached: handle ${handleId} (${handle.server_name}:${handle.event_name}) and task ${handle.task_id ?? "none"} soft-deleted`;
		},
	};
}
