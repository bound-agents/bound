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
 * top-justified lines of text on the right. The favicon (cream square, dark
 * ring, rust-red dot) maps to:
 *   - Outer rounded box-drawing (dimColor) — corresponds to the dark ring
 *   - Inner `●` glyph (red) — corresponds to the rust-red dot
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
				<Text dimColor>{"   ╭─────╮"}</Text>
				<Text dimColor>{"  ╱       ╲"}</Text>
				<Text dimColor>{" │         │"}</Text>
				<Box flexDirection="row">
					<Text dimColor>{" │    "}</Text>
					<Text color="red">●</Text>
					<Text dimColor>{"    │"}</Text>
				</Box>
				<Text dimColor>{" │         │"}</Text>
				<Text dimColor>{"  ╲       ╱"}</Text>
				<Text dimColor>{"   ╰─────╯"}</Text>
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
