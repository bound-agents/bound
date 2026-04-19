import { Box, Text } from "ink";
import type React from "react";
import { useState } from "react";

export interface CollapsibleProps {
	header: string;
	defaultOpen?: boolean;
	children?: React.ReactNode;
}

export function Collapsible({
	header,
	defaultOpen = false,
	children,
}: CollapsibleProps): React.ReactElement {
	const [isOpen] = useState(defaultOpen);

	return (
		<Box flexDirection="column">
			<Text>
				{isOpen ? "▾" : "▸"} {header}
			</Text>
			{isOpen && <Box>{typeof children === "string" ? <Text>{children}</Text> : children}</Box>}
		</Box>
	);
}
