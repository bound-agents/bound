import { BoundClient, BoundSocket } from "@bound/client";
import { writable } from "svelte/store";

/** Shared BoundClient instance for all web UI components. */
export const client = new BoundClient();

/** Shared BoundSocket instance for real-time events. */
export const socket = new BoundSocket();

/**
 * Svelte-friendly event store bridging BoundSocket events.
 * Components can subscribe with `$wsEvents` for reactive updates.
 */
export interface WebSocketMessage {
	type: string;
	data: unknown;
}

export const wsEvents = writable<WebSocketMessage[]>([]);

// Wire BoundSocket events into the Svelte store for backward compatibility.
// Components can incrementally migrate to socket.on() later.
function bridgeEvent(type: string) {
	return (data: unknown) => {
		wsEvents.update((events) => [...events, { type, data }]);
	};
}

socket.on("message:created", bridgeEvent("message:created"));
socket.on("task_update", bridgeEvent("task_update"));
socket.on("file_update", bridgeEvent("file_update"));
socket.on("context:debug", bridgeEvent("context:debug"));

/** Connect the WebSocket. Safe to call multiple times. */
export function connectWebSocket(): void {
	socket.connect();
}

/** Subscribe to real-time events for a thread. */
export function subscribeToThread(threadId: string): void {
	socket.subscribe(threadId);
}

/** Disconnect the WebSocket. */
export function disconnectWebSocket(): void {
	socket.disconnect();
}
