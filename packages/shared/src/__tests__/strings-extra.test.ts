import { describe, expect, it } from "bun:test";
import { compareBytewise, escapeXmlAttr, safeSlice } from "../strings";

describe("compareBytewise", () => {
	it("orders by UTF-16 code units, not host locale", () => {
		expect(compareBytewise("a", "b")).toBe(-1);
		expect(compareBytewise("b", "a")).toBe(1);
		expect(compareBytewise("a", "a")).toBe(0);
	});

	it("sorts a list deterministically regardless of locale rules", () => {
		const list = ["banana", "Apple", "apple", "Banana"];
		const sorted = [...list].sort(compareBytewise);
		// Uppercase code points precede lowercase in UTF-16 order.
		expect(sorted).toEqual(["Apple", "Banana", "apple", "banana"]);
	});
});

describe("escapeXmlAttr", () => {
	it("escapes all five XML predefined entities", () => {
		expect(escapeXmlAttr(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
	});

	it("escapes ampersand first so entities are not double-escaped", () => {
		expect(escapeXmlAttr("a & b < c")).toBe("a &amp; b &lt; c");
	});

	it("passes through content with no special characters", () => {
		expect(escapeXmlAttr("plain text 123")).toBe("plain text 123");
	});

	it("escapes a realistic thread title with a backtick and ampersand", () => {
		expect(escapeXmlAttr("fix the `mxc` policy & retry")).toBe("fix the `mxc` policy &amp; retry");
	});
});

describe("safeSlice", () => {
	it("returns a plain slice when no surrogate pair straddles the boundary", () => {
		expect(safeSlice("hello world", 0, 5)).toBe("hello");
	});

	it("clamps end past the string length", () => {
		expect(safeSlice("abc", 0, 99)).toBe("abc");
	});

	it("steps back to avoid splitting a surrogate pair", () => {
		// '😀' is a surrogate pair (2 code units). Cutting at index 1 would orphan
		// the high surrogate; safeSlice backs off to exclude the pair entirely.
		const s = "x😀y";
		const cut = safeSlice(s, 0, 2);
		expect(cut).toBe("x");
		expect(cut).not.toContain("\uD800");
	});
});
