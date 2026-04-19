import { Box } from "ink";
import type React from "react";

export interface ScrollRegionProps {
	maxHeight?: number;
	children: React.ReactNode;
}

export function ScrollRegion({ maxHeight, children }: ScrollRegionProps): React.ReactElement {
	return (
		<Box flexDirection="column" height={maxHeight} overflow="hidden">
			{children}
		</Box>
	);
}
