import { Text } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
const FRAME_INTERVAL_MS = 80;

export interface SpinnerProps {
	label?: string;
}

export function Spinner({ label }: SpinnerProps): React.ReactElement {
	const [frame, setFrame] = useState(0);
	const startTime = useRef(Date.now());

	useEffect(() => {
		const interval = setInterval(() => {
			setFrame((prev) => prev + 1);
		}, FRAME_INTERVAL_MS);

		return () => clearInterval(interval);
	}, []);

	const spinner = SPINNER_CHARS[frame % SPINNER_CHARS.length];
	const elapsed = Math.floor((Date.now() - startTime.current) / 1000);

	return (
		<Text>
			{spinner} {elapsed}s{label ? ` ${label}` : ""}
		</Text>
	);
}
