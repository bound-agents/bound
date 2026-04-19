import { Box } from "ink";
import type React from "react";
import { KeyHint } from "./KeyHint.js";

export interface ActionBarAction {
	keys: string;
	label: string;
}

export interface ActionBarProps {
	actions: ActionBarAction[];
}

export function ActionBar({ actions }: ActionBarProps): React.ReactElement {
	return (
		<Box flexDirection="row" gap={1}>
			{actions.map((action) => (
				<Box key={`${action.keys}-${action.label}`}>
					<KeyHint keys={action.keys} label={action.label} />
				</Box>
			))}
		</Box>
	);
}
