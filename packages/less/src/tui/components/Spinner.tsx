import { Text } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
const FRAME_INTERVAL_MS = 80;
export interface SpinnerProps {
	label?: string;
	/**
	 * Epoch ms anchoring the elapsed counter; defaults to mount time. Threaded
	 * for long-running operations (a Yard run) whose spinner label swaps in
	 * mid-flight — the elapsed must reflect the operation, not this component's
	 * mount.
	 */
	startTime?: number;
}
export function Spinner({ label, startTime }: SpinnerProps): React.ReactElement {
	const [frame, setFrame] = useState(0);
	const mountTime = useRef(Date.now());

	useEffect(() => {
		const interval = setInterval(() => {
			setFrame((prev) => prev + 1);
		}, FRAME_INTERVAL_MS);

		return () => clearInterval(interval);
	}, []);

	const spinner = SPINNER_CHARS[frame % SPINNER_CHARS.length];
	const elapsed = Math.max(0, Math.floor((Date.now() - (startTime ?? mountTime.current)) / 1000));

	return (
		<Text>
			{spinner} {elapsed}s{label ? ` ${label}` : ""}
		</Text>
	);
}
