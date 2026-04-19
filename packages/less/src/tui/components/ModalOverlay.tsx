import { Box, useInput } from "ink";
import type React from "react";

export interface ModalOverlayProps {
	onDismiss: () => void;
	children: React.ReactNode;
}

export function ModalOverlay({ onDismiss, children }: ModalOverlayProps): React.ReactElement {
	useInput(
		(_input, key) => {
			if (key.escape) {
				onDismiss();
			}
		},
		{ isActive: true },
	);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} paddingY={1}>
			{children}
		</Box>
	);
}
