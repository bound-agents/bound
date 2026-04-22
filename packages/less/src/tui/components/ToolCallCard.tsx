import { Box, Text } from "ink";
import type React from "react";
import { Collapsible } from "./Collapsible";
import { Spinner } from "./Spinner";

/** Cap live stdout to avoid the dynamic area exceeding terminal height. */
const MAX_STDOUT_LINES = 15;

/** Strip the "boundless_" prefix from local tool names for cleaner display. */
function displayToolName(name: string): string {
	return name.startsWith("boundless_") ? name.slice("boundless_".length) : name;
}

export interface ToolCallCardProps {
	toolName: string;
	startTime: number;
	stdout?: string;
}

/**
 * Renders an in-flight tool call with spinner and optional stdout streaming.
 * - Spinner with display name and elapsed time
 * - If `stdout` provided: Collapsible with live stdout content, auto-expanded
 */
export function ToolCallCard({ toolName, stdout }: ToolCallCardProps): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Spinner label={displayToolName(toolName)} />
			{stdout && (
				<Collapsible header="Output" defaultOpen={true}>
					<Text>
						{stdout.split("\n").length > MAX_STDOUT_LINES
							? `${stdout.split("\n").slice(-MAX_STDOUT_LINES).join("\n")}\n... (showing last ${MAX_STDOUT_LINES} lines)`
							: stdout}
					</Text>
				</Collapsible>
			)}
		</Box>
	);
}
