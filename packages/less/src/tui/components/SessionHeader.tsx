import { Box, Text } from "ink";
import type React from "react";
import { tildifyPath } from "../util/path";

export interface SessionHeaderProps {
	commitHash: string;
	cwd: string;
}

/**
 * Splash header rendered once at the top of the session log.
 *
 * Layout: a 7-line ASCII rendering of the bound favicon on the left, with two
 * top-justified lines on the right.
 *
 * The favicon (cream square, dark ring, solid center dot) maps to:
 *   - A chunky filled-block ring (▄ ▀ █) for the dark outline. Filled blocks
 *     instead of single-line box-drawing because a 1-char-thick ring reads as
 *     a rounded rectangle, not a circle. Width 16 / height 7 compensates for
 *     terminal cells being ~2:1 tall — equal char counts in both dimensions
 *     would render visibly squashed.
 *   - A solid `●` glyph (blue) for the center dot. Color-matched to the rest
 *     of the TUI's blue accents (tool_call/tool_result stripes) — the favicon
 *     itself is rust-red, but in the terminal the rest of the chrome is
 *     monochrome + blue, so a red dot pops out of theme.
 *
 * Right column:
 *   - Line 1: `boundless` (bold) · short commit hash
 *   - Line 2: tildified working directory
 *
 * Designed to render exactly once per session via Ink's `<Static>`, so it
 * scrolls with the rest of the log into the terminal's native scrollback.
 */
export function SessionHeader({ commitHash, cwd }: SessionHeaderProps): React.ReactElement {
	return (
		<Box flexDirection="row">
			<Box flexDirection="column" marginRight={2}>
				<Text dimColor>{"     ▄▄▄▄▄▄     "}</Text>
				<Text dimColor>{"   ▄████████▄   "}</Text>
				<Text dimColor>{"  ███      ███  "}</Text>
				<Box flexDirection="row">
					<Text dimColor>{" ██    "}</Text>
					<Text color="blue">●</Text>
					<Text dimColor>{"     ██ "}</Text>
				</Box>
				<Text dimColor>{"  ███      ███  "}</Text>
				<Text dimColor>{"   ▀████████▀   "}</Text>
				<Text dimColor>{"     ▀▀▀▀▀▀     "}</Text>
			</Box>
			<Box flexDirection="column">
				<Box flexDirection="row">
					<Text bold>boundless</Text>
					<Text dimColor>{" · "}</Text>
					<Text dimColor>{commitHash}</Text>
				</Box>
				<Text dimColor>{tildifyPath(cwd)}</Text>
			</Box>
		</Box>
	);
}
