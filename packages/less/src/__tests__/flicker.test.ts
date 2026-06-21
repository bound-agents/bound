import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Spinner } from "../tui/components/Spinner";
import { ToolCallCard, computeStdoutRowBudget } from "../tui/components/ToolCallCard";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("ToolCallCard timer", () => {
	it("renders tool name and running status", async () => {
		const { lastFrame } = render(
			React.createElement(ToolCallCard, {
				toolName: "boundless_bash",
				startTime: Date.now(),
				terminalColumns: 80,
			}),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("bash");
	});

	it("does not update more than once per second", async () => {
		// Track how many times the component renders
		let renderCount = 0;
		function TrackingWrapper() {
			renderCount++;
			return React.createElement(ToolCallCard, {
				toolName: "test_tool",
				startTime: Date.now() - 5000,
				terminalColumns: 80,
			});
		}

		render(React.createElement(TrackingWrapper));
		await tick();

		const initialCount = renderCount;

		// Wait 500ms — should NOT cause additional renders if interval is >= 1s
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Allow for at most 1 extra render from the 1s timer if it happened to fire
		expect(renderCount - initialCount).toBeLessThanOrEqual(1);
	});
});

describe("Spinner timer", () => {
	it("renders spinner character and label", async () => {
		const { lastFrame } = render(React.createElement(Spinner, { label: "loading" }));
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("loading");
	});
});

describe("computeStdoutRowBudget", () => {
	// The dynamic region must never exceed terminal height, or Ink's
	// `outputHeight >= rows` branch fires, bypasses logUpdate's line
	// tracking, and strands the in-flight tool card in scrollback (#tui).

	it("gives a single in-flight tool a generous budget on a normal terminal", () => {
		// 24 rows - fixed chrome (5) - safety (1) - per-card chrome (4) = 14
		expect(computeStdoutRowBudget(24, 1)).toBe(14);
	});

	it("splits the budget across parallel in-flight tools", () => {
		// 24 - 5 - 1 - 2*4 = 10, /2 = 5 each
		expect(computeStdoutRowBudget(24, 2)).toBe(5);
	});

	it("never exceeds the legacy hard cap on a tall terminal", () => {
		expect(computeStdoutRowBudget(200, 1)).toBe(15);
	});

	it("returns 0 (no streamed output) when the terminal is too short", () => {
		expect(computeStdoutRowBudget(10, 1)).toBe(0);
		expect(computeStdoutRowBudget(8, 3)).toBe(0);
	});

	it("never returns a negative budget", () => {
		expect(computeStdoutRowBudget(4, 5)).toBeGreaterThanOrEqual(0);
	});

	it("treats zero in-flight tools as the hard cap (no division by zero)", () => {
		expect(computeStdoutRowBudget(24, 0)).toBe(15);
	});

	it("keeps the whole dynamic region within the viewport for 1 tool", () => {
		const rows = 24;
		const budget = computeStdoutRowBudget(rows, 1);
		// spinner(1) + collapsible header(1) + budget + truncation note(1) + margin(1) + chrome(5)
		const dynamicHeight = 1 + 1 + budget + 1 + 1 + 5;
		expect(dynamicHeight).toBeLessThanOrEqual(rows);
	});
});

describe("ToolCallCard stdout cap", () => {
	it("omits streamed output entirely when the row budget is 0", async () => {
		const { lastFrame } = render(
			React.createElement(ToolCallCard, {
				toolName: "boundless_bash",
				startTime: Date.now(),
				stdout: "line one\nline two\nline three",
				terminalColumns: 80,
				maxStdoutRows: 0,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("bash");
		expect(frame).not.toContain("line one");
		expect(frame).not.toContain("Output");
	});

	it("truncates streamed output to the passed row budget", async () => {
		const stdout = Array.from({ length: 30 }, (_, i) => `row${i}`).join("\n");
		const { lastFrame } = render(
			React.createElement(ToolCallCard, {
				toolName: "boundless_bash",
				startTime: Date.now(),
				stdout,
				terminalColumns: 80,
				maxStdoutRows: 5,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("showing last 5 lines");
		expect(frame).toContain("row29");
		expect(frame).not.toContain("row0\n");
	});
});
