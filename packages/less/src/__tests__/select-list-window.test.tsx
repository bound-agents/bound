import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";

// Drive the real useTerminalSize hook through the test stdout: set `rows`
// and emit "resize". mock.module would leak the stub into every later test
// file in the same Bun process (it broke use-terminal-size.test.ts).
import { SelectList } from "../tui/components/SelectList";

type TestStdout = { rows?: number; emit: (event: string) => boolean };
function resize(stdout: unknown, rows: number) {
	const s = stdout as TestStdout;
	s.rows = rows;
	s.emit("resize");
}

/** Mount, let the hook's resize listener attach, then size the terminal. */
async function mount(rows: number) {
	const r = render(view());
	await tick();
	resize(r.stdout, rows);
	await tick();
	return r;
}

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
		const { lastFrame, stdin } = await mount(16);
		const first = height(lastFrame());
		// rows(16) - reserved(9) - indicators(2) = 5 items + 2 indicator rows.
		expect(first).toBe(7);
		expect(lastFrame()).toContain("↓ 35 more");
		for (let i = 0; i < 25; i++) {
			stdin.write(DOWN);
			await tick();
			expect(height(lastFrame())).toBe(first);
			expect(lastFrame()).toContain(`> ${items[i + 1]}`);
		}
		expect(lastFrame()).toMatch(/↑ \d+ more/);
	});

	it("re-derives the window height on resize", async () => {
		const { lastFrame, stdout } = await mount(16);
		expect(height(lastFrame())).toBe(7);
		resize(stdout, 20);
		await tick();
		expect(height(lastFrame())).toBe(11);
		resize(stdout, 4);
		await tick();
		// Floor: one item plus indicators, so tiny terminals stay under rows.
		expect(height(lastFrame())).toBe(3);
	});
});

describe("SelectList reserved-rows contract", () => {
	it("documents a reservedRows default that equals modal chrome plus Ink's spare row", async () => {
		const mod = await import("../tui/components/SelectList");
		expect(mod.MODAL_LIST_RESERVED_ROWS).toBe(mod.MODAL_LIST_CHROME_ROWS + mod.INK_SPARE_ROWS);
		expect(mod.INK_SPARE_ROWS).toBeGreaterThanOrEqual(1);
	});
});
