import type { TypedEventEmitter } from "@bound/shared";
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

export function createWebSocketHandler(
	eventBus: TypedEventEmitter,
): WebSocketConfig & { cleanup: () => void } {
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
			type: "task_update",
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
			type: "file_update",
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

	eventBus.on("message:created", handleMessageCreated);
	// message:broadcast is used for assistant-response re-emit so it reaches
	// WebSocket clients without re-triggering the agent loop handler.
	eventBus.on("message:broadcast", handleMessageCreated);
	eventBus.on("task:completed", handleTaskCompleted);
	eventBus.on("file:changed", handleFileChanged);
	eventBus.on("alert:created", handleAlertCreated);
	eventBus.on("context:debug", handleContextDebug);

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
						// Placeholder for Task 3
						break;
					}
					case "tool:result": {
						// Placeholder for Task 4
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
			clients.clear();
		},
	};
}
