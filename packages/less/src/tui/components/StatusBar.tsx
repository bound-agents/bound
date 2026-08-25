import type { ConnectionState } from "@bound/client";
import { Box, Text } from "ink";
import type React from "react";
import { type SessionHudState, formatTokens, formatUsd } from "../hooks/useSessionHud";
import { tildifyPath } from "../util/path";
import { Badge } from "./Badge";

export interface StatusBarProps {
	threadId: string;
	model: string | null;
	connectionState: ConnectionState;
	mcpServerCount: number;
	cwd: string;
	/** Live session HUD (context gauge + spend). Absent → those segments hide. */
	hud?: SessionHudState;
}

/** Color for the context gauge: calm → caution → pressure. */
export function contextGaugeColor(pct: number): string {
	if (pct >= 0.85) return "red";
	if (pct >= 0.6) return "yellow";
	return "green";
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
	const display = tildifyPath(cwd);
	// Split on either separator so a Windows path (`C:\Users\alice\repo\pkg`)
	// collapses to its last two segments just like a POSIX one. Rejoin with the
	// separator the path actually uses, so the label stays native.
	const sep = display.includes("\\") && !display.includes("/") ? "\\" : "/";
	const parts = display.split(/[/\\]/).filter(Boolean);
	if (parts.length <= 2) return display;
	return parts.slice(-2).join(sep);
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
	hud,
}: StatusBarProps): React.ReactElement {
	// ConnectionState's three values ("connecting" | "connected" | "disconnected")
	// are all valid BadgeStatus values, so the prop passes through directly.
	// Keeping this as a named binding so the intent — that the badge color reflects
	// the live WebSocket state — stays visible at the call site.
	const badgeStatus = connectionState;

	const sep = <Text dimColor> · </Text>;

	// HUD segments render only once their signal exists — a fresh session
	// shows nothing rather than a row of 0s pretending to be measurements.
	const ctxPct = hud?.contextPct ?? null;
	const showCtx = ctxPct != null && hud?.contextTokens != null;
	const showCost = hud?.threadCostUsd != null && hud?.todayCostUsd != null;
	// Background work shows only while something is actually in flight. A steady
	// "bg 0" would be noise on every idle thread, and unlike ctx/cost there is no
	// "not yet measured" state worth distinguishing from "none running".
	const bgCount = hud?.backgroundCount ?? 0;
	const showBg = bgCount > 0;

	return (
		<Box paddingX={1} flexDirection="column" width="100%">
			{/* HUD row — its own line so it never fights the identity row for
			    width (the full thread ID is copyable BY DESIGN and must not
			    wrap). One truncate-end Text = at most one physical row, so the
			    dynamic region's height stays predictable. */}
			{(showCtx || showCost || showBg) && (
				<Box>
					<Text wrap="truncate-end">
						{showCtx && (
							<>
								<Text color={contextGaugeColor(ctxPct)}>ctx {Math.round(ctxPct * 100)}%</Text>
								<Text dimColor>
									{" "}
									({formatTokens(hud.contextTokens ?? 0)}
									{hud.contextWindow != null ? `/${formatTokens(hud.contextWindow)}` : ""})
								</Text>
							</>
						)}
						{showCtx && showCost && sep}
						{showCost && (
							<Text dimColor>
								{formatUsd(hud.threadCostUsd ?? 0)} thread · {formatUsd(hud.todayCostUsd ?? 0)}{" "}
								today
							</Text>
						)}
						{(showCtx || showCost) && showBg && sep}
						{showBg && <Text color="magenta">● {bgCount} background</Text>}
					</Text>
				</Box>
			)}
			<Box flexDirection="row" width="100%">
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
		</Box>
	);
}
