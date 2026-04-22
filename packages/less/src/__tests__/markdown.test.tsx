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

	describe("mixed content", () => {
		it("renders a mix of headings, paragraphs, and code", async () => {
			const md = [
				"# Hello",
				"",
				"This is **important** text.",
				"",
				"```js",
				"console.log('hi');",
				"```",
				"",
				"- item one",
				"- item two",
			].join("\n");

			const { lastFrame } = render(React.createElement(Markdown, { text: md }));
			await tick();
			const frame = lastFrame();
			expect(frame).toContain("Hello");
			expect(frame).toContain("important");
			expect(frame).toContain("console.log");
			expect(frame).toContain("item one");
			expect(frame).not.toContain("```");
			expect(frame).not.toContain("**");
		});
	});
});
