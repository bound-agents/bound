import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Markdown } from "../Markdown";

/**
 * Strip SGR color/style escapes (CSI ... m) but DELIBERATELY keep OSC 8
 * hyperlink sequences (ESC ] 8 ; ; ... BEL), since the link assertions need to
 * see them. Width is pinned via the `width` prop so the frame doesn't depend on
 * the ambient terminal size (see the TUI frame-capture gotcha).
 */
const stripSgr = (s: string): string =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the literal SGR escape is the point
	s.replace(/\u001B\[[0-9;]*m/g, "");

describe("Markdown — formatting tweaks", () => {
	it("renders a link as an OSC 8 hyperlink, not literal [label](url)", () => {
		const { lastFrame } = render(
			React.createElement(Markdown, {
				text: "see [the docs](https://example.com/x) now",
				width: 80,
			}),
		);
		const frame = stripSgr(lastFrame() ?? "");
		// OSC 8 opener carrying the href, then the visible label.
		expect(frame).toContain("\u001B]8;;https://example.com/x\u0007the docs");
		// OSC 8 closer (empty href).
		expect(frame).toContain("\u001B]8;;\u0007");
		// The raw markdown URL must NOT appear as visible text.
		expect(frame).not.toContain("(https://example.com/x)");
	});

	it("double-spaces authored line breaks within a paragraph", () => {
		const { lastFrame } = render(
			React.createElement(Markdown, { text: "Line A\nLine B", width: 60 }),
		);
		const frame = stripSgr(lastFrame() ?? "");
		// A blank line now sits between the two authored lines.
		expect(frame).toMatch(/Line A\s*\n\s*\n\s*Line B/);
	});

	it("does NOT double-space soft-wrap continuations (only authored breaks)", () => {
		// One authored line, long enough to soft-wrap at width 20. The wrap point
		// must stay single-spaced — doubling it would scatter blank lines through
		// a paragraph.
		const text = "the quick brown fox jumps over the lazy dog again";
		const { lastFrame } = render(React.createElement(Markdown, { text, width: 20 }));
		const frame = stripSgr(lastFrame() ?? "");
		// No blank line anywhere (no authored newline → nothing to double).
		expect(frame).not.toMatch(/\S\s*\n\s*\n\s*\S/);
	});

	it("puts a single blank line between two paragraphs", () => {
		const { lastFrame } = render(
			React.createElement(Markdown, {
				text: "Para one.\n\nPara two.",
				width: 60,
			}),
		);
		const frame = stripSgr(lastFrame() ?? "");
		expect(frame).toMatch(/Para one\.\n\s*\nPara two\./);
	});

	it("collapses 3+ blank lines between paragraphs to a single gap", () => {
		// Consecutive blank lines collapse to a single authored gap, so the row
		// count is always exactly one regardless of how many blanks were typed.
		const { lastFrame } = render(
			React.createElement(Markdown, {
				text: "Para one.\n\n\n\nPara two.",
				width: 60,
			}),
		);
		const frame = stripSgr(lastFrame() ?? "");
		expect(frame).toMatch(/Para one\.\n\s*\nPara two\./);
		// Not two blank rows.
		expect(frame).not.toMatch(/Para one\.\n\s*\n\s*\nPara two\./);
	});

	it("does not strand a blank row from a trailing blank line", () => {
		// A trailing blank line must not become a stray blank row below the
		// message: authoredBlockGaps only records gaps BETWEEN blocks.
		const { lastFrame } = render(
			React.createElement(Markdown, { text: "Only para.\n\n", width: 60 }),
		);
		const frame = stripSgr(lastFrame() ?? "");
		expect(frame).toBe("Only para.");
	});

	it("does not strand a blank row from a leading blank line", () => {
		const { lastFrame } = render(
			React.createElement(Markdown, { text: "\n\nOnly para.", width: 60 }),
		);
		const frame = stripSgr(lastFrame() ?? "");
		expect(frame).toBe("Only para.");
	});
});

describe("Markdown — tables honor the width budget (#275)", () => {
	const visibleLines = (frame: string): string[] =>
		stripSgr(frame)
			.split("\n")
			.map((l) => l.replace(/\s+$/, ""));

	const narrowTable = [
		"| Name | Description |",
		"| --- | --- |",
		"| alpha | the first entry has a long description that must wrap inside its cell |",
		"| beta | short |",
	].join("\n");

	it("keeps every row and the separator within a narrow width, wrapping cells", () => {
		const { lastFrame } = render(React.createElement(Markdown, { text: narrowTable, width: 30 }));
		const lines = visibleLines(lastFrame() ?? "");
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
		// Wrapped cell text survives in full, across several lines.
		const joined = lines.join(" ").replace(/\s+/g, " ");
		for (const word of "the first entry has a long description that must wrap inside its cell".split(
			" ",
		)) {
			expect(joined).toContain(word);
		}
		// The long cell wraps, so the table spans more rows than header+sep+2 bodies.
		expect(lines.filter((l) => l.trim().length > 0).length).toBeGreaterThan(4);
		// The short column keeps its own text intact on one line.
		expect(lines.some((l) => l.includes("alpha"))).toBe(true);
		const sep = lines.find((l) => l.includes("\u2500")) ?? "";
		expect(Bun.stringWidth(sep)).toBeGreaterThan(0);
		expect(Bun.stringWidth(sep)).toBeLessThanOrEqual(30);
	});

	it("renders a table that fits at its natural width, one line per row", () => {
		const text = ["| A | B |", "| --- | --- |", "| one | two |", "| three | four |"].join("\n");
		const { lastFrame } = render(React.createElement(Markdown, { text, width: 80 }));
		const lines = visibleLines(lastFrame() ?? "").filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(4);
		// Column 1 is 5 wide ("three") plus the 3-col gutter, so column 2 starts at 9;
		// cells without an alignment marker are left-aligned.
		expect(lines[0]).toMatch(/^ A {7}B$/);
		expect(lines[2]).toMatch(/^ one {5}two$/);
		expect(lines[3]).toMatch(/^ three {3}four$/);
		// Separator spans the natural table width, not the full 80 columns.
		expect(Bun.stringWidth(lines[1])).toBeLessThan(20);
	});
});
