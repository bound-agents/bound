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

	it("announces service to the Boundless Satellite Station", () => {
		const { lastFrame } = render(<SessionHeader commitHash="abc1234" cwd="/tmp/work" />);
		expect(lastFrame() ?? "").toContain("Beginning service to the Boundless Satellite Station");
	});

	it("renders the favicon ASCII art (all-cyan, chunky-block ring)", () => {
		const { lastFrame } = render(<SessionHeader commitHash="dev" cwd="/tmp" />);
		const frame = lastFrame() ?? "";
		// Chunky filled-block ring (▄ ▀ █) — switched from single-line box-drawing
		// because a 1-char-thick ring reads as a rounded rectangle in a terminal,
		// not a circle. The half-block top/bottom + full-block sides give the
		// outline visible thickness.
		expect(frame).toContain("▄");
		expect(frame).toContain("▀");
		expect(frame).toContain("█");
	});

	it("places the text column to the right of the icon (single row)", () => {
		const { lastFrame } = render(<SessionHeader commitHash="abc1234" cwd="/tmp/work" />);
		const frame = lastFrame() ?? "";
		// `boundless` must appear on a line that also contains a glyph from the
		// icon's top — i.e. the columns are siblings in a row, not stacked.
		const lines = frame.split("\n");
		const boundlessLine = lines.find((l) => l.includes("boundless"));
		expect(boundlessLine).toBeDefined();
		// The favicon's first row is the rounded top: `     ▄▄▄▄▄▄     `. That
		// row is the same physical row as the `boundless` line when laid out as a
		// flex row with column children.
		expect(boundlessLine).toContain("▄");
	});
});
