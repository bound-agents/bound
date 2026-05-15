import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, softDelete } from "@bound/core";
import type { ToolDefinition } from "@bound/llm";
import { z } from "zod";
import { connectorHandleId } from "./connector-handle-id.js";
import {
	createConnectorHandle,
	getConnectorHandle,
	getConnectorHandlesByServer,
} from "./connector-handle.js";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

/**
 * Return type for the connector tool factory.
 * Structurally compatible with RegisteredTool from @bound/agent.
 */
export interface ConnectorToolDef {
	kind: "builtin";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<string>;
}

/**
 * Context for the connector tool.
 */
export interface ConnectorToolContext {
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
 * Zod schema for connector tool inputs — action-dispatcher pattern.
 */
const connectorSchema = z.object({
	action: z
		.enum(["list", "channels", "attach", "detach"])
		.describe(
			"Connector operation: list servers, list event channels, attach to event, detach from event",
		),
	server_name: z
		.string()
		.optional()
		.describe("Platform server name (required for channels, attach)"),
	event_name: z.string().optional().describe("Event type to subscribe to (required for attach)"),
	event_args: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Subscription filter parameters (required for attach, e.g. { channel_id: '123' })"),
	handle_id: z.string().optional().describe("Connector handle ID to detach (required for detach)"),
});

/**
 * Handler for the "list" action — cluster-wide server discovery.
 */
async function handleList(ctx: ConnectorToolContext): Promise<string> {
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
}

/**
 * Handler for the "channels" action — list available events from a server.
 */
async function handleChannels(
	ctx: ConnectorToolContext,
	input: z.infer<typeof connectorSchema>,
): Promise<string> {
	if (!input.server_name) {
		return "Error: server_name is required for the 'channels' action";
	}

	const serverName = input.server_name;

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
		// MCP SDK client.request() requires a real Zod v4 schema (with `_zod`)
		// as the second arg; the SDK's safeParse falls back to v3 when `_zod`
		// is missing and crashes if the value isn't a Zod schema at all.
		// Use a permissive passthrough schema to accept any response shape.
		// See e028985 for the relay-processor sibling fix.
		eventsResult = (await client.request(
			{ method: "events/list", params: {} },
			z.object({}).passthrough(),
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
}

/**
 * Handler for the "attach" action — bind to a platform event stream.
 */
async function handleAttach(
	ctx: ConnectorToolContext,
	input: z.infer<typeof connectorSchema>,
): Promise<string> {
	if (!input.server_name) {
		return "Error: server_name is required for the 'attach' action";
	}
	if (!input.event_name) {
		return "Error: event_name is required for the 'attach' action";
	}
	if (!input.event_args) {
		return "Error: event_args is required for the 'attach' action";
	}

	const serverName = input.server_name;
	const eventName = input.event_name;
	const eventArgs = input.event_args;

	// Check if handle already exists (idempotency check)
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
}

/**
 * Handler for the "detach" action — unbind from a platform event stream.
 */
async function handleDetach(
	ctx: ConnectorToolContext,
	input: z.infer<typeof connectorSchema>,
): Promise<string> {
	if (!input.handle_id) {
		return "Error: handle_id is required for the 'detach' action";
	}

	const handleId = input.handle_id;

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
}

/**
 * Creates a unified connector tool with action-dispatcher pattern.
 * Replaces the 4 individual dispatcher tool factories.
 *
 * Actions:
 * - list: Show all connected platform servers (local + cluster-wide)
 * - channels: Show available events from a server, annotated with bound status
 * - attach: Create connector handle, event task, and thread; activate subscription
 * - detach: Soft-delete handle and associated task
 */
export function createConnectorTool(ctx: ConnectorToolContext): ConnectorToolDef {
	const { $schema: _, ...parameters } = z.toJSONSchema(connectorSchema) as Record<string, unknown>;

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "connector",
				description:
					"Manage platform event subscriptions. Actions: list (show servers), channels (show events), attach (subscribe), detach (unsubscribe).",
				parameters,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const result = connectorSchema.safeParse(raw);
			if (!result.success) {
				const issues = result.error.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; ");
				return `Error: invalid parameters for "connector": ${issues}`;
			}
			const input = result.data;

			switch (input.action) {
				case "list":
					return handleList(ctx);
				case "channels":
					return handleChannels(ctx, input);
				case "attach":
					return handleAttach(ctx, input);
				case "detach":
					return handleDetach(ctx, input);
				default: {
					const _exhaustive: never = input.action;
					return "Error: unknown action";
				}
			}
		},
	};
}
