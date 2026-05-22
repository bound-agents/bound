import { homedir } from "node:os";
import type { ConnectionState } from "@bound/client";
import { Box, Text } from "ink";
import type React from "react";
import { Badge } from "./Badge";

export interface StatusBarProps {
	threadId: string;
	model: string | null;
	connectionState: ConnectionState;
	mcpServerCount: number;
	cwd: string;
}

/**
 * Collapse a working directory to a one-glance label suitable for the status bar.
 *
 * - Replaces $HOME with `~`.
 * - Keeps at most the last two path segments so deep subdirs (e.g.
 *   `…/bound/packages/less`) still surface their parent (`packages/less`)
 *   instead of just the leaf (`less`), which would be ambiguous across repos.
 */
export function shortCwd(cwd: string): string {
	const home = homedir();
	let display = cwd;
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
		display = cwd === home ? "~" : `~${cwd.slice(home.length)}`;
	}
	const parts = display.split("/").filter(Boolean);
	if (parts.length <= 2) return display;
	return parts.slice(-2).join("/");
}

/**
 * Renders the bottom status bar as two zones pushed to opposite edges:
 *
 * LEFT (identity): connection badge · full thread ID · model · MCP count
 * RIGHT (environment): short working-directory label
 *
 * The full thread ID is intentionally rendered without truncation so operators
 * can select-and-copy it for `--attach` / debugging — see the existing
 * "renders the full thread ID without truncation" test for design intent.
 *
 * Layout: `width="100%"` on the outer Box plus a `flexGrow={1}` spacer between
 * the zones anchors the right side to the terminal edge instead of leaving
 * dead space on wide terminals.
 */
export function StatusBar({
	threadId,
	model,
	connectionState,
	mcpServerCount,
	cwd,
}: StatusBarProps): React.ReactElement {
	// ConnectionState's three values ("connecting" | "connected" | "disconnected")
	// are all valid BadgeStatus values, so the prop passes through directly.
	// Keeping this as a named binding so the intent — that the badge color reflects
	// the live WebSocket state — stays visible at the call site.
	const badgeStatus = connectionState;

	const sep = <Text dimColor> · </Text>;

	return (
		<Box paddingX={1} flexDirection="row" width="100%">
			<Box flexDirection="row">
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
			<Box flexGrow={1} />
			<Box>
				<Text dimColor>{shortCwd(cwd)}</Text>
			</Box>
		</Box>
	);
}
