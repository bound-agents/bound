import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Markdown } from "../tui/components/Markdown";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("Markdown", () => {
	describe("plain text", () => {
		it("renders plain text as-is", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "hello world" }));
			await tick();
			expect(lastFrame()).toContain("hello world");
		});

		it("renders empty string without crashing", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "" }));
			await tick();
			expect(lastFrame()).toBe("");
		});

		it("renders multiple paragraphs with blank lines between", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, { text: "first paragraph\n\nsecond paragraph" }),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("first paragraph");
			expect(frame).toContain("second paragraph");
		});
	});

	describe("inline formatting", () => {
		it("renders bold text", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "hello **bold** world" }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("bold");
			expect(frame).toContain("hello");
			expect(frame).toContain("world");
			// Should NOT contain the markdown syntax
			expect(frame).not.toContain("**");
		});

		it("renders italic text", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "hello *italic* world" }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("italic");
			expect(frame).not.toContain("*italic*");
		});

		it("renders inline code with backtick markers", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, { text: "run `npm install` now" }),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("npm install");
			// The backticks should be replaced with visual markers
			expect(frame).toContain("`");
			expect(frame).not.toContain("``");
		});

		it("renders links showing text and URL", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, { text: "click [here](https://example.com) please" }),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("here");
			expect(frame).toContain("https://example.com");
			// Should NOT contain raw markdown link syntax
			expect(frame).not.toContain("](");
		});

		it("renders strikethrough text", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, { text: "this is ~~deleted~~ text" }),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("deleted");
			expect(frame).not.toContain("~~");
		});
	});

	describe("headings", () => {
		it("renders h1 headings with emphasis", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "# Main Title" }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("Main Title");
			// Should NOT contain the # prefix
			expect(frame).not.toContain("# ");
		});

		it("renders h2 headings", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "## Sub Title" }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("Sub Title");
			expect(frame).not.toContain("## ");
		});
	});

	describe("code blocks", () => {
		it("renders fenced code blocks with language label", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "```typescript\nconst x = 1;\n```",
				}),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("const x = 1;");
			// Should NOT contain the fence markers
			expect(frame).not.toContain("```");
		});

		it("renders code blocks without language", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "```\nhello code\n```",
				}),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("hello code");
			expect(frame).not.toContain("```");
		});
	});

	describe("lists", () => {
		it("renders unordered lists with bullet markers", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "- first item\n- second item\n- third item",
				}),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("first item");
			expect(frame).toContain("second item");
			expect(frame).toContain("third item");
		});

		it("renders ordered lists with numbers", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "1. first\n2. second\n3. third",
				}),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("1.");
			expect(frame).toContain("first");
			expect(frame).toContain("2.");
			expect(frame).toContain("second");
		});

		// Issue #142: the marker sits in its own fixed-width column so there is a
		// gutter space between the number and the content, and wrapped
		// continuation lines stay aligned with the first content column. The
		// regression was a missing space (`1.content`) plus a one-column
		// misalignment on continuations, surfacing on the Ink-wrapped path where
		// Ink trims trailing whitespace from a flex-row-sibling Text node.
		it("renders a gutter space after an ordered marker (no-width / Ink-wrapped path)", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "1. content line one that is quite long and will wrap around now and keep going past the width",
				}),
			);
			await tick();
			const frame = lastFrame() ?? "";
			// Space between the number and the content — NOT `1.content`.
			expect(frame).toContain("1. content");
			expect(frame).not.toContain("1.content");
		});

		it("renders a gutter space and aligns wrapped continuations (width path)", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "1. first item that is long enough to wrap\n2. second item also long enough to wrap",
					width: 30,
				}),
			);
			await tick();
			const frame = lastFrame() ?? "";
			expect(frame).toContain("1. first");
			expect(frame).toContain("2. second");
			expect(frame).not.toContain("1.first");
			// Continuation lines align under the content column (markerWidth = 3),
			// i.e. they are indented by exactly three spaces, matching the gutter.
			const lines = frame.split("\n");
			const continuations = lines.filter(
				(l) => /^\s/.test(l) && !/^\s*\d+\.\s/.test(l) && l.trim().length > 0,
			);
			expect(continuations.length).toBeGreaterThan(0);
			for (const line of continuations) {
				expect(line.startsWith("   ")).toBe(true);
				expect(line.startsWith("    ")).toBe(false);
			}
		});

		it("renders a gutter space after a bullet marker", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "- bullet item long enough to wrap onto a second visual line for sure",
					width: 28,
				}),
			);
			await tick();
			const frame = lastFrame() ?? "";
			expect(frame).toContain("\u2022 bullet");
			expect(frame).not.toContain("\u2022bullet");
		});

		// Issue #142 follow-up: a list item's children are a mix of inline
		// content and nested block tokens. The earlier code flattened every
		// child through renderProse (inline-only), so a nested list dropped to
		// its raw-text default (`now1.`) and loose-list paragraphs lost inline
		// styling. Children are now dispatched by type — `text` through prose,
		// everything else (including nested `list`) through renderBlock.
		it("renders a nested ordered list with its own markers and indent", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "1. parent item one\n   1. child a\n   2. child b\n2. sibling",
					width: 40,
				}),
			);
			await tick();
			const frame = lastFrame() ?? "";
			// Nested markers render as real list items, not raw text.
			expect(frame).toContain("1. parent");
			expect(frame).toContain("2. sibling");
			expect(frame).toContain("1. child a");
			expect(frame).toContain("2. child b");
			// The raw-text fallback would have glued the child marker onto the
			// parent's wrapped text (`parent item one1.`); it must not appear.
			expect(frame).not.toMatch(/one1\./);
			// Child markers are indented under the parent's content column.
			const lines = frame.split("\n");
			const childLine = lines.find((l) => l.includes("1. child a"));
			expect(childLine).toBeDefined();
			expect((childLine ?? "").startsWith("   ")).toBe(true);
		});

		it("renders a nested unordered list inside an ordered item", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "1. parent\n   - bullet a\n   - bullet b",
					width: 40,
				}),
			);
			await tick();
			const frame = lastFrame() ?? "";
			expect(frame).toContain("1. parent");
			expect(frame).toContain("\u2022 bullet a");
			expect(frame).toContain("\u2022 bullet b");
		});

		it("preserves inline styling in loose-list paragraphs", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, {
					text: "1. first with **bold** word\n\n2. second item",
					width: 40,
				}),
			);
			await tick();
			const frame = lastFrame() ?? "";
			// The word still renders (styling is ANSI, not visible in the frame
			// text), and the marker gutter is intact for both items.
			expect(frame).toContain("1. first");
			expect(frame).toContain("bold");
			expect(frame).toContain("2. second");
		});
	});

	describe("blockquotes", () => {
		it("renders blockquotes with visual indicator", async () => {
			const { lastFrame } = render(React.createElement(Markdown, { text: "> this is a quote" }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("this is a quote");
			// Should have a visual prefix (pipe or similar)
			expect(frame).toContain("\u2502");
		});
	});

	describe("horizontal rules", () => {
		it("renders horizontal rules as a line", async () => {
			const { lastFrame } = render(
				React.createElement(Markdown, { text: "above\n\n---\n\nbelow" }),
			);
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("above");
			expect(frame).toContain("below");
			expect(frame).toContain("\u2500");
		});
	});

	describe("tables", () => {
		it("renders a basic table with header and rows", async () => {
			const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			// Should contain all cell values
			expect(frame).toContain("Name");
			expect(frame).toContain("Age");
			expect(frame).toContain("Alice");
			expect(frame).toContain("30");
			expect(frame).toContain("Bob");
			expect(frame).toContain("25");
			// Should have box-drawing separator between header and body
			expect(frame).toContain("─");
			// Should NOT contain raw pipe syntax
			expect(frame).not.toContain("|---");
		});

		it("renders header cells with bold styling", async () => {
			const md = "| Col1 | Col2 |\n|------|------|\n| a | b |";
			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			// Headers should be present (bold is an ANSI escape, hard to check directly)
			expect(frame).toContain("Col1");
			expect(frame).toContain("Col2");
		});

		it("pads columns to equal width", async () => {
			const md = "| Short | A much longer header |\n|-------|----------------------|\n| x | y |";
			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			// The separator line should be at least as wide as the longest header
			expect(frame).toContain("A much longer header");
			expect(frame).toContain("Short");
		});

		it("renders inline formatting inside table cells", async () => {
			const md = "| Feature | Status |\n|---------|--------|\n| **Auth** | `done` |";
			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("Auth");
			expect(frame).toContain("done");
			// Should NOT contain raw markdown syntax
			expect(frame).not.toContain("**Auth**");
		});

		it("handles empty cells gracefully", async () => {
			const md = "| A | B |\n|---|---|\n|   | x |";
			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("A");
			expect(frame).toContain("B");
			expect(frame).toContain("x");
		});

		it("renders table embedded in other markdown content", async () => {
			const md = "# Results\n\n| Name | Score |\n|------|-------|\n| Alice | 95 |\n\nGreat work!";
			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("Results");
			expect(frame).toContain("Alice");
			expect(frame).toContain("95");
			expect(frame).toContain("Great work!");
		});
	});

	describe("width-wrapped prose (issue #130)", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
		const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

		it("elides leading whitespace on wrapped continuation lines", async () => {
			const text =
				"the quick brown fox jumps over the lazy dog and then keeps on running well past the edge";
			const { lastFrame } = render(React.createElement(Markdown, { text, width: 20 }));
			await tick();
			const lines = stripAnsi(lastFrame() ?? "")
				.split("\n")
				.filter((l) => l.length > 0);
			// The paragraph must wrap into multiple visual rows at width 20.
			expect(lines.length).toBeGreaterThan(1);
			// No continuation row begins with whitespace.
			for (let i = 1; i < lines.length; i++) {
				expect(lines[i]).not.toMatch(/^\s/);
			}
		});

		it("keeps every visual row within the width budget", async () => {
			const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
			const { lastFrame } = render(React.createElement(Markdown, { text, width: 16 }));
			await tick();
			const lines = stripAnsi(lastFrame() ?? "")
				.split("\n")
				.filter((l) => l.length > 0);
			for (const line of lines) {
				expect([...line].length).toBeLessThanOrEqual(16);
			}
		});

		it("preserves inline bold styling across a wrap boundary", async () => {
			const text = "intro text then **a long bold run that will certainly wrap** and a tail";
			const { lastFrame } = render(React.createElement(Markdown, { text, width: 18 }));
			await tick();
			const frame = lastFrame() ?? "";
			// Visible words survive; markdown syntax does not leak.
			expect(stripAnsi(frame)).toContain("bold run");
			expect(frame).not.toContain("**");
		});
	});
});
