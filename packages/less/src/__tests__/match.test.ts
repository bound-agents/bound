import { describe, expect, it } from "bun:test";
import { findStringOccurrences } from "../tools/match";

describe("findStringOccurrences", () => {
	it("reports no occurrences for an empty search string", () => {
		expect(findStringOccurrences("anything", "")).toEqual({ count: 0, occurrences: [] });
	});

	it("reports no occurrences when the search string is absent", () => {
		expect(findStringOccurrences("hello world\n", "nope")).toEqual({
			count: 0,
			occurrences: [],
		});
	});

	it("reports a single occurrence with its 1-based line and line text", () => {
		const content = "line 1\nfoo bar\nline 3\n";
		expect(findStringOccurrences(content, "foo bar")).toEqual({
			count: 1,
			occurrences: [{ line: 2, lineText: "foo bar" }],
		});
	});

	it("reports every non-overlapping occurrence in document order", () => {
		const content = "MATCH\nx\nMATCH\ny\nMATCH\n";
		expect(findStringOccurrences(content, "MATCH")).toEqual({
			count: 3,
			occurrences: [
				{ line: 1, lineText: "MATCH" },
				{ line: 3, lineText: "MATCH" },
				{ line: 5, lineText: "MATCH" },
			],
		});
	});

	it("locates the beginning of a multi-line match (the per-line scan misses this)", () => {
		const content = "line 1\nline 2\nline 3\nline 4\n";
		// "line 2\nline 3" begins on line 2; a substring-per-line scan would never
		// match it because no single line contains the whole search string.
		expect(findStringOccurrences(content, "line 2\nline 3")).toEqual({
			count: 1,
			occurrences: [{ line: 2, lineText: "line 2" }],
		});
	});

	it("counts newlines inside earlier matches when locating later ones", () => {
		// First match spans lines 1-2; the second begins on line 4.
		const content = "a\nb\nc\na\nb\n";
		expect(findStringOccurrences(content, "a\nb")).toEqual({
			count: 2,
			occurrences: [
				{ line: 1, lineText: "a" },
				{ line: 4, lineText: "a" },
			],
		});
	});

	it("handles multiple occurrences on the same line", () => {
		const content = "xx and xx\n";
		expect(findStringOccurrences(content, "xx")).toEqual({
			count: 2,
			occurrences: [
				{ line: 1, lineText: "xx and xx" },
				{ line: 1, lineText: "xx and xx" },
			],
		});
	});
});
