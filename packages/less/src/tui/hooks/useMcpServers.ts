import { useEffect, useState } from "react";
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

	useEffect(() => {
		// Get initial state
		const states = mcpManager.getServerStates();
		setServerStates(states);

		// TODO: Replace 1s polling with event-driven updates from McpServerManager
		// For now, we poll for state changes. This is a performance trade-off
		// that works fine for the small number of MCP servers typically running.
		const interval = setInterval(() => {
			const updatedStates = mcpManager.getServerStates();
			setServerStates(updatedStates);
		}, 1000);

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
