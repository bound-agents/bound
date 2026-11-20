import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ActionBar } from "../tui/components/ActionBar.js";
import { Banner } from "../tui/components/Banner.js";
import { ModalOverlay } from "../tui/components/ModalOverlay.js";
import { ScrollRegion } from "../tui/components/ScrollRegion.js";
import { SplitView } from "../tui/components/SplitView.js";

describe("ScrollRegion", () => {
	it("renders children", () => {
		const { lastFrame } = render(
			<ScrollRegion>
				<Text>Child content</Text>
			</ScrollRegion>,
		);
		const output = lastFrame();
		expect(output).toContain("Child content");
	});
});

describe("Banner", () => {
	it("renders error banner with message", () => {
		const { lastFrame } = render(<Banner type="error" message="An error occurred" />);
		const output = lastFrame();
		expect(output).toContain("An error occurred");
	});

	it("renders info banner with message", () => {
		const { lastFrame } = render(<Banner type="info" message="Information message" />);
		const output = lastFrame();
		expect(output).toContain("Information message");
	});

	it("includes dismiss hint when onDismiss provided", () => {
		const { lastFrame } = render(
			<Banner type="error" message="Dismissible error" onDismiss={() => {}} />,
		);
		const output = lastFrame();
		expect(output).toContain("Dismissible error");
		expect(output).toContain("[press 'x' to dismiss]");
	});

	it("does not show dismiss hint when onDismiss not provided", () => {
		const { lastFrame } = render(<Banner type="error" message="Non-dismissible error" />);
		const output = lastFrame();
		expect(output).toContain("Non-dismissible error");
		expect(output).not.toContain("[press 'x' to dismiss]");
	});
});

describe("ModalOverlay", () => {
	it("renders children on top", () => {
		const { lastFrame } = render(
			<ModalOverlay onDismiss={() => {}}>
				<Text>Modal content</Text>
			</ModalOverlay>,
		);
		const output = lastFrame();
		expect(output).toContain("Modal content");
	});
});

describe("SplitView", () => {
	it("renders top and bottom sections", () => {
		const { lastFrame } = render(
			<SplitView top={<Text>Top content</Text>} bottom={<Text>Bottom content</Text>} />,
		);
		const output = lastFrame();
		expect(output).toContain("Top content");
		expect(output).toContain("Bottom content");
	});
});

describe("ActionBar", () => {
	it("renders actions with KeyHint components", () => {
		const { lastFrame } = render(
			<ActionBar
				actions={[
					{ keys: "Ctrl+C", label: "Cancel" },
					{ keys: "Enter", label: "Submit" },
				]}
			/>,
		);
		const output = lastFrame();
		expect(output).toContain("Ctrl+C");
		expect(output).toContain("Cancel");
		expect(output).toContain("Enter");
		expect(output).toContain("Submit");
	});
});
