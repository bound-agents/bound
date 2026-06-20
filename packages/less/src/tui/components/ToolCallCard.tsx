import { Box, Text } from "ink";
import type React from "react";
import { wrapLineAtWidth } from "../util/wrap";
import { Collapsible } from "./Collapsible";
import { Spinner } from "./Spinner";

/**
 * Cap live stdout to avoid the dynamic area exceeding terminal height.
 * Counts VISUAL rows (after hard-wrap), not `\n`-split logical lines —
 * a single 100KB line wraps to ~hundreds of physical rows in a normal
 * terminal, blowing past terminal height under the legacy
 * `split("\n").length` check (#74).
 */
const MAX_STDOUT_ROWS = 15;

/** Strip the "boundless_" prefix from local tool names for cleaner display. */
function displayToolName(name: string): string {
	if (name.startsWith("boundless_")) return name.slice("boundless_".length);
	if (name.startsWith("bms_")) return name.slice("bms_".length);
	return name;
}

export interface ToolCallCardProps {
	toolName: string;
	startTime: number;
	stdout?: string;
	/**
	 * Live terminal column count from `useTerminalSize()` in the parent view.
	 * Used to wrap long single-line stdout (e.g., a JSON dump from `cat`)
	 * into deterministic visual rows so the truncation cap counts physical
	 * rows. Without this, one huge line counts as 1 logical line, escapes
	 * the cap, and lets the terminal's own soft-wrap blow out vertical space.
	 */
	terminalColumns: number;
}

/**
 * Renders an in-flight tool call with spinner and optional stdout streaming.
 * - Spinner with display name and elapsed time
 * - If `stdout` provided: Collapsible with live stdout content, auto-expanded.
 *   Stdout is hard-wrapped at the terminal width and truncated to the last
 *   MAX_STDOUT_ROWS visual rows.
 */
export function ToolCallCard({
	toolName,
	stdout,
	terminalColumns,
}: ToolCallCardProps): React.ReactElement {
	let stdoutDisplay: string | undefined;
	if (stdout) {
		// Wrap budget: leave a couple cols for the Collapsible header/border
		// and any ancestor padding so visual rows don't accidentally trigger
		// the terminal's own soft-wrap.
		const wrapColumn = Math.max(1, terminalColumns - 4);
		// Flatten logical lines into visual rows.
		const allVisualRows: string[] = [];
		for (const line of stdout.split("\n")) {
			allVisualRows.push(...wrapLineAtWidth(line, wrapColumn));
		}
		if (allVisualRows.length > MAX_STDOUT_ROWS) {
			const tail = allVisualRows.slice(-MAX_STDOUT_ROWS).join("\n");
			stdoutDisplay = `${tail}\n... (showing last ${MAX_STDOUT_ROWS} lines)`;
		} else {
			stdoutDisplay = allVisualRows.join("\n");
		}
	}

	return (
		<Box flexDirection="column">
			<Spinner label={displayToolName(toolName)} />
			{stdoutDisplay !== undefined && (
				<Collapsible header="Output" defaultOpen={true}>
					<Text>{stdoutDisplay}</Text>
				</Collapsible>
			)}
		</Box>
	);
}
