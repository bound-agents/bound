import { describe, expect, test } from "bun:test";
import {
	SYNTAX_LANGS,
	SYNTAX_THEME,
	getHighlighter,
	highlightToHtml,
	highlightToTokens,
	normalizeLang,
	prewarmHighlighter,
} from "../syntax";

describe("normalizeLang", () => {
	test("returns plaintext for null/undefined/empty", () => {
		expect(normalizeLang(null)).toBe("plaintext");
		expect(normalizeLang(undefined)).toBe("plaintext");
		expect(normalizeLang("")).toBe("plaintext");
	});

	test("passes known languages through", () => {
		expect(normalizeLang("typescript")).toBe("typescript");
		expect(normalizeLang("python")).toBe("python");
		expect(normalizeLang("bash")).toBe("bash");
	});

	test("aliases common short forms", () => {
		expect(normalizeLang("js")).toBe("javascript");
		expect(normalizeLang("ts")).toBe("typescript");
		expect(normalizeLang("tsx")).toBe("typescript");
		expect(normalizeLang("jsx")).toBe("javascript");
		expect(normalizeLang("py")).toBe("python");
		expect(normalizeLang("sh")).toBe("bash");
		expect(normalizeLang("shell")).toBe("bash");
		expect(normalizeLang("zsh")).toBe("bash");
		expect(normalizeLang("yml")).toBe("yaml");
		expect(normalizeLang("htm")).toBe("html");
	});

	test("is case-insensitive", () => {
		expect(normalizeLang("TypeScript")).toBe("typescript");
		expect(normalizeLang("PYTHON")).toBe("python");
		expect(normalizeLang("JS")).toBe("javascript");
	});

	test("returns plaintext for unknown languages", () => {
		expect(normalizeLang("rust")).toBe("plaintext");
		expect(normalizeLang("go")).toBe("plaintext");
		expect(normalizeLang("haskell")).toBe("plaintext");
		expect(normalizeLang("nonsense-lang")).toBe("plaintext");
	});
});

describe("highlighter lifecycle", () => {
	test("SYNTAX_LANGS exposes the bundled set", () => {
		expect(SYNTAX_LANGS).toContain("typescript");
		expect(SYNTAX_LANGS).toContain("python");
		expect(SYNTAX_LANGS).toContain("bash");
		// plaintext is shiki's special pass-through, not a bundled language
		expect((SYNTAX_LANGS as readonly string[]).includes("plaintext")).toBe(false);
	});

	test("SYNTAX_THEME is set", () => {
		expect(SYNTAX_THEME).toBe("tokyo-night");
	});

	test("prewarmHighlighter resolves and getHighlighter is idempotent", async () => {
		await prewarmHighlighter();
		const a = await getHighlighter();
		const b = await getHighlighter();
		expect(a).toBe(b);
	});
});

describe("highlightToTokens", () => {
	test("returns lines × tokens for known language post-warm", async () => {
		await prewarmHighlighter();
		const code = "const x = 1;\nconst y = 2;";
		const lines = highlightToTokens(code, "typescript");
		expect(lines.length).toBe(2);
		// each line has at least one token; tokens carry .content
		for (const line of lines) {
			expect(line.length).toBeGreaterThan(0);
			for (const tok of line) {
				expect(typeof tok.content).toBe("string");
			}
		}
		// token texts joined per line should reconstruct each line
		expect(lines[0].map((t) => t.content).join("")).toBe("const x = 1;");
		expect(lines[1].map((t) => t.content).join("")).toBe("const y = 2;");
	});

	test("falls back to plaintext for unknown language", async () => {
		await prewarmHighlighter();
		const code = "some opaque text";
		const lines = highlightToTokens(code, "made-up-lang");
		expect(lines.length).toBe(1);
		expect(lines[0].map((t) => t.content).join("")).toBe("some opaque text");
	});

	test("preserves blank lines in multi-line code", async () => {
		await prewarmHighlighter();
		const code = "a\n\nb";
		const lines = highlightToTokens(code, "plaintext");
		expect(lines.length).toBe(3);
	});
});

describe("highlightToHtml", () => {
	test("returns HTML wrapping the input code", async () => {
		const html = await highlightToHtml("const x = 1;", "typescript");
		expect(html).toContain("<pre");
		expect(html).toContain("const");
		expect(html).toContain("x");
	});

	test("plaintext falls back without throwing", async () => {
		const html = await highlightToHtml("plain content", null);
		expect(html).toContain("<pre");
		expect(html).toContain("plain content");
	});
});
