import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, writeOutbox } from "@bound/core";
import type { ToolDefinition } from "@bound/llm";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type ConnectorHandleRecord,
	getAllActiveConnectorHandles,
	getConnectorHandle,
	updateConnectorHandleCursor,
} from "./connector-handle.js";
import { DISPATCHER_TASK_ID } from "./dispatcher.js";

export interface PlatformServerEntry {
	name: string;
	server: Server | McpServer;
	client: Client;
	clientTransport: InMemoryTransport;
	serverTransport: InMemoryTransport;
}

export interface PlatformMcpRegistryDeps {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger: Logger;
	hubSiteId?: string;
}

/**
 * Platform tool registration entry (minimal subset of RegisteredTool to avoid circular dependency).
 * Execute returns a string result (tool output) or an error message.
 */
export interface PlatformRegisteredTool {
	kind: "platform";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<string>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

/** MCP Event as sent by server in notifications/events/event */
export interface McpEvent {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	cursor: string;
}

/** Active subscription state for push mode */
interface ActiveSubscription {
	handleId: string;
	serverName: string;
	taskId: string;
	threadId: string;
	buffer: McpEvent[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	deduplicationSet: Set<string>;
}

/**
 * Manages MCP server instances for platform connectors.
 * Creates InMemoryTransport pairs, connects clients to servers,
 * and manages the lifecycle of platform MCP connections.
 * Also manages connector handle subscriptions (push and poll modes).
 * Also discovers and manages platform tools from MCP servers.
 */
export class PlatformMcpRegistry {
	private servers = new Map<string, PlatformServerEntry>();
	private activeSubscriptions = new Map<string, ActiveSubscription>();
	private pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private platformTools = new Map<string, Map<string, PlatformRegisteredTool>>(); // serverName → toolName → PlatformRegisteredTool
	private deps: PlatformMcpRegistryDeps;

	constructor(deps: PlatformMcpRegistryDeps) {
		this.deps = deps;
	}

	/**
	 * Discovers tools from a connected MCP server and stores them.
	 * Called after registerServer() connects the client.
	 */
	private async discoverTools(entry: PlatformServerEntry): Promise<void> {
		try {
			const result = await entry.client.listTools();
			const serverTools = new Map<string, PlatformRegisteredTool>();

			for (const tool of result.tools) {
				const registeredTool: PlatformRegisteredTool = {
					kind: "platform",
					toolDefinition: {
						type: "function",
						function: {
							name: tool.name,
							description: tool.description ?? "",
							parameters: tool.inputSchema as Record<string, unknown>,
						},
					},
					execute: async (input: Record<string, unknown>) => {
						const callResult = await entry.client.callTool({
							name: tool.name,
							arguments: input,
						});
						// Convert MCP tool result to string
						// biome-ignore lint/suspicious/noExplicitAny: MCP SDK return type is any
						const content = (callResult as any).content as Array<{ type: string; text?: string }>;
						const textContent = content
							.filter((c) => c.type === "text")
							.map((c) => c.text ?? "")
							.join("\n");
						// biome-ignore lint/suspicious/noExplicitAny: MCP SDK return type is any
						const isError = (callResult as any).isError ?? false;
						return isError ? `Error: ${textContent}` : textContent || "done";
					},
					annotations: tool.annotations as PlatformRegisteredTool["annotations"],
				};
				serverTools.set(tool.name, registeredTool);
			}

			this.platformTools.set(entry.name, serverTools);
			this.deps.logger.info(`Discovered ${serverTools.size} tools from server '${entry.name}'`);
		} catch (err) {
			this.deps.logger.error(`Failed to discover tools from server '${entry.name}': ${err}`);
		}
	}

