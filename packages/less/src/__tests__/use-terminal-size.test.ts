import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { useTerminalSize } from "../tui/hooks/useTerminalSize";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("useTerminalSize", () => {
	it("returns columns and rows from stdout", async () => {
		let size: { columns: number; rows: number } | null = null;

		function Harness() {
			size = useTerminalSize();
			return React.createElement(Text, null, `${size.columns}x${size.rows}`);
		}

		render(React.createElement(Harness));
		await tick();

		// ink-testing-library's Stdout has columns=100, no rows
		// Our hook should provide a reasonable default for rows
		expect(size).not.toBeNull();
		expect(size?.columns).toBeGreaterThan(0);
		expect(size?.rows).toBeGreaterThan(0);
	});

	it("returns default rows when stdout has no rows property", async () => {
		let size: { columns: number; rows: number } | null = null;

		function Harness() {
			size = useTerminalSize();
			return React.createElement(Text, null, `rows:${size.rows}`);
		}

		render(React.createElement(Harness));
		await tick();

		// ink-testing-library mock stdout doesn't have rows, so should use default
		expect(size?.rows).toBe(24);
	});
});
