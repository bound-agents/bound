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
			} else if (key.backspace) {
				setValue((prev) => prev.slice(0, -1));
			} else if (input && input.length > 0) {
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
