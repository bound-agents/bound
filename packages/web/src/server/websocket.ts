import type { TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";

interface WebSocketMessage {
	subscribe?: string[];
	unsubscribe?: string[];
}

interface ClientConnection {
	ws: ServerWebSocket<unknown>;
	subscriptions: Set<string>;
}

export interface WebSocketConfig {
	open(ws: ServerWebSocket<unknown>): void;
	message(ws: ServerWebSocket<unknown>, message: string | Buffer): void;
	close(ws: ServerWebSocket<unknown>): void;
}

export function createWebSocketHandler(eventBus: TypedEventEmitter): WebSocketConfig {
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

	eventBus.on("message:created", handleMessageCreated);
	// message:broadcast is used for assistant-response re-emit so it reaches
	// WebSocket clients without re-triggering the agent loop handler.
	eventBus.on("message:broadcast", handleMessageCreated);
	eventBus.on("task:completed", handleTaskCompleted);
	eventBus.on("file:changed", handleFileChanged);
	eventBus.on("alert:created", handleAlertCreated);

	return {
		open(ws: ServerWebSocket<unknown>): void {
			const conn: ClientConnection = {
				ws,
				subscriptions: new Set(),
			};
			clients.set(ws, conn);
		},

		message(ws: ServerWebSocket<unknown>, rawMessage: string | Buffer): void {
			if (typeof rawMessage !== "string") {
				return;
			}

			try {
				const message = JSON.parse(rawMessage) as WebSocketMessage;
				const conn = clients.get(ws);

				if (!conn) return;

				if (Array.isArray(message.subscribe)) {
					for (const threadId of message.subscribe) {
						if (typeof threadId === "string") {
							conn.subscriptions.add(threadId);
						}
					}
				}

				if (Array.isArray(message.unsubscribe)) {
					for (const threadId of message.unsubscribe) {
						if (typeof threadId === "string") {
							conn.subscriptions.delete(threadId);
						}
					}
				}
			} catch (error) {
				console.error("WebSocket message error:", error);
			}
		},

		close(ws: ServerWebSocket<unknown>): void {
			clients.delete(ws);
		},
	};
}
