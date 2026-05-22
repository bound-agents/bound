import type { BoundClient, ConnectionState } from "@bound/client";
import { useEffect, useState } from "react";

/**
 * Track a `BoundClient`'s WebSocket connection state in React.
 *
 * Reads `client.connectionState` for the initial snapshot, then subscribes to
 * `connection:state` events for transitions. The snapshot read matters: by the
 * time `App` mounts, `boundless.tsx` has already attached the client past
 * `connect()`, so the `open` event has fired and any hook that listened only
 * to events would be stuck at the initial state forever.
 *
 * Returns `"disconnected"` when `client` is null.
 */
export function useConnectionState(client: BoundClient | null): ConnectionState {
	const [state, setState] = useState<ConnectionState>(() =>
		client ? client.connectionState : "disconnected",
	);

	useEffect(() => {
		if (!client) {
			setState("disconnected");
			return;
		}
		// Re-sync to the current state in case it transitioned between the render
		// that closed over `client` and this effect running.
		setState(client.connectionState);

		const handler = (next: ConnectionState) => setState(next);
		client.on("connection:state", handler);
		return () => {
			client.off("connection:state", handler);
		};
	}, [client]);

	return state;
}
