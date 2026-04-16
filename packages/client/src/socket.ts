import type { BoundSocketEvents } from "./types.js";

type EventName = keyof BoundSocketEvents;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * WebSocket client for Bound real-time events.
 *
 * Emits typed events for message creation, task updates, file changes,
 * and context debug info. Auto-reconnects with exponential backoff and
 * re-sends subscriptions on reconnect.
 */
export class BoundSocket {
	private ws: WebSocket | null = null;
	private readonly subscriptions = new Set<string>();
	private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private shouldReconnect = false;
	private readonly wsUrl: string;

	/**
	 * @param baseUrl Base URL for the Bound server. If empty (browser default),
	 *   derives the WebSocket URL from `window.location`. Otherwise converts
	 *   http(s) to ws(s) and appends `/ws`.
	 */
	constructor(baseUrl = "") {
		if (baseUrl) {
			this.wsUrl = `${baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
		} else if (typeof window !== "undefined") {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			this.wsUrl = `${protocol}//${window.location.host}/ws`;
		} else {
			this.wsUrl = "ws://localhost:3001/ws";
		}
	}

	connect(): void {
		if (this.ws) return;
		this.shouldReconnect = true;
		this.createConnection();
	}

	disconnect(): void {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	subscribe(threadId: string): void {
		this.subscriptions.add(threadId);
		this.sendSubscriptions();
	}

	unsubscribe(threadId: string): void {
		this.subscriptions.delete(threadId);
		this.sendSubscriptions();
	}

	on<E extends EventName>(event: E, handler: BoundSocketEvents[E]): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(handler as (...args: unknown[]) => void);
	}

	off<E extends EventName>(event: E, handler: BoundSocketEvents[E]): void {
		const set = this.listeners.get(event);
		if (set) {
			set.delete(handler as (...args: unknown[]) => void);
			if (set.size === 0) this.listeners.delete(event);
		}
	}

	private emit(event: string, ...args: unknown[]): void {
		const set = this.listeners.get(event);
		if (set) {
			for (const handler of set) {
				handler(...args);
			}
		}
	}

	private createConnection(): void {
		const ws = new WebSocket(this.wsUrl);

		ws.onopen = () => {
			this.reconnectAttempt = 0;
			this.sendSubscriptions();
			this.emit("open");
		};

		ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data as string) as {
					type: string;
					data: unknown;
				};
				this.emit(msg.type, msg.data);
			} catch {
				// Ignore malformed messages
			}
		};

		ws.onerror = (event) => {
			this.emit("error", event);
		};

		ws.onclose = () => {
			this.ws = null;
			this.emit("close");
			if (this.shouldReconnect) {
				this.scheduleReconnect();
			}
		};

		this.ws = ws;
	}

	private sendSubscriptions(): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN && this.subscriptions.size > 0) {
			this.ws.send(JSON.stringify({ subscribe: Array.from(this.subscriptions) }));
		}
	}

	private scheduleReconnect(): void {
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
		// Add jitter: 0.5x to 1.5x of computed delay
		const jitteredDelay = delay * (0.5 + Math.random());
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.createConnection();
		}, jitteredDelay);
	}
}
