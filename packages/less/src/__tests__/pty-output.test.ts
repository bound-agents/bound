import { describe, expect, it } from "bun:test";
import { cleanPtyOutput, createPtyOutputCleaner } from "../tools/pty-output";

// The exact preamble ConPTY paints before any command output, reconstructed from
// a live capture of the IsolationSession exec path on Windows (cmd.exe). The
// blank-row run is one `ESC[K` erase-line + CRLF per viewport row; the live
// capture showed ~80, so a representative run is used here.
const ESC = "\u001b";
function conptyPreamble(rows = 80): string {
	const init = `${ESC}[?9001h${ESC}[?1004h${ESC}[?1004h${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[H`;
	const title1 = `${ESC}]0;C:\\Users\\user\\.bound\\less\\mxc-runtime\\58f60ec379d98759\\x64\\wxc-exec.exe\u0007`;
	const reclear = `${ESC}[?25h${ESC}[2J${ESC}[?25l`;
	const blankRows = Array.from({ length: rows }, () => `${ESC}[K`).join("\r\n");
	const home = `${ESC}[H`;
	const title2 = `${ESC}]0;C:\\Windows\\System32\\cmd.exe\u0007`;
	const showCursor = `${ESC}[?25h`;
	return init + title1 + reclear + blankRows + home + title2 + showCursor;
}

describe("cleanPtyOutput", () => {
	it("reduces the ConPTY viewport preamble + a one-line command to just the output", () => {
		const raw = `${conptyPreamble()}hello\r\n`;
		expect(cleanPtyOutput(raw)).toBe("hello\n");
	});

	it("preserves multiple real output lines", () => {
		const raw = `${conptyPreamble()}a\r\nb\r\n`;
		expect(cleanPtyOutput(raw)).toBe("a\nb\n");
	});

	it("preserves a multi-entry directory listing", () => {
		const raw = `${conptyPreamble()}node_modules\r\npackage.json\r\nsrc\r\n_ansi_probe.ts\r\n`;
		expect(cleanPtyOutput(raw)).toBe("node_modules\npackage.json\nsrc\n_ansi_probe.ts\n");
	});

	it("preserves blank lines that appear AFTER real content (command's own output)", () => {
		const raw = `${conptyPreamble()}line1\r\n\r\nline2\r\n`;
		expect(cleanPtyOutput(raw)).toBe("line1\n\nline2\n");
	});

	it("passes through plain text with no escapes unchanged", () => {
		expect(cleanPtyOutput("just text\nwith lines\n")).toBe("just text\nwith lines\n");
	});

	it("strips a bare OSC title sequence", () => {
		expect(cleanPtyOutput(`${ESC}]0;some title\u0007payload`)).toBe("payload");
	});

	it("strips standalone CSI sequences mid-content", () => {
		expect(cleanPtyOutput(`red${ESC}[31m text${ESC}[0m here`)).toBe("red text here");
	});
});

describe("createPtyOutputCleaner (streaming / chunk boundaries)", () => {
	it("strips an escape sequence split across two chunks", () => {
		const clean = createPtyOutputCleaner();
		// `ESC[31` arrives, then `m` completes the CSI in the next chunk.
		const out1 = clean(`x${ESC}[31`);
		const out2 = clean("m y");
		expect(out1 + out2).toBe("x y");
	});

	it("buffers an OSC split across chunks (payload has no fixed charset)", () => {
		const clean = createPtyOutputCleaner();
		const out1 = clean(`${ESC}]0;C:\\Win`);
		const out2 = clean("dows\\cmd.exe\u0007done");
		expect(out1 + out2).toBe("done");
	});

	it("suppresses leading viewport blanks streamed before the first content chunk", () => {
		const clean = createPtyOutputCleaner();
		const out1 = clean(conptyPreamble());
		const out2 = clean("result\r\n");
		expect(out1).toBe("");
		expect(out1 + out2).toBe("result\n");
	});

	it("holds back a lone trailing ESC until the next chunk", () => {
		const clean = createPtyOutputCleaner();
		const out1 = clean(`a${ESC}`);
		const out2 = clean("[0mb");
		expect(out1 + out2).toBe("ab");
	});
});
