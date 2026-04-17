import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	acknowledgeClientToolCall,
	enqueueToolResult,
	getPendingClientToolCalls,
	insertRow,
	updateClaimedBy,
} from "@bound/core";
import type { Message, StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";
import { z } from "zod";

// Zod schemas for all client→server message types
const sessionConfigureSchema = z.object({
	type: z.literal("session:configure"),
	tools: z.array(
		z.object({
			type: z.literal("function"),
			function: z.object({
				name: z.string(),
				description: z.string(),
				parameters: z.record(z.string(), z.unknown()),
			}),
		}),
	),
});

const messageSendSchema = z.object({
	type: z.literal("message:send"),
	thread_id: z.string(),
	content: z.string(),
	file_ids: z.array(z.string()).optional(),
});

const threadSubscribeSchema = z.object({
	type: z.literal("thread:subscribe"),
	thread_id: z.string(),
});

const threadUnsubscribeSchema = z.object({
	type: z.literal("thread:unsubscribe"),
	thread_id: z.string(),
});

const toolResultSchema = z.object({
	type: z.literal("tool:result"),
	call_id: z.string(),
	thread_id: z.string(),
	content: z.string(),
	is_error: z.boolean().optional(),
});

// Discriminated union for all message types
const wsClientMessageSchema = z.discriminatedUnion("type", [
	sessionConfigureSchema,
	messageSendSchema,
	threadSubscribeSchema,
	threadUnsubscribeSchema,
	toolResultSchema,
]);

interface ClientConnection {
	ws: ServerWebSocket<unknown>;
	connectionId: string;
	subscriptions: Set<string>;
	clientTools: Map<
		string,
		{
			type: "function";
			function: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			};
		}
	>;
}

export interface WebSocketConfig {
	open(ws: ServerWebSocket<unknown>): void;
	message(ws: ServerWebSocket<unknown>, message: string | Buffer): void;
	close(ws: ServerWebSocket<unknown>): void;
}

export interface WebSocketHandlerConfig {
	eventBus: TypedEventEmitter;
	db?: Database;
	siteId?: string;
	defaultUserId?: string;
	hostOrigin?: string;
}