	/**
	 * Registers a platform MCP server and establishes an in-process connection.
	 * Creates an InMemoryTransport pair, connects client and server.
	 * Also discovers available tools from the server.
	 */
	async registerServer(name: string, server: Server | McpServer): Promise<PlatformServerEntry> {
		if (this.servers.has(name)) {
			throw new Error(`Platform server '${name}' already registered`);
		}

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		const client = new Client(
			{ name: `bound-platform-${name}`, version: "1.0.0" },
			{ capabilities: {} },
		);

		// Connect both sides — server connects to its transport, client connects to its transport
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		// Register notification handlers for list_changed events
		// When MCP server emits notifications/tools/list_changed or notifications/events/list_changed,
		// translate to internal event bus and rediscover tools
		// TODO: Replace internal SDK access when SDK exposes a public API for notification interception
		// biome-ignore lint/suspicious/noExplicitAny: MCP SDK internals for notification handling
		const protocol = (client as any)._protocol;
		if (protocol) {
			const originalHandler = protocol._onNotification;
			protocol._onNotification = async (notification: {
				method: string;
				params: Record<string, unknown>;
			}): Promise<void> => {
				if (notification.method === "notifications/tools/list_changed") {
					// Rediscover tools when the list changes
					await this.discoverTools(entry);
				} else if (notification.method === "notifications/events/list_changed") {
					this.deps.eventBus.emit("connector:list_changed", { server_name: name });
				}
				// Call original handler if it exists
				if (originalHandler) {
					await originalHandler(notification);
				}
			};
		}

		const entry: PlatformServerEntry = {
			name,
			server,
			client,
			clientTransport,
			serverTransport,
		};

		this.servers.set(name, entry);
		this.deps.logger.info(`Platform MCP server '${name}' registered and connected`);

		// Discover tools from the server
		await this.discoverTools(entry);

		return entry;
	}

	/**
	 * Unregisters a platform MCP server and tears down its transport.
	 */
	async unregisterServer(name: string): Promise<void> {
		const entry = this.servers.get(name);
		if (!entry) {
			return;
		}

		await entry.client.close();
		await entry.server.close();
		this.servers.delete(name);
		this.deps.logger.info(`Platform MCP server '${name}' unregistered`);
	}

	/**
	 * Returns the MCP client for a given platform server name.
	 */
	getClient(name: string): Client | undefined {
		return this.servers.get(name)?.client;
	}

	/**
	 * Returns all registered server names.
	 */
	getServerNames(): string[] {
		return Array.from(this.servers.keys());
	}

	/**
	 * Returns a server entry by name.
	 */
	getServerEntry(name: string): PlatformServerEntry | undefined {
		return this.servers.get(name);
	}

