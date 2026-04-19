import { Box } from "ink";
import type React from "react";

export interface SplitViewProps {
	top: React.ReactNode;
	bottom: React.ReactNode;
}

export function SplitView({ top, bottom }: SplitViewProps): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Box>{top}</Box>
			<Box>{bottom}</Box>
		</Box>
	);
}