export function createWebSocketHandler(
	config: WebSocketHandlerConfig | TypedEventEmitter,
): WebSocketConfig & { cleanup: () => void } {
	// Support both old (eventBus only) and new (config object) signatures for backwards compatibility
	let eventBus: TypedEventEmitter;
	let db: Database | undefined;
	let siteId: string | undefined;
	let defaultUserId: string | undefined;
	let hostOrigin = "localhost:3000";

	if ("on" in config && "emit" in config) {
		// Old signature: eventBus parameter
		eventBus = config;
	} else {
		// New signature: config object
		eventBus = config.eventBus;
		db = config.db;
		siteId = config.siteId;
		defaultUserId = config.defaultUserId;
		hostOrigin = config.hostOrigin ?? "localhost:3000";
	}

	const clients = new Map<ServerWebSocket<unknown>, ClientConnection>();

	const handleMessageCreated = (data: {
		message: unknown;
		thread_id: string;
	}): void => {
		for (const [ws, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				const message = JSON.stringify({
					type: "message:created",
					data: data.message,
				});
				if (ws.readyState === 1) {
					ws.send(message);
				}
			}
		}
	};

	const handleTaskCompleted = (data: {
		task_id: string;
		result: string | null;
	}): void => {
		const message = JSON.stringify({
			type: "task:updated",
			data: {
				taskId: data.task_id,
				status: "completed",
			},
		});

		for (const [ws] of clients) {
			if (ws.readyState === 1) {
				ws.send(message);
			}
		}
	};

	const handleFileChanged = (data: {
		path: string;
		operation: "created" | "modified" | "deleted";
	}): void => {
		const message = JSON.stringify({
			type: "file:updated",
			data: {
				path: data.path,
				operation: data.operation,
			},
		});

		for (const [ws] of clients) {
			if (ws.readyState === 1) {
				ws.send(message);
			}
		}
	};

	const handleAlertCreated = (data: {
		message: unknown;
		thread_id: string;
	}): void => {
		const message = JSON.stringify({
			type: "alert",
			data: data.message,
		});

		for (const [ws, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				if (ws.readyState === 1) {
					ws.send(message);
				}
			}
		}
	};

	const handleContextDebug = (data: {
		thread_id: string;
		turn_id: number;
		debug: unknown;
	}): void => {
		for (const [ws, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				const message = JSON.stringify({
					type: "context:debug",
					data: { turn_id: data.turn_id, debug: data.debug },
				});
				if (ws.readyState === 1) {
					ws.send(message);
				}
			}
		}
	};

	function handleSessionConfigure(
		conn: ClientConnection,
		msg: z.infer<typeof sessionConfigureSchema>,
	): void {
		conn.clientTools.clear();
		for (const tool of msg.tools) {
			conn.clientTools.set(tool.function.name, tool);
		}
		// Scan for pending client_tool_call entries that match this connection's tools
		// (reconnection delivery — Phase 8 completes this, but structure the scan here)
	}

	function handleThreadSubscribe(
		conn: ClientConnection,
		msg: z.infer<typeof threadSubscribeSchema>,
	): void {
		conn.subscriptions.add(msg.thread_id);
	}

	function handleThreadUnsubscribe(
		conn: ClientConnection,
		msg: z.infer<typeof threadUnsubscribeSchema>,
	): void {
		conn.subscriptions.delete(msg.thread_id);
	}

	function handleMessageSend(conn: ClientConnection, msg: z.infer<typeof messageSendSchema>): void {
		if (!db || !siteId || !defaultUserId) {
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "handler_not_configured",
					message: "Message handler not configured with required dependencies",
				}),
			);
			return;
		}

		try {
			const MAX_CONTENT_LENGTH = 512 * 1024; // 512KB

			// Validate content is non-empty
			if (!msg.content.trim()) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "invalid_content",
						message: "Content must not be empty",
					}),
				);
				return;
			}

			// Validate content length
			if (msg.content.length > MAX_CONTENT_LENGTH) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "content_too_large",
						message: `Maximum content length is ${MAX_CONTENT_LENGTH / 1024}KB`,
					}),
				);
				return;
			}

			// Verify thread exists
			const thread = db
				.query("SELECT * FROM threads WHERE id = ? AND deleted = 0")
				.get(msg.thread_id);
			if (!thread) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "thread_not_found",
						message: "Thread not found",
					}),
				);
				return;
			}

			// Append file contents if provided
			let content: string = msg.content;
			const MAX_FILE_IDS = 20;
			const fileIds: string[] = (Array.isArray(msg.file_ids) ? msg.file_ids : [])
				.filter((id): id is string => typeof id === "string")
				.slice(0, MAX_FILE_IDS);
			for (const fileId of fileIds) {
				const file = db.query("SELECT * FROM files WHERE id = ? AND deleted = 0").get(fileId) as {
					path: string;
					content: string | null;
					is_binary: number;
					size_bytes: number;
				} | null;
				if (!file) continue;
				const name = file.path.split("/").pop() ?? file.path;
				if (file.is_binary) {
					content += `\n\n[Attached file: ${name} (binary, ${file.size_bytes} bytes)]`;
				} else {
					content += `\n\n[Attached file: ${name}]\n${file.content ?? ""}`;
				}
			}

			// Persist the message
			const messageId = randomUUID();
			const now = new Date().toISOString();

			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: msg.thread_id,
					role: "user",
					content,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostOrigin,
				},
				siteId,
			);

			// Retrieve the persisted message
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;

			// Emit message:created event to trigger agent loop
			eventBus.emit("message:created", {
				message,
				thread_id: msg.thread_id,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "message_send_failed",
					message: errorMsg,
				}),
			);
		}
	}

	function handleToolResult(conn: ClientConnection, msg: z.infer<typeof toolResultSchema>): void {
		if (!db || !siteId || !defaultUserId) {
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "handler_not_configured",
					message: "Tool result handler not configured with required dependencies",
				}),
			);
			return;
		}

		try {
			const now = new Date().toISOString();
			const TTL_MS = 5 * 60 * 1000; // 5 minutes
			const cutoff = new Date(Date.now() - TTL_MS).toISOString();

			// Look up the pending client tool call entry
			const pendingCalls = getPendingClientToolCalls(db, msg.thread_id);
			let matchingEntry = null;

			for (const entry of pendingCalls) {
				if (!entry.event_payload) continue;
				try {
					const payload = JSON.parse(entry.event_payload) as { call_id?: string };
					if (payload.call_id === msg.call_id) {
						matchingEntry = entry;
						break;
					}
				} catch {
					// Ignore parse errors and continue searching
				}
			}

			if (!matchingEntry) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "unknown_call_id",
						message: "No pending tool call with this call_id",
						call_id: msg.call_id,
					}),
				);
				return;
			}

			// Check if entry has expired
			if (matchingEntry.created_at < cutoff) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "tool_call_expired",
						message: "Tool call has expired",
						call_id: msg.call_id,
					}),
				);
				return;
			}

			// Persist the tool_result message
			const messageId = randomUUID();
			const toolResultContent = msg.is_error ? `Error: ${msg.content}` : msg.content;

			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: msg.thread_id,
					role: "tool_result",
					content: toolResultContent,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostOrigin,
				},
				siteId,
			);

			// Acknowledge the dispatch entry
			acknowledgeClientToolCall(db, matchingEntry.message_id);

			// Enqueue tool result trigger to resume agent loop
			enqueueToolResult(db, msg.thread_id, msg.call_id);

			// Emit an event to trigger handleThread (re-emit the message so subscribed clients see it)
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;
			eventBus.emit("message:created", {
				message,
				thread_id: msg.thread_id,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "tool_result_failed",
					message: errorMsg,
				}),
			);
		}
	}

	const handleClientToolCallCreated = (data: {
		threadId: string;
		callId: string;
		entryId: string;
		toolName: string;
		arguments: Record<string, unknown>;
	}): void => {
		// Find the first connection subscribed to this thread that has the matching tool
		for (const [, conn] of clients) {
			if (conn.subscriptions.has(data.threadId) && conn.clientTools.has(data.toolName)) {
				const toolCallMessage = JSON.stringify({
					type: "tool:call",
					call_id: data.callId,
					thread_id: data.threadId,
					tool_name: data.toolName,
					arguments: data.arguments,
				});
				if (conn.ws.readyState === 1) {
					conn.ws.send(toolCallMessage);
				}
				// Update dispatch_queue entry status to 'processing' and claimed_by to connectionId
				if (db) {
					try {
						updateClaimedBy(db, data.entryId, conn.connectionId);
					} catch {
						// Ignore errors from updating dispatch queue
					}
				}
				break; // Deliver to first matching connection
			}
		}
	};

	const handleThreadStatus = (data: {
		threadId: string;
		active: boolean;
		state: string | null;
		tokens: number;
		model: string | null;
	}): void => {
		for (const [, conn] of clients) {
			if (conn.subscriptions.has(data.threadId)) {
				const statusMessage = JSON.stringify({
					type: "thread:status",
					thread_id: data.threadId,
					active: data.active,
					state: data.state,
					tokens: data.tokens,
					model: data.model,
				});
				if (conn.ws.readyState === 1) {
					conn.ws.send(statusMessage);
				}
			}
		}
	};

	const handleStatusForward = (data: StatusForwardPayload): void => {
		// Only push thread:status if the payload is for a thread (not a task)
		if (data.thread_id) {
			handleThreadStatus({
				threadId: data.thread_id,
				active: data.status !== "idle",
				state: data.status,
				tokens: data.tokens,
				model: data.detail,
			});
		}
	};

	eventBus.on("message:created", handleMessageCreated);
	// message:broadcast is used for assistant-response re-emit so it reaches
	// WebSocket clients without re-triggering the agent loop handler.
	eventBus.on("message:broadcast", handleMessageCreated);
	eventBus.on("task:completed", handleTaskCompleted);
	eventBus.on("file:changed", handleFileChanged);
	eventBus.on("alert:created", handleAlertCreated);
	eventBus.on("context:debug", handleContextDebug);
	eventBus.on("client_tool_call:created", handleClientToolCallCreated);
	eventBus.on("status:forward", handleStatusForward);

	return {
		open(ws: ServerWebSocket<unknown>): void {
			const conn: ClientConnection = {
				ws,
				connectionId: crypto.randomUUID(),
				subscriptions: new Set(),
				clientTools: new Map(),
			};
			clients.set(ws, conn);
		},

		message(ws: ServerWebSocket<unknown>, rawMessage: string | Buffer): void {
			if (typeof rawMessage !== "string") {
				return;
			}

			const conn = clients.get(ws);
			if (!conn) return;

			try {
				const parsed = wsClientMessageSchema.safeParse(JSON.parse(rawMessage));
				if (!parsed.success) {
					// Invalid message schema, send error response
					ws.send(
						JSON.stringify({
							type: "error",
							code: "invalid_message",
							message: parsed.error.message,
						}),
					);
					return;
				}

				const message = parsed.data;

				switch (message.type) {
					case "session:configure": {
						handleSessionConfigure(conn, message);
						break;
					}
					case "thread:subscribe": {
						handleThreadSubscribe(conn, message);
						break;
					}
					case "thread:unsubscribe": {
						handleThreadUnsubscribe(conn, message);
						break;
					}
					case "message:send": {
						handleMessageSend(conn, message);
						break;
					}
					case "tool:result": {
						handleToolResult(conn, message);
						break;
					}
				}
			} catch {
				// Invalid JSON, send error response
				ws.send(
					JSON.stringify({
						type: "error",
						code: "invalid_json",
						message: "Invalid JSON",
					}),
				);
			}
		},

		close(ws: ServerWebSocket<unknown>): void {
			clients.delete(ws);
		},

		cleanup(): void {
			eventBus.off("message:created", handleMessageCreated);
			eventBus.off("message:broadcast", handleMessageCreated);
			eventBus.off("task:completed", handleTaskCompleted);
			eventBus.off("file:changed", handleFileChanged);
			eventBus.off("alert:created", handleAlertCreated);
			eventBus.off("context:debug", handleContextDebug);
			eventBus.off("client_tool_call:created", handleClientToolCallCreated);
			eventBus.off("status:forward", handleStatusForward);
			clients.clear();
		},
	};
}
