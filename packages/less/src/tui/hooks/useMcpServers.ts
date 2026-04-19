import { useEffect, useState } from "react";
import type { McpServerManager, McpServerState } from "../mcp/manager";

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

		// For now, we don't have a real event system, so we poll
		// In the future, this could be replaced with an event listener
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
