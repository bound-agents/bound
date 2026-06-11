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

// Every subscriber reads only the most recent event (`events[events.length -
// 1]`), so the array exists purely to make each push a fresh reference for
// Svelte reactivity. Cap it so a long-lived tab on a busy thread doesn't grow
// the buffer (and re-copy it per event) without bound.
const WS_EVENT_BUFFER_CAP = 100;

// Wire BoundClient events into the Svelte store for backward compatibility.
// Components can incrementally migrate to client.on() later.
function bridgeEvent(type: string) {
	return (data: unknown) => {
		wsEvents.update((events) => [...events.slice(-(WS_EVENT_BUFFER_CAP - 1)), { type, data }]);
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

// There is deliberately no disconnect helper: the WebSocket is shared by every
// view (status chips, file updates, MCP App tool dispatch). A view leaving a
// thread should call `client.unsubscribe(threadId)`, never close the socket.
