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
 *     a rounded rectangle, not a circle. Width 17 (odd) so the single center
 *     dot lands at col 9 — the true horizontal center — instead of being a
 *     half-cell off as it would be in any even-width layout. Height stays at
 *     7 so row 4 is the true vertical center; going taller would stretch
 *     the silhouette and undo the rounding gain from going wider.
 *   - A solid `●` glyph (blueBright) for the center dot. Same hue family as
 *     the `color="blue"` accent stripes used by tool_call/tool_result blocks,
 *     but rendered at the bright-ANSI intensity level. A single ● glyph reads
 *     as less saturated than a multi-char vertical stripe at the same color
 *     code (smaller target, less aliasing) — bumping to blueBright keeps the
 *     dot perceptually matched with the stripes the operator sees throughout
 *     the rest of the session log.
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
				<Text dimColor>{"     ▄▄▄▄▄▄▄     "}</Text>
				<Text dimColor>{"   ▄█████████▄   "}</Text>
				<Text dimColor>{"  ███       ███  "}</Text>
				<Box flexDirection="row">
					<Text dimColor>{" ██     "}</Text>
					<Text color="blueBright">●</Text>
					<Text dimColor>{"     ██ "}</Text>
				</Box>
				<Text dimColor>{"  ███       ███  "}</Text>
				<Text dimColor>{"   ▀█████████▀   "}</Text>
				<Text dimColor>{"     ▀▀▀▀▀▀▀     "}</Text>
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
