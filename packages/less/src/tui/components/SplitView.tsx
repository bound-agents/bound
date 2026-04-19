import { Box } from "ink";
import type React from "react";

export interface SplitViewProps {
	top: React.ReactNode;
	bottom: React.ReactNode;
	/** Total height in rows. When set, the top section grows to fill available space. */
	height?: number;
}

export function SplitView({ top, bottom, height }: SplitViewProps): React.ReactElement {
	return (
		<Box flexDirection="column" height={height}>
			<Box flexGrow={1} flexDirection="column" overflow="hidden">
				{top}
			</Box>
			<Box flexShrink={0}>{bottom}</Box>
		</Box>
	);
}
