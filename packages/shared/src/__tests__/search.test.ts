import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MAX_MATCHES,
	DEFAULT_MAX_PREVIEW_CHARS,
	compileSearchPattern,
	formatSearchResults,
	isLikelyBinary,
	searchFiles,
	shouldSearchPath,
} from "../search.js";

describe("compileSearchPattern", () => {
	it("compiles a regex with the global flag forced on", () => {
		const re = compileSearchPattern({ pattern: "foo" });
		expect(re.global).toBe(true);
		expect(re.source).toBe("foo");
	});

	it("honors the case-insensitive flag", () => {
		const re = compileSearchPattern({ pattern: "Foo", flags: "i" });
		expect(re.ignoreCase).toBe(true);
	});

	it("escapes regex metacharacters when fixedStrings is set", () => {
		const re = compileSearchPattern({ pattern: "a.b(c)", fixedStrings: true });
		// Should match the literal string, not 'a<any>b' followed by a group.
		expect(re.test("a.b(c)")).toBe(true);
		re.lastIndex = 0;
		expect(re.test("axbYc")).toBe(false);
	});

	it("throws a clean error on an invalid regex", () => {
		expect(() => compileSearchPattern({ pattern: "a(" })).toThrow();
	});
});

describe("searchFiles", () => {
	it("reports 1-based line and column for each match", () => {
		const result = searchFiles([{ path: "a.txt", content: "alpha\nbeta foo\ngamma" }], {
			pattern: "foo",
		});
		expect(result.matches).toEqual([{ path: "a.txt", line: 2, column: 6, preview: "beta foo" }]);
		expect(result.filesSearched).toBe(1);
		expect(result.filesMatched).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("finds multiple matches on the same line", () => {
		const result = searchFiles([{ path: "a.txt", content: "foo foo foo" }], { pattern: "foo" });
		expect(result.matches.map((m) => m.column)).toEqual([1, 5, 9]);
	});

	it("matches across multiple files and counts matched vs searched", () => {
		const result = searchFiles(
			[
				{ path: "a.txt", content: "has match here" },
				{ path: "b.txt", content: "nothing relevant" },
				{ path: "c.txt", content: "another match line" },
			],
			{ pattern: "match" },
		);
		expect(result.matches.map((m) => m.path)).toEqual(["a.txt", "c.txt"]);
		expect(result.filesSearched).toBe(3);
		expect(result.filesMatched).toBe(2);
	});

	it("caps total matches at maxMatches and sets truncated", () => {
		const content = Array.from({ length: 50 }, () => "needle").join("\n");
		const result = searchFiles([{ path: "a.txt", content }], { pattern: "needle", maxMatches: 10 });
		expect(result.matches.length).toBe(10);
		expect(result.truncated).toBe(true);
	});

	it("caps matches per file independently of the global cap", () => {
		const content = Array.from({ length: 100 }, () => "x").join("\n");
		const result = searchFiles(
			[
				{ path: "a.txt", content },
				{ path: "b.txt", content },
			],
			{ pattern: "x", maxMatchesPerFile: 5, maxMatches: 1000 },
		);
		const perFile = result.matches.reduce<Record<string, number>>((acc, m) => {
			acc[m.path] = (acc[m.path] ?? 0) + 1;
			return acc;
		}, {});
		expect(perFile["a.txt"]).toBe(5);
		expect(perFile["b.txt"]).toBe(5);
	});

	it("windows the preview around the match for very long lines (anti-bloat)", () => {
		// A minified-asset-style single giant line with the match buried in the middle.
		const filler = "z".repeat(5000);
		const line = `${filler}NEEDLE${filler}`;
		const result = searchFiles([{ path: "min.js", content: line }], {
			pattern: "NEEDLE",
			maxPreviewChars: 80,
		});
		expect(result.matches.length).toBe(1);
		const preview = result.matches[0].preview;
		// Bounded well under the line length, contains the match, ellipsis on both ends.
		expect(preview.length).toBeLessThanOrEqual(82); // 80 + up to 2 ellipsis chars
		expect(preview).toContain("NEEDLE");
		expect(preview.startsWith("…")).toBe(true);
		expect(preview.endsWith("…")).toBe(true);
	});

	it("does not window a short line", () => {
		const result = searchFiles([{ path: "a.txt", content: "short needle line" }], {
			pattern: "needle",
			maxPreviewChars: 80,
		});
		expect(result.matches[0].preview).toBe("short needle line");
	});

	it("does not infinite-loop on a zero-width pattern", () => {
		const result = searchFiles([{ path: "a.txt", content: "one\ntwo\nthree" }], {
			pattern: "^",
			maxMatchesPerFile: 1000,
		});
		// One zero-width match at the start of each line.
		expect(result.matches.map((m) => m.line)).toEqual([1, 2, 3]);
		expect(result.matches.every((m) => m.column === 1)).toBe(true);
	});

	it("respects the case-insensitive flag end to end", () => {
		const result = searchFiles([{ path: "a.txt", content: "FooBar" }], {
			pattern: "foobar",
			flags: "i",
		});
		expect(result.matches.length).toBe(1);
	});
});

describe("formatSearchResults", () => {
	it("renders grep-style path:line:preview lines with a summary footer", () => {
		const result = searchFiles(
			[
				{ path: "a.txt", content: "hit one" },
				{ path: "b.txt", content: "hit two" },
			],
			{ pattern: "hit" },
		);
		const out = formatSearchResults(result);
		expect(out).toContain("a.txt:1:hit one");
		expect(out).toContain("b.txt:1:hit two");
		expect(out).toContain("2 matches in 2 files");
	});

	it("reports no matches cleanly", () => {
		const result = searchFiles([{ path: "a.txt", content: "nothing" }], { pattern: "zzz" });
		expect(formatSearchResults(result)).toContain("No matches");
	});

	it("notes truncation in the footer when the cap was hit", () => {
		const content = Array.from({ length: 300 }, () => "m").join("\n");
		const result = searchFiles([{ path: "a.txt", content }], { pattern: "m" });
		const out = formatSearchResults(result);
		expect(result.truncated).toBe(true);
		expect(out.toLowerCase()).toContain("truncated");
	});
});

describe("shouldSearchPath", () => {
	it("skips common vendor and vcs directories", () => {
		expect(shouldSearchPath("node_modules/foo/index.js")).toBe(false);
		expect(shouldSearchPath("packages/x/node_modules/y.ts")).toBe(false);
		expect(shouldSearchPath(".git/config")).toBe(false);
		expect(shouldSearchPath("dist/bundle.js")).toBe(false);
	});

	it("skips known binary extensions", () => {
		expect(shouldSearchPath("assets/logo.png")).toBe(false);
		expect(shouldSearchPath("fonts/x.woff2")).toBe(false);
		expect(shouldSearchPath("a.wasm")).toBe(false);
	});

	it("allows ordinary source files", () => {
		expect(shouldSearchPath("packages/shared/src/search.ts")).toBe(true);
		expect(shouldSearchPath("README.md")).toBe(true);
	});

	it("accepts a custom exclude list", () => {
		expect(shouldSearchPath("vendor/x.ts", ["vendor/"])).toBe(false);
		expect(shouldSearchPath("src/x.ts", ["vendor/"])).toBe(true);
	});
});

describe("isLikelyBinary", () => {
	it("flags content with a NUL byte", () => {
		expect(isLikelyBinary("abc\u0000def")).toBe(true);
	});

	it("treats normal text as non-binary", () => {
		expect(isLikelyBinary("just normal text\nwith lines")).toBe(false);
	});
});

describe("exported defaults", () => {
	it("exposes sane default caps", () => {
		expect(DEFAULT_MAX_MATCHES).toBeGreaterThan(0);
		expect(DEFAULT_MAX_PREVIEW_CHARS).toBeGreaterThan(0);
	});
});
