import { Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface TextInputProps {
	onSubmit: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
}

export function TextInput({
	onSubmit,
	placeholder = "",
	disabled = false,
}: TextInputProps): React.ReactElement {
	const [value, setValue] = useState("");

	useInput(
		(input, key) => {
			if (disabled) {
				return;
			}

			if (key.return) {
				onSubmit(value);
				setValue("");
			} else if (key.backspace || key.delete) {
				setValue((prev) => prev.slice(0, -1));
			} else if (key.ctrl || key.meta || key.escape) {
				// Ignore control sequences — don't append characters
				return;
			} else if (input && input.length > 0) {
				// Filter out mouse escape sequences that leak through Ink's parser.
				// After ESC stripping, they look like "[<0;17;23M" or "[M..."
				if (input.startsWith("[<") || input.startsWith("[M")) {
					return;
				}
				setValue((prev) => prev + input);
			}
		},
		{ isActive: !disabled },
	);

	const displayText = value || (disabled ? "" : placeholder);
	const isDim = !value && !disabled;

	return (
		<Text dimColor={isDim}>
			{displayText}
			{!disabled && "▌"}
		</Text>
	);
}
