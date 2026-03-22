import { writable } from "svelte/store";

export interface WebSocketMessage {
	type: string;
	data: unknown;
}

export const wsEvents = writable<WebSocketMessage[]>([]);

let ws: WebSocket | null = null;
const subscriptions: Set<string> = new Set();

export function connectWebSocket(): void {
	if (ws) return;

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = `${protocol}//${window.location.host}/ws`;

	ws = new WebSocket(url);

	ws.onopen = () => {
		console.log("WebSocket connected");
		if (subscriptions.size > 0) {
			ws?.send(JSON.stringify({ subscribe: Array.from(subscriptions) }));
		}
	};

	ws.onmessage = (event) => {
		try {
			const message = JSON.parse(event.data) as WebSocketMessage;
			wsEvents.update((events) => [...events, message]);
		} catch (error) {
			console.error("Failed to parse WebSocket message:", error);
		}
	};

	ws.onerror = (error) => {
		console.error("WebSocket error:", error);
	};

	ws.onclose = () => {
		console.log("WebSocket closed");
		ws = null;
	};
}

export function subscribeToThread(threadId: string): void {
	subscriptions.add(threadId);
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ subscribe: Array.from(subscriptions) }));
	}
}

export function disconnectWebSocket(): void {
	if (ws) {
		ws.close();
		ws = null;
	}
}