	/**
	 * Delivers a batch of events to the event task thread.
	 * Both push and poll modes call this method for consistent delivery.
	 * Implements AC1.2, AC1.3, AC5.4, AC5.5, and AC6.4 (cursor-based filtering).
	 * @internal Used by tests; not part of public API.
	 */
	deliverBatch(subscription: ActiveSubscription, events: McpEvent[]): void {
		// Get the stored cursor to filter events (AC6.4 - replay cursor filtering)
		const handle = getConnectorHandle(this.deps.db, subscription.handleId);
		const storedCursor = handle?.cursor;

		// Filter events: only include events with cursor > stored cursor (if cursor exists)
		// This ensures replay only sends new events after the stored position
		let filteredEvents = events;
		if (storedCursor) {
			filteredEvents = events.filter((e) => this.compareCursors(e.cursor, storedCursor) > 0);
		}

		// 1. Deduplicate: skip events whose eventId is in deduplicationSet (AC1.3)
		const newEvents = filteredEvents.filter((e) => !subscription.deduplicationSet.has(e.eventId));
		if (newEvents.length === 0) return; // No-op if all duplicates

		// 2. Track eventIds for future dedup (prune set at 500 entries)
		for (const e of newEvents) {
			subscription.deduplicationSet.add(e.eventId);
		}
		if (subscription.deduplicationSet.size > 500) {
			const idsToKeep = Array.from(subscription.deduplicationSet).slice(-500);
			subscription.deduplicationSet.clear();
			for (const id of idsToKeep) {
				subscription.deduplicationSet.add(id);
			}
		}

		// 3. Format batch content (opaque to bound — format determined by MCP server)
		const batchContent = JSON.stringify(newEvents.map((e) => e.data));

		// 4. Persist as developer-role message in the event task's thread (AC1.2)
		const now = new Date().toISOString();
		const messageId = randomUUID();
		insertRow(
			this.deps.db,
			"messages",
			{
				id: messageId,
				thread_id: subscription.threadId,
				role: "developer",
				content: batchContent,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: this.deps.siteId,
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			this.deps.siteId,
		);

		// 5. Update cursor on connector handle (AC5.5)
		const lastCursor = newEvents[newEvents.length - 1]?.cursor;
		updateConnectorHandleCursor(this.deps.db, this.deps.siteId, subscription.handleId, lastCursor);

		// 5.5. Write relay intake entry for multi-host routing (AC7.1, AC7.2)
		if (this.deps.hubSiteId && this.deps.hubSiteId !== this.deps.siteId) {
			// Multi-host mode: write intake for hub routing
			writeOutbox(this.deps.db, {
				id: randomUUID(),
				source_site_id: this.deps.siteId,
				target_site_id: this.deps.hubSiteId,
				kind: "intake",
				ref_id: null,
				idempotency_key: `intake:${subscription.serverName}:${newEvents[0].eventId}`,
				stream_id: null,
				payload: JSON.stringify({
					platform: subscription.serverName,
					platform_event_id: newEvents[0].eventId,
					thread_id: subscription.threadId,
					message_id: messageId,
					content: batchContent,
					attachments: [],
				}),
				created_at: now,
				expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
			});
		}

		// 6. Fire event trigger to wake the SPECIFIC task (AFTER commit per invariant #6)
		// Use per-handle trigger key so only the target task wakes (not all event tasks)
		const triggerKey = `connector:event:${subscription.handleId}`;
		this.deps.eventBus.emit("connector:event", {
			trigger_key: triggerKey,
			task_id: subscription.taskId,
			handle_id: subscription.handleId,
			batch_size: newEvents.length,
		});
		// The scheduler.onEvent(triggerKey, payload) matches against task.trigger_spec exactly
	}

	/**
	 * Compares two cursor values.
	 * Returns: negative if a < b, 0 if a == b, positive if a > b
	 * Attempts numeric comparison first, falls back to lexicographic.
	 */
	private compareCursors(a: string, b: string): number {
		const aNum = Number(a);
		const bNum = Number(b);
		if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
			return aNum - bNum;
		}
		// Lexicographic fallback for non-numeric cursors
		return a.localeCompare(b);
	}

	/**
	 * Sets up a push-mode subscription with stream listener.
	 * Requests events/stream from the MCP server.
	 * The server will send notifications/events/event which are handled by storing in buffer.
	 */
	private async startStreamSubscription(
		subscription: ActiveSubscription,
		handle: ConnectorHandleRecord,
	): Promise<void> {
		const client = this.getClient(subscription.serverName);
		if (!client) {
			this.deps.logger.warn(`Client not found for server ${subscription.serverName}`);
			return;
		}

		// Store subscription in a way we can access it from the protocol notification handler
		// We use a per-server handler that routes to all matching subscriptions
		// biome-ignore lint/suspicious/noExplicitAny: MCP SDK internals for notification handling
		const protocol = (client as any)._protocol;
		if (protocol) {
			// Set up notification handler directly on protocol
			// This bypasses the schema validation in setNotificationHandler
			const originalHandler = protocol._onNotification;

			protocol._onNotification = async (notification: {
				method: string;
				params: Record<string, unknown>;
			}): Promise<void> => {
				if (notification.method === "notifications/events/event") {
					const event = notification.params as unknown as McpEvent;

					// Find subscriptions this event belongs to (match by server name and event name)
					for (const sub of this.activeSubscriptions.values()) {
						if (sub.serverName === subscription.serverName && event.name === handle.event_name) {
							// Add event to this subscription's buffer
							sub.buffer.push(event);
							// Schedule flush if not already scheduled
							if (!sub.flushTimer) {
								sub.flushTimer = setTimeout(() => {
									this.flushBuffer(sub);
								}, 2000);
							}
						}
					}
				}

				// Call original handler if it exists
				if (originalHandler) {
					await originalHandler(notification);
				}
			};
		}

		// Request stream subscription from server
		// This tells the server to start sending notifications/events/event
		try {
			await client.request(
				{
					method: "events/stream",
					params: {
						event: handle.event_name,
						params: JSON.parse(handle.event_args),
						cursor: handle.cursor ?? undefined,
					},
				},
				{} as never,
			);
		} catch (err) {
			this.deps.logger.error(
				`Failed to subscribe to stream for handle ${subscription.handleId}: ${err}`,
			);
		}
	}

