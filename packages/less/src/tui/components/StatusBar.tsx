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
 * - Full thread ID (operators copy it for `--attach` / debugging) — dim
 * - Model name (or "default" if null) — cyan, the most action-relevant zone
 * - Connection badge — colored dot
 * - MCP server count — subtle
 *
 * Each zone uses a distinct color/weight so the bar reads as separate fields
 * at a glance instead of a single dim line of text.
 */
export function StatusBar({
	threadId,
	model,
	connectionState,
	mcpServerCount,
}: StatusBarProps): React.ReactElement {
	// Map connection state to badge status
	const badgeStatus: "connected" | "disconnected" =
		connectionState === "connected" ? "connected" : "disconnected";

	const sep = <Text dimColor> · </Text>;

	return (
		<Box paddingX={1} flexDirection="row">
			<Badge status={badgeStatus} />
			<Text> </Text>
			<Text dimColor>{threadId}</Text>
			{sep}
			<Text color="cyan">{model || "default"}</Text>
			{mcpServerCount > 0 && (
				<>
					{sep}
					<Text dimColor>{mcpServerCount} MCP</Text>
				</>
			)}
		</Box>
	);
}
