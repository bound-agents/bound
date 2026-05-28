import { describe, expect, test } from "bun:test";
import { wrapToVisualRows } from "../tui/util/wrap";

describe("wrapToVisualRows", () => {
	test("returns input unchanged when shorter than width", () => {
		expect(wrapToVisualRows("hello", 80)).toEqual(["hello"]);
	});

	test("returns input unchanged at exact width", () => {
		expect(wrapToVisualRows("hello", 5)).toEqual(["hello"]);
	});

	test("splits into chunks of exactly width when longer", () => {
		// 12 chars at width 5 → ["12345", "67890", "ab"]
		expect(wrapToVisualRows("1234567890ab", 5)).toEqual(["12345", "67890", "ab"]);
	});

	test("hard-breaks long single tokens with no whitespace (the #74/#75 case)", () => {
		const long = "abcdefghij".repeat(10); // 100 chars, no spaces
		const rows = wrapToVisualRows(long, 20);
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect(row.length).toBe(20);
		}
		expect(rows.join("")).toBe(long);
	});

	test("preserves content exactly across chunk boundaries", () => {
		const input = `${"x".repeat(73)}yz${"x".repeat(73)}`;
		const rows = wrapToVisualRows(input, 73);
		expect(rows.join("")).toBe(input);
	});

	test("returns single chunk for empty string", () => {
		expect(wrapToVisualRows("", 80)).toEqual([""]);
	});

	test("returns input unchanged when width <= 0 (defensive)", () => {
		expect(wrapToVisualRows("hello", 0)).toEqual(["hello"]);
		expect(wrapToVisualRows("hello", -5)).toEqual(["hello"]);
	});

	test("handles width=1 with multi-char input", () => {
		expect(wrapToVisualRows("abc", 1)).toEqual(["a", "b", "c"]);
	});
});
