import { useEffect, useRef, useState } from "react";
import type { McpServerManager, McpServerState } from "../../mcp/manager";

export interface UseMcpServersResult {
	serverStates: Map<string, McpServerState>;
	runningCount: number;
}

/**
 * Tracks MCP server state for the McpView.
 * - State: mirrors `mcpManager.getServerStates()`
 * - Refreshes on manager changes
 * - Exposes `serverStates`, `runningCount`
 */
export function useMcpServers(mcpManager: McpServerManager): UseMcpServersResult {
	const [serverStates, setServerStates] = useState<Map<string, McpServerState>>(new Map());
	const statesRef = useRef(serverStates);
	statesRef.current = serverStates;

	useEffect(() => {
		// Get initial state
		const states = mcpManager.getServerStates();
		setServerStates(states);

		// Poll for state changes, but only update React state when something changed.
		// This avoids unnecessary re-renders that cause terminal flicker.
		const interval = setInterval(() => {
			const updatedStates = mcpManager.getServerStates();
			const prev = statesRef.current;
			// Only update if the count or any status changed
			if (updatedStates.size !== prev.size) {
				setServerStates(updatedStates);
				return;
			}
			for (const [name, state] of updatedStates) {
				const prevState = prev.get(name);
				const prevToolsLen = prevState?.tools?.length ?? -1;
				const nextToolsLen = state?.tools?.length ?? -1;
				if (!prevState || prevState.status !== state?.status || prevToolsLen !== nextToolsLen) {
					setServerStates(updatedStates);
					return;
				}
			}
		}, 5000);

		return () => clearInterval(interval);
	}, [mcpManager]);

	// Count running servers
	const runningCount = Array.from(serverStates.values()).filter(
		(state) => state.status === "running",
	).length;

	return {
		serverStates,
		runningCount,
	};
}
