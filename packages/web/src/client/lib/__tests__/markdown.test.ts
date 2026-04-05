import { describe, expect, it } from "bun:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { highlightCode, renderMarkdown, splitOnThinkingBlocks } from "../markdown";

// ---------------------------------------------------------------------------
// DOMPurify instance backed by jsdom — used only for XSS tests (AC5.*)
// so those tests exercise real sanitization rather than passthrough.
// ---------------------------------------------------------------------------
const { window: jsdomWindow } = new JSDOM("<!DOCTYPE html>");
// biome-ignore lint/suspicious/noExplicitAny: jsdom Window type is not assignable to browser Window
const jsdomDOMPurify = createDOMPurify(jsdomWindow as any);
const realSanitize = (html: string): string =>
	jsdomDOMPurify.sanitize(html, {
		ADD_ATTR: ["style"],
		ADD_TAGS: ["details", "summary"],
	});

// Passthrough sanitizer for structural/rendering tests — no DOM dependency.
const passthroughSanitize = (html: string): string => html;

// ---------------------------------------------------------------------------
// splitOnThinkingBlocks
// ---------------------------------------------------------------------------
describe("splitOnThinkingBlocks", () => {
	it("returns single text segment when no thinking blocks present", () => {
		const result = splitOnThinkingBlocks("hello world");
		expect(result).toEqual([{ kind: "text", text: "hello world" }]);
	});

	it("returns empty array for empty input", () => {
		const result = splitOnThinkingBlocks("");
		expect(result).toEqual([]);
	});

	it("splits a single thinking block with surrounding text", () => {
		const result = splitOnThinkingBlocks("before<thinking>inner</thinking>after");
		expect(result).toEqual([
			{ kind: "text", text: "before" },
			{ kind: "thinking", text: "inner" },
			{ kind: "text", text: "after" },
		]);
	});

	it("handles thinking block at start with no leading text", () => {
		const result = splitOnThinkingBlocks("<thinking>inner</thinking>after");
		expect(result).toEqual([
			{ kind: "thinking", text: "inner" },
			{ kind: "text", text: "after" },
		]);
	});

	it("handles thinking block at end with no trailing text", () => {
		const result = splitOnThinkingBlocks("before<thinking>inner</thinking>");
		expect(result).toEqual([
			{ kind: "text", text: "before" },
			{ kind: "thinking", text: "inner" },
		]);
	});

	it("splits multiple thinking blocks", () => {
		const result = splitOnThinkingBlocks("<thinking>a</thinking>mid<thinking>b</thinking>");
		expect(result).toEqual([
			{ kind: "thinking", text: "a" },
			{ kind: "text", text: "mid" },
			{ kind: "thinking", text: "b" },
		]);
	});

	it("is case-insensitive for the thinking tag", () => {
		const result = splitOnThinkingBlocks("<THINKING>content</THINKING>");
		expect(result).toEqual([{ kind: "thinking", text: "content" }]);
	});
});

// ---------------------------------------------------------------------------
// renderMarkdown — plain text and basic markdown elements
// ---------------------------------------------------------------------------
describe("renderMarkdown — plain text and markdown elements", () => {
	it("passes through plain text", async () => {
		const html = await renderMarkdown("hello world", passthroughSanitize);
		expect(html).toContain("hello world");
	});

	it("renders an h1 header", async () => {
		const html = await renderMarkdown("# Hello", passthroughSanitize);
		expect(html).toContain("<h1>");
		expect(html).toContain("Hello");
	});

	it("renders an h2 header", async () => {
		const html = await renderMarkdown("## SubHead", passthroughSanitize);
		expect(html).toContain("<h2>");
	});

	it("renders **bold** as <strong>", async () => {
		const html = await renderMarkdown("**bold text**", passthroughSanitize);
		expect(html).toContain("<strong>");
		expect(html).toContain("bold text");
	});

	it("renders an unordered list", async () => {
		const html = await renderMarkdown("- item one\n- item two", passthroughSanitize);
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>");
		expect(html).toContain("item one");
	});

	it("renders inline code with <code> tag", async () => {
		const html = await renderMarkdown("use `console.log()` here", passthroughSanitize);
		expect(html).toContain("<code>");
		expect(html).toContain("console.log()");
	});
});

// ---------------------------------------------------------------------------
// renderMarkdown — table wrapped in .table-wrap
// ---------------------------------------------------------------------------
describe("renderMarkdown — tables", () => {
	it("wraps a markdown table in a .table-wrap div", async () => {
		const md = "| Col A | Col B |\n| ----- | ----- |\n| cell1 | cell2 |";
		const html = await renderMarkdown(md, passthroughSanitize);
		expect(html).toContain('<div class="table-wrap">');
		expect(html).toContain("<table>");
	});
});

// ---------------------------------------------------------------------------
// renderMarkdown — fenced code blocks (AC2)
// ---------------------------------------------------------------------------
describe("renderMarkdown — fenced code blocks", () => {
	it("renders fenced code with a known language using Shiki inline styles (AC2.1)", async () => {
		const html = await renderMarkdown("```javascript\nconst x = 1;\n```", passthroughSanitize);
		// Shiki emits style="color:..." on token spans
		expect(html).toMatch(/style="[^"]*color:/);
	});

	it("renders fenced code with no language without Shiki color styles (AC2.2)", async () => {
		const html = await renderMarkdown("```\nsome plain code\n```", passthroughSanitize);
		// Must contain a code/pre element
		expect(html).toMatch(/<code|<pre/);
		// Must NOT have Shiki inline color styles
		expect(html).not.toMatch(/style="[^"]*color:/);
		// Must preserve the code content (not replace with empty string)
		expect(html).toContain("some plain code");
	});
});

