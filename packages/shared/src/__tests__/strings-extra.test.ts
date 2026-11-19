import { describe, expect, it } from "bun:test";
import {
	HALF_OUTPUT_BYTES,
	compareBytewise,
	escapeXmlAttr,
	safeSlice,
	truncateStreamOutput,
} from "../strings";

describe("truncateStreamOutput", () => {
	it("returns input unchanged when within budget", () => {
		expect(truncateStreamOutput("short", 1000)).toBe("short");
	});

	it("middle-truncates oversized output, keeping head and tail with a marker", () => {
		const input = "A".repeat(100) + "B".repeat(100);
		const out = truncateStreamOutput(input, 40);
		expect(out).toContain("... [truncated");
		expect(out).toContain("bytes from middle] ...");
		expect(out.startsWith("A")).toBe(true);
		expect(out.endsWith("B")).toBe(true);
		// Dropped-byte count is total minus the retained budget.
		expect(out).toContain("[truncated 160 bytes from middle]");
	});

	it("never splits a multi-byte character at the head boundary", () => {
		// '€' is 3 UTF-8 bytes. A budget forcing a cut must stop on a char boundary.
		const input = "€".repeat(50);
		const out = truncateStreamOutput(input, 30);
		// Every retained run of content is whole euro signs — no replacement char.
		expect(out).not.toContain("\uFFFD");
	});

	it("exposes the shared 50KB per-stream budget", () => {
		expect(HALF_OUTPUT_BYTES).toBe(50000);
	});
});

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
