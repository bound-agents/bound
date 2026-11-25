import { describe, expect, it, mock } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";

// A mocked small terminal: 16 rows. Resize is simulated by changing `rows`
// and re-rendering.
let rows = 16;
mock.module("../tui/hooks/useTerminalSize", () => ({
	useTerminalSize: () => ({ columns: 80, rows }),
}));

const { SelectList } = await import("../tui/components/SelectList");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const DOWN = "\u001B[B";
const items = Array.from({ length: 40 }, (_, i) => `item-${String(i).padStart(2, "0")}`);

function view() {
	return React.createElement(SelectList<string>, {
		items,
		onSelect: () => {},
		renderItem: (item: string, selected: boolean) =>
			React.createElement(Text, null, `${selected ? "> " : "  "}${item}`),
	});
}

const height = (frame: string | undefined) => (frame ?? "").split("\n").length;

describe("SelectList windowing", () => {
	it("keeps a fixed frame height while navigating and keeps the cursor visible", async () => {
		rows = 16;
		const { lastFrame, stdin } = render(view());
		await tick();
		const first = height(lastFrame());
		// rows(16) - reserved(8) - indicators(2) = 6 items + 2 indicator rows.
		expect(first).toBe(8);
		expect(lastFrame()).toContain("↓ 34 more");
		for (let i = 0; i < 25; i++) {
			stdin.write(DOWN);
			await tick();
			expect(height(lastFrame())).toBe(first);
			expect(lastFrame()).toContain(`> ${items[i + 1]}`);
		}
		expect(lastFrame()).toMatch(/↑ \d+ more/);
	});

	it("re-derives the window height on resize", async () => {
		rows = 16;
		const { lastFrame, rerender } = render(view());
		await tick();
		expect(height(lastFrame())).toBe(8);
		rows = 20;
		rerender(view());
		await tick();
		expect(height(lastFrame())).toBe(12);
		rows = 4;
		rerender(view());
		await tick();
		// Sane minimum: three items plus indicators.
		expect(height(lastFrame())).toBe(5);
	});
});
