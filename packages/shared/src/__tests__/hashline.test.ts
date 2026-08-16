import { describe, expect, it } from "bun:test";
import {
	EMPTY_LINE_HASH,
	applyHashlineEdits,
	computeLineHash,
	formatWithHashes,
	parseAnchor,
	resolveAnchor,
} from "../hashline";

describe("computeLineHash", () => {
	it("returns a 4-char lowercase hex hash for non-empty lines", () => {
		const h = computeLineHash("function foo() {");
		expect(h).toMatch(/^[0-9a-f]{4}$/);
	});

	it("is deterministic", () => {
		expect(computeLineHash("const x = 1;")).toBe(computeLineHash("const x = 1;"));
	});

	it("hashes trimmed content so indentation changes do not break anchors", () => {
		expect(computeLineHash("  return true;")).toBe(computeLineHash("\treturn true;"));
		expect(computeLineHash("return true;")).toBe(computeLineHash("    return true;   "));
	});

	it("returns the visible reserved hash for empty and whitespace-only lines", () => {
		expect(EMPTY_LINE_HASH).toBe("0000");
		expect(computeLineHash("")).toBe(EMPTY_LINE_HASH);
		expect(computeLineHash("   ")).toBe(EMPTY_LINE_HASH);
		expect(computeLineHash("\t")).toBe(EMPTY_LINE_HASH);
	});

	it("gives different hashes to different content (spot check)", () => {
		expect(computeLineHash("const x = 1;")).not.toBe(computeLineHash("const x = 2;"));
	});
});

describe("formatWithHashes", () => {
	it("formats each line as LINE:HASH|content with 1-based numbering", () => {
		const out = formatWithHashes("alpha\nbeta");
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(`1:${computeLineHash("alpha")}|alpha`);
		expect(lines[1]).toBe(`2:${computeLineHash("beta")}|beta`);
	});

	it("renders empty lines with their visible reserved hash", () => {
		expect(formatWithHashes("alpha\n\nbeta")).toContain(`2:${EMPTY_LINE_HASH}|`);
	});

	it("preserves original line content verbatim after the pipe", () => {
		const out = formatWithHashes("  indented\t");
		expect(out.split("|").slice(1).join("|")).toBe("  indented\t");
	});

	it("respects offset and limit with true line numbers", () => {
		const out = formatWithHashes("a\nb\nc\nd", 2, 2);
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toStartWith("2:");
		expect(lines[0]).toEndWith("|b");
		expect(lines[1]).toStartWith("3:");
	});

	it("handles trailing newline without emitting a phantom line", () => {
		const out = formatWithHashes("a\nb\n");
		expect(out.split("\n")).toHaveLength(2);
	});

	it("formats an empty file as empty output", () => {
		expect(formatWithHashes("")).toBe("");
	});
});

describe("parseAnchor", () => {
	it("parses LINE:HASH", () => {
		expect(parseAnchor("12:a3f1")).toEqual({ line: 12, hash: "a3f1" });
	});

	it("parses a bare hash with no line hint", () => {
		expect(parseAnchor("a3f1")).toEqual({ line: undefined, hash: "a3f1" });
	});

	it("rejects malformed anchors", () => {
		expect(parseAnchor("")).toBeNull();
		expect(parseAnchor("abc:")).toBeNull();
		expect(parseAnchor(":abc")).toBeNull();
		expect(parseAnchor("x1:a3f1")).toBeNull();
	});
});

describe("resolveAnchor", () => {
	const lines = [
		"function foo() {",
		"  return 1;",
		"}",
		"",
		"function bar() {",
		"  return 1;",
		"}",
	];

	it("resolves a unique hash match", () => {
		const idx = resolveAnchor(lines, { line: 1, hash: computeLineHash("function foo() {") });
		expect(idx).toEqual({ ok: true, index: 0 });
	});

	it("resolves an ambiguous hash by proximity to the line hint", () => {
		const h = computeLineHash("  return 1;");
		// Two matches: index 1 (line 2) and index 5 (line 6).
		expect(resolveAnchor(lines, { line: 6, hash: h })).toEqual({ ok: true, index: 5 });
		expect(resolveAnchor(lines, { line: 2, hash: h })).toEqual({ ok: true, index: 1 });
	});

	it("resolves despite shifted line numbers (proximity survives inserts)", () => {
		const shifted = ["// header", ...lines];
		const h = computeLineHash("  return 1;");
		// Anchor was captured pre-shift at line 2; closest match is now index 2.
		expect(resolveAnchor(shifted, { line: 2, hash: h })).toEqual({ ok: true, index: 2 });
	});

	it("falls back to first match when no line hint on ambiguity", () => {
		const h = computeLineHash("  return 1;");
		expect(resolveAnchor(lines, { line: undefined, hash: h })).toEqual({ ok: true, index: 1 });
	});

	it("fails when the hash is absent", () => {
		const res = resolveAnchor(lines, { line: 3, hash: "ffff" });
		expect(res.ok).toBe(false);
	});
});

