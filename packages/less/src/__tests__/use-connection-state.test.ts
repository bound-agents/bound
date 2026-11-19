import { describe, expect, it } from "bun:test";
import type { BoundClient, ConnectionState } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { useConnectionState } from "../tui/hooks/useConnectionState";

/** Let React effects flush. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

type EventHandler = (...args: unknown[]) => void;

function createMockClient(initial: ConnectionState) {
	const listeners = new Map<string, Set<EventHandler>>();
	return {
		connectionState: initial,
		on(event: string, handler: EventHandler) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
		},
		off(event: string, handler: EventHandler) {
			listeners.get(event)?.delete(handler);
		},
		emit(event: string, data: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(data);
		},
	} as unknown as BoundClient & {
		connectionState: ConnectionState;
		emit(event: string, data: unknown): void;
	};
}

describe("useConnectionState", () => {
	it("returns disconnected when client is null", async () => {
		let stateRef: ConnectionState | null = null;
		function Harness() {
			const state = useConnectionState(null);
			stateRef = state;
			return React.createElement(Text, null, state);
		}
		render(React.createElement(Harness));
		await tick();
		expect(stateRef).toBe("disconnected");
	});

	it("seeds from the client's current connectionState snapshot", async () => {
		const client = createMockClient("connected");
		let stateRef: ConnectionState | null = null;
		function Harness() {
			const state = useConnectionState(client);
			stateRef = state;
			return React.createElement(Text, null, state);
		}
		render(React.createElement(Harness));
		await tick();
		expect(stateRef).toBe("connected");
	});

	it("re-syncs to the live state if it changed between render and effect", async () => {
		const client = createMockClient("connecting");
		// Simulate the transition that happened before the effect ran.
		client.connectionState = "connected";
		let stateRef: ConnectionState | null = null;
		function Harness() {
			const state = useConnectionState(client);
			stateRef = state;
			return React.createElement(Text, null, state);
		}
		render(React.createElement(Harness));
		await tick();
		expect(stateRef).toBe("connected");
	});

	it("updates on connection:state transition events", async () => {
		const client = createMockClient("connected");
		let stateRef: ConnectionState | null = null;
		function Harness() {
			const state = useConnectionState(client);
			stateRef = state;
			return React.createElement(Text, null, state);
		}
		render(React.createElement(Harness));
		await tick();
		expect(stateRef).toBe("connected");

		client.emit("connection:state", "disconnected");
		await tick();
		expect(stateRef).toBe("disconnected");

		client.emit("connection:state", "connecting");
		await tick();
		expect(stateRef).toBe("connecting");
	});

	it("resets to disconnected when the client becomes null across renders", async () => {
		const client = createMockClient("connected");
		let stateRef: ConnectionState | null = null;
		function Harness({ c }: { c: BoundClient | null }) {
			const state = useConnectionState(c);
			stateRef = state;
			return React.createElement(Text, null, state);
		}
		const { rerender } = render(React.createElement(Harness, { c: client }));
		await tick();
		expect(stateRef).toBe("connected");

		rerender(React.createElement(Harness, { c: null }));
		await tick();
		expect(stateRef).toBe("disconnected");
	});

	it("detaches the connection:state listener on unmount", async () => {
		const offCalls: string[] = [];
		const client = {
			connectionState: "connected" as ConnectionState,
			on() {},
			off(event: string) {
				offCalls.push(event);
			},
		} as unknown as BoundClient;
		function Harness() {
			useConnectionState(client);
			return React.createElement(Text, null, "ok");
		}
		const { unmount } = render(React.createElement(Harness));
		await tick();
		unmount();
		await tick();
		expect(offCalls).toContain("connection:state");
	});
});