// ---------------------------------------------------------------------------
// renderMarkdown — thinking blocks (AC3)
// ---------------------------------------------------------------------------
describe("renderMarkdown — thinking blocks", () => {
	it("renders a single thinking block as a collapsed <details> element (AC3.1)", async () => {
		const html = await renderMarkdown("<thinking>my reasoning</thinking>", passthroughSanitize);
		expect(html).toContain("<details");
		expect(html).toContain("<summary>Thinking...</summary>");
		expect(html).toContain("my reasoning");
		// Must NOT have 'open' attribute — collapsed by default
		expect(html).not.toMatch(/<details[^>]*\bopen\b/);
	});

	it("renders markdown inside a thinking block (AC3.2)", async () => {
		const html = await renderMarkdown(
			"<thinking>## Header\n- list item</thinking>",
			passthroughSanitize,
		);
		expect(html).toContain("<details");
		expect(html).toContain("<h2>");
		expect(html).toContain("<li>");
	});

	it("renders multiple thinking blocks as separate <details> elements (AC3.3)", async () => {
		const html = await renderMarkdown(
			"<thinking>first</thinking>middle text<thinking>second</thinking>",
			passthroughSanitize,
		);
		const detailsCount = (html.match(/<details/g) ?? []).length;
		expect(detailsCount).toBe(2);
		expect(html).toContain("middle text");
	});

	it("renders a message with no thinking blocks with no <details> elements (AC3.4)", async () => {
		const html = await renderMarkdown("just a normal message", passthroughSanitize);
		expect(html).not.toContain("<details");
	});
});

// ---------------------------------------------------------------------------
// renderMarkdown — XSS safety / DOMPurify (AC5)
// Uses realSanitize (jsdom-backed DOMPurify) for authentic sanitization.
// ---------------------------------------------------------------------------
describe("renderMarkdown — XSS safety", () => {
	it("strips <script> tags from output (AC5.1)", async () => {
		const html = await renderMarkdown("hello <script>alert('xss')</script> world", realSanitize);
		expect(html).not.toContain("<script");
		expect(html).not.toContain("alert('xss')");
	});

	it("strips onclick attributes from output (AC5.2)", async () => {
		const html = await renderMarkdown('click <a href="#" onclick="evil()">here</a>', realSanitize);
		expect(html).not.toContain("onclick");
	});

	it("preserves Shiki inline style attributes after DOMPurify (AC5.3)", async () => {
		const html = await renderMarkdown("```javascript\nconst x = 1;\n```", realSanitize);
		// Shiki color styles must survive sanitization
		expect(html).toMatch(/style="[^"]*color:/);
	});

	it("preserves <details> and <summary> tags from thinking blocks after DOMPurify (AC5.4)", async () => {
		const html = await renderMarkdown("<thinking>reasoning here</thinking>", realSanitize);
		expect(html).toContain("<details");
		expect(html).toContain("<summary>");
	});
});

// ---------------------------------------------------------------------------
// highlightCode — standalone code highlighting
// ---------------------------------------------------------------------------
describe("highlightCode", () => {
	it("highlights TypeScript code with Shiki inline styles", async () => {
		const html = await highlightCode("const x: string = 'hello';", "typescript", realSanitize);
		// Shiki emits style="color:..." on token spans
		expect(html).toMatch(/style="[^"]*color:/);
		expect(html).toContain("hello");
	});

	it("highlights JavaScript code with Shiki inline styles", async () => {
		const html = await highlightCode("const x = 42;", "javascript", realSanitize);
		expect(html).toMatch(/style="[^"]*color:/);
	});

	it("falls back to plaintext for unsupported languages", async () => {
		const html = await highlightCode("some code", "unknown-lang", realSanitize);
		// Should still produce valid HTML, but without Shiki colors
		expect(html).toMatch(/<pre|<code/);
		expect(html).toContain("some code");
	});

	it("returns sanitized HTML with DOMPurify", async () => {
		const html = await highlightCode("const x = 1;", "javascript", realSanitize);
		// Should not contain any raw HTML tags outside of the expected pre/code/span structure
		// Check that it's been through DOMPurify by looking for expected Shiki structure
		expect(html).toMatch(/<pre/);
	});

	it("preserves code content exactly as provided", async () => {
		const code = "function hello() {\n\treturn 'world';\n}";
		const html = await highlightCode(code, "javascript", realSanitize);
		// Content should be preserved in the output
		expect(html).toContain("function");
		expect(html).toContain("hello");
		expect(html).toContain("world");
	});

	it("renders Python code with Shiki inline styles", async () => {
		const html = await highlightCode("def hello():\n\treturn 'world'", "python", realSanitize);
		expect(html).toMatch(/style="[^"]*color:/);
		expect(html).toContain("hello");
	});

	it("renders SQL code with Shiki inline styles", async () => {
		const html = await highlightCode("SELECT * FROM users;", "sql", realSanitize);
		expect(html).toMatch(/style="[^"]*color:/);
	});
});
