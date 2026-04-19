import { useEffect, useState } from "react";
import { BoundClient } from "@bound/client";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface UseSessionResult {
	client: BoundClient | null;
	connectionState: ConnectionState;
	reconnect: () => void;
}

/**
 * Manages BoundClient lifecycle.
 * - Creates and connects BoundClient on mount, disconnects on unmount
 * - Tracks connection state: "connecting" | "connected" | "disconnected"
 * - Exposes `client`, `connectionState`, `reconnect()`
 */
export function useSession(url: string): UseSessionResult {
	const [client, setClient] = useState<BoundClient | null>(null);
	const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

	useEffect(() => {
		const boundClient = new BoundClient(url);

		// Set to connecting immediately
		setConnectionState("connecting");
		setClient(boundClient);

		// Handle connection open
		const handleOpen = () => {
			setConnectionState("connected");
		};

		// Handle connection close
		const handleClose = () => {
			setConnectionState("disconnected");
		};

		// Register event listeners
		boundClient.on("open", handleOpen);
		boundClient.on("close", handleClose);

		// Connect
		boundClient.connect();

		// Cleanup on unmount
		return () => {
			boundClient.off("open", handleOpen);
			boundClient.off("close", handleClose);
			boundClient.disconnect();
		};
	}, [url]);

	const reconnect = () => {
		if (client) {
			setConnectionState("connecting");
			client.connect();
		}
	};

	return {
		client,
		connectionState,
		reconnect,
	};
}
