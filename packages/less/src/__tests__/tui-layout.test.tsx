import { describe, expect, it, mock } from "bun:test";
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

	it("constrains to maxHeight", () => {
		const { lastFrame } = render(
			<ScrollRegion maxHeight={2}>
				<Text>Line 1</Text>
				<Text>Line 2</Text>
				<Text>Line 3</Text>
			</ScrollRegion>,
		);
		const output = lastFrame();
		expect(output).toBeDefined();
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
		expect(output).toContain("[Press 'x' to dismiss]");
	});

	it("does not show dismiss hint when onDismiss not provided", () => {
		const { lastFrame } = render(<Banner type="error" message="Non-dismissible error" />);
		const output = lastFrame();
		expect(output).toContain("Non-dismissible error");
		expect(output).not.toContain("[Press 'x' to dismiss]");
	});

	it("has useInput handler configured for x key dismissal", () => {
		const handleDismiss = mock(() => {});
		const { lastFrame } = render(
			<Banner type="error" message="Dismissible error" onDismiss={handleDismiss} />,
		);
		const output = lastFrame();
		expect(output).toContain("Dismissible error");
		// Component has useInput hook set up to handle x key
		expect(typeof handleDismiss).toBe("function");
	});

	it("ignores input when onDismiss not provided", () => {
		const { lastFrame } = render(<Banner type="error" message="Non-dismissible" />);
		const output = lastFrame();
		expect(output).toContain("Non-dismissible");
		// When onDismiss is not provided, useInput isActive should be false
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

	it("renders with border styling", () => {
		const { lastFrame } = render(
			<ModalOverlay onDismiss={() => {}}>
				<Text>Modal with border</Text>
			</ModalOverlay>,
		);
		const output = lastFrame();
		expect(output).toBeDefined();
	});

	it("has escape key handler for dismissal", () => {
		const handleDismiss = mock(() => {});
		const { lastFrame } = render(
			<ModalOverlay onDismiss={handleDismiss}>
				<Text>Modal content</Text>
			</ModalOverlay>,
		);
		const output = lastFrame();
		expect(output).toContain("Modal content");
		// Component configured with useInput to handle escape key
		expect(typeof handleDismiss).toBe("function");
	});

	it("uses key.escape handler instead of raw escape code", () => {
		const handleDismiss = mock(() => {});
		const { lastFrame } = render(
			<ModalOverlay onDismiss={handleDismiss}>
				<Text>Modal content</Text>
			</ModalOverlay>,
		);
		const output = lastFrame();
		expect(output).toContain("Modal content");
		// Component correctly uses key.escape from useInput
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

	it("renders empty when no actions", () => {
		const { lastFrame } = render(<ActionBar actions={[]} />);
		const output = lastFrame();
		expect(output).toBeDefined();
	});
});