describe("applyHashlineEdits", () => {
	const file = [
		"function hello() {",
		"  // comment",
		'  console.log("hi");',
		"",
		"  return true;",
		"}",
	].join("\n");
	const anchorFor = (text: string, line: number) => `${line}:${computeLineHash(text)}`;

	it("replaces a single line", () => {
		const a = anchorFor('  console.log("hi");', 3);
		const res = applyHashlineEdits(file, [{ start: a, end: a, content: '  console.log("bye");' }]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.content.split("\n")[2]).toBe('  console.log("bye");');
			expect(res.content.split("\n")).toHaveLength(6);
		}
	});

	it("replaces a range of lines", () => {
		const start = anchorFor("  // comment", 2);
		const end = anchorFor("  return true;", 5);
		const res = applyHashlineEdits(file, [{ start, end, content: "  return false;" }]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.content).toBe(["function hello() {", "  return false;", "}"].join("\n"));
		}
	});

	it("deletes a range when content is empty", () => {
		const a = anchorFor("  // comment", 2);
		const res = applyHashlineEdits(file, [{ start: a, end: a, content: "" }]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.content.split("\n")).toHaveLength(5);
			expect(res.content).not.toContain("comment");
		}
	});

	it("applies an edit against shifted content using stale line hints", () => {
		const shifted = `// new header\n${file}`;
		// Anchor captured before the shift: line 3 hint, but the line is now at 4.
		const a = anchorFor('  console.log("hi");', 3);
		const res = applyHashlineEdits(shifted, [{ start: a, end: a, content: "  noop();" }]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.content.split("\n")[3]).toBe("  noop();");
		}
	});

	it("applies multiple non-overlapping edits atomically in one pass", () => {
		const res = applyHashlineEdits(file, [
			{
				start: anchorFor("  // comment", 2),
				end: anchorFor("  // comment", 2),
				content: "  // updated comment",
			},
			{
				start: anchorFor("  return true;", 5),
				end: anchorFor("  return true;", 5),
				content: "  return 42;",
			},
		]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const lines = res.content.split("\n");
			expect(lines[1]).toBe("  // updated comment");
			expect(lines[4]).toBe("  return 42;");
		}
	});

	it("rejects overlapping edits without writing anything", () => {
		const res = applyHashlineEdits(file, [
			{
				start: anchorFor("  // comment", 2),
				end: anchorFor("  return true;", 5),
				content: "x",
			},
			{
				start: anchorFor('  console.log("hi");', 3),
				end: anchorFor('  console.log("hi");', 3),
				content: "y",
			},
		]);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("overlap");
	});

	it("rejects an end anchor that resolves before the start anchor", () => {
		const res = applyHashlineEdits(file, [
			{
				start: anchorFor("  return true;", 5),
				end: anchorFor("  // comment", 2),
				content: "x",
			},
		]);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("before");
	});

	it("rejects a missing anchor with an actionable error", () => {
		const res = applyHashlineEdits(file, [{ start: "3:ffff", end: "3:ffff", content: "x" }]);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("not found");
	});

	it("rejects a malformed anchor", () => {
		const res = applyHashlineEdits(file, [{ start: "nope!", end: "nope!", content: "x" }]);
		expect(res.ok).toBe(false);
	});

	it("preserves a trailing newline", () => {
		const withNl = `${file}\n`;
		const a = anchorFor("  // comment", 2);
		const res = applyHashlineEdits(withNl, [{ start: a, end: a, content: "  // c2" }]);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.content).toEndWith("}\n");
	});

	it("supports multi-line replacement content", () => {
		const a = anchorFor('  console.log("hi");', 3);
		const res = applyHashlineEdits(file, [
			{ start: a, end: a, content: "  const msg = 'hi';\n  console.log(msg);" },
		]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.content.split("\n")).toHaveLength(7);
			expect(res.content).toContain("const msg");
		}
	});

	it("reports post-edit regions (1-based new-content line numbers, ascending)", () => {
		const res = applyHashlineEdits(file, [
			{
				start: anchorFor("  return true;", 5),
				end: anchorFor("  return true;", 5),
				content: "  return 42;",
			},
			{
				start: anchorFor("  // comment", 2),
				end: anchorFor('  console.log("hi");', 3),
				content: "  // one\n  // two\n  // three",
			},
		]);
		expect(res.ok).toBe(true);
		if (res.ok) {
			// First edit (lines 2-3 → 3 lines) grows the file by 1, shifting the
			// second edit's region from line 5 to line 6.
			expect(res.regions).toEqual([
				{ startLine: 2, lineCount: 3 },
				{ startLine: 6, lineCount: 1 },
			]);
		}
	});

	it("reports a zero-length region for a pure deletion", () => {
		const a = anchorFor("  // comment", 2);
		const res = applyHashlineEdits(file, [{ start: a, end: a, content: "" }]);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.regions).toEqual([{ startLine: 2, lineCount: 0 }]);
	});

	it("targets empty lines via the reserved hash", () => {
		const a = `4:${EMPTY_LINE_HASH}`;
		const res = applyHashlineEdits(file, [{ start: a, end: a, content: "  // filled in" }]);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.content.split("\n")[3]).toBe("  // filled in");
	});
});
