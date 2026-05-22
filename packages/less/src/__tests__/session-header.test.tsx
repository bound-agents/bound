import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { render } from "ink-testing-library";
import { SessionHeader } from "../tui/components/SessionHeader";

const HOME = homedir();

describe("SessionHeader", () => {
	it("renders 'boundless' and the commit hash", () => {
		const { lastFrame } = render(<SessionHeader commitHash="abc1234" cwd="/tmp/work" />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("boundless");
		expect(frame).toContain("abc1234");
	});

	it("tildifies the working directory", () => {
		const { lastFrame } = render(
			<SessionHeader commitHash="abc1234" cwd={`${HOME}/Documents/GitHub/bound`} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("~/Documents/GitHub/bound");
		// Should not contain the un-tildified absolute prefix.
		expect(frame).not.toContain(`${HOME}/Documents`);
	});

	it("preserves a non-home cwd as-is", () => {
		const { lastFrame } = render(<SessionHeader commitHash="abc1234" cwd="/etc/hosts" />);
		expect(lastFrame() ?? "").toContain("/etc/hosts");
	});

	it("renders the favicon ASCII art (red dot, dimmed ring)", () => {
		const { lastFrame } = render(<SessionHeader commitHash="dev" cwd="/tmp" />);
		const frame = lastFrame() ?? "";
		// The red ● glyph is the rust-red dot in the bound favicon — it's the most
		// distinctive piece of the ASCII art, and a reliable signal that the
		// SessionHeader rendered through to the frame.
		expect(frame).toContain("●");
		// Box-drawing for the rounded ring.
		expect(frame).toContain("╭");
		expect(frame).toContain("╯");
	});

	it("places the text column to the right of the icon (single row)", () => {
		const { lastFrame } = render(<SessionHeader commitHash="abc1234" cwd="/tmp/work" />);
		const frame = lastFrame() ?? "";
		// `boundless` must appear on a line that also contains a glyph from the
		// icon's top — i.e. the columns are siblings in a row, not stacked.
		const lines = frame.split("\n");
		const boundlessLine = lines.find((l) => l.includes("boundless"));
		expect(boundlessLine).toBeDefined();
		// The favicon's first row is the rounded top: `   ╭─────╮`. That row is
		// the same physical row as the `boundless` line when laid out as a flex
		// row with column children.
		expect(boundlessLine).toContain("╭");
	});
});
