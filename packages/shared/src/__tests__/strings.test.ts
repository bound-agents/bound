import { describe, expect, test } from "bun:test";
import {
	MAX_TOOL_RESULT_BYTES,
	appendToolDuration,
	capToolResultContent,
	formatFileAttachment,
	safeSlice,
	stripToolDuration,
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

describe("appendToolDuration", () => {
	test("appends [duration: N.NNNs] suffix to plain string content", () => {
		const result = appendToolDuration("hello world", 1234);
		expect(result).toBe("hello world\n\n[duration: 1.234s]");
	});

	test("appends to empty string with leading newline separator", () => {
		const result = appendToolDuration("", 500);
		expect(result).toBe("\n\n[duration: 0.500s]");
	});

	test("formats sub-second durations with three decimal places", () => {
		expect(appendToolDuration("x", 7)).toBe("x\n\n[duration: 0.007s]");
		expect(appendToolDuration("x", 0)).toBe("x\n\n[duration: 0.000s]");
	});

	test("formats large durations correctly", () => {
		const result = appendToolDuration("x", 60_500);
		expect(result).toBe("x\n\n[duration: 60.500s]");
	});

	test("appends as a separate ContentBlock when content is a JSON-serialized array", () => {
		const blocks = [{ type: "text", text: "first" }];
		const result = appendToolDuration(JSON.stringify(blocks), 250);
		const parsed = JSON.parse(result);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual({ type: "text", text: "first" });
		expect(parsed[1]).toEqual({ type: "text", text: "[duration: 0.250s]" });
	});

	test("handles empty ContentBlock array", () => {
		const result = appendToolDuration("[]", 100);
		const parsed = JSON.parse(result);
		expect(parsed).toEqual([{ type: "text", text: "[duration: 0.100s]" }]);
	});

	test("treats string starting with '[' but not valid JSON as plain string", () => {
		const result = appendToolDuration("[error: weird]", 50);
		expect(result).toBe("[error: weird]\n\n[duration: 0.050s]");
	});

	test("treats string starting with '[' that parses to a non-array as plain string", () => {
		// Could happen if a tool result happens to start with '[' but the JSON
		// parses to e.g. a number.
		const result = appendToolDuration("[1,2,3", 25);
		expect(result).toBe("[1,2,3\n\n[duration: 0.025s]");
	});

	test("returns input unchanged for negative elapsedMs (clock skew defense)", () => {
		expect(appendToolDuration("hello", -1)).toBe("hello");
		expect(appendToolDuration("hello", -1000)).toBe("hello");
		expect(appendToolDuration(JSON.stringify([{ type: "text", text: "x" }]), -50)).toBe(
			JSON.stringify([{ type: "text", text: "x" }]),
		);
	});

	test("output stays under cap when called before capToolResultContent", () => {
		// Construct content that's just at the cap, append duration, then cap.
		// Middle-cut should preserve the duration block at the tail.
		const oversize = "x".repeat(MAX_TOOL_RESULT_BYTES);
		const withDuration = appendToolDuration(oversize, 1500);
		const capped = capToolResultContent(withDuration);

		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
		// Duration suffix lives in the tail half — survives middle-cut.
		expect(capped).toContain("[duration: 1.500s]");
	});
});

describe("stripToolDuration", () => {
	test("strips a trailing [duration: N.NNNs] suffix from plain string content", () => {
		expect(stripToolDuration("hello world\n\n[duration: 1.234s]")).toBe("hello world");
	});

	test("recovers the original JSON payload an app JSON.parses (github get-me case)", () => {
		const json = '{"login":"polaris-is-online","id":280102667}';
		expect(stripToolDuration(`${json}\n\n[duration: 0.457s]`)).toBe(json);
	});

	test("strips large-duration and sub-second markers", () => {
		expect(stripToolDuration("x\n\n[duration: 60.500s]")).toBe("x");
		expect(stripToolDuration("x\n\n[duration: 0.000s]")).toBe("x");
	});

	test("pops a trailing duration ContentBlock from a JSON-serialized array", () => {
		const withMarker = JSON.stringify([
			{ type: "text", text: "first" },
			{ type: "text", text: "[duration: 0.250s]" },
		]);
		expect(stripToolDuration(withMarker)).toBe(JSON.stringify([{ type: "text", text: "first" }]));
	});

	test("leaves a JSON array without a trailing duration block unchanged", () => {
		const noMarker = JSON.stringify([{ type: "text", text: "only" }]);
		expect(stripToolDuration(noMarker)).toBe(noMarker);
	});

	test("leaves content with no marker unchanged", () => {
		expect(stripToolDuration("plain result")).toBe("plain result");
		expect(stripToolDuration("")).toBe("");
		expect(stripToolDuration('{"login":"x"}')).toBe('{"login":"x"}');
	});

	test("does not strip a duration-shaped line that is not the appended suffix", () => {
		// Only the exact `\n\n[duration: N.NNNs]` tail is removed, not an inline mention.
		expect(stripToolDuration("see [duration: 1.000s] above\n\nmore")).toBe(
			"see [duration: 1.000s] above\n\nmore",
		);
	});

	test("round-trips appendToolDuration for both shapes", () => {
		expect(stripToolDuration(appendToolDuration("plain", 1234))).toBe("plain");
		const blocks = JSON.stringify([{ type: "text", text: "b" }]);
		expect(stripToolDuration(appendToolDuration(blocks, 250))).toBe(blocks);
	});

	test("is idempotent", () => {
		const once = stripToolDuration("x\n\n[duration: 1.234s]");
		expect(stripToolDuration(once)).toBe(once);
	});
});
