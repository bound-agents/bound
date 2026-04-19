import { Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface ConfirmProps {
	message: string;
	onYes: () => void;
	onNo: () => void;
}

export function Confirm({ message, onYes, onNo }: ConfirmProps): React.ReactElement {
	const [selection, _setSelection] = useState<"yes" | "no">("yes");

	useInput((input) => {
		if (input === "y" || input === "Y") {
			onYes();
		} else if (input === "n" || input === "N") {
			onNo();
		} else if (input === "\r") {
			if (selection === "yes") {
				onYes();
			} else {
				onNo();
			}
		}
	});

	return (
		<Text>
			{message} {selection === "yes" ? "[Y/n]" : "[y/N]"}
		</Text>
	);
}
