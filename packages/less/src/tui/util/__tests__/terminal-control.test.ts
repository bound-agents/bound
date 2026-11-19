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
		expect(stripTerminalControlSequences("first\r\r\nsecond\r\r\nthird")).toBe(
			"first\nsecond\nthird",
		);
	});

	it("drops a reporter row that contains only terminal controls", () => {
		// Bun places an SGR reset on its own CRLF-terminated row between some
		// report rows. After stripping SGR, preserving that row makes a phantom
		// blank line in the result card.
		expect(stripTerminalControlSequences("\x1b[0m\r\nfirst\r\n\x1b[0m\r\nsecond")).toBe(
			"first\nsecond",
		);
	});

	it("preserves an intentional blank line between CRLF-terminated rows", () => {
		expect(stripTerminalControlSequences("first\r\n\r\nsecond")).toBe("first\n\nsecond");
	});

	it("strips an ESC-prefixed CSI sequence terminated by a final byte", () => {
		// ESC [ 1 ; 2 H (cursor position) — final byte 'H' (0x48) ends the CSI.
		expect(stripTerminalControlSequences("a\x1b[1;2Hb")).toBe("ab");
	});

	it("drops an unterminated CSI sequence to end of string", () => {
		// No final byte in [0x40,0x7e] — skipCsi runs to input.length.
		expect(stripTerminalControlSequences("a\x1b[1;2;3")).toBe("a");
	});

	it("strips a two-byte ESC control (e.g. ESC c reset)", () => {
		// ESC c — not CSI/OSC/charset, falls to the two-byte branch.
		expect(stripTerminalControlSequences("a\x1bcb")).toBe("ab");
	});

	it("strips a three-byte ESC charset-designation control", () => {
		// ESC ( B — designate US-ASCII as G0; three-byte ESC control.
		expect(stripTerminalControlSequences("a\x1b(Bb")).toBe("ab");
		// ESC ) 0 — designate DEC special graphics as G1.
		expect(stripTerminalControlSequences("a\x1b)0b")).toBe("ab");
	});

	it("strips a C1 CSI introducer (0x9b) and its parameters", () => {
		// 0x9b is the 8-bit CSI; '31m' then a final 'm' terminate it.
		expect(stripTerminalControlSequences("a\x9b31mred")).toBe("ared");
	});

	it("strips a C1 string control (0x9d OSC) terminated by ST (0x9c)", () => {
		// 0x9d OSC ... 0x9c ST — the 8-bit string-control form.
		expect(stripTerminalControlSequences("a\x9d8;;x\x9cb")).toBe("ab");
	});

	it("drops a lone C1 control byte in the 0x80–0x9f range", () => {
		// 0x85 (NEL) is a bare C1 control — dropped, marks the line as control-only.
		expect(stripTerminalControlSequences("vis\x85")).toBe("vis");
	});
});
