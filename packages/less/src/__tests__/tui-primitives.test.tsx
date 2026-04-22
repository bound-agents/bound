import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { Badge } from "../tui/components/Badge.js";
import { Collapsible } from "../tui/components/Collapsible.js";
import { KeyHint } from "../tui/components/KeyHint.js";
import { Spinner } from "../tui/components/Spinner.js";

describe("Spinner", () => {
	it("renders with initial elapsed time", () => {
		const { lastFrame } = render(<Spinner />);
		expect(lastFrame()).toContain("0s");
	});
});

describe("Badge", () => {
	it("renders running status as colored dot", () => {
		const { lastFrame } = render(<Badge status="running" />);
		expect(lastFrame()).toContain("●");
	});

	it("renders failed status as colored dot", () => {
		const { lastFrame } = render(<Badge status="failed" />);
		expect(lastFrame()).toContain("●");
	});

	it("renders disabled status as colored dot", () => {
		const { lastFrame } = render(<Badge status="disabled" />);
		expect(lastFrame()).toContain("●");
	});

	it("renders connected status as colored dot", () => {
		const { lastFrame } = render(<Badge status="connected" />);
		expect(lastFrame()).toContain("●");
	});

	it("renders disconnected status as colored dot", () => {
		const { lastFrame } = render(<Badge status="disconnected" />);
		expect(lastFrame()).toContain("●");
	});
});

describe("KeyHint", () => {
	it("renders keys and label", () => {
		const { lastFrame } = render(<KeyHint keys="Ctrl+C" label="Cancel" />);
		const output = lastFrame();
		expect(output).toContain("Ctrl+C");
		expect(output).toContain("Cancel");
	});
});

describe("Collapsible", () => {
	it("hides children when defaultOpen is false", () => {
		const { lastFrame } = render(
			<Collapsible header="Section" defaultOpen={false}>
				Hidden content
			</Collapsible>,
		);
		const output = lastFrame();
		expect(output).toContain("Section");
		expect(output).toContain("▸");
		expect(output).not.toContain("Hidden content");
	});

	it("shows children when defaultOpen is true", () => {
		const { lastFrame } = render(
			<Collapsible header="Section" defaultOpen={true}>
				Visible content
			</Collapsible>,
		);
		const output = lastFrame();
		expect(output).toContain("Section");
		expect(output).toContain("▾");
		expect(output).toContain("Visible content");
	});

	it("defaults to closed when defaultOpen not provided", () => {
		const { lastFrame } = render(<Collapsible header="Section">Hidden by default</Collapsible>);
		const output = lastFrame();
		expect(output).toContain("▸");
		expect(output).not.toContain("Hidden by default");
	});
});
