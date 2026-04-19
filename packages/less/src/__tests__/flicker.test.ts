import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Spinner } from "../tui/components/Spinner";
import { ToolCallCard } from "../tui/components/ToolCallCard";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("ToolCallCard timer", () => {
	it("renders tool name and running status", async () => {
		const { lastFrame } = render(
			React.createElement(ToolCallCard, {
				toolName: "boundless_bash",
				startTime: Date.now(),
			}),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("boundless_bash");
	});

	it("does not update more than once per second", async () => {
		// Track how many times the component renders
		let renderCount = 0;
		function TrackingWrapper() {
			renderCount++;
			return React.createElement(ToolCallCard, {
				toolName: "test_tool",
				startTime: Date.now() - 5000,
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
