import { beforeAll, describe, expect, it } from "bun:test";
import { prewarmHighlighter } from "@bound/shared";
import { render } from "ink-testing-library";
import React from "react";
import {
	HighlightedWrappedLine,
	highlightLineToRows,
	wrapTokenRow,
} from "../tui/components/HighlightedCode";
import { wrapLineAtWidth } from "../tui/util/wrap";

// #239: syntax highlighting broke on word wrap because long lines were either
// pre-wrapped as plain text and highlighted per-fragment (grammar restarts
// mid-line) or handed to Ink whole (Ink splits the styled spans arbitrarily).
// The fix tokenizes the WHOLE logical line once and slices the token row at
// the width budget. These tests pin that slicing contract.

beforeAll(async () => {
	await prewarmHighlighter();
});

describe("wrapTokenRow (#239)", () => {
	const tok = (content: string, color?: string) => ({ content, offset: 0, color });

	it("returns one row when the content fits", () => {
		const rows = wrapTokenRow([tok("const x = 1;", "#f00")], 40);
		expect(rows.length).toBe(1);
		expect(rows[0].map((t) => t.content).join("")).toBe("const x = 1;");
	});

	it("slices a single long token across rows, preserving its style", () => {
		const rows = wrapTokenRow([tok("a".repeat(25), "#0f0")], 10);
		expect(rows.length).toBe(3);
		expect(rows.map((r) => r.map((t) => t.content).join(""))).toEqual([
			"a".repeat(10),
			"a".repeat(10),
			"a".repeat(5),
		]);
		for (const row of rows) {
			for (const t of row) expect(t.color).toBe("#0f0");
		}
	});

	it("splits at a token boundary without losing either side's style", () => {
		const rows = wrapTokenRow([tok("abcdef", "#111"), tok("ghijkl", "#222")], 8);
		expect(rows.length).toBe(2);
		expect(rows[0].map((t) => t.content).join("")).toBe("abcdefgh");
		expect(rows[1].map((t) => t.content).join("")).toBe("ijkl");
		// The split token keeps its color on both fragments.
		expect(rows[0][1].color).toBe("#222");
		expect(rows[1][0].color).toBe("#222");
	});

	it("concatenation of rows equals the input content", () => {
		const tokens = [tok("function "), tok("greet", "#ff0"), tok("(name) { return name; }")];
		const rows = wrapTokenRow(tokens, 7);
		const rejoined = rows.map((r) => r.map((t) => t.content).join("")).join("");
		expect(rejoined).toBe("function greet(name) { return name; }");
	});

	it("does not split surrogate pairs", () => {
		const rows = wrapTokenRow([tok("😀😀😀😀😀")], 2);
		for (const row of rows) {
			const text = row.map((t) => t.content).join("");
			// Every emoji survives intact — no lone surrogates.
			expect([...text].every((c) => c === "😀")).toBe(true);
		}
	});

	it("width <= 0 returns the row unsliced", () => {
		const rows = wrapTokenRow([tok("abc")], 0);
		expect(rows.length).toBe(1);
	});
});

describe("highlightLineToRows row-count parity (#239)", () => {
	// InspectorView runs scroll math on physical rows. The token slicer must
	// produce the same row count as the plain-text wrapper for identical
	// content, or scroll offsets drift from what's rendered.
	it("matches wrapLineAtWidth's row count for code lines", () => {
		const lines = [
			"const veryLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree);",
			"x",
			"",
			`return ${"a + ".repeat(30)}0;`,
		];
		for (const line of lines) {
			for (const width of [10, 24, 37, 80]) {
				const plain = wrapLineAtWidth(line, width).length;
				const tokens = highlightLineToRows(line, "javascript", width).length;
				expect(tokens).toBe(plain);
			}
		}
	});
});

describe("HighlightedWrappedLine (#239)", () => {
	it("keeps the prefix on the first row and indents continuations", () => {
		const { lastFrame } = render(
			React.createElement(HighlightedWrappedLine, {
				line: `const value = "${"x".repeat(40)}";`,
				lang: "javascript",
				width: 20,
				firstPrefix: React.createElement(React.Fragment, null, "+ "),
				contIndent: "  ",
			}),
		);
		const frame = lastFrame() ?? "";
		const rows = frame.split("\n");
		expect(rows.length).toBeGreaterThan(1);
		expect(rows[0].startsWith("+ ")).toBe(true);
		for (const row of rows.slice(1)) {
			expect(row.startsWith("  ")).toBe(true);
			expect(row.startsWith("+ ")).toBe(false);
		}
		// No visual row exceeds prefix + width.
		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(2 + 20);
		}
	});

	it("renders single-Text (legacy) when width is undefined", () => {
		const { lastFrame } = render(
			React.createElement(HighlightedWrappedLine, {
				line: "const x = 1;",
				lang: "javascript",
			}),
		);
		expect(lastFrame()).toContain("const x = 1;");
	});
});
