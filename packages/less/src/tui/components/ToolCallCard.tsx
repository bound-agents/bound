import { Box, Text } from "ink";
import type React from "react";
import { Badge } from "./Badge";
import { Collapsible } from "./Collapsible";
import { Spinner } from "./Spinner";

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
export function ToolCallCard({ toolName, stdout }: ToolCallCardProps): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Box>
				<Spinner label={toolName} />
				<Text> </Text>
				<Badge status="running" />
			</Box>
			{stdout && (
				<Collapsible header="Output" defaultOpen={true}>
					<Text>{stdout}</Text>
				</Collapsible>
			)}
		</Box>
	);
}