	/**
	 * Flushes the buffer for a subscription by calling deliverBatch.
	 */
	private flushBuffer(subscription: ActiveSubscription): void {
		if (subscription.buffer.length > 0) {
			const events = subscription.buffer.splice(0);
			this.deliverBatch(subscription, events);
		}
		subscription.flushTimer = null;
	}

	/**
	 * Stops a subscription and cleans up timers.
	 */
	private stopSubscription(handleId: string): void {
		const subscription = this.activeSubscriptions.get(handleId);
		if (!subscription) return;

		if (subscription.flushTimer) {
			clearTimeout(subscription.flushTimer);
		}

		const pollTimer = this.pollTimers.get(handleId);
		if (pollTimer) {
			clearTimeout(pollTimer);
			this.pollTimers.delete(handleId);
		}

		this.activeSubscriptions.delete(handleId);
		// No need to clean subscriptionsByHandleId since it was removed (M1)
	}

	/**
	 * Activates a subscription for an existing connector handle.
	 * Used both for new handles and for reconnection after failover (AC6.3).
	 */
	async activateSubscription(handle: ConnectorHandleRecord): Promise<void> {
		if (!handle.task_id) {
			this.deps.logger.warn(`Cannot activate handle ${handle.id}: task_id is null`);
			return;
		}

		const task = this.deps.db
			.query("SELECT thread_id FROM tasks WHERE id = ? AND deleted = 0")
			.get(handle.task_id) as { thread_id: string } | null;

		if (!task) {
			this.deps.logger.warn(
				`Cannot activate handle ${handle.id}: task ${handle.task_id} not found`,
			);
			return;
		}

		const subscription: ActiveSubscription = {
			handleId: handle.id,
			serverName: handle.server_name,
			taskId: handle.task_id,
			threadId: task.thread_id,
			buffer: [],
			flushTimer: null,
			deduplicationSet: new Set(),
		};

		this.activeSubscriptions.set(handle.id, subscription);

		if (handle.delivery_mode === "push") {
			await this.startStreamSubscription(subscription, handle);
		} else {
			// Poll mode: start with 2s interval
			this.startPollTimer(subscription, 2);
		}
	}

	/**
	 * Reconstitutes all active subscriptions from the database.
	 * Called on leader election / failover (AC6.3).
	 * Resumes from stored cursors (AC6.4).
	 */
	async reconnectAll(): Promise<void> {
		const handles = getAllActiveConnectorHandles(this.deps.db);
		this.deps.logger.info(`Reconnecting ${handles.length} connector handles`);
		for (const handle of handles) {
			if (!handle.task_id) continue; // orphan handle, skip
			await this.activateSubscription(handle);
		}
	}

	/**
	 * Starts a poll timer for a subscription (poll mode).
	 * Calls events/poll at the specified interval.
	 */
	private startPollTimer(subscription: ActiveSubscription, pollSeconds: number): void {
		const timer = setTimeout(async () => {
			try {
				const handle = getConnectorHandle(this.deps.db, subscription.handleId);
				if (!handle || handle.deleted) return; // handle was deleted

				const client = this.getClient(subscription.serverName);
				if (!client) return; // server disconnected

				const result = (await client.request(
					{
						method: "events/poll",
						params: {
							event: handle.event_name,
							params: JSON.parse(handle.event_args),
							cursor: handle.cursor ?? undefined,
						},
					},
					{} as never,
				)) as { events: McpEvent[]; nextPollSeconds?: number };

				if (result.events.length > 0) {
					this.deliverBatch(subscription, result.events);
				}
				// AC5.3: empty response = no-op (no deliverBatch, no task wake)

				// Reschedule with server-specified interval
				this.startPollTimer(subscription, result.nextPollSeconds ?? pollSeconds);
			} catch (err) {
				this.deps.logger.error(`Poll failed for handle ${subscription.handleId}: ${err}`);
				// Retry after double the interval (exponential backoff capped at 60s)
				this.startPollTimer(subscription, Math.min(pollSeconds * 2, 60));
			}
		}, pollSeconds * 1000);

		// Store timer reference for cleanup
		this.pollTimers.set(subscription.handleId, timer);
	}

