import { describe, expect, it } from "bun:test";
import { compareCursors } from "../cursor-order";

describe("compareCursors", () => {
	it("orders snowflakes above 2^53 exactly", () => {
		// Number() collapses these two to the same double; BigInt keeps them apart.
		const a = "1400000000000000001";
		const b = "1400000000000000002";
		expect(Number(a)).toBe(Number(b));
		expect(compareCursors(a, b)).toBe(-1);
		expect(compareCursors(b, a)).toBe(1);
	});

	it("orders numeric cursors of different lengths numerically, not lexically", () => {
		expect(compareCursors("999999999999999999", "1000000000000000000")).toBe(-1);
		expect(compareCursors("1000000000000000000", "999999999999999999")).toBe(1);
		expect(compareCursors("9", "10")).toBe(-1);
	});

	it("falls back to localeCompare when either cursor is non-numeric", () => {
		expect(compareCursors("cursor-a", "cursor-b")).toBeLessThan(0);
		expect(compareCursors("cursor-b", "cursor-a")).toBeGreaterThan(0);
		expect(compareCursors("10", "abc")).toBe("10".localeCompare("abc"));
	});

	it("returns 0 for equal cursors on both paths", () => {
		expect(compareCursors("1400000000000000001", "1400000000000000001")).toBe(0);
		expect(compareCursors("opaque", "opaque")).toBe(0);
	});
});
