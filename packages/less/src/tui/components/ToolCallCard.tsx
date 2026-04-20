import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge } from "./Badge";
import { Collapsible } from "./Collapsible";
import { Spinner } from "./Spinner";

/** Cap live stdout to avoid the dynamic area exceeding terminal height. */
const MAX_STDOUT_LINES = 15;

export interface ToolCallCardProps {
	toolName: string;
	startTime: number;
	stdout?: string;
}

/**
 * Renders an in-flight tool call with spinner and optional stdout streaming.
 * - Spinner with elapsed time since `startTime`
 * - Badge with "running" status and tool name
 * - If `stdout` provided: Collapsible with live stdout content, auto-expanded
 */
export function ToolCallCard({
	toolName,
	startTime,
	stdout,
}: ToolCallCardProps): React.ReactElement {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setElapsed(Math.floor((Date.now() - startTime) / 1000));
		}, 1000);
		return () => clearInterval(interval);
	}, [startTime]);

	const elapsedStr = `${elapsed}s`;

	return (
		<Box flexDirection="column">
			<Box>
				<Spinner label={toolName} />
				<Text> </Text>
				<Badge status="running" />
				<Text> {elapsedStr}</Text>
			</Box>
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
