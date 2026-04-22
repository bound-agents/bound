import { Box, Text } from "ink";
import type React from "react";
import { Badge } from "./Badge";

export interface StatusBarProps {
	threadId: string;
	model: string | null;
	connectionState: string;
	mcpServerCount: number;
}

/**
 * Renders a bottom status bar with thread info, model, connection status, and MCP count.
 * - Thread ID truncated to 12 chars
 * - Model name (or "default" if null)
 * - Connection status badge
 * - MCP server count
 */
export function StatusBar({
	threadId,
	model,
	connectionState,
	mcpServerCount,
}: StatusBarProps): React.ReactElement {
	// Truncate thread ID to 12 chars
	const displayThreadId = threadId.length > 12 ? `${threadId.slice(0, 12)}...` : threadId;

	// Map connection state to badge status
	const badgeStatus: "connected" | "disconnected" =
		connectionState === "connected" ? "connected" : "disconnected";

	return (
		<Box paddingX={1}>
			<Text dimColor>
				<Badge status={badgeStatus} /> {displayThreadId} · {model || "default"}
				{mcpServerCount > 0 ? ` · ${mcpServerCount} MCP` : ""}
			</Text>
		</Box>
	);
}
