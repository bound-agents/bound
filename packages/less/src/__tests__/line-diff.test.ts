import { describe, expect, it } from "bun:test";
import { computeLineDiff, hunkDiff } from "../tui/components/lineDiff";

describe("computeLineDiff", () => {
	it("returns empty array for two empty strings", () => {
		expect(computeLineDiff("", "")).toEqual([]);
	});

	it("treats empty old as all-add", () => {
		expect(computeLineDiff("", "a\nb")).toEqual([
			{ kind: "add", text: "a" },
			{ kind: "add", text: "b" },
		]);
	});

	it("treats empty new as all-remove", () => {
		expect(computeLineDiff("a\nb", "")).toEqual([
			{ kind: "remove", text: "a" },
			{ kind: "remove", text: "b" },
		]);
	});

	it("returns all-same when texts are identical", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nb\nc");
		expect(diff.every((d) => d.kind === "same")).toBe(true);
		expect(diff.map((d) => d.text)).toEqual(["a", "b", "c"]);
	});

	it("emits remove + add for a single-line replacement", () => {
		const diff = computeLineDiff(
			"function foo() {\n  return 1;\n}",
			"function foo() {\n  return 2;\n}",
		);
		expect(diff).toEqual([
			{ kind: "same", text: "function foo() {" },
			{ kind: "remove", text: "  return 1;" },
			{ kind: "add", text: "  return 2;" },
			{ kind: "same", text: "}" },
		]);
	});

	it("emits adds for inserted lines while preserving surrounding context", () => {
		const diff = computeLineDiff("a\nc", "a\nb\nc");
		expect(diff).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "add", text: "b" },
			{ kind: "same", text: "c" },
		]);
	});

	it("emits removes for deleted lines while preserving surrounding context", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nc");
		expect(diff).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "remove", text: "b" },
			{ kind: "same", text: "c" },
		]);
	});

	it("orders removes before adds within a contiguous change run", () => {
		const diff = computeLineDiff("a\nb", "c\nb");
		// Conventional unified-diff order: -a then +c, then context b.
		expect(diff).toEqual([
			{ kind: "remove", text: "a" },
			{ kind: "add", text: "c" },
			{ kind: "same", text: "b" },
		]);
	});

	it("handles a totally disjoint change", () => {
		const diff = computeLineDiff("a\nb", "c\nd");
		expect(diff).toEqual([
			{ kind: "remove", text: "a" },
			{ kind: "remove", text: "b" },
			{ kind: "add", text: "c" },
			{ kind: "add", text: "d" },
		]);
	});

	it("treats trailing newlines as empty trailing lines (split semantics)", () => {
		// "a\n" splits to ["a", ""] — useful to know so callers can decide
		// whether to trim or preserve.
		const diff = computeLineDiff("a\n", "a\n");
		expect(diff.length).toBe(2);
		expect(diff.every((d) => d.kind === "same")).toBe(true);
	});
});

describe("hunkDiff", () => {
	it("returns empty array for a pure-context diff", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nb\nc");
		expect(hunkDiff(diff)).toEqual([]);
	});

	it("keeps small diffs intact when they fit within the context window", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nx\nc");
		// 3 lines total, context=3 keeps everything — no ellipsis.
		const hunked = hunkDiff(diff, 3);
		expect(hunked).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "remove", text: "b" },
			{ kind: "add", text: "x" },
			{ kind: "same", text: "c" },
		]);
	});

	it("collapses long unchanged prefixes into a leading ellipsis", () => {
		// 10 unchanged lines, then one removed line at the end.
		const oldText = `${Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")}\nremove-me`;
		const newText = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
		const diff = computeLineDiff(oldText, newText);
		const hunked = hunkDiff(diff, 3);

		// Should start with an ellipsis collapsing the 7 unused leading "same" lines,
		// followed by 3 lines of context, then the remove.
		expect(hunked[0]).toEqual({ kind: "ellipsis", count: 7 });
		const tail = hunked.slice(1);
		expect(tail.map((e) => e.kind)).toEqual(["same", "same", "same", "remove"]);
	});

	it("merges adjacent change ranges that are within 2*context of each other", () => {
		// Two changes 4 lines apart — with context=3, their windows overlap and merge.
		const diff: Parameters<typeof hunkDiff>[0] = [
			{ kind: "remove", text: "a" },
			{ kind: "same", text: "1" },
			{ kind: "same", text: "2" },
			{ kind: "same", text: "3" },
			{ kind: "same", text: "4" },
			{ kind: "remove", text: "b" },
		];
		const hunked = hunkDiff(diff, 3);
		// All 6 entries should be kept (no internal ellipsis), since the
		// context windows of the two changes touch.
		expect(hunked).toHaveLength(6);
		expect(hunked.every((e) => e.kind !== "ellipsis")).toBe(true);
	});
});
