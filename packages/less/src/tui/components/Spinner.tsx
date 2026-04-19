import { Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");

export interface SpinnerProps {
	label?: string;
}

export function Spinner({ label }: SpinnerProps): React.ReactElement {
	// Single state counter drives both spinner frame and elapsed display
	const [tick, setTick] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setTick((prev) => prev + 1);
		}, 1000);

		return () => clearInterval(interval);
	}, []);

	const spinner = SPINNER_CHARS[tick % SPINNER_CHARS.length];

	return (
		<Text>
			{spinner} {tick}s{label ? ` ${label}` : ""}
		</Text>
	);
}
