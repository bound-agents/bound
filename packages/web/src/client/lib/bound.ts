import { BoundClient } from "@bound/client";
import { writable } from "svelte/store";

/** Shared BoundClient instance for all web UI components. */
export const client = new BoundClient();

/**
 * Svelte-friendly event store bridging BoundClient events.
 * Components can subscribe with `$wsEvents` for reactive updates.
 */
export interface WebSocketMessage {
	type: string;
	data: unknown;
}

export const wsEvents = writable<WebSocketMessage[]>([]);

// Wire BoundClient events into the Svelte store for backward compatibility.
// Components can incrementally migrate to client.on() later.
function bridgeEvent(type: string) {
	return (data: unknown) => {
		wsEvents.update((events) => [...events, { type, data }]);
	};
}

client.on("message:created", bridgeEvent("message:created"));
client.on("task:updated", bridgeEvent("task:updated"));
client.on("file:updated", bridgeEvent("file:updated"));
client.on("context:debug", bridgeEvent("context:debug"));

/** Connect the WebSocket. Safe to call multiple times. */
export function connectWebSocket(): void {
	client.connect();
}

/** Subscribe to real-time events for a thread. */
export function subscribeToThread(threadId: string): void {
	client.subscribe(threadId);
}

/** Disconnect the WebSocket. */
export function disconnectWebSocket(): void {
	client.disconnect();
}
