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
 * Layout: an 8-line ASCII rendering of the bound favicon on the left, with
 * `boundless · hash` and the cwd in the right column, dropped one line so
 * the bold name aligns with the top arc of the circle (row 2) instead of
 * the thin cap (row 1) — the chunky arc is where the icon's visual mass
 * starts, so the wordmark anchors there.
 *
 * The favicon (cream square, dark ring, solid center dot) maps to:
 *   - A chunky filled-block ring (▄ ▀ █) for the outline. Filled blocks
 *     instead of single-line box-drawing because a 1-char-thick ring reads as
 *     a rounded rectangle, not a circle. Width 17 (odd) so the single center
 *     dot lands at col 9 — the true horizontal center — instead of being a
 *     half-cell off as it would be in any even-width layout. Height 8 so the
 *     17:16 char:cell-pixel ratio (terminal cells are ~2:1 tall) reads as
 *     close to circular; 7 rows was visibly squashed at the new width.
 *   - A half-block diamond (▄███▄ / ▀███▀) for the center dot. The 5-cell-
 *     wide × 2-row block uses lower-half-blocks at the top corners and
 *     upper-half-blocks at the bottom corners, which chamfers the silhouette
 *     into a rounded blob and — more importantly — places the dot's visual
 *     mass exactly at the boundary between rows 4 and 5, which IS the
 *     geometric center of an 8-row layout. A single-glyph dot in row 4 read
 *     as one unit too high; this is centered on the axis.
 *
 * The whole favicon renders in cyan — dimColor on the ring read as dead
 * pixels on a black terminal background, and cyan is already the dominant
 * accent throughout the rest of the chrome (status bar, key hints,
 * tool-call headers, slash commands, picker arrows), so the splash reads
 * as part of the same accent family the operator sees everywhere else in
 * the session. (The blue stripes on tool_call / tool_result blocks are a
 * separate visual layer for turn-grouping; the splash is chrome.)
 *
 * Right column:
 *   - Line 1: (blank, for alignment with top arc)
 *   - Line 2: `boundless` (bold) · short commit hash
 *   - Line 3: tildified working directory
 *
 * Designed to render exactly once per session via Ink's `<Static>`, so it
 * scrolls with the rest of the log into the terminal's native scrollback.
 */
export function SessionHeader({ commitHash, cwd }: SessionHeaderProps): React.ReactElement {
	return (
		<Box flexDirection="row">
			<Box flexDirection="column" marginRight={2}>
				<Text color="cyan">{"     ▄▄▄▄▄▄▄     "}</Text>
				<Text color="cyan">{"   ▄█████████▄   "}</Text>
				<Text color="cyan">{"  ███       ███  "}</Text>
				<Text color="cyan">{" ██   ▄███▄   ██ "}</Text>
				<Text color="cyan">{" ██   ▀███▀   ██ "}</Text>
				<Text color="cyan">{"  ███       ███  "}</Text>
				<Text color="cyan">{"   ▀█████████▀   "}</Text>
				<Text color="cyan">{"     ▀▀▀▀▀▀▀     "}</Text>
			</Box>
			<Box flexDirection="column" marginTop={1}>
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
