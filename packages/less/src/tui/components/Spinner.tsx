import { Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");

export interface SpinnerProps {
	label?: string;
}

export function Spinner({ label }: SpinnerProps): React.ReactElement {
	const [elapsed, setElapsed] = useState(0);
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setElapsed((prev) => prev + 1);
			setFrame((prev) => (prev + 1) % SPINNER_CHARS.length);
		}, 1000);

		return () => clearInterval(interval);
	}, []);

	const spinner = SPINNER_CHARS[frame];

	return (
		<Text>
			{spinner} {elapsed}s{label ? ` ${label}` : ""}
		</Text>
	);
}