	/**
	 * Returns platform tools for a specific server (used for per-thread scoping).
	 * Returns empty map if server not found.
	 */
	getToolsForServer(serverName: string): Map<string, PlatformRegisteredTool> {
		return this.platformTools.get(serverName) ?? new Map();
	}

	/**
	 * Returns ALL platform tools from ALL servers (used for dispatcher task).
	 */
	getAllPlatformTools(): Map<string, PlatformRegisteredTool> {
		const all = new Map<string, PlatformRegisteredTool>();
		for (const [_serverName, tools] of this.platformTools) {
			for (const [toolName, tool] of tools) {
				all.set(toolName, tool);
			}
		}
		return all;
	}

	/**
	 * Returns platform tools annotated as read-only across all servers.
	 * Tools without annotations or with readOnlyHint !== true are excluded.
	 */
	getReadOnlyPlatformTools(): Map<string, PlatformRegisteredTool> {
		const readOnly = new Map<string, PlatformRegisteredTool>();
		for (const [_serverName, tools] of this.platformTools) {
			for (const [toolName, tool] of tools) {
				if (tool.annotations?.readOnlyHint === true) {
					readOnly.set(toolName, tool);
				}
			}
		}
		return readOnly;
	}

	/**
	 * Resolves which platform tools a thread should receive.
	 * Traces: thread → task → connector_handle → server_name → tools
	 * Returns empty map for threads not bound to any connector handle.
	 * Implements AC3.4: scoping resolution through the handle chain.
	 */
	getToolsForThread(threadId: string): Map<string, PlatformRegisteredTool> {
		// Find task that owns this thread
		const task = this.deps.db
			.query(
				"SELECT id, payload FROM tasks WHERE thread_id = ? AND type = 'event' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
			)
			.get(threadId) as { id: string; payload: string | null } | null;

		if (!task) return new Map(); // AC3.3: no event task → no platform tools

		// Find connector handle for this task
		const handle = this.deps.db
			.query("SELECT server_name FROM connector_handles WHERE task_id = ? AND deleted = 0")
			.get(task.id) as { server_name: string } | null;

		if (!handle) return new Map(); // AC3.3: no handle → no platform tools

		// AC3.1: return only this server's tools
		return this.getToolsForServer(handle.server_name);
	}

	/**
	 * Checks if a thread belongs to the dispatcher task.
	 * Dispatcher task receives ALL platform tools.
	 */
	isDispatcherThread(threadId: string): boolean {
		const task = this.deps.db
			.query("SELECT id FROM tasks WHERE thread_id = ? AND id = ? AND deleted = 0")
			.get(threadId, DISPATCHER_TASK_ID) as { id: string } | null;
		return task !== null;
	}

	/**
	 * Tears down all registered servers. Called on shutdown or leader loss.
	 */
	async shutdown(): Promise<void> {
		// Stop all subscriptions
		for (const handleId of Array.from(this.activeSubscriptions.keys())) {
			this.stopSubscription(handleId);
		}

		const names = Array.from(this.servers.keys());
		for (const name of names) {
			await this.unregisterServer(name);
		}
	}
}

/**
 * Helper function to register scheduler event listeners for connector notifications.
 * Call this during startup to wire the event bus to the scheduler.
 * The scheduler.onEvent() method will match event tasks by their trigger_spec.
 *
 * @param eventBus - The TypedEventEmitter from AppContext
 * @param scheduler - The task scheduler instance
 */
export function registerConnectorEventListeners(
	eventBus: TypedEventEmitter,
	scheduler: { onEvent: (eventType: string, payload: Record<string, unknown>) => void },
): void {
	// Dispatcher wakes on connector:list_changed from any server
	eventBus.on("connector:list_changed", (payload) => {
		scheduler.onEvent("connector:list_changed", payload);
	});

	// Per-handle event tasks wake with per-handle trigger keys (e.g., "connector:event:handle_id")
	eventBus.on("connector:event", (payload) => {
		// Route to the specific task using the per-handle trigger key
		scheduler.onEvent(payload.trigger_key, payload);
	});
}
