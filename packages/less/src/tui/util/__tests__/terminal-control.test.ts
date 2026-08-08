import { describe, expect, it } from "bun:test";
import { stripTerminalControlSequences } from "../terminal-control";

describe("stripTerminalControlSequences", () => {
	it("strips complete OSC 8 hyperlinks while preserving the visible label", () => {
		const input =
			"before \x1b]8;;https://biomejs.dev/linter/rules/no-control-characters-in-regex\x07lint/suspicious/noControlCharactersInRegex\x1b]8;;\x07 after";

		expect(stripTerminalControlSequences(input)).toBe(
			"before lint/suspicious/noControlCharactersInRegex after",
		);
	});

	it("drops an unterminated OSC sequence instead of leaking a live terminal control", () => {
		const input =
			"before \x1b]8;;https://biomejs.dev/linter/rules/no-control-characters-in-regex\x07lint/suspicious/noControlCharactersInRegex\x1b]8;;";

		expect(stripTerminalControlSequences(input)).toBe(
			"before lint/suspicious/noControlCharactersInRegex",
		);
	});

	it("strips CSI and C0/C1 controls but preserves layout whitespace", () => {
		const input = "\x1b[31mred\x1b[0m\r\nnext\tcol\x07";

		expect(stripTerminalControlSequences(input)).toBe("red\nnext\tcol");
	});

	it("collapses a CR run followed by LF into one line ending", () => {
		// Bun's coverage reporter emits `\r\r\n`; treating each CR as a
		// newline produces a phantom blank row between every report row.
		expect(stripTerminalControlSequences("first\r\r\nsecond\r\r\nthird")).toBe(
			"first\nsecond\nthird",
		);
	});

	it("preserves an intentional blank line between CRLF-terminated rows", () => {
		expect(stripTerminalControlSequences("first\r\n\r\nsecond")).toBe("first\n\nsecond");
	});
});
