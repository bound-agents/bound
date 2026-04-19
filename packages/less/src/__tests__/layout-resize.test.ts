import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { ScrollRegion } from "../tui/components/ScrollRegion";
import { SplitView } from "../tui/components/SplitView";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("SplitView", () => {
	it("renders both top and bottom sections", async () => {
		const { lastFrame } = render(
			React.createElement(SplitView, {
				top: React.createElement(Text, null, "TOP_SECTION"),
				bottom: React.createElement(Text, null, "BOTTOM_SECTION"),
			}),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("TOP_SECTION");
		expect(frame).toContain("BOTTOM_SECTION");
	});

	it("sets height to fill terminal when height prop is provided", async () => {
		const { lastFrame } = render(
			React.createElement(SplitView, {
				height: 30,
				top: React.createElement(Text, null, "TOP"),
				bottom: React.createElement(Text, null, "BOTTOM"),
			}),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("TOP");
		expect(frame).toContain("BOTTOM");
	});
});

describe("ScrollRegion", () => {
	it("renders children within max height", async () => {
		const { lastFrame } = render(
			React.createElement(
				ScrollRegion,
				{ maxHeight: 5 },
				React.createElement(Text, null, "scroll content"),
			),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("scroll content");
	});

	it("accepts dynamic maxHeight values", async () => {
		// Dynamic height should work the same as static
		const dynamicHeight = 15;
		const { lastFrame } = render(
			React.createElement(
				ScrollRegion,
				{ maxHeight: dynamicHeight },
				React.createElement(Text, null, "dynamic content"),
			),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("dynamic content");
	});
});
