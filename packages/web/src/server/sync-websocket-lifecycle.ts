import type { createWsHandlers } from "@bound/sync";
import type { Server } from "bun";
import {
	type SyncWebSocketAttempt,
	acceptSyncWebSocketAttempt,
	closeSyncWebSocketAttempt,
	markSyncWebSocketAttemptError,
	rejectSyncWebSocketAttempt,
	startSyncWebSocketAttempt,
} from "./sync-websocket-telemetry.js";

type SyncHandlers = ReturnType<typeof createWsHandlers>;
type SyncSocket = Parameters<NonNullable<SyncHandlers["websocket"]["open"]>>[0];
type SyncData = SyncSocket["data"];

export function instrumentSyncWebSocketHandlers(handlers: SyncHandlers): SyncHandlers {
	const pending = new WeakMap<object, SyncWebSocketAttempt>();
	const connections = new WeakMap<object, SyncWebSocketAttempt>();
	const original = handlers.websocket;

	return {
		handleUpgrade: async (request, server) => {
			const attempt = startSyncWebSocketAttempt();
			let capturedData: object | undefined;
			const wrappedServer = new Proxy(server, {
				get(target, property, receiver) {
					if (property !== "upgrade") return Reflect.get(target, property, receiver);
					return (req: Request, options: { data: SyncData; headers?: HeadersInit }) => {
						if (options.data && typeof options.data === "object") capturedData = options.data;
						return target.upgrade(req, options);
					};
				},
			});
			try {
				const response = await handlers.handleUpgrade(request, wrappedServer as Server<SyncData>);
				if (response) {
					const outcome = response.status === 500 ? "upgrade" : "authentication";
					rejectSyncWebSocketAttempt(
						attempt,
						outcome,
						new Error(`WebSocket ${outcome} rejected: ${response.status}`),
					);
				} else if (capturedData) {
					pending.set(capturedData, attempt);
				} else {
					rejectSyncWebSocketAttempt(
						attempt,
						"upgrade",
						new Error("Upgrade accepted without connection data"),
					);
				}
				return response;
			} catch (error) {
				rejectSyncWebSocketAttempt(attempt, "upgrade", error);
				throw error;
			}
		},
		websocket: {
			...original,
			open(ws) {
				const attempt = pending.get(ws.data);
				if (attempt) {
					pending.delete(ws.data);
					connections.set(ws, attempt);
					acceptSyncWebSocketAttempt(attempt, ws.data.siteId);
				}
				try {
					original.open?.(ws);
				} catch (error) {
					if (attempt) markSyncWebSocketAttemptError(attempt, error);
					throw error;
				}
			},
			message(ws, message) {
				try {
					original.message(ws, message);
				} catch (error) {
					const attempt = connections.get(ws);
					if (attempt) markSyncWebSocketAttemptError(attempt, error);
					throw error;
				}
			},
			close(ws, code, reason) {
				const attempt = connections.get(ws);
				try {
					original.close?.(ws, code, reason);
				} catch (error) {
					if (attempt) markSyncWebSocketAttemptError(attempt, error);
					throw error;
				} finally {
					if (attempt) {
						connections.delete(ws);
						closeSyncWebSocketAttempt(attempt, code);
					}
				}
			},
		},
	};
}
