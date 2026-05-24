import { describe, expect, test } from "bun:test";
import {
	MAX_TOOL_RESULT_BYTES,
	capToolResultContent,
	formatFileAttachment,
	safeSlice,
} from "../strings";

describe("formatFileAttachment", () => {
	test("formats file attachment string", () => {
		expect(formatFileAttachment("doc.txt", "/files/abc", 1024)).toBe(
			"[Attached file: doc.txt — saved to /files/abc (1024 bytes)]",
		);
	});
});

describe("safeSlice", () => {
	test("clamps end to string length", () => {
		expect(safeSlice("abc", 0, 100)).toBe("abc");
	});

	test("preserves surrogate pairs at the boundary", () => {
		// 🎉 is a non-BMP code point — two UTF-16 code units (surrogate pair).
		const s = `a${"🎉"}b`;
		// Length is 4 code units: 'a' + high + low + 'b'.
		// Slicing at end=2 would leave an orphan high surrogate; safeSlice steps back to 1.
		const result = safeSlice(s, 0, 2);
		expect(result).toBe("a");
	});

	test("returns full content when end is at the boundary of a complete pair", () => {
		const s = `a${"🎉"}b`;
		expect(safeSlice(s, 0, 3)).toBe(`a${"🎉"}`);
	});
});

describe("capToolResultContent", () => {
	test("returns input unchanged when within budget", () => {
		const input = "hello world";
		expect(capToolResultContent(input)).toBe(input);
	});

	test("returns input unchanged at exact budget", () => {
		const input = "x".repeat(MAX_TOOL_RESULT_BYTES);
		expect(capToolResultContent(input)).toBe(input);
	});

	test("truncates when over budget and embeds marker", () => {
		const input = "x".repeat(MAX_TOOL_RESULT_BYTES + 1000);
		const result = capToolResultContent(input);

		expect(result.length).toBeLessThan(input.length);
		expect(result).toContain("[truncated");
		expect(result).toContain("bytes from middle");
		expect(result).toContain(`${MAX_TOOL_RESULT_BYTES}-byte cap`);
	});

	test("preserves head and tail of input", () => {
		const head = "HEAD_MARKER_BEGIN";
		const tail = "TAIL_MARKER_END";
		const filler = "x".repeat(MAX_TOOL_RESULT_BYTES);
		const input = head + filler + tail;
		const result = capToolResultContent(input);

		expect(result.startsWith(head)).toBe(true);
		expect(result.endsWith(tail)).toBe(true);
	});

	test("idempotent on already-capped content", () => {
		const input = "x".repeat(MAX_TOOL_RESULT_BYTES + 5000);
		const once = capToolResultContent(input);
		const twice = capToolResultContent(once);
		expect(twice).toBe(once);
	});

	test("operates on UTF-8 byte length, not character count", () => {
		// Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units / 1 code point.
		// Build a string whose JS .length is well under MAX_TOOL_RESULT_BYTES
		// but whose UTF-8 byte length exceeds it.
		const emojiCount = Math.ceil(MAX_TOOL_RESULT_BYTES / 4) + 100;
		const input = "🎉".repeat(emojiCount);
		expect(Buffer.byteLength(input, "utf8")).toBeGreaterThan(MAX_TOOL_RESULT_BYTES);
		const result = capToolResultContent(input);
		expect(Buffer.byteLength(result, "utf8")).toBeLessThan(Buffer.byteLength(input, "utf8"));
		expect(result).toContain("[truncated");
	});

	test("output never exceeds MAX_TOOL_RESULT_BYTES", () => {
		const oversizes = [
			MAX_TOOL_RESULT_BYTES + 1,
			MAX_TOOL_RESULT_BYTES + 1000,
			MAX_TOOL_RESULT_BYTES * 2,
			MAX_TOOL_RESULT_BYTES * 10,
		];
		for (const size of oversizes) {
			const input = "x".repeat(size);
			const result = capToolResultContent(input);
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
		}
	});

	test("dropped byte count in marker matches actual delta", () => {
		const oversize = MAX_TOOL_RESULT_BYTES + 50_000;
		const input = "x".repeat(oversize);
		const result = capToolResultContent(input);

		const match = result.match(/\[truncated (\d+) bytes from middle/);
		expect(match).not.toBeNull();
		const reportedDropped = Number.parseInt(match?.[1] ?? "0", 10);
		// Reported drop should be close to the actual delta (within rounding from
		// the half-budget walks; head + tail combined sit at or just under MAX).
		expect(reportedDropped).toBeGreaterThan(oversize - MAX_TOOL_RESULT_BYTES - 10);
		expect(reportedDropped).toBeLessThanOrEqual(oversize);
	});
});
