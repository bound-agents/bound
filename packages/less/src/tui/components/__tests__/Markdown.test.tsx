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
	it("renders inline code without literal backticks", () => {
		const { lastFrame } = render(
			React.createElement(Markdown, { text: "run the `build` step", width: 60 }),
		);
		const frame = stripSgr(lastFrame() ?? "");
		expect(frame).toContain("build");
		expect(frame).not.toContain("`");
	});

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
		// marked emits one `space` token regardless of how many blank lines were
		// typed, so the gap is always exactly one row.
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
		// marked emits a trailing `space` token for "Para.\n\n"; the positional
		// walker must not turn it into a stray blank row below the message.
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
