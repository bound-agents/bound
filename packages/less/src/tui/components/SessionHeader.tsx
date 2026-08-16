import { Box, Text } from "ink";
import type React from "react";
import { tildifyPath } from "../util/path";

export interface SessionHeaderProps {
	commitHash: string;
	cwd: string;
}

/** Static splash header: an 8-line cyan favicon beside the version and tildified cwd. */
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
				<Text color="cyan">Beginning service to the Boundless Satellite Station</Text>
				<Text dimColor>{tildifyPath(cwd)}</Text>
			</Box>
		</Box>
	);
}
