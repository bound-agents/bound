import { describe, expect, it } from "bun:test";
import { wrapLineAtWidth, wrapLinesAtWidth } from "../tui/util/wrap";

describe("wrapLineAtWidth", () => {
	it("returns the line unchanged when shorter than width", () => {
		expect(wrapLineAtWidth("hello", 10)).toEqual(["hello"]);
	});

	it("returns the line unchanged when exactly at width", () => {
		expect(wrapLineAtWidth("hello", 5)).toEqual(["hello"]);
	});

	it("hard-breaks a line one codepoint over width", () => {
		expect(wrapLineAtWidth("helloworld", 5)).toEqual(["hello", "world"]);
	});

	it("hard-breaks an unbreakable string into chunks", () => {
		// The #75 case: a long single string with no whitespace.
		const s = "a".repeat(250);
		const chunks = wrapLineAtWidth(s, 80);
		expect(chunks).toHaveLength(4);
		expect(chunks[0]).toBe("a".repeat(80));
		expect(chunks[1]).toBe("a".repeat(80));
		expect(chunks[2]).toBe("a".repeat(80));
		expect(chunks[3]).toBe("a".repeat(10));
	});

	it("preserves an empty input as a single empty visual row", () => {
		expect(wrapLineAtWidth("", 10)).toEqual([""]);
	});

	it("falls back to a single chunk on non-positive width", () => {
		expect(wrapLineAtWidth("hello", 0)).toEqual(["hello"]);
		expect(wrapLineAtWidth("hello", -1)).toEqual(["hello"]);
	});

	it("does not split surrogate pairs", () => {
		// 🐻 is a surrogate pair (2 UTF-16 code units, 1 codepoint).
		// Five bears = 5 codepoints, 10 UTF-16 code units.
		const bears = "🐻🐻🐻🐻🐻";
		const chunks = wrapLineAtWidth(bears, 2);
		// 5 codepoints / width 2 → 3 chunks of [2, 2, 1] codepoints.
		expect(chunks).toEqual(["🐻🐻", "🐻🐻", "🐻"]);
		// Each chunk is a valid UTF-16 string (no orphaned high surrogates).
		for (const chunk of chunks) {
			expect([...chunk].length).toBeGreaterThan(0);
		}
	});

	it("preserves all content in the concatenation", () => {
		const s = "the quick brown fox jumps over the lazy dog";
		expect(wrapLineAtWidth(s, 10).join("")).toBe(s);
	});
});

describe("wrapLinesAtWidth", () => {
	it("flattens correctly with predictable width 7", () => {
		const lines = ["short", "verylonglineneedswrap", "also short"];
		// width=7: "short" → ["short"], "verylonglineneedswrap" (21) → 7+7+7,
		//   "also short" (10) → 7+3.
		expect(wrapLinesAtWidth(lines, 7)).toEqual([
			"short",
			"verylon",
			"glinene",
			"edswrap",
			"also sh",
			"ort",
		]);
	});

	it("preserves empty lines as single visual rows", () => {
		expect(wrapLinesAtWidth(["one", "", "three"], 10)).toEqual(["one", "", "three"]);
	});

	it("returns an empty array for an empty input", () => {
		expect(wrapLinesAtWidth([], 10)).toEqual([]);
	});
});
