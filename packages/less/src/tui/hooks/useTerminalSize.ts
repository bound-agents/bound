import { useStdout } from "ink";
import { useCallback, useEffect, useState } from "react";

export interface TerminalSize {
	columns: number;
	rows: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * Hook that returns the current terminal size and updates on resize.
 * Falls back to sensible defaults when stdout dimensions are unavailable.
 */
export function useTerminalSize(): TerminalSize {
	const { stdout } = useStdout();

	const getSize = useCallback(
		(): TerminalSize => ({
			columns: (stdout as { columns?: number })?.columns ?? DEFAULT_COLUMNS,
			rows: (stdout as { rows?: number })?.rows ?? DEFAULT_ROWS,
		}),
		[stdout],
	);

	const [size, setSize] = useState<TerminalSize>(getSize);

	useEffect(() => {
		const handleResize = () => {
			setSize(getSize());
		};

		stdout.on("resize", handleResize);
		return () => {
			stdout.off("resize", handleResize);
		};
	}, [stdout, getSize]);

	return size;
}
