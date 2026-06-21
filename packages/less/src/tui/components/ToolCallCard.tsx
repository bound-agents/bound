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

/**
 * Fixed-chrome rows in the dynamic (live) region that are NOT a tool card:
 * the rounded input frame (top border + content + bottom border = 3), the
 * status bar (1), and the action bar (1).
 */
const DYNAMIC_CHROME_ROWS = 5;

/**
 * Per-card overhead beyond the streamed stdout body, charged once per
 * in-flight tool: the spinner line, the Collapsible "Output" header, the
 * "showing last N lines" truncation note, and the card's marginBottom.
 */
const PER_CARD_CHROME_ROWS = 4;

/** One-row cushion for rounding and the occasional banner / ctrl-C hint. */
const SAFETY_ROWS = 1;

/**
 * Per-card stdout row budget that keeps the WHOLE dynamic region within the
 * terminal viewport.
 *
 * This is the load-bearing fix for the "pending indicator pushed up into
 * history" bug. When the live region's rendered height reaches `stdout.rows`,
 * Ink takes its `outputHeight >= rows` branch (ink/build/ink.js): it writes
 * `clearTerminal + fullStaticOutput + output` directly to stdout and BYPASSES
 * logUpdate, so logUpdate's internal `previousLineCount` goes stale. On the
 * next sub-viewport render logUpdate erases that stale (smaller) count instead
 * of the tall frame actually on screen — stranding the bottom rows, including
 * the in-flight `⠇ 6s bash` spinner card, permanently in scrollback.
 *
 * The static `MAX_STDOUT_ROWS = 15` cap (#74) only bounds a single tool's
 * output; it ignores fixed chrome and parallel in-flight tools, so a short
 * terminal or two streaming tools still overflow. Distributing the remaining
 * rows across the live in-flight tools keeps the live region under the
 * viewport so Ink never takes the stranding branch.
 *
 * Pure function of (terminal rows, in-flight count) so it stays unit-testable.
 */
export function computeStdoutRowBudget(termRows: number, numInFlight: number): number {
	// No cards in flight: nothing to distribute; report the legacy hard cap.
	if (numInFlight <= 0) return MAX_STDOUT_ROWS;
	const remaining =
		termRows - DYNAMIC_CHROME_ROWS - SAFETY_ROWS - numInFlight * PER_CARD_CHROME_ROWS;
	if (remaining <= 0) return 0;
	const perCard = Math.floor(remaining / numInFlight);
	return Math.max(0, Math.min(MAX_STDOUT_ROWS, perCard));
}

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
	/**
	 * Maximum visual rows of streamed stdout this card may render. Defaults to
	 * the legacy hard cap; ChatView passes a tighter, parallelism-aware budget
	 * from `computeStdoutRowBudget` so the aggregate live region stays under the
	 * terminal viewport. A value <= 0 suppresses the stdout block entirely (the
	 * spinner line alone) — which keeps the card from stranding in scrollback on
	 * short terminals. See `computeStdoutRowBudget`.
	 */
	maxStdoutRows?: number;
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
	maxStdoutRows = MAX_STDOUT_ROWS,
}: ToolCallCardProps): React.ReactElement {
	// Effective cap: never above the legacy hard cap, never below zero. A cap of
	// 0 means the dynamic region has no room for streamed output, so we render
	// the spinner line alone — see computeStdoutRowBudget for why that prevents
	// the card from stranding in scrollback.
	const rowCap = Math.max(0, Math.min(MAX_STDOUT_ROWS, maxStdoutRows));
	let stdoutDisplay: string | undefined;
	if (stdout && rowCap > 0) {
		// Wrap budget: leave a couple cols for the Collapsible header/border
		// and any ancestor padding so visual rows don't accidentally trigger
		// the terminal's own soft-wrap.
		const wrapColumn = Math.max(1, terminalColumns - 4);
		// Flatten logical lines into visual rows.
		const allVisualRows: string[] = [];
		for (const line of stdout.split("\n")) {
			allVisualRows.push(...wrapLineAtWidth(line, wrapColumn));
		}
		if (allVisualRows.length > rowCap) {
			const tail = allVisualRows.slice(-rowCap).join("\n");
			stdoutDisplay = `${tail}\n... (showing last ${rowCap} lines)`;
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
